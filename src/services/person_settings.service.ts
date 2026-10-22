/**
 * The person layer of notifications (PLAN-notification-layers D): each person's own on / off per event, which wins
 * over the realm and the org for them.
 *
 * - `my_runs` — about runs they started (wherever): seeded with the events that mean trouble switched on.
 * - `all` — what reaches them from their org and realms: off stops it for them; on brings it to them from every
 *   realm they're a member of, even when nothing sends it to them.
 *
 * No row = follow the realm, then the org (for `my_runs`: off).
 */

import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { NotificationService } from './notification.service.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.person_settings');

export type PersonScope = 'my_runs' | 'all';
export type PersonState = 'on' | 'off';

/** "Runs I start", switched on when a person's settings are seeded: the events that mean a run is in trouble. */
export const MY_RUNS_SEEDED_ON: readonly string[] = [
    'run.failed', 'run.crashed', 'phase.failed', 'phase.timed_out', 'phase.idle', 'phase.input_required', 'phase.escalated',
];

/** The events "Runs I start" lists (seeded off unless in {@link MY_RUNS_SEEDED_ON}). */
export const MY_RUNS_EVENTS: readonly string[] = [
    ...MY_RUNS_SEEDED_ON, 'run.cancelled', 'run.started', 'run.completed', 'run.resumed',
    'phase.started', 'phase.completed', 'phase.skipped', 'phase.inputs_supplied',
];

export interface PersonSettingData {
    scope: PersonScope;
    event: string;
    state: PersonState;
}

async function model() {
    return (await import('../models/index.js')).NotificationPersonSetting;
}

export class PersonSettingsService {
    /** Seeds "Runs I start" once per person (the trouble events on). A person who has any `my_runs` row is left alone. */
    static async ensure_seeded(user_id: string): Promise<number> {
        const M = await model();
        if (await M.findOne({ where: { user_id, scope: 'my_runs' }, attributes: ['id'], raw: true })) return 0;
        const now = Date.now();
        await M.bulkCreate(MY_RUNS_SEEDED_ON.map((event) => ({
            id: randomUUID(), user_id, scope: 'my_runs' as const, event, state: 'on' as const, created_at: now, updated_at: now,
        })), { ignoreDuplicates: true });
        log.info('person_settings_seeded', { user_id, events: MY_RUNS_SEEDED_ON.length });
        return MY_RUNS_SEEDED_ON.length;
    }

    /** A person's own settings. */
    static async list(user_id: string): Promise<PersonSettingData[]> {
        const M = await model();
        const rows = await M.findAll({ where: { user_id }, attributes: ['scope', 'event', 'state'], order: [['scope', 'ASC'], ['event', 'ASC']], raw: true });
        return rows.map((r) => ({ scope: r.scope, event: r.event, state: r.state }));
    }

    /** Sets one setting, or clears it (`state: null` — follow the realm and org again). */
    static async set(user_id: string, scope: PersonScope, event: string, state: PersonState | null): Promise<void> {
        const M = await model();
        if (state === null) {
            await M.destroy({ where: { user_id, scope, event } });
            return;
        }
        const now = Date.now();
        const [row, created] = await M.findOrCreate({
            where: { user_id, scope, event },
            defaults: { id: randomUUID(), user_id, scope, event, state, created_at: now, updated_at: now } as never,
        });
        if (!created && row.state !== state) await row.update({ state, updated_at: now });
    }

    /** Of `user_ids`, who switched `event` off for themselves (exact event, its family `run.*`, or `*`). */
    static async off_for(user_ids: string[], event: string): Promise<Set<string>> {
        if (user_ids.length === 0) return new Set();
        const M = await model();
        const rows = await M.findAll({
            where: { user_id: { [Op.in]: user_ids }, scope: 'all', state: 'off', event: { [Op.in]: NotificationService.build_matching_selectors(event) } },
            attributes: ['user_id'], raw: true,
        });
        return new Set(rows.map((r) => String(r.user_id)));
    }

    /** Everyone who switched `event` on for themselves (`all`), of the given realm's members. */
    static async on_in_realm(event: string, realm_id: string): Promise<string[]> {
        const M = await model();
        const rows = await M.findAll({
            where: { scope: 'all', state: 'on', event: { [Op.in]: NotificationService.build_matching_selectors(event) } },
            attributes: ['user_id'], raw: true,
        });
        const ids = [...new Set(rows.map((r) => String(r.user_id)))];
        if (ids.length === 0) return [];
        const { RealmMember } = await import('../models/index.js');
        const members = await RealmMember.findAll({ where: { realm_id, member_type: 'user', member_id: ids } as never, attributes: ['member_id'], raw: true });
        return members.map((m) => String((m as { member_id: string }).member_id));
    }

