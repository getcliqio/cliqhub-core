/**
 * Ask the production route policy what it decides for a route and caller.
 * Unit tests use this for access rules that used to live in handlers.
 */

import { decide, type AccessStore, type Decision, type OrgRoleInfo } from '../../src/auth/route_policy/engine.js';
import { ROUTE_POLICY } from '../../src/auth/route_policy/table.js';
import { DEFAULT_ROLES } from '../../src/auth/permissions.js';

export interface TestCaller {
    id?: string;
    role?: 'admin' | 'user';
    daemon?: { realm_id: string | null };
}

export function caller_auth(c: TestCaller | null) {
    if (!c) return undefined;
    return {
        user: { id: c.id ?? 'u-1', role: c.daemon ? 'user' : (c.role ?? 'user') },
        auth_via: c.daemon ? 'daemon_token' : 'pat',
        realm_id: c.daemon?.realm_id ?? undefined,
        org_ids: [], org_slugs: [], scopes: [],
    } as never;
}

/** Store where `org_roles[org_id][user_id]` names a default role slug. */
export function org_role_store(org_roles: Record<string, Record<string, string>> = {}): AccessStore {
    const role = (slug: string): OrgRoleInfo => {
        const d = DEFAULT_ROLES.find((r) => r.slug === slug)!;
        return { slug: d.slug, is_system: d.is_system, permissions: [...d.permissions] };
    };
    return {
        realm: async () => null,
        realm_by_slug: async () => null,
        realm_role: async () => null,
        org_role: async (org_id, user_id) => (org_roles[org_id]?.[user_id] ? role(org_roles[org_id][user_id]) : null),
        org_id_by_slug: async () => null,
        daemon_in_realm: async () => false,
        record: async () => null,
    };
}

export async function policy_decision(
    route: string,
    caller: TestCaller | null,
    body: Record<string, unknown> = {},
    store: AccessStore = org_role_store(),
): Promise<Decision> {
    const policy = ROUTE_POLICY[route];
    if (!policy) throw new Error(`no policy for ${route}`);
    const [method, path] = route.split(' ');
    return decide(policy, { method, path, body, query: {}, params: {}, auth: caller_auth(caller) }, store, { allow_pat_daemon_writes: true });
}

/** Status the policy answers with (200 when it lets the request through). */
export async function policy_status(...args: Parameters<typeof policy_decision>): Promise<number> {
    const d = await policy_decision(...args);
    return d.allow ? 200 : d.status;
}
