/**
 * The getHugs reconcile (PLAN-gethugs-step2-provisioning.md, sub-step 3): read one org's cliqhub state, read its getHugs
 * state, make getHugs match. It is the only code that writes to getHugs, and every run is idempotent: a second run
 * with nothing changed makes no writes.
 *
 * Records are found by their external references (`external_source` `cliqhub`, `external_id` `<kind>:<id>`); getHugs
 * records without a cliqhub reference are left alone. A record getHugs refuses (a 4xx other than auth) is skipped
 * and reported, never blocking the rest (step 0's rule). Anything else — getHugs unreachable, the token refused, an
 * active org without its default realm — throws, and the worker tries again later.
 */

import { HugsError } from '@gethugs/client';
import { QueryTypes } from 'sequelize';

import { runs_viewers } from '../auth/route_policy/visible.js';
import type { Level } from '../auth/route_policy/policy.js';
import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';
import type { GethugsPartner } from './gethugs.service.js';
import { reconcile_templates } from './gethugs_templates.js';

const log = get_logger('gethugs_reconcile');

export const EXTERNAL_SOURCE = 'cliqhub';
type Kind = 'org' | 'user' | 'realm' | 'channel';
const ref = (kind: Kind, id: string) => `${kind}:${id}`;

/** A record getHugs refused, or that has no getHugs form: skipped, never blocking the rest. */
export interface Refusal {
    kind: Kind | 'destination' | 'template';
    cliq_id: string;
    reason: string;
    message?: string;
}

export interface ReconcileResult {
    /** The org in getHugs (null: not provisioned — waiting for its owner, or deleted and never mirrored). */
    gethugs_org_id: string | null;
    /** Every write made, as `<path> <cliq ref>` — empty when getHugs already matched. */
    writes: string[];
    report: Refusal[];
}

// ── getHugs shapes (only what the reconcile reads) ─────────────────────────────────────────────────────────────

type External = { source: string; id: string } | null;
interface HOrg { id: string; name: string; status: 'active' | 'suspended' | 'deleted'; version: number; external: External }
interface HUser { id: string; email: string; name: string | null; type: string; status: 'invited' | 'active' | 'deactivated'; role: { id: string; slug: string }; external: External }
interface HWorkspace { id: string; name: string; archived_at: number | null; external: External }
interface HMember { user_id: string; role: WorkspaceRole }
interface HChannel { id: string; workspace_id: string | null; name: string; enabled: boolean; scope: 'org' | 'workspace' | 'personal'; builtin: boolean; external: External }
interface HDestination { id: string; type: string; config: Record<string, unknown>; target: { id: string; personal_user_id: string | null } | null }
type WorkspaceRole = 'admin' | 'operator' | 'member';
type Page<T> = { items: T[]; next_cursor?: string | null };

// ── cliqhub state ──────────────────────────────────────────────────────────────────────────────────────────────

interface COrg { id: string; display_name: string; status: string; deleted_at: Date | null; owner_id: string | null }
interface CPerson { id: string; email: string; display_name: string | null; username: string | null; role_slug: string | null; is_system: boolean | null; legacy_role: string }
interface CRealm { id: string; slug: string; name: string }
interface CChannel { id: string; realm_id: string | null; name: string; enabled: number }
interface CDestination { channel_id: string; type: string; config: Record<string, unknown> }

/** The getHugs form of a cliq destination, with the key it is compared by (cliq recreates destinations on edit). */
type Desired =
    | { key: string; body: { type: 'email'; address: string } }
    | { key: string; body: { type: 'webhook' | 'slack'; url: string } }
    | { key: string; body: { type: 'channel'; channel_id: string } }
    | { key: string; body: { type: 'channel'; user_id: string } };

const LEVEL_ROLE: Record<Level, WorkspaceRole> = { admin: 'admin', operate: 'operator', view: 'member' };

async function rows<T extends object>(sql: string, replacements: Record<string, unknown>): Promise<T[]> {
    return get_sequelize().query<T>(sql, { replacements, type: QueryTypes.SELECT });
}

