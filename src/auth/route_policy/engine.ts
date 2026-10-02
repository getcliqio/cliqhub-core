/**
 * Route policy engine — decides one request against its policy.
 *
 * Pure decision logic over an {@link AccessStore}, so it can be unit-tested
 * without a database. `enforce_route_policy` wires it to Express.
 *
 * Realm level (decisions of Sep 30):
 *   - site admin (user token)                → admin everywhere
 *   - owner or admin of the realm's org      → admin on every realm in that org
 *   - realm owner                            → admin
 *   - realm member role                      → member=view, operator=operate, admin=admin
 *   - daemon token                           → its own realm only (read / write rules)
 * Org permission: when the policy names one, an org member must also hold it
 * (the realm role is the ceiling, the org role grants the permission). A realm
 * member who is not in the org (a guest) is judged on the realm role alone.
 */

import type { AuthContext } from '../../schemas/auth_types.js';
import { can_view_team, type TeamAccess } from '../access.js';
import {
    LEVEL_RANK,
    type FieldRef,
    type Level,
    type Policy,
    type RecordKind,
} from './policy.js';

export interface OrgRoleInfo {
    slug: string;
    is_system: boolean;
    permissions: string[];
}

export interface RealmInfo {
    id: string;
    org_id: string | null;
    owner_user_id: string | null;
    deleted?: boolean;
}

/** Where a record lives. `realm_ids` for records that span realms (daemons, workspaces). */
export interface RecordScope {
    realm_id?: string | null;
    realm_ids?: string[];
    org_id?: string | null;
    /** Personal records (a user's own notification channel). */
    owner_user_id?: string | null;
    /** The caller was assigned this record by name (a review's user-targeted notification). */
    assigned_user?: boolean;
    team?: TeamAccess;
}

/** Data the engine needs; implemented over Sequelize in `store.ts`, faked in tests. */
export interface AccessStore {
    realm(realm_id: string): Promise<RealmInfo | null>;
    realm_by_slug(org_id: string, slug: string): Promise<RealmInfo | null>;
    realm_role(realm_id: string, user_id: string): Promise<'admin' | 'operator' | 'member' | null>;
    org_role(org_id: string, user_id: string): Promise<OrgRoleInfo | null>;
    org_id_by_slug(slug: string): Promise<string | null>;
    daemon_in_realm(realm_id: string, daemon_id: string): Promise<boolean>;
    /** Resolve a record id to where it lives, or null when it does not exist. */
    record(kind: RecordKind, id: string, req: RequestLike): Promise<RecordScope | null>;
}

export interface RequestLike {
    method: string;
    path: string;
    body?: unknown;
    query?: unknown;
    params?: Record<string, string>;
    auth?: AuthContext;
}

export type DenyReason =
    | 'no_token'
    | 'daemon_not_allowed'
    | 'user_token_not_allowed'
    | 'not_site_admin'
    | 'not_found_or_hidden'
    | 'level_too_low'
    | 'missing_permission'
    | 'scope_required'
    | 'daemon_other_realm';

export interface AccessGrant {
    org_id?: string | null;
    realm_id?: string | null;
    level?: Level | 'daemon' | null;
    record?: { kind: RecordKind; id: string };
    /** A user token pushed daemon state under ALLOW_PAT_DAEMON_WRITES. */
    pat_daemon_write?: boolean;
}

export type Decision =
    | { allow: true; access: AccessGrant; unresolved?: string }
    | { allow: false; status: 400 | 401 | 403 | 404; reason: DenyReason; access?: AccessGrant; detail?: string };

export interface EngineOptions {
    /** One-release transition: user tokens may push daemon state (logged `warn`). */
    allow_pat_daemon_writes: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────

export function read_field(req: RequestLike, ref: FieldRef): string | undefined {
    const [where, ...rest] = ref.split('.');
    const key = rest.join('.');
    const src = (where === 'body' ? req.body : where === 'query' ? req.query : req.params) as
        Record<string, unknown> | undefined;
    const v = src?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
    return undefined;
}

function first_field(req: RequestLike, refs: FieldRef | FieldRef[]): { ref: FieldRef; value: string } | undefined {
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
        const value = read_field(req, ref);
        if (value) return { ref, value };
    }
    return undefined;
}

