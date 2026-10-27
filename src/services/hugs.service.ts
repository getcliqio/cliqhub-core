/**
 * Hugs — Core's side of the one protocol for asking people (PLAN-hug-requests §6).
 *
 * Core stores a Hug, resolves its channels and notifies the people they reach, authorizes and
 * validates their responses, keeps the requester's event stream (numbered per Hug) and delivers
 * each event to the daemon that opened it, expires Hugs and sends their reminders. It never
 * interprets a value: what a response means, and when the requester has heard enough, is the
 * requester's business.
 */

import { randomUUID } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import {
    HugSpecSchema,
    validate_values,
    type FileValue,
    type RequestedInput,
} from '@getcliqio/cliq-sdk';

import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { get_sequelize } from '../db/sequelize.js';
import { Hug, HugDelivery, HugEventRow, HugResponse, Realm, StoredArtifact, User } from '../models/index.js';
import type { HugNotSentTo } from '../models/hug.model.js';
import type { HugEventType } from '../models/hug.model.js';
import { visible_realm_ids } from '../auth/route_policy/visible.js';
import { no_channel_message, raise_unknown_channel } from '../notifications/unknown_channel.js';
import { raise_no_access } from '../notifications/no_access.js';
import { people_reached, resolve_channels, type ChannelDestination } from './channel_resolution.service.js';
import { load_realm_info_map, load_run_info_map, resolve_team } from './hug_enrichment.js';
import { EventSubmitService, type SubmittedEvent } from './events_service.js';

const log = get_logger('svc.hugs');

/** How long past expiry Core keeps retrying delivery of a Hug's last events (§9). */
const DELIVERY_GRACE_MS = 60 * 60 * 1000;

/** How long a Hug's events are kept after it ends (§9.3); the command outbox keeps deliveries as long. */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Input to {@link HugsService.create} (the route checked the run, realm and daemon). */
export interface CreateHugInput {
    /** Daemon-minted id (§9): a retried create adopts it instead of opening a second Hug. */
    hug_id?: string;
    run_id: string;
    daemon_id: string;
    realm_id: string;
    phase: string;
    iteration: number;
    /** The agent's HugSpec, validated here (it comes from the daemon unchanged). */
    spec: unknown;
    actor_id: string | null;
}

/** One response as Core returns it. */
export interface HugResponseData {
    response_id: string;
    responder: { user_id: string; name: string };
    via: string[];
    values: Record<string, unknown>;
    comment: string | null;
    responded_at: string;
}

/** A Hug as Core returns it (detail). */
export interface HugData {
    id: string;
    hug_url: string;
    run_id: string;
    run_name: string | null;
    team: string | null;
    phase: string;
    iteration: number;
    realm_id: string;
    realm_name: string | null;
    realm_slug: string | null;
    org_slug: string | null;
    daemon_id: string;
    title: string;
    prompt: string;
    context: unknown[];
    requested_inputs: unknown[];
    channels: string[];
    ui: Record<string, unknown> | null;
    status: string;
    outcome: string | null;
    expires_at: string;
    created_at: string;
    closed_at: string | null;
    last_reminded_at: string | null;
    /** People its channels reach who may not see it, so it wasn't sent to them (name and channel). */
    not_sent_to: Array<{ name: string; channel: string }>;
    responses: HugResponseData[];
}

/** One event of a Hug's requester stream. */
export interface HugEventData {
    hug_id: string;
    seq: number;
    type: HugEventType;
    payload: Record<string, unknown>;
}

/** The Hub page for a Hug. */
export function hug_url_for(hug_id: string): string {
    const base = (process.env.PUBLIC_APP_URL || process.env.CLIQHUB_PUBLIC_URL || 'https://cliqhub.io').replace(/\/+$/, '');
    return `${base}/hugs/${hug_id}`;
}

/** Whether `user_id` has `runs.view` on `realm_id` (the route policy's rule). */
async function can_view_runs(user_id: string, realm_id: string): Promise<boolean> {
    return (await visible_realm_ids(user_id, { perm: 'runs.view' })).includes(realm_id);
}

/** Those of `user_ids` with `runs.view` on `realm_id`. */
async function users_with_runs_view(user_ids: readonly string[], realm_id: string): Promise<string[]> {
    const out: string[] = [];
    for (const id of user_ids) if (await can_view_runs(id, realm_id)) out.push(id);
    return out;
}