/** getHugs' org role for a cliq org member: owner → owner, admin → admin, anything else → member. */
function person_role(p: CPerson): 'owner' | 'admin' | 'member' {
    if (p.role_slug) return p.is_system || p.role_slug === 'owner' ? 'owner' : p.role_slug === 'admin' ? 'admin' : 'member';
    return p.legacy_role === 'admin' || p.legacy_role === 'owner' ? 'admin' : 'member';
}

const slack_hint = (url: string) => `hooks.slack.com/…${url.slice(-4)}`;

/** The key an existing getHugs destination is compared by. */
function actual_key(d: HDestination): string {
    if (d.type === 'channel') return d.target?.personal_user_id ? `person:${d.target.personal_user_id}` : `channel:${d.target?.id ?? ''}`;
    if (d.type === 'slack') return `slack:${String(d.config.url_hint ?? '')}`;
    if (d.type === 'email') return d.config.account ? 'email:account' : `email:${String(d.config.address ?? '').toLowerCase()}`;
    if (d.type === 'webhook') return `webhook:${String(d.config.url ?? '')}`;
    return `${d.type}:`;
}

const is_refusal = (err: unknown): err is HugsError =>
    err instanceof HugsError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 && err.status !== 429;

/** Reconciles one org. Throws when it can't finish (the worker retries); refusals are in the report. */
export async function gethugs_reconcile(org_id: string, partner: GethugsPartner): Promise<ReconcileResult> {
    const writes: string[] = [];
    const report: Refusal[] = [];
    const call = <T>(path: string, body: object, cliq_ref: string) => {
        writes.push(`${path} ${cliq_ref}`);
        return partner.site.call<T>(path, body);
    };
    const read = <T>(path: string, body: object) => partner.site.call<T>(path, body);
    async function all<T>(path: string, body: object): Promise<T[]> {
        const out: T[] = [];
        let cursor: string | null | undefined;
        do {
            const page = await read<Page<T>>(path, { ...body, limit: 100, ...(cursor ? { cursor } : {}) });
            out.push(...page.items);
            cursor = page.next_cursor;
        } while (cursor);
        return out;
    }
    /** Runs a write for one record; a refusal is reported and the reconcile goes on. */
    async function attempt<T>(kind: Refusal['kind'], cliq_id: string, fn: () => Promise<T>): Promise<T | null> {
        try {
            return await fn();
        } catch (err) {
            if (!is_refusal(err)) throw err;
            report.push({ kind, cliq_id, reason: err.code, message: err.message });
            log.warn('gethugs_refused', { org_id, kind, cliq_id, code: err.code });
            return null;
        }
    }

    // ── The org ──────────────────────────────────────────────────────────────────────────────────────────────
    const [org] = await rows<COrg>('SELECT id, display_name, status, deleted_at, owner_id FROM cliq.orgs WHERE id = :org_id', { org_id });
    if (!org) return { gethugs_org_id: null, writes, report };
    const found = (await read<Page<HOrg>>('site/get_orgs', { external_source: EXTERNAL_SOURCE, external_id: ref('org', org_id), limit: 1 })).items[0] ?? null;

    if (org.deleted_at || org.status === 'deleted') {
        if (found?.status === 'active') await call('site/suspend_org', { org_id: found.id, reason: 'Deleted in cliqhub' }, ref('org', org_id));
        return { gethugs_org_id: found?.id ?? null, writes, report };
    }
    if (org.status !== 'active') return { gethugs_org_id: found?.id ?? null, writes, report };

    const realms = await rows<CRealm>('SELECT id, slug, name FROM cliq.realms WHERE org_id = :org_id AND deleted = false ORDER BY created_at', { org_id });
    const people = await rows<CPerson>(
        `SELECT u.id, u.email, u.display_name, u.username, r.slug AS role_slug, r.is_system, m.role AS legacy_role
         FROM cliq.org_members m
         JOIN cliq.users u ON u.id = m.user_id
         LEFT JOIN cliq.org_roles r ON r.id = m.role_id
         WHERE m.org_id = :org_id AND m.status = 'active' AND m.deleted_at IS NULL
           AND u.deleted_at IS NULL AND u.suspended_at IS NULL AND u.status <> 'suspended'`,
        { org_id },
    );

    let h_org = found;
    if (!h_org) {
        const default_realm = realms.find((r) => r.slug === 'default');
        if (!default_realm) throw new Error(`org ${org_id} is active but has no default realm yet`);
        const [owner] = await rows<{ id: string; email: string; display_name: string | null }>(
            'SELECT id, email, display_name FROM cliq.users WHERE id = :id', { id: org.owner_id ?? '' },
        );
        if (!owner) throw new Error(`org ${org_id} has no owner to provision`);
        const made = await call<{ org: HOrg }>('site/create_org', {
            name: org.display_name,
            owner_email: owner.email,
            ...(owner.display_name ? { owner_name: owner.display_name } : {}),
            workspace_name: default_realm.name,
            send_invite: false,
            external_source: EXTERNAL_SOURCE, external_id: ref('org', org_id),
            owner_external_source: EXTERNAL_SOURCE, owner_external_id: ref('user', owner.id),
            workspace_external_source: EXTERNAL_SOURCE, workspace_external_id: ref('realm', default_realm.id),
        }, ref('org', org_id));
        h_org = made.org;
    } else {
        if (h_org.status === 'suspended') {
            h_org = await call<HOrg>('site/restore_org', { org_id: h_org.id, reason: 'Active in cliqhub' }, ref('org', org_id));
        }
        if (h_org.name !== org.display_name) {
            const current = h_org;
            h_org = (await attempt('org', org_id, () => call<HOrg>('site/update_org', { org_id: current.id, version: current.version, name: org.display_name }, ref('org', org_id)))) ?? h_org;
        }
    }
    const g_org = h_org.id;

    // ── People ───────────────────────────────────────────────────────────────────────────────────────────────
    const role_ids = new Map((await read<{ items: Array<{ id: string; slug: string }> }>('roles/get', { org_id: g_org })).items.map((r) => [r.slug, r.id]));
    const h_users = await all<HUser>('users/get', { org_id: g_org, type: 'person' });
    const by_ref = new Map<string, HUser>();
    for (const u of h_users) if (u.external?.source === EXTERNAL_SOURCE) by_ref.set(u.external.id, u);

    /** cliq user id → getHugs person id, for the people mirrored. */
    const person_of = new Map<string, string>();
    // New Owners first: getHugs keeps an org from losing its last Owner, so an ownership move promotes before it demotes.
    const ordered = [...people].sort((a, b) => Number(person_role(b) === 'owner') - Number(person_role(a) === 'owner'));
    for (const p of ordered) {
        const want_role = role_ids.get(person_role(p));
        const name = p.display_name?.trim() || null;
        const existing = by_ref.get(ref('user', p.id));
        if (!existing) {
            const made = await attempt('user', p.id, () => call<HUser>('users/create', {
                org_id: g_org, email: p.email, ...(name ? { name } : {}), ...(want_role ? { role_id: want_role } : {}), send_invite: false,
                external_source: EXTERNAL_SOURCE, external_id: ref('user', p.id),
            }, ref('user', p.id)));
            if (made) person_of.set(p.id, made.id);
            continue;
        }
        person_of.set(p.id, existing.id);
        if (existing.status === 'deactivated') {
            await attempt('user', p.id, () => call('users/reactivate', { org_id: g_org, user_id: existing.id }, ref('user', p.id)));
        }
        const patch: Record<string, unknown> = {};
        if (existing.email.toLowerCase() !== p.email.toLowerCase()) patch.email = p.email;
        if ((existing.name ?? null) !== name && name) patch.name = name;
        if (want_role && existing.role?.id !== want_role) patch.role_id = want_role;
        if (Object.keys(patch).length) {
            await attempt('user', p.id, () => call('users/update', { org_id: g_org, user_id: existing.id, ...patch }, ref('user', p.id)));
        }
    }
    const wanted_people = new Set(people.map((p) => ref('user', p.id)));
    for (const [r, u] of by_ref) {
        if (wanted_people.has(r) || u.status === 'deactivated' || !r.startsWith('user:')) continue;
        await attempt('user', r.slice(5), () => call('users/deactivate', { org_id: g_org, user_id: u.id }, r));
    }

    // ── Workspaces and their members ─────────────────────────────────────────────────────────────────────────
    const h_workspaces = await all<HWorkspace>('workspaces/get', { org_id: g_org });
    const ws_by_ref = new Map<string, HWorkspace>();
    for (const w of h_workspaces) if (w.external?.source === EXTERNAL_SOURCE) ws_by_ref.set(w.external.id, w);
    /** cliq realm id → getHugs workspace id. */
    const workspace_of = new Map<string, string>();
    for (const realm of realms) {
        const existing = ws_by_ref.get(ref('realm', realm.id));
        if (!existing) {
            const made = await attempt('realm', realm.id, () => call<HWorkspace>('workspaces/create', {
                org_id: g_org, name: realm.name, external_source: EXTERNAL_SOURCE, external_id: ref('realm', realm.id),
            }, ref('realm', realm.id)));
            if (made) workspace_of.set(realm.id, made.id);
            continue;
        }
        workspace_of.set(realm.id, existing.id);
        if (existing.name !== realm.name) {
            await attempt('realm', realm.id, () => call('workspaces/update', { org_id: g_org, workspace_id: existing.id, name: realm.name }, ref('realm', realm.id)));
        }
    }
    const wanted_realms = new Set(realms.map((r) => ref('realm', r.id)));
    for (const [r, w] of ws_by_ref) {
        if (wanted_realms.has(r) || !r.startsWith('realm:')) continue;
        await attempt('realm', r.slice(6), () => call('workspaces/delete', { org_id: g_org, workspace_id: w.id }, r));
    }

    const viewers = await runs_viewers(org_id);
    const mirrored_people = new Set(person_of.values());
    for (const [realm_id, ws] of workspace_of) {
        const want = new Map<string, WorkspaceRole>();
        for (const [user_id, level] of viewers.get(realm_id) ?? []) {
            const g_user = person_of.get(user_id);
            if (g_user) want.set(g_user, LEVEL_ROLE[level]);
        }
        const have = new Map((await read<{ items: HMember[] }>('workspaces/get_members', { org_id: g_org, workspace_id: ws })).items.map((m) => [m.user_id, m.role]));
        const add = [...want].filter(([u, role]) => have.get(u) !== role).map(([user_id, role]) => ({ user_id, role }));
        // Only people cliqhub mirrors are removed; anyone else in the workspace is getHugs' own.
        const remove = [...have.keys()].filter((u) => !want.has(u) && mirrored_people.has(u));
        for (let i = 0; i < add.length; i += 200) {
            const chunk = add.slice(i, i + 200);
            await attempt('realm', realm_id, () => call('workspaces/add_members', { org_id: g_org, workspace_id: ws, members: chunk }, ref('realm', realm_id)));
        }
        if (remove.length) {
            await attempt('realm', realm_id, () => call('workspaces/remove_members', { org_id: g_org, workspace_id: ws, user_ids: remove }, ref('realm', realm_id)));
        }
    }

    // ── Channels and their destinations ──────────────────────────────────────────────────────────────────────
    // Built-ins (getHugs has its own), personal channels (getHugs makes each person's) and Jira channels (run events
    // only) aren't mirrored.
    const channels = await rows<CChannel>(
        `SELECT id, realm_id, name, enabled FROM cliq.notification_channels
         WHERE system_key IS NULL AND user_id IS NULL AND name NOT LIKE 'jira-%'
           AND ((org_id = :org_id AND realm_id IS NULL) OR realm_id IN (SELECT id FROM cliq.realms WHERE org_id = :org_id AND deleted = false))
         ORDER BY created_at`,
        { org_id },
    );
    const h_channels: HChannel[] = [...await all<HChannel>('channels/get', { org_id: g_org })];
    for (const ws of workspace_of.values()) {
        h_channels.push(...(await all<HChannel>('channels/get', { org_id: g_org, workspace_id: ws })).filter((c) => c.workspace_id === ws));
    }
    const ch_by_ref = new Map<string, HChannel>();
    for (const c of h_channels) if (c.external?.source === EXTERNAL_SOURCE && c.scope !== 'personal') ch_by_ref.set(c.external.id, c);

    /** cliq channel id → getHugs channel id. */
    const channel_of = new Map<string, string>();
    for (const c of channels) {
        const ws = c.realm_id ? workspace_of.get(c.realm_id) : undefined;
        if (c.realm_id && !ws) continue; // its realm wasn't mirrored (reported there)
        const existing = ch_by_ref.get(ref('channel', c.id));
        const enabled = c.enabled === 1;
        if (!existing) {
            const made = await attempt('channel', c.id, () => call<HChannel>('channels/create', {
                org_id: g_org, ...(ws ? { workspace_id: ws } : {}), name: c.name,
                external_source: EXTERNAL_SOURCE, external_id: ref('channel', c.id),
            }, ref('channel', c.id)));
            if (!made) continue;
            channel_of.set(c.id, made.id);
            if (!enabled) await attempt('channel', c.id, () => call('channels/update', { org_id: g_org, ...(ws ? { workspace_id: ws } : {}), channel_id: made.id, enabled: false }, ref('channel', c.id)));
            continue;
        }
        channel_of.set(c.id, existing.id);
        const patch: Record<string, unknown> = {};
        if (existing.name !== c.name) patch.name = c.name;
        if (existing.enabled !== enabled) patch.enabled = enabled;
        if (Object.keys(patch).length) {
            await attempt('channel', c.id, () => call('channels/update', { org_id: g_org, ...(ws ? { workspace_id: ws } : {}), channel_id: existing.id, ...patch }, ref('channel', c.id)));
        }
    }
    const wanted_channels = new Set(channels.map((c) => ref('channel', c.id)));
    for (const [r, c] of ch_by_ref) {
        if (wanted_channels.has(r) || !r.startsWith('channel:')) continue;
        await attempt('channel', r.slice(8), () => call('channels/delete', { org_id: g_org, ...(c.workspace_id ? { workspace_id: c.workspace_id } : {}), channel_id: c.id }, r));
    }

    // Destinations, after every channel exists (a channel_ref names another channel).
    const dests = channels.length
        ? await rows<CDestination>('SELECT channel_id, type, config FROM cliq.channel_destinations WHERE channel_id IN (:ids) ORDER BY created_at, id', { ids: channels.map((c) => c.id) })
        : [];
    const by_username = new Map(people.filter((p) => p.username).map((p) => [p.username!.toLowerCase(), p.id]));
    for (const c of channels) {
        const g_channel = channel_of.get(c.id);
        if (!g_channel) continue;
        const ws = c.realm_id ? workspace_of.get(c.realm_id) : undefined;
        const desired = new Map<string, Desired['body']>();
        for (const d of dests.filter((x) => x.channel_id === c.id)) {
            for (const want of map_destination(d, c, channels, channel_of, by_username, person_of, viewers, report)) desired.set(want.key, want.body);
        }
        const have = (await read<{ items: HDestination[] }>('destinations/get', { org_id: g_org, ...(ws ? { workspace_id: ws } : {}), channel_id: g_channel })).items;
        const have_keys = new Set<string>();
        for (const h of have) {
            const key = actual_key(h);
            if (desired.has(key) && !have_keys.has(key)) { have_keys.add(key); continue; }
            await attempt('destination', c.id, () => call('destinations/delete', { org_id: g_org, ...(ws ? { workspace_id: ws } : {}), destination_id: h.id }, ref('channel', c.id)));
        }
        for (const [key, body] of desired) {
            if (have_keys.has(key)) continue;
            await attempt('destination', c.id, () => call('destinations/create', { org_id: g_org, ...(ws ? { workspace_id: ws } : {}), channel_id: g_channel, destination: body }, ref('channel', c.id)));
        }
    }

    // Team hugs as templates (PLAN-gethugs-step8-4-cliqd.md).
    await reconcile_templates({ org_id, g_org, call, read, attempt });

    await save_links(org_id, g_org, person_of, workspace_of, channel_of);
    log.info('gethugs_reconciled', { org_id, gethugs_org_id: g_org, writes: writes.length, refused: report.length });
    return { gethugs_org_id: g_org, writes, report };
}