const is_daemon = (auth?: AuthContext) => auth?.auth_via === 'daemon_token';
const is_site_admin = (auth?: AuthContext) => !is_daemon(auth) && auth?.user?.role === 'admin';
const deny = (status: 400 | 401 | 403 | 404, reason: DenyReason, access?: AccessGrant, detail?: string): Decision =>
    ({ allow: false, status, reason, access, detail });
const allow = (access: AccessGrant = {}, unresolved?: string): Decision => ({ allow: true, access, unresolved });

const REALM_ROLE_LEVEL: Record<'admin' | 'operator' | 'member', Level> = {
    admin: 'admin', operator: 'operate', member: 'view',
};

function max_level(a: Level | null, b: Level | null): Level | null {
    if (!a) return b;
    if (!b) return a;
    return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

function role_has(role: OrgRoleInfo | null, perm: string): boolean {
    if (!role) return false;
    if (role.is_system) return true;
    return role.permissions.includes(perm);
}

// ── realm / org evaluation ─────────────────────────────────────────────

interface RealmStanding {
    realm: RealmInfo;
    level: Level | null;
    org_role: OrgRoleInfo | null;
}

async function realm_standing(store: AccessStore, auth: AuthContext, realm: RealmInfo): Promise<RealmStanding> {
    if (is_site_admin(auth)) return { realm, level: 'admin', org_role: null };
    const user_id = auth.user!.id;
    const [role, org_role] = await Promise.all([
        store.realm_role(realm.id, user_id),
        realm.org_id ? store.org_role(realm.org_id, user_id) : Promise.resolve(null),
    ]);
    let level: Level | null = role ? REALM_ROLE_LEVEL[role] : null;
    if (org_role && (org_role.is_system || org_role.slug === 'admin')) level = 'admin';
    if (realm.owner_user_id && realm.owner_user_id === user_id) level = max_level(level, 'admin');
    return { realm, level, org_role };
}

/** Check a user on one realm against a need. Returns null when allowed. */
function judge_standing(s: RealmStanding, need: Level | null, perm: string | undefined, auth: AuthContext): Decision | null {
    const access: AccessGrant = { realm_id: s.realm.id, org_id: s.realm.org_id, level: s.level };
    if (!s.level) return deny(404, 'not_found_or_hidden', access);
    if (need && LEVEL_RANK[s.level] < LEVEL_RANK[need]) return deny(403, 'level_too_low', access, `needs ${need}`);
    if (perm && !is_site_admin(auth) && s.org_role && !role_has(s.org_role, perm)) {
        return deny(403, 'missing_permission', access, perm);
    }
    return null;
}

async function judge_realm(
    store: AccessStore,
    req: RequestLike,
    realm: RealmInfo | null,
    need: Level | null,
    perm: string | undefined,
    daemon: 'read' | 'write' | 'only' | undefined,
    opts: EngineOptions,
): Promise<Decision> {
    const auth = req.auth!;
    if (!realm || realm.deleted) return deny(404, 'not_found_or_hidden');
    const base: AccessGrant = { realm_id: realm.id, org_id: realm.org_id };

    if (is_daemon(auth)) {
        if (!daemon) return deny(403, 'daemon_not_allowed', base);
        if (auth.realm_id !== realm.id) return deny(404, 'daemon_other_realm', base);
        return allow({ ...base, level: 'daemon' });
    }

    // User token on a daemon push (`level: null`): only during the PAT transition.
    if (need === null) {
        if (!opts.allow_pat_daemon_writes) return deny(403, 'user_token_not_allowed', base);
        const s = await realm_standing(store, auth, realm);
        const d = judge_standing(s, 'operate', undefined, auth);
        if (d) return d;
        return allow({ ...base, level: s.level, pat_daemon_write: true });
    }

    const s = await realm_standing(store, auth, realm);
    const d = judge_standing(s, need, perm, auth);
    if (d) return d;
    return allow({ ...base, level: s.level });
}

async function judge_org(store: AccessStore, auth: AuthContext, org_id: string | null, perm: string): Promise<Decision> {
    if (!org_id) return deny(404, 'not_found_or_hidden');
    if (is_daemon(auth)) return deny(403, 'daemon_not_allowed', { org_id });
    if (is_site_admin(auth)) return allow({ org_id, level: 'admin' });
    const role = await store.org_role(org_id, auth.user!.id);
    if (!role) return deny(404, 'not_found_or_hidden', { org_id });
    if (perm !== 'member' && !role_has(role, perm)) return deny(403, 'missing_permission', { org_id }, perm);
    return allow({ org_id });
}

async function resolve_org_id(store: AccessStore, ref: FieldRef, value: string): Promise<string | null> {
    if (ref.endsWith('.slug')) return store.org_id_by_slug(value);
    return value;
}

async function resolve_realm(store: AccessStore, req: RequestLike, ref: FieldRef, value: string): Promise<RealmInfo | null> {
    if (ref.endsWith('.slug')) {
        // Realm slugs are unique per org: the org comes from body.org_id or body.org_slug.
        const org_slug = read_field(req, 'body.org_slug');
        const org_id = read_field(req, 'body.org_id') ?? (org_slug ? await store.org_id_by_slug(org_slug) : null);
        return org_id ? store.realm_by_slug(org_id, value) : null;
    }
    return store.realm(value);
}

// ── main entry ─────────────────────────────────────────────────────────

export async function decide(policy: Policy, req: RequestLike, store: AccessStore, opts: EngineOptions): Promise<Decision> {
    const auth = req.auth;
    const signed = Boolean(auth?.user);

    switch (policy.kind) {
        case 'by_body':
            return decide(read_field(req, policy.field) !== undefined ? policy.when_present : policy.otherwise, req, store, opts);

        case 'public':
        case 'bff_only':
        case 'a2a_dispatch':
            return allow();

        case 'signed_in':
            if (!signed) return deny(401, 'no_token');
            if (is_daemon(auth) && !policy.daemon) return deny(403, 'daemon_not_allowed');
            return allow();

        case 'site_admin':
            if (!signed) return deny(401, 'no_token');
            if (is_daemon(auth)) return policy.daemon === 'read' ? allow({ level: 'daemon' }) : deny(403, 'daemon_not_allowed');
            return is_site_admin(auth) ? allow({ level: 'admin' }) : deny(403, 'not_site_admin');

        case 'daemon_self':
            if (!signed) return deny(401, 'no_token');
            if (is_daemon(auth)) return allow({ realm_id: auth!.realm_id, level: 'daemon' });
            if (policy.token_only) return deny(403, 'user_token_not_allowed');
            return opts.allow_pat_daemon_writes
                ? allow({ pat_daemon_write: true })
                : deny(403, 'user_token_not_allowed');

        case 'daemon_realm': {
            if (!signed) return deny(401, 'no_token');
            if (is_daemon(auth)) {
                if (!auth!.realm_id) return deny(403, 'daemon_other_realm');
                return allow({ realm_id: auth!.realm_id, level: 'daemon' });
            }
            return opts.allow_pat_daemon_writes
                ? allow({ pat_daemon_write: true }, 'realm resolved by handler')
                : deny(403, 'user_token_not_allowed');
        }

        case 'org': {
            if (!signed) return deny(401, 'no_token');
            const f = first_field(req, policy.from);
            if (!f) return allow({}, 'org id missing; handler validates');
            return judge_org(store, auth!, await resolve_org_id(store, f.ref, f.value), policy.perm);
        }

        case 'scope': {
            if (!signed) return deny(401, 'no_token');
            if (is_daemon(auth) && !policy.daemon) return deny(403, 'daemon_not_allowed');
            const rf = policy.realm && first_field(req, policy.realm.from);
            if (policy.realm && rf) {
                const r = await resolve_realm(store, req, rf.ref, rf.value);
                return judge_realm(store, req, r, policy.realm.level, policy.realm.perm, policy.daemon, opts);
            }
            const of = policy.org && first_field(req, policy.org.from);
            if (policy.org && of) {
                if (is_daemon(auth)) return allow({ org_id: of.value, level: 'daemon' }, 'daemon org scope: handler checks');
                return judge_org(store, auth!, await resolve_org_id(store, of.ref, of.value), policy.org.perm);
            }
            if (policy.otherwise === 'required') return deny(400, 'scope_required');
            return allow();
        }

        case 'realm': {
            if (!signed) return deny(401, 'no_token');
            if (is_daemon(auth) && !policy.daemon) return deny(403, 'daemon_not_allowed');
            const f = first_field(req, policy.from);
            if (!f) return allow({}, 'realm id missing; handler validates');
            const r = await resolve_realm(store, req, f.ref, f.value);
            return judge_realm(store, req, r, policy.level, policy.perm, policy.daemon, opts);
        }

        case 'record': {
            const f = first_field(req, policy.from);
            if (policy.record === 'team') return decide_team(store, req, f?.value);
            if (!signed) return deny(401, 'no_token');
            if (is_daemon(auth) && !policy.daemon) return deny(403, 'daemon_not_allowed');
            if (!f) return allow({}, `${policy.record} id missing; handler validates`);

            if (policy.record === 'realm') {
                const r = await resolve_realm(store, req, f.ref, f.value);
                const d = await judge_realm(store, req, r, policy.level, policy.perm, policy.daemon, opts);
                return with_record(d, policy.record, f.value);
            }

            const scope_ = await store.record(policy.record, f.value, req);
            if (!scope_) return deny(404, 'not_found_or_hidden', { record: { kind: policy.record, id: f.value } });

            if (scope_.owner_user_id && !is_daemon(auth) && scope_.owner_user_id === auth!.user!.id) {
                return allow({ level: 'admin', record: { kind: policy.record, id: f.value } });
            }
            const realm_ids = scope_.realm_ids ?? (scope_.realm_id ? [scope_.realm_id] : []);
            if (realm_ids.length === 0) {
                // Org-level record (org channel / rule / invite) or a record with no realm.
                if (scope_.org_id) {
                    const perm = policy.org_perm ?? policy.perm ?? 'member';
                    const d = await judge_org(store, auth!, scope_.org_id, perm);
                    return with_record(d, policy.record, f.value);
                }
                return is_site_admin(auth)
                    ? allow({ level: 'admin', record: { kind: policy.record, id: f.value } })
                    : deny(404, 'not_found_or_hidden', { record: { kind: policy.record, id: f.value } }, 'record has no realm or org');
            }

            // Records spanning realms: best standing wins.
            let last: Decision | null = null;
            for (const rid of realm_ids) {
                const d = await judge_realm(store, req, await store.realm(rid), policy.level, policy.perm, policy.daemon, opts);
                if (d.allow) return with_record(d, policy.record, f.value);
                if (!last || rank_deny(d) > rank_deny(last)) last = d;
            }
            // A named reviewer may view and act on their review (not daemon pushes).
            if (scope_.assigned_user && !is_daemon(auth) && policy.level !== null && policy.level !== 'admin') {
                return allow({ realm_id: realm_ids[0], level: policy.level, record: { kind: policy.record, id: f.value } });
            }
            return with_record(last!, policy.record, f.value);
        }
    }
}

/** Prefer the most informative denial across realms: 403 (can see, can't act) over 404. */
function rank_deny(d: Decision): number {
    return d.allow ? 99 : d.status === 403 ? 2 : 1;
}

function with_record(d: Decision, kind: RecordKind, id: string): Decision {
    if (d.allow) return { ...d, access: { ...d.access, record: { kind, id } } };
    return { ...d, access: { ...(d.access ?? {}), record: { kind, id } } };
}

async function decide_team(store: AccessStore, req: RequestLike, id: string | undefined): Promise<Decision> {
    if (!id) return req.auth?.user ? allow({}, 'team id missing; handler validates') : deny(401, 'no_token');
    const scope_ = await store.record('team', id, req);
    const auth = req.auth ?? ({ scopes: [], org_ids: [], org_slugs: [] } as unknown as AuthContext);
    if (!scope_?.team) return deny(404, 'not_found_or_hidden', { record: { kind: 'team', id } });
    if (is_site_admin(auth) || can_view_team({ ...auth, scopes: auth.scopes ?? [] }, scope_.team)) {
        return allow({ record: { kind: 'team', id }, level: 'view' });
    }
    return deny(404, 'not_found_or_hidden', { record: { kind: 'team', id } });
}
