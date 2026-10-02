/**
 * Access rules that used to be repeated in controllers and services and now
 * live only in the route policy (Core API 5, duplicate checks removed).
 * One place, one test: every rule below was a "rejects non-admin" case in a
 * service or controller test.
 */
import { describe, it, expect } from 'vitest';

import type { AccessStore } from '../../../src/auth/route_policy/engine.js';
import { DEFAULT_ROLES } from '../../../src/auth/permissions.js';
import { policy_status, type TestCaller } from '../../helpers/policy_decision.js';

// Org O1: owner, admin, operator, member. Realm R1 in O1: op (operator), mem (member).
const ORG_ROLE: Record<string, string> = { owner: 'owner', admin: 'admin', op: 'operator', mem: 'member' };
const REALM_ROLE: Record<string, 'admin' | 'operator' | 'member'> = { op: 'operator', mem: 'member' };
const role = (slug: string) => {
    const d = DEFAULT_ROLES.find((r) => r.slug === slug)!;
    return { slug: d.slug, is_system: d.is_system, permissions: [...d.permissions] };
};
const store: AccessStore = {
    realm: async (id) => (id === 'R1' ? { id: 'R1', org_id: 'O1', owner_user_id: null, deleted: false } : null),
    realm_by_slug: async (org_id, slug) => (org_id === 'O1' && slug === 'r-one' ? { id: 'R1', org_id: 'O1', owner_user_id: null, deleted: false } : null),
    realm_role: async (realm_id, user_id) => (realm_id === 'R1' ? REALM_ROLE[user_id] ?? null : null),
    org_role: async (org_id, user_id) => (org_id === 'O1' && ORG_ROLE[user_id] ? role(ORG_ROLE[user_id]) : null),
    org_id_by_slug: async (slug) => (slug === 'acme' ? 'O1' : null),
    daemon_in_realm: async () => false,
    record: async (kind, id) => {
        if (kind === 'invitation' && id === 'inv_realm') return { realm_id: 'R1' };
        if (kind === 'invitation' && id === 'inv_org') return { org_id: 'O1' };
        return null;
    },
};
const u = (id: string): TestCaller => ({ id });
const SITE: TestCaller = { id: 'sam', role: 'admin' };
const DAEMON: TestCaller = { id: 'sam', role: 'admin', daemon: { realm_id: 'R1' } };
const st = (route: string, caller: TestCaller | null, body: Record<string, unknown> = {}) => policy_status(`POST ${route}`, caller, body, store);

describe('site-admin routes (users, orgs, reports, settings, seed)', () => {
    const routes = [
        '/internal/users/new', '/internal/users/delete', '/internal/users/suspend', '/internal/users/unsuspend',
        '/internal/users/reset_password', '/internal/users/set_role', '/internal/orgs/new', '/internal/orgs/delete',
        '/v1/orgs/new', '/internal/reports/audit', '/v1/settings/set', '/v1/system/seed',
    ];
    it.each(routes)('%s: site admin yes, org owner 403, daemon token 403, no token 401', async (route) => {
        expect(await st(route, SITE, { org_id: 'O1' })).toBe(200);
        expect(await st(route, u('owner'), { org_id: 'O1' })).toBe(403);
        expect(await st(route, DAEMON, { org_id: 'O1' })).toBe(403);
        expect(await st(route, null)).toBe(401);
    });
});

describe('org routes', () => {
    it('orgs/delete: the owner (org.delete) and site admins; org admins cannot', async () => {
        expect(await st('/v1/orgs/delete', u('owner'), { org_id: 'O1' })).toBe(200);
        expect(await st('/v1/orgs/delete', SITE, { org_id: 'O1' })).toBe(200);
        expect(await st('/v1/orgs/delete', u('admin'), { org_id: 'O1' })).toBe(403);
    });

    it('update needs org.settings; members and roles need org.members.manage; scopes need org.scopes.manage', async () => {
        for (const route of ['/v1/orgs/update', '/v1/orgs/remove_member', '/v1/orgs/create_role',
            '/internal/orgs/update_role', '/internal/users/update_role', '/v1/orgs/new_scope', '/v1/orgs/delete_scope',
            '/v1/orgs/assign_scope_member', '/v1/orgs/unassign_scope_member']) {
            expect(await st(route, u('admin'), { org_id: 'O1' }), route).toBe(200);
            expect(await st(route, u('op'), { org_id: 'O1' }), route).toBe(403);
            expect(await st(route, u('stranger'), { org_id: 'O1' }), route).toBe(404);
        }
    });

    it('member-level reads: any member; outsiders 404', async () => {
        for (const route of ['/v1/orgs/list_roles', '/v1/orgs/get_role', '/v1/orgs/get_reviewable_targets', '/internal/dashboard/summary', '/v1/notifications/get']) {
            expect(await st(route, u('mem'), { org_id: 'O1' }), route).toBe(200);
            expect(await st(route, u('stranger'), { org_id: 'O1' }), route).toBe(404);
        }
    });
});