/** The getHugs form of one cliq destination (several for an email with cc/bcc); what has none is reported. */
function map_destination(
    d: CDestination,
    channel: CChannel,
    channels: CChannel[],
    channel_of: Map<string, string>,
    by_username: Map<string, string>,
    person_of: Map<string, string>,
    viewers: Map<string, Map<string, Level>>,
    report: Refusal[],
): Desired[] {
    const cfg = d.config ?? {};
    const refuse = (reason: string, message?: string): Desired[] => { report.push({ kind: 'destination', cliq_id: channel.id, reason, ...(message ? { message } : {}) }); return []; };
    switch (d.type) {
        case 'email': {
            if (cfg.members) return refuse('members_email_not_mirrored', 'getHugs reaches workspace members through its built-in channels');
            if (cfg.account) return refuse('account_email_not_mirrored', 'Only personal channels send to the account address');
            const addresses = [cfg.address, cfg.to, cfg.cc, cfg.bcc]
                .flatMap((v) => (typeof v === 'string' ? v.split(/[,;\s]+/) : []))
                .map((a) => a.trim().toLowerCase())
                .filter(Boolean);
            if (!addresses.length) return refuse('email_without_address');
            return [...new Set(addresses)].map((address) => ({ key: `email:${address}`, body: { type: 'email', address } }));
        }
        case 'slack': {
            const url = String(cfg.webhook_url ?? cfg.url ?? '');
            return [{ key: `slack:${slack_hint(url)}`, body: { type: 'slack', url } }];
        }
        case 'webhook':
        case 'http': {
            const url = String(cfg.url ?? '');
            if (cfg.headers && Object.keys(cfg.headers as object).length) report.push({ kind: 'destination', cliq_id: channel.id, reason: 'headers_not_mirrored', message: url });
            return [{ key: `webhook:${url}`, body: { type: 'webhook', url } }];
        }
        case 'channel_ref': {
            // As cliq resolves it: the realm's channel of that name, else the org's; and the person of that name.
            const name = String(cfg.name ?? '');
            const out: Desired[] = [];
            const target = (channel.realm_id ? channels.find((c) => c.realm_id === channel.realm_id && c.name === name) : undefined)
                ?? channels.find((c) => c.realm_id === null && c.name === name);
            const g_target = target && target.id !== channel.id ? channel_of.get(target.id) : undefined;
            if (g_target) out.push({ key: `channel:${g_target}`, body: { type: 'channel', channel_id: g_target } });
            const user = by_username.get(name.toLowerCase());
            const g_user = user ? person_of.get(user) : undefined;
            // A workspace channel reaches only the workspace's members.
            const in_realm = !channel.realm_id || Boolean(user && viewers.get(channel.realm_id)?.has(user));
            if (g_user && in_realm) out.push({ key: `person:${g_user}`, body: { type: 'channel', user_id: g_user } });
            return out.length ? out : refuse('channel_ref_not_found', name);
        }
        case 'cliqhub':
            return refuse('in_app_not_mirrored', 'getHugs has in-app only on personal channels; people get Hugs in their inbox');
        default:
            return refuse('unknown_destination_type', d.type);
    }
}