/** Core's side of the Hug protocol. */
export class HugsService {
    /**
     * Open a Hug: validate it, resolve its channels (unknown names raise Unknown channel; none left →
     * 422), store it with one delivery row per destination, and notify those channels directly.
     */
    static async create(input: CreateHugInput): Promise<{ hug_id: string; hug_url: string }> {
        const parsed = HugSpecSchema.safeParse(input.spec);
        if (!parsed.success) {
            throw ApiError.unprocessable(`Invalid Hug: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('; ')}`, 'invalid_hug');
        }
        const spec = parsed.data;
        if (spec.expires_in_min === undefined) throw ApiError.unprocessable('expires_in_min is required — every Hug expires', 'invalid_hug');

        if (input.hug_id) {
            const existing = await Hug.findByPk(input.hug_id, { attributes: ['id', 'run_id'], raw: true });
            if (existing) {
                if (existing.run_id !== input.run_id) throw ApiError.conflict('Hug id is already used by another run');
                return { hug_id: existing.id, hug_url: hug_url_for(existing.id) };
            }
        }

        const realm = await Realm.findByPk(input.realm_id, { attributes: ['org_id'], raw: true });
        if (!realm?.org_id) throw ApiError.not_found('Realm not found');
        const org_id = String(realm.org_id);

        await HugsService._check_context_artifacts(spec.context ?? [], input.run_id);

        const channels = [...new Set((spec.channels ?? []).map((c) => c.trim()).filter(Boolean))];
        const raise = (name: string | null) => raise_unknown_channel({
            realm_id: input.realm_id, name, source: 'reviewers', for_event: 'hug.opened',
            run_id: input.run_id, phase: input.phase, daemon_id: input.daemon_id,
        });
        if (channels.length === 0) {
            await raise(null);
            throw ApiError.unprocessable(no_channel_message(input.phase), 'invalid_params');
        }
        const resolved = await resolve_channels(org_id, channels, input.realm_id);
        for (const name of resolved.unresolved) await raise(name);
        if (resolved.destinations.length === 0) {
            throw ApiError.unprocessable(
                `Hug sent to unknown channel ${resolved.unresolved.map((c) => `'${c}'`).join(', ')} — no channel with that name in this realm or its org`,
                'invalid_params',
            );
        }
        const not_sent_to = await HugsService._not_sent_to(resolved.destinations, input.realm_id);

        const id = input.hug_id ?? randomUUID();
        const now = new Date();
        const expires_at = new Date(now.getTime() + spec.expires_in_min * 60_000);
        const reminders = spec.reminders ?? null;
        await get_sequelize().transaction(async (t) => {
            await Hug.create({
                id,
                run_id: input.run_id,
                phase: input.phase,
                iteration: input.iteration,
                daemon_id: input.daemon_id,
                realm_id: input.realm_id,
                org_id,
                title: spec.title,
                prompt: spec.prompt,
                context: spec.context ?? [],
                requested_inputs: spec.requested_inputs,
                channels,
                ui: spec.ui ?? null,
                status: 'open',
                outcome: null,
                expires_at,
                reminders,
                next_remind_at: next_remind_at(now, reminders, null, expires_at),
                last_reminded_at: null,
                last_seq: 0,
                created_at: now,
                closed_at: null,
                not_sent_to: not_sent_to.length > 0 ? not_sent_to : null,
            }, { transaction: t });
            await HugDelivery.bulkCreate(resolved.destinations.map((d) => ({
                id: randomUUID(), hug_id: id, channel: d.channel, channel_id: d.channel_id, user_id: d.user_id, created_at: now,
            })), { transaction: t });
        });

        const hug_url = hug_url_for(id);
        await HugsService._notify_opened({
            hug_id: id, hug_url, realm_id: input.realm_id, org_id, run_id: input.run_id, phase: input.phase,
            daemon_id: input.daemon_id, title: spec.title, actor_id: input.actor_id,
            channel_ids: [...new Set(resolved.destinations.map((d) => d.channel_id))],
        });
        for (const p of not_sent_to) {
            await raise_no_access({
                realm_id: input.realm_id, channel: p.channel, person: { user_id: p.user_id, name: p.name }, for_event: 'hug.opened',
                run_id: input.run_id, phase: input.phase, daemon_id: input.daemon_id,
            });
        }
        log.info('hug_opened', { hug_id: id, run_id: input.run_id, phase: input.phase, destinations: resolved.destinations.length, not_sent_to: not_sent_to.length });
        return { hug_id: id, hug_url };
    }

