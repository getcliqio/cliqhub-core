/**
 * Route policy vocabulary — one policy per route, declared in `table.ts`.
 *
 * A policy says who may call a route and, for record routes, which record the
 * caller must be able to see and at what level. `enforce_route_policy` applies
 * the table to every request; routes never declare auth themselves.
 */

import type { Permission as RolePermission, OWNER_ONLY_PERMISSIONS } from '../permissions.js';

/** Any permission, including owner-only ones (`org.delete`, `org.transfer`). */
export type Permission = RolePermission | (typeof OWNER_ONLY_PERMISSIONS)[number];

/** Realm access levels, lowest first. Realm roles map member→view, operator→operate, admin→admin. */
export type Level = 'view' | 'operate' | 'admin';
export const LEVEL_RANK: Record<Level, number> = { view: 1, operate: 2, admin: 3 };

/** Records a policy can load. Each resolves to the realm (and org) it lives in. */
export type RecordKind =
    | 'realm'
    | 'run'
    | 'review'
    | 'artifact'
    | 'event'
    | 'custom_event'
    | 'daemon'
    | 'workspace'
    | 'invitation'
    | 'channel'
    | 'rule'
    | 'team';

/** Where to read an id from: `body.run_id`, `query.review_id`, `params.slug`. First present wins. */
export type FieldRef = `${'body' | 'query' | 'params'}.${string}`;

/**
 * How daemon tokens are treated on a route:
 *  - undefined → daemon tokens get 403
 *  - 'read'    → allowed when the record is in the token's realm
 *  - 'write'   → state push; allowed when the record is in the token's realm.
 *                User tokens may also push while `ALLOW_PAT_DAEMON_WRITES` is on (logged `warn`).
 *  - 'only'    → daemon tokens only (user tokens get 403, except under the PAT transition flag)
 */
export type DaemonRule = 'read' | 'write' | 'only';

interface Base {
    /** Extra rules the handler still enforces (shown in the table, not evaluated). */
    handler?: string;
}

export type Policy =
    | Base & { kind: 'public' }
    /** `/internal` routes the BFF calls with no token (sign-in, sign-up). */
    | Base & { kind: 'bff_only' }
    /** A2A dispatch — the route verifies its own dispatch-key signature. */
    | Base & { kind: 'a2a_dispatch' }
    /** Any user token; the service scopes results to the caller. */
    | Base & { kind: 'signed_in'; daemon?: DaemonRule }
    /** A user token whose user has site role `admin`. Never a daemon token (S18). */
    | Base & { kind: 'site_admin'; daemon?: 'read' }
    /** Daemon token acting on itself (register, heartbeat, claim). */
    /** Daemon lifecycle. `token_only`: user tokens are refused even while ALLOW_PAT_DAEMON_WRITES is on. */
    | Base & { kind: 'daemon_self'; token_only?: boolean }
    /** Member of the org named in the request; `perm` required unless 'member'. */
    | Base & { kind: 'org'; from: FieldRef | FieldRef[]; perm: Permission | 'member' }
    /**
     * Realm or org named in the request, whichever is present (realm first).
     * With neither: `none` → any signed-in caller (service scopes the list), `required` → 400.
     */
    | Base & {
        kind: 'scope';
        realm?: { from: FieldRef | FieldRef[]; level: Level; perm?: Permission };
        org?: { from: FieldRef | FieldRef[]; perm: Permission | 'member' };
        otherwise: 'none' | 'required';
        daemon?: DaemonRule;
    }
    /** Realm named in the request. `level: null` = daemon push with no user level. */
    | Base & { kind: 'realm'; from: FieldRef | FieldRef[]; level: Level | null; perm?: Permission; daemon?: DaemonRule }
    /** Record named in the request; the caller needs `level` on the record's realm. */
    | Base & {
        kind: 'record';
        record: RecordKind;
        from: FieldRef | FieldRef[];
        level: Level | null;
        perm?: Permission;
        /** Permission used when the record belongs to an org, not a realm (org channels / rules). */
        org_perm?: Permission;
        daemon?: DaemonRule;
    }
    /** Daemon push that creates a record in the token's own realm (runs/create). */
    | Base & { kind: 'daemon_realm'; level: Level };

// ── Builders (keep the table readable) ─────────────────────────────────

export const public_ = (handler?: string): Policy => ({ kind: 'public', handler });
export const bff_only = (handler?: string): Policy => ({ kind: 'bff_only', handler });
export const a2a_dispatch = (): Policy => ({ kind: 'a2a_dispatch' });
export const signed_in = (opts: { daemon?: DaemonRule; handler?: string } = {}): Policy => ({ kind: 'signed_in', ...opts });
export const site_admin = (opts: { daemon?: 'read'; handler?: string } = {}): Policy => ({ kind: 'site_admin', ...opts });
export const daemon_self = (handler?: string): Policy => ({ kind: 'daemon_self', handler });
/** Daemon-token-only route (register, heartbeat, deregister, ack, acl). */
export const daemon_only = (handler?: string): Policy => ({ kind: 'daemon_self', token_only: true, handler });
export const org = (from: FieldRef | FieldRef[], perm: Permission | 'member', handler?: string): Policy =>
    ({ kind: 'org', from, perm, handler });
export const realm = (
    from: FieldRef | FieldRef[],
    level: Level | null,
    opts: { perm?: Permission; daemon?: DaemonRule; handler?: string } = {},
): Policy => ({ kind: 'realm', from, level, ...opts });
export const record = (
    kind: RecordKind,
    from: FieldRef | FieldRef[],
    level: Level | null,
    opts: { perm?: Permission; org_perm?: Permission; daemon?: DaemonRule; handler?: string } = {},
): Policy => ({ kind: 'record', record: kind, from, level, ...opts });
export const scope = (opts: Omit<Extract<Policy, { kind: 'scope' }>, 'kind'>): Policy => ({ kind: 'scope', ...opts });
export const daemon_realm = (level: Level, handler?: string): Policy => ({ kind: 'daemon_realm', level, handler });