/** Replaces the org's links with what this reconcile found. */
async function save_links(org_id: string, g_org: string, people: Map<string, string>, realms: Map<string, string>, channels: Map<string, string>): Promise<void> {
    const values: Array<[Kind, string, string]> = [
        ['org', org_id, g_org],
        ...[...people].map(([c, g]) => ['user', c, g] as [Kind, string, string]),
        ...[...realms].map(([c, g]) => ['realm', c, g] as [Kind, string, string]),
        ...[...channels].map(([c, g]) => ['channel', c, g] as [Kind, string, string]),
    ];
    await get_sequelize().transaction(async (t) => {
        await get_sequelize().query('DELETE FROM cliq.gethugs_links WHERE org_id = :org_id', { replacements: { org_id }, transaction: t });
        for (let i = 0; i < values.length; i += 500) {
            const chunk = values.slice(i, i + 500);
            const replacements: Record<string, string> = { org_id };
            const tuples = chunk.map(([kind, cliq_id, gethugs_id], j) => {
                replacements[`k${j}`] = kind; replacements[`c${j}`] = cliq_id; replacements[`g${j}`] = gethugs_id;
                return `(:org_id, :k${j}, :c${j}, :g${j})`;
            });
            await get_sequelize().query(`INSERT INTO cliq.gethugs_links (org_id, kind, cliq_id, gethugs_id) VALUES ${tuples.join(', ')}`, { replacements, transaction: t });
        }
    });
}