    /**
     * The people a Hug's channels reach — transitively ({@link people_reached}) — who may not see it
     * (no `runs.view` on its realm). Channels carry no permissions; the fan-out leaves these people out
     * (notifications/event_access.ts), and the Hug records them so its page and admins can see who
     * wasn't asked. People behind Slack, plain email addresses and webhooks can't be named.
     *
     * @throws ApiError 422 `no_one_can_answer` when nobody it reaches could answer: every person it
     *   names lacks access and it reaches no one Core can't name.
     */
    private static async _not_sent_to(destinations: readonly ChannelDestination[], realm_id: string): Promise<HugNotSentTo[]> {
        const { people, external } = await people_reached(destinations, realm_id);
        const allowed = new Set(await users_with_runs_view([...people.keys()], realm_id));
        const denied = [...people].filter(([user_id]) => !allowed.has(user_id));
        const names = denied.length === 0 ? new Map<string, string>() : new Map((await User.findAll({
            where: { id: { [Op.in]: denied.map(([id]) => id) } }, attributes: ['id', 'username', 'display_name'], raw: true,
        })).map((u) => [String(u.id), u.username || u.display_name || String(u.id)]));
        const not_sent_to = denied.map(([user_id, channel]) => ({ user_id, name: names.get(user_id) ?? user_id, channel }));
        if (allowed.size === 0 && !external && not_sent_to.length > 0) {
            const who = not_sent_to.slice(0, 5).map((p) => `${p.name} (via '${p.channel}')`).join(', ');
            throw ApiError.unprocessable(
                `Hug refused: nobody it reaches can view runs in this realm — ${who}${not_sent_to.length > 5 ? ` and ${not_sent_to.length - 5} more` : ''}. Give them a role with runs.view, or change the channels.`,
                'no_one_can_answer',
            );
        }
        return not_sent_to;
    }

    /** One Hug with its responses. */
    static async get(hug_id: string): Promise<HugData> {
        const hug = await Hug.findByPk(hug_id);
        if (!hug) throw ApiError.not_found('Hug not found');
        const [runs, realms, responses] = await Promise.all([
            load_run_info_map([hug.run_id]),
            load_realm_info_map([hug.realm_id]),
            HugsService._responses(hug.id),
        ]);
        const run = runs.get(hug.run_id);
        const realm = realms.get(hug.realm_id);
        return {
            id: hug.id,
            hug_url: hug_url_for(hug.id),
            run_id: hug.run_id,
            run_name: run?.run_name ?? null,
            team: resolve_team(run),
            phase: hug.phase,
            iteration: hug.iteration,
            realm_id: hug.realm_id,
            realm_name: realm?.realm_name ?? null,
            realm_slug: realm?.realm_slug ?? null,
            org_slug: realm?.org_slug ?? null,
            daemon_id: hug.daemon_id,
            title: hug.title,
            prompt: hug.prompt,
            context: hug.context,
            requested_inputs: hug.requested_inputs,
            channels: hug.channels,
            ui: hug.ui,
            status: hug.status,
            outcome: hug.outcome,
            expires_at: hug.expires_at.toISOString(),
            created_at: hug.created_at.toISOString(),
            closed_at: hug.closed_at ? hug.closed_at.toISOString() : null,
            last_reminded_at: hug.last_reminded_at ? hug.last_reminded_at.toISOString() : null,
            not_sent_to: (hug.not_sent_to ?? []).map((p) => ({ name: p.name, channel: p.channel })),
            responses,
        };
    }

    /**
     * The Hug's channels addressed to `user_id`: their own channel and its shared channels. Empty
     * when it wasn't addressed to them, or they lack `runs.view` on its realm (a Hug is seen like
     * its run; being asked grants nothing).
     */
    static async channels_reaching(hug: Pick<Hug, 'id' | 'realm_id'>, user_id: string): Promise<string[]> {
        if (!(await can_view_runs(user_id, hug.realm_id))) return [];
        const rows = await HugDelivery.findAll({ where: { hug_id: hug.id }, attributes: ['channel', 'user_id'], raw: true });
        return [...new Set(rows.filter((r) => r.user_id === null || r.user_id === user_id).map((r) => r.channel))];
    }