describe('realm routes', () => {
    it('add/remove team: realm operators (operate + realms.teams.manage), not only realm admins', async () => {
        for (const route of ['/v1/realms/add_team', '/v1/realms/remove_team']) {
            expect(await st(route, u('op'), { realm_id: 'R1' }), route).toBe(200);
            expect(await st(route, u('mem'), { realm_id: 'R1' }), route).toBe(403);
            expect(await st(route, u('stranger'), { realm_id: 'R1' }), route).toBe(404);
        }
    });

    it('update / delete / members: realm admin (org admins count as realm admin)', async () => {
        for (const route of ['/v1/realms/update', '/v1/realms/delete', '/v1/realms/add_member', '/v1/realms/remove_member', '/v1/realms/a2a']) {
            expect(await st(route, u('admin'), { realm_id: 'R1' }), route).toBe(200);
            expect(await st(route, u('op'), { realm_id: 'R1' }), route).toBe(403);
        }
    });

    it('get_by_id by slug resolves the org from org_id or org_slug', async () => {
        expect(await st('/v1/realms/get_by_id', u('mem'), { slug: 'r-one', org_id: 'O1' })).toBe(200);
        expect(await st('/v1/realms/get_by_id', u('mem'), { slug: 'r-one', org_slug: 'acme' })).toBe(200);
        expect(await st('/v1/realms/get_by_id', u('stranger'), { slug: 'r-one', org_slug: 'acme' })).toBe(404);
    });

    it('dispatch keys: view to read, admin + dispatch_keys.manage to rotate', async () => {
        expect(await st('/v1/auth/get_dispatch_public_key', u('mem'), { realm_id: 'R1' })).toBe(200);
        expect(await st('/v1/auth/rotate_dispatch_key', u('op'), { realm_id: 'R1' })).toBe(403);
        expect(await st('/v1/auth/rotate_dispatch_key', u('admin'), { realm_id: 'R1' })).toBe(200);
    });
});

describe('invitations', () => {
    it('realm invite: realm admin + realms.members.manage (an org operator who is not realm admin cannot)', async () => {
        expect(await st('/v1/invitations/create', u('admin'), { target_type: 'realm', realm_id: 'R1' })).toBe(200);
        expect(await st('/v1/invitations/create', u('op'), { target_type: 'realm', realm_id: 'R1' })).toBe(403);
        expect(await st('/v1/invitations/revoke', u('admin'), { invite_id: 'inv_realm' })).toBe(200);
        expect(await st('/v1/invitations/revoke', u('op'), { invite_id: 'inv_realm' })).toBe(403);
    });

    it('org invite: org.members.manage', async () => {
        expect(await st('/v1/invitations/get_by_id', u('admin'), { invite_id: 'inv_org', target_type: 'org' })).toBe(200);
        expect(await st('/v1/invitations/get_by_id', u('op'), { invite_id: 'inv_org', target_type: 'org' })).toBe(403);
    });

    it('get_by_id and revoke take invite_id alone', async () => {
        expect(await st('/v1/invitations/get_by_id', u('admin'), { invite_id: 'inv_org' })).toBe(200);
        expect(await st('/v1/invitations/revoke', u('admin'), { invite_id: 'inv_org' })).toBe(200);
        expect(await st('/v1/invitations/revoke', u('mem'), { invite_id: 'inv_org' })).toBe(403);
    });

    it('get_by_token and accept are public; a signed-in caller may use them too', async () => {
        for (const route of ['/v1/invitations/get_by_token', '/v1/invitations/accept']) {
            expect(await st(route, null, { token: 't' }), route).toBe(200);
            expect(await st(route, u('stranger'), { token: 't' }), route).toBe(200);
        }
    });
});

describe('daemon lifecycle routes: daemon tokens only', () => {
    it.each(['/v1/daemons/register', '/v1/daemons/heartbeat', '/v1/daemons/deregister', '/v1/daemons/ack_command', '/v1/auth/acl'])(
        '%s: user tokens 403 even with ALLOW_PAT_DAEMON_WRITES on; daemon token yes',
        async (route) => {
            expect(await st(route, SITE)).toBe(403);
            expect(await st(route, u('op'))).toBe(403);
            expect(await st(route, DAEMON)).toBe(200);
        },
    );
});