    /** Whether the person who started a run gets `event` about it ("Runs I start"). */
    static async my_runs_on(user_id: string, event: string): Promise<boolean> {
        const M = await model();
        const row = await M.findOne({ where: { user_id, scope: 'my_runs', event: { [Op.in]: NotificationService.build_matching_selectors(event) }, state: 'on' }, attributes: ['id'], raw: true });
        return Boolean(row);
    }

    /** Events the person switched off for themselves (`all`) — their inbox hides shared notices of these. */
    static async muted_events(user_id: string): Promise<string[]> {
        const M = await model();
        const rows = await M.findAll({ where: { user_id, scope: 'all', state: 'off' }, attributes: ['event'], raw: true });
        return rows.map((r) => r.event);
    }
}

/** One event that reaches a person, and what it comes through (names only — never anyone's addresses). */
export interface ReachesMe {
    event: string;
    via: string[];
}

/**
 * What reaches a person from their orgs and realms: every rule that's on and whose channel takes them in — the
 * built-in All org / All realm members of an org or realm they're in, their own channel (a rule to them), or a
 * channel that names them (a channel_ref with their username). One entry per event, with each "via" once.
 */
export async function reaches_me(user_id: string, username: string): Promise<ReachesMe[]> {
    const { OrgMember, RealmMember, NotificationRule, NotificationChannel, ChannelDestination, Realm } = await import('../models/index.js');
    const org_ids = (await OrgMember.findAll({ where: { user_id, status: 'active' } as never, attributes: ['org_id'], raw: true }))
        .map((m) => String((m as { org_id: string }).org_id));
    const realm_ids = (await RealmMember.findAll({ where: { member_type: 'user', member_id: user_id } as never, attributes: ['realm_id'], raw: true }))
        .map((m) => String((m as { realm_id: string }).realm_id));
    // Orgs of my realms count too (their org rules reach me there).
    const realm_orgs = realm_ids.length ? (await Realm.findAll({ where: { id: realm_ids } as never, attributes: ['org_id'], raw: true }))
        .map((r) => String((r as { org_id: string | null }).org_id ?? '')).filter(Boolean) : [];
    const orgs = [...new Set([...org_ids, ...realm_orgs])];
    if (orgs.length === 0 && realm_ids.length === 0) return [];

    const rules = await NotificationRule.findAll({
        where: {
            enabled: true, team_slug: { [Op.is]: null },
            [Op.or]: [
                ...(orgs.length ? [{ org_id: { [Op.in]: orgs }, realm_id: { [Op.is]: null } }] : []),
                ...(realm_ids.length ? [{ realm_id: { [Op.in]: realm_ids } }] : []),
            ],
        } as never,
        attributes: ['event', 'channel_id'], raw: true,
    }) as unknown as Array<{ event: string; channel_id: string }>;
    if (rules.length === 0) return [];
    const channels = await NotificationChannel.findAll({
        where: { id: [...new Set(rules.map((r) => r.channel_id))], enabled: 1 } as never,
        include: [{ model: ChannelDestination, as: 'destinations_rows' }],
    }) as unknown as Array<{ id: string; name: string; user_id: string | null; system_key: string | null; destinations_rows?: Array<{ type: string; config: Record<string, unknown> }> }>;
    const me = username.toLowerCase();
    const via_of = new Map<string, string>();
    for (const c of channels) {
        if (c.user_id === user_id) via_of.set(c.id, 'sent to you');
        else if (c.system_key === 'org.in_app') via_of.set(c.id, 'All org members');
        else if (c.system_key === 'realm.members' || c.system_key === 'org.realm_members') via_of.set(c.id, 'All realm members');
        else if ((c.destinations_rows ?? []).some((d) => d.type === 'channel_ref' && String(d.config?.name ?? '').toLowerCase() === me)) via_of.set(c.id, `${c.name} names you`);
    }
    const by_event = new Map<string, Set<string>>();
    for (const r of rules) {
        const via = via_of.get(r.channel_id);
        if (!via) continue;
        by_event.set(r.event, (by_event.get(r.event) ?? new Set()).add(via));
    }
    return [...by_event.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([event, via]) => ({ event, via: [...via] }));
}