    /**
     * Submit or replace a person's response. The Hug must be open and not past `expires_at` (410
     * even when the sweep hasn't run yet); the person must have been reached through its channels;
     * the values must satisfy its requested inputs. File values must be this person's uploads for
     * this Hug and input. The response, its `response` event and the delivery to the daemon are
     * written in one transaction that holds the Hug's row, so a `close` or expiry can't slip in
     * between the check and the write, and no response is stored without its delivery.
     */
    static async respond(input: {
        hug_id: string;
        user_id: string;
        values: unknown;
        comment?: string;
    }): Promise<{ response_id: string; seq: number }> {
        const hug = await Hug.findByPk(input.hug_id);
        if (!hug) throw ApiError.not_found('Hug not found');
        assert_answerable(hug);

        const via = await HugsService.channels_reaching(hug, input.user_id);
        if (via.length === 0) throw ApiError.forbidden('This Hug was not sent to you, or you cannot view runs in its realm');

        const inputs = hug.requested_inputs as RequestedInput[];
        const checked = validate_values(inputs, input.values);
        if (!checked.ok) throw ApiError.unprocessable(checked.problems.join('; '), 'invalid_values');
        const values = { ...checked.value };

        const response = await get_sequelize().transaction(async (t) => {
            const locked = await Hug.findByPk(hug.id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!locked) throw ApiError.not_found('Hug not found');
            assert_answerable(locked);
            await HugsService._attach_files(hug, inputs, values, input.user_id, t);
            const seq = await append_seq(hug.id, t);
            const now = new Date();
            const existing = await HugResponse.findOne({ where: { hug_id: hug.id, responder_user_id: input.user_id }, transaction: t });
            const row = existing
                ? await existing.update({ via_channels: via, values, comment: input.comment ?? null, seq, updated_at: now }, { transaction: t })
                : await HugResponse.create({
                    id: randomUUID(), hug_id: hug.id, responder_user_id: input.user_id, via_channels: via, values,
                    comment: input.comment ?? null, seq, created_at: now, updated_at: now,
                }, { transaction: t });
            const data = await response_data(row);
            await HugEventRow.create({ hug_id: hug.id, seq, type: 'response', payload: { response: data }, created_at: now }, { transaction: t });
            await HugsService._deliver(hug, { hug_id: hug.id, seq, type: 'response', payload: { response: data } }, t);
            return { row, data, seq };
        });

        await HugsService._notify(hug, 'hug.responded', { responder: response.data.responder.name });
        log.info('hug_responded', { hug_id: hug.id, seq: response.seq, responder: input.user_id });
        return { response_id: response.row.id, seq: response.seq };
    }

    /**
     * The requester closes the Hug with its outcome; later responses are refused. Idempotent. Only
     * the daemon that opened it may close it (403 otherwise).
     */
    static async close(input: { hug_id: string; outcome: string; daemon_id: string }): Promise<{ status: string }> {
        const owner = await Hug.findByPk(input.hug_id, { attributes: ['daemon_id'], raw: true });
        if (!owner) throw ApiError.not_found('Hug not found');
        if (owner.daemon_id !== input.daemon_id) throw ApiError.forbidden('Only the daemon that opened this Hug may close it');
        const [count] = await Hug.update(
            { status: 'closed', outcome: input.outcome, closed_at: new Date(), next_remind_at: null },
            { where: { id: input.hug_id, status: 'open' } },
        );
        const hug = await Hug.findByPk(input.hug_id);
        if (!hug) throw ApiError.not_found('Hug not found');
        if (count > 0) {
            await HugsService._notify(hug, 'hug.closed', { outcome: input.outcome });
            log.info('hug_closed', { hug_id: hug.id });
        }
        return { status: hug.status };
    }

    /**
     * Catch-up for a daemon (§9.4): its Hugs' events after each cursor (up to 500 per call), and
     * each Hug's status — read from the Hug itself, so an ended Hug whose events were cleaned up
     * still reports how it ended.
     */
    static async get_events(input: {
        daemon_id: string;
        cursors: Array<{ hug_id: string; after_seq: number }>;
    }): Promise<{ events: HugEventData[]; hugs: Array<{ hug_id: string; status: string; last_seq: number }>; has_more: boolean }> {
        const ids = [...new Set(input.cursors.map((c) => c.hug_id))];
        if (ids.length === 0) return { events: [], hugs: [], has_more: false };
        const hugs = await Hug.findAll({ where: { id: { [Op.in]: ids }, daemon_id: input.daemon_id }, attributes: ['id', 'status', 'last_seq'], raw: true });
        const own = new Set(hugs.map((h) => h.id));
        const after = new Map(input.cursors.map((c) => [c.hug_id, c.after_seq]));
        const LIMIT = 500;
        const rows = own.size === 0 ? [] : await HugEventRow.findAll({
            where: { [Op.or]: [...own].map((id) => ({ hug_id: id, seq: { [Op.gt]: after.get(id) ?? 0 } })) },
            order: [['hug_id', 'ASC'], ['seq', 'ASC']],
            limit: LIMIT + 1,
            raw: true,
        });
        return {
            events: rows.slice(0, LIMIT).map((r) => ({ hug_id: r.hug_id, seq: r.seq, type: r.type, payload: r.payload })),
            hugs: hugs.map((h) => ({ hug_id: h.id, status: h.status, last_seq: h.last_seq })),
            has_more: rows.length > LIMIT,
        };
    }

    /** A run ended (any reason): its open Hugs are cancelled and the requester is told (§6.2). */
    static async cancel_for_run(run_id: string): Promise<number> {
        const open = await Hug.findAll({ where: { run_id, status: 'open' } });
        for (const hug of open) await HugsService._end(hug, 'cancelled');
        return open.length;
    }

    /** Sweep: expire open Hugs past `expires_at`, telling each requester. */
    static async expire_due(now = new Date()): Promise<number> {
        const due = await Hug.findAll({ where: { status: 'open', expires_at: { [Op.lte]: now } }, limit: 100 });
        for (const hug of due) await HugsService._end(hug, 'expired');
        return due.length;
    }

    /**
     * Sweep: send due reminders (§6.7) to the channels whose people haven't responded, then schedule
     * the next. Reminders go to people only — never to the requester.
     */
    static async remind_due(now = new Date()): Promise<number> {
        const due = await Hug.findAll({ where: { status: 'open', next_remind_at: { [Op.lte]: now }, expires_at: { [Op.gt]: now } }, limit: 100 });
        for (const hug of due) {
            try {
                const channel_ids = await HugsService._unanswered_channel_ids(hug);
                if (channel_ids.length > 0) await HugsService._notify(hug, 'hug.reminded', {}, channel_ids);
                await hug.update({ last_reminded_at: now, next_remind_at: next_remind_at(hug.created_at, hug.reminders, now, hug.expires_at) });
            } catch (err) {
                log.error('hug_remind_failed', { hug_id: hug.id, error: err instanceof Error ? err.message : String(err) });
            }
        }
        return due.length;
    }

    /**
     * Delete the events of Hugs that ended more than 7 days ago (§9.3). The Hug row stays, so a
     * daemon catching up later still learns how it ended (§9.4).
     *
     * @returns how many events were deleted
     */
    static async delete_old_events(now = new Date()): Promise<number> {
        const before = new Date(now.getTime() - EVENT_RETENTION_MS);
        const ended = await Hug.findAll({
            where: { status: { [Op.ne]: 'open' }, closed_at: { [Op.lt]: before } },
            attributes: ['id'],
            raw: true,
        });
        if (ended.length === 0) return 0;
        const deleted = await HugEventRow.destroy({ where: { hug_id: { [Op.in]: ended.map((h) => h.id) } } });
        if (deleted > 0) log.info('hug_events_deleted', { hugs: ended.length, events: deleted });
        return deleted;
    }

    // ── internals ───────────────────────────────────────────────────

    /** End an open Hug as expired or cancelled: status, an event for the requester, a notice for people. */
    private static async _end(hug: Hug, how: 'expired' | 'cancelled'): Promise<void> {
        try {
            const ended = await get_sequelize().transaction(async (t) => {
                const [count] = await Hug.update({ status: how, closed_at: new Date(), next_remind_at: null }, { where: { id: hug.id, status: 'open' }, transaction: t });
                if (count === 0) return null;
                const seq = await append_seq(hug.id, t);
                await HugEventRow.create({ hug_id: hug.id, seq, type: how, payload: {}, created_at: new Date() }, { transaction: t });
                await HugsService._deliver(hug, { hug_id: hug.id, seq, type: how, payload: {} }, t);
                return seq;
            });
            if (ended === null) return;
            if (how === 'expired') await HugsService._notify(hug, 'hug.expired', {});
            log.info(`hug_${how}`, { hug_id: hug.id, run_id: hug.run_id });
        } catch (err) {
            log.error('hug_end_failed', { hug_id: hug.id, how, error: err instanceof Error ? err.message : String(err) });
        }
    }

    /**
     * Queue one event for the daemon that opened the Hug, in the transaction that wrote it (§9), and
     * retry it until shortly after the Hug expires.
     */
    private static async _deliver(hug: Hug, event: HugEventData, transaction: Transaction): Promise<void> {
        const { command_outbox_enqueue } = await import('./command_outbox.service.js');
        await command_outbox_enqueue(hug.daemon_id, '/v1/hugs/deliver', { ...event, run_id: hug.run_id }, {
            deliver_until: Math.max(hug.expires_at.getTime(), Date.now()) + DELIVERY_GRACE_MS,
            transaction,
        });
    }

    /** A notification event to the Hug's channels (or the given ones). Best effort. */
    private static async _notify(hug: Hug, type: 'hug.responded' | 'hug.closed' | 'hug.expired' | 'hug.reminded', extra: Record<string, unknown>, channel_ids?: string[]): Promise<void> {
        try {
            const ids = channel_ids ?? [...new Set((await HugDelivery.findAll({ where: { hug_id: hug.id }, attributes: ['channel_id'], raw: true })).map((d) => d.channel_id))];
            await EventSubmitService.submit({
                type,
                realm_id: hug.realm_id,
                run_id: hug.run_id,
                phase: hug.phase,
                daemon_id: hug.daemon_id,
                payload: { hug_id: hug.id, hug_url: hug_url_for(hug.id), title: hug.title, ...extra },
                target_channels: ids,
            });
        } catch (err) {
            log.error('hug_notify_failed', { hug_id: hug.id, type, error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** Post the new Hug straight to its channels — not an event, so no rule can match it (B4.5). */
    private static async _notify_opened(input: {
        hug_id: string; hug_url: string; realm_id: string; org_id: string; run_id: string; phase: string;
        daemon_id: string; title: string; actor_id: string | null; channel_ids: string[];
    }): Promise<void> {
        try {
            const { NotificationFanOutService } = await import('../notifications/fan_out.service.js');
            const now = new Date();
            await NotificationFanOutService.deliver_to_channels(input.channel_ids, {
                id: randomUUID(),
                type: 'hug.opened',
                occurred_at: now.toISOString(),
                realm_id: input.realm_id,
                org_id: input.org_id,
                run_id: input.run_id,
                phase: input.phase,
                daemon_id: input.daemon_id,
                title: input.title,
                message: `Your input is needed for a run. Open: ${input.hug_url}`,
                severity: 'info',
                payload: { hug_id: input.hug_id, hug_url: input.hug_url },
                actor_id: input.actor_id,
                created_at: now.getTime(),
                notifications: 'deferred',
            } as unknown as SubmittedEvent);
        } catch (err) {
            log.error('hug_open_delivery_failed', { hug_id: input.hug_id, error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** Responses with their responders' names, oldest first. */
    private static async _responses(hug_id: string): Promise<HugResponseData[]> {
        const rows = await HugResponse.findAll({ where: { hug_id }, order: [['created_at', 'ASC']] });
        return Promise.all(rows.map(response_data));
    }

    /** Every `artifact` context block must name a ready stored artifact of this run (§6.5). */
    private static async _check_context_artifacts(context: ReadonlyArray<{ type: string; artifact_id?: string }>, run_id: string): Promise<void> {
        const ids = [...new Set(context.filter((b) => b.type === 'artifact').map((b) => b.artifact_id!))];
        if (ids.length === 0) return;
        const found = await StoredArtifact.findAll({ where: { id: { [Op.in]: ids }, run_id, status: 'ready' }, attributes: ['id'], raw: true });
        const missing = ids.filter((id) => !found.some((f) => f.id === id));
        if (missing.length > 0) throw ApiError.unprocessable(`Context artifact not found in this run: ${missing.join(', ')}`, 'invalid_hug');
    }

    /**
     * Turn each file input's `{ artifact_id }` references into full file values, checking they are
     * this person's uploads for this Hug and input (and still within the input's limits), and mark
     * them ready (§6.6.3).
     */
    private static async _attach_files(hug: Hug, inputs: RequestedInput[], values: Record<string, unknown>, user_id: string, t: Transaction): Promise<void> {
        for (const input of inputs) {
            if (input.type !== 'file' || values[input.name] === undefined || values[input.name] === null) continue;
            const refs = (input.multiple ? values[input.name] : [values[input.name]]) as Array<{ artifact_id: string }>;
            const ids = refs.map((r) => r.artifact_id);
            const rows = await StoredArtifact.findAll({ where: { id: { [Op.in]: ids } }, transaction: t });
            const files: FileValue[] = ids.map((id) => {
                const row = rows.find((r) => r.id === id);
                if (!row || row.hug_id !== hug.id || row.hug_requested_input !== input.name || row.uploaded_by !== user_id) {
                    throw ApiError.unprocessable(`${input.name}: file ${id} was not uploaded by you for this input`, 'HUG_FILE_INVALID');
                }
                if (input.max_bytes !== undefined && Number(row.size_bytes) > input.max_bytes) {
                    throw ApiError.unprocessable(`${input.name}: ${row.name} is larger than ${input.max_bytes} bytes`, 'HUG_FILE_INVALID');
                }
                return { artifact_id: row.id, name: row.name, size: Number(row.size_bytes), content_type: row.mime_type, sha256: row.sha256 ?? '' };
            });
            await StoredArtifact.update({ status: 'ready' }, { where: { id: { [Op.in]: ids } }, transaction: t });
            values[input.name] = input.multiple ? files : files[0];
        }
    }

    /** Channel ids to remind: personal channels of people who haven't responded, and shared channels nobody has answered through. */
    private static async _unanswered_channel_ids(hug: Hug): Promise<string[]> {
        const [deliveries, responses] = await Promise.all([
            HugDelivery.findAll({ where: { hug_id: hug.id }, raw: true }),
            HugResponse.findAll({ where: { hug_id: hug.id }, attributes: ['responder_user_id', 'via_channels'], raw: true }),
        ]);
        const responded = new Set(responses.map((r) => r.responder_user_id));
        const answered_channels = new Set(responses.flatMap((r) => r.via_channels));
        return [...new Set(deliveries
            .filter((d) => (d.user_id ? !responded.has(d.user_id) : !answered_channels.has(d.channel)))
            .map((d) => d.channel_id))];
    }
}

/** 404/409/410 unless the Hug can still take a response — the clock counts, not just the status. */
export function assert_answerable(hug: Pick<Hug, 'status' | 'expires_at'>, now = new Date()): void {
    if (hug.status === 'expired' || (hug.status === 'open' && hug.expires_at.getTime() <= now.getTime())) {
        throw ApiError.gone('This Hug has expired', 'HUG_EXPIRED');
    }
    if (hug.status !== 'open') throw ApiError.conflict(`This Hug is ${hug.status}`, 'HUG_CLOSED');
}

/**
 * When the next reminder is due (§6.7): the earliest `at_min` nudge, or `every_min` tick, after the
 * last reminder (or the opening). Null when there is none before the Hug expires.
 */
export function next_remind_at(
    created_at: Date,
    reminders: { every_min?: number; at_min?: number[] } | null,
    last_reminded_at: Date | null,
    expires_at: Date,
): Date | null {
    if (!reminders) return null;
    const since = (last_reminded_at ?? created_at).getTime();
    const candidates = (reminders.at_min ?? []).map((m) => created_at.getTime() + m * 60_000).filter((at) => at > since);
    if (reminders.every_min) candidates.push(since + reminders.every_min * 60_000);
    const next = candidates.length > 0 ? Math.min(...candidates) : null;
    return next !== null && next < expires_at.getTime() ? new Date(next) : null;
}

/** Allocate the Hug's next event number (in the caller's transaction). */
async function append_seq(hug_id: string, t: Transaction): Promise<number> {
    await Hug.increment('last_seq', { by: 1, where: { id: hug_id }, transaction: t });
    const row = await Hug.findByPk(hug_id, { attributes: ['last_seq'], transaction: t, raw: true });
    return Number(row!.last_seq);
}

/** A response row as the API and the requester see it. */
async function response_data(row: HugResponse): Promise<HugResponseData> {
    const user = await User.findByPk(row.responder_user_id, { attributes: ['username', 'display_name'], raw: true });
    return {
        response_id: row.id,
        responder: { user_id: row.responder_user_id, name: user?.display_name?.trim() || user?.username || row.responder_user_id },
        via: row.via_channels,
        values: row.values,
        comment: row.comment,
        responded_at: row.updated_at.toISOString(),
    };
}
