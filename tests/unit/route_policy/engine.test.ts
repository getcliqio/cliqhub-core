/**
 * Route policy engine — level rules, org permission ceiling, daemon tokens,
 * 404-for-hidden, PAT daemon-write transition. Uses the real table entries.
 */
import { describe, it, expect } from 'vitest';

import { decide, type AccessStore, type OrgRoleInfo, type RealmInfo, type RecordScope } from '../../../src/auth/route_policy/engine.js';
import { ROUTE_POLICY } from '../../../src/auth/route_policy/table.js';
import { ADMIN_PERMISSIONS, OPERATOR_PERMISSIONS, MEMBER_PERMISSIONS } from '../../../src/auth/permissions.js';
import type { AuthContext } from '../../../src/schemas/auth_types.js';

const ROLES: Record<string, OrgRoleInfo> = {
    owner: { slug: 'owner', is_system: true, permissions: [] },
    admin: { slug: 'admin', is_system: false, permissions: [...ADMIN_PERMISSIONS] },
    operator: { slug: 'operator', is_system: false, permissions: [...OPERATOR_PERMISSIONS] },
    member: { slug: 'member', is_system: false, permissions: [...MEMBER_PERMISSIONS] },
    no_runs: { slug: 'no-runs', is_system: false, permissions: ['realms.view'] },
};

const REALMS: Record<string, RealmInfo> = {
    A1: { id: 'A1', org_id: 'acme', owner_user_id: null },
    A2: { id: 'A2', org_id: 'acme', owner_user_id: null },
    B1: { id: 'B1', org_id: 'beta', owner_user_id: null },
    P: { id: 'P', org_id: null, owner_user_id: 'pat' },
    GONE: { id: 'GONE', org_id: 'acme', owner_user_id: null, deleted: true },
};

const ORG_ROLE: Record<string, Record<string, keyof typeof ROLES>> = {
    acme: { olivia: 'owner', adam: 'admin', omar: 'operator', mia: 'member', nora: 'member', nick: 'no_runs' },
    beta: { ben: 'owner' },
};

const REALM_ROLE: Record<string, Record<string, 'admin' | 'operator' | 'member'>> = {
    A1: { omar: 'operator', mia: 'member', gil: 'operator', nick: 'operator' },
};

const RECORDS: Record<string, RecordScope> = {
    'run:r-a1': { realm_id: 'A1', org_id: 'acme' },
    'run:r-b1': { realm_id: 'B1', org_id: 'beta' },
    'run:r-none': { realm_id: null, org_id: null },
    'review:rv-a1': { realm_id: 'A1', org_id: 'acme' },
    'review:rv-assigned': { realm_id: 'A1', org_id: 'acme', assigned_user: true },
    'daemon:d-a1': { realm_ids: ['A1'] },
    'daemon:d-multi': { realm_ids: ['A1', 'B1'] },
    'channel:ch-acme': { realm_id: null, org_id: 'acme' },
    'channel:ch-mia': { realm_ids: [], owner_user_id: 'mia' },
    'team:t-public': { team: { visibility: 'public', author_id: 'x', scope: 'cliq' } },
    'team:t-private': { team: { visibility: 'private', author_id: 'mia', scope: null } },
};

const store: AccessStore = {
    realm: async (id) => REALMS[id] ?? null,
    realm_by_slug: async (org_id, slug) => Object.values(REALMS).find((r) => r.org_id === org_id && r.id === slug.toUpperCase()) ?? null,
    realm_role: async (realm_id, user_id) => REALM_ROLE[realm_id]?.[user_id] ?? null,
    org_role: async (org_id, user_id) => (ORG_ROLE[org_id]?.[user_id] ? ROLES[ORG_ROLE[org_id][user_id]] : null),
    org_id_by_slug: async (slug) => (ORG_ROLE[slug] ? slug : null),
    daemon_in_realm: async (realm_id, daemon_id) => Boolean(RECORDS[`daemon:${daemon_id}`]?.realm_ids?.includes(realm_id)),
    record: async (kind, id) => RECORDS[`${kind}:${id}`] ?? null,
};

type Who = 'anon' | 'sam' | 'sam_daemon' | 'daemon_a1' | 'daemon_b1' | string;

function auth(who: Who): AuthContext | undefined {
    const base = { org_slugs: [], org_ids: [], scopes: [] } as unknown as AuthContext;
    if (who === 'anon') return undefined;
    if (who === 'sam') return { ...base, user: { id: 'sam', role: 'admin' }, auth_via: 'pat' } as AuthContext;
    if (who === 'sam_daemon') return { ...base, user: { id: 'sam', role: 'admin' }, auth_via: 'daemon_token', realm_id: 'A1' } as AuthContext;
    if (who === 'daemon_a1') return { ...base, user: { id: 'omar', role: 'user' }, auth_via: 'daemon_token', realm_id: 'A1' } as AuthContext;
    if (who === 'daemon_b1') return { ...base, user: { id: 'ben', role: 'user' }, auth_via: 'daemon_token', realm_id: 'B1' } as AuthContext;
    return { ...base, user: { id: who, role: 'user' }, auth_via: 'pat' } as AuthContext;
}

async function check(key: string, who: Who, body: Record<string, unknown> = {}, pat = true) {
    const policy = ROUTE_POLICY[key];
    if (!policy) throw new Error(`no policy for ${key}`);
    const [method, path] = key.split(' ');
    const query = method === 'GET' ? body : {};
    const d = await decide(policy, { method, path, body, query, auth: auth(who) }, store, { allow_pat_daemon_writes: pat });
    return d.allow ? { status: 200, ...d } : d;
}

const status = async (...a: Parameters<typeof check>) => (await check(...a)).status;

describe('realm levels', () => {
    it('org owner sees every realm in the org without being added', async () => {
        expect(await status('POST /v1/runs/get_by_id', 'olivia', { run_id: 'r-a1' })).toBe(200);
        expect(await status('POST /v1/realms/update', 'olivia', { realm_id: 'A2' })).toBe(200);
    });
    it('org admin is realm admin everywhere in the org', async () => {
        expect(await status('POST /v1/realms/delete', 'adam', { realm_id: 'A1' })).toBe(200);
    });
    it('realm member (viewer) can view but not operate', async () => {
        expect(await status('POST /v1/runs/get_by_id', 'mia', { run_id: 'r-a1' })).toBe(200);
        expect(await check('POST /v1/runs/cancel', 'mia', { run_id: 'r-a1' })).toMatchObject({ status: 403, reason: 'level_too_low' });
    });
    it('realm operator can operate but not administer', async () => {
        expect(await status('POST /v1/runs/cancel', 'omar', { run_id: 'r-a1' })).toBe(200);
        expect(await check('POST /v1/realms/update', 'omar', { realm_id: 'A1' })).toMatchObject({ status: 403, reason: 'level_too_low' });
    });
    it('org role is the permission ceiling: operator in realm, but org role lacks runs.view', async () => {
        expect(await check('POST /v1/runs/get_by_id', 'nick', { run_id: 'r-a1' })).toMatchObject({ status: 403, reason: 'missing_permission' });
    });
    it('realm guest (not in the org) is judged on the realm role alone', async () => {
        expect(await status('POST /v1/runs/cancel', 'gil', { run_id: 'r-a1' })).toBe(200);
    });
    it('org member not in the realm gets 404, not 403', async () => {
        expect(await check('POST /v1/runs/get_by_id', 'nora', { run_id: 'r-a1' })).toMatchObject({ status: 404, reason: 'not_found_or_hidden' });
    });
    it('another org gets 404', async () => {
        expect(await status('POST /v1/runs/get_by_id', 'ben', { run_id: 'r-a1' })).toBe(404);
        expect(await status('POST /v1/reviews/get_messages', 'ben', { review_id: 'rv-a1' })).toBe(404);
    });
    it('personal realm owner is admin', async () => {
        expect(await status('POST /v1/realms/update', 'pat', { realm_id: 'P' })).toBe(200);
    });
    it('deleted realm and missing records are 404', async () => {
        expect(await status('POST /v1/realms/get_by_id', 'olivia', { realm_id: 'GONE' })).toBe(404);
        expect(await status('POST /v1/runs/get_by_id', 'olivia', { run_id: 'nope' })).toBe(404);
    });
    it('realm by slug needs org_id and resolves', async () => {
        expect(await status('POST /v1/realms/get_by_id', 'mia', { slug: 'a1', org_id: 'acme' })).toBe(200);
    });
    it('a record with no realm is visible to site admins only', async () => {
        expect(await status('POST /v1/runs/get_by_id', 'olivia', { run_id: 'r-none' })).toBe(404);
        expect(await status('POST /v1/runs/get_by_id', 'sam', { run_id: 'r-none' })).toBe(200);
    });
    it('records spanning realms: any realm with enough standing wins', async () => {
        expect(await status('POST /v1/daemons/get_by_id', 'ben', { daemon_id: 'd-multi' })).toBe(200);
        expect(await status('POST /v1/daemons/get_by_id', 'ben', { daemon_id: 'd-a1' })).toBe(404);
        expect(await check('POST /v1/daemons/remove', 'mia', { daemon_id: 'd-a1' })).toMatchObject({ status: 403 });
    });
});

describe('daemon-targeted writes (no realm_id): judged on the daemon\'s realm', () => {
    it('a realm viewer cannot install, uninstall or run by naming a daemon', async () => {
        expect(await check('POST /v1/teams/install', 'mia', { team_id: 't', daemon_ids: ['d-a1'] })).toMatchObject({ status: 403, reason: 'level_too_low' });
        expect(await status('POST /v1/teams/uninstall', 'mia', { team_id: 't', daemon_id: 'd-a1' })).toBe(403);
        expect(await status('POST /v1/teams/uninstall', 'mia', { team_id: 't', daemon_ids: ['d-a1'] })).toBe(403);
        expect(await status('POST /v1/runs/enqueue', 'mia', { team_id: 't', daemon_id: 'd-a1' })).toBe(403);
    });
    it('a realm operator can', async () => {
        expect(await status('POST /v1/teams/install', 'omar', { team_id: 't', daemon_ids: ['d-a1'] })).toBe(200);
        expect(await status('POST /v1/teams/uninstall', 'omar', { team_id: 't', daemon_id: 'd-a1' })).toBe(200);
        expect(await status('POST /v1/runs/enqueue', 'omar', { team_id: 't', daemon_id: 'd-a1' })).toBe(200);
    });
    it('a daemon in a realm you cannot see, or one that does not exist, is 404', async () => {
        expect(await status('POST /v1/teams/install', 'ben', { team_id: 't', daemon_ids: ['d-a1'] })).toBe(404);
        expect(await status('POST /v1/teams/install', 'omar', { team_id: 't', daemon_ids: ['d-nope'] })).toBe(404);
    });
    it('a daemon serving several realms: best standing wins; every listed daemon must pass', async () => {
        expect(await status('POST /v1/teams/install', 'ben', { team_id: 't', daemon_ids: ['d-multi'] })).toBe(200);
        expect(await status('POST /v1/teams/install', 'ben', { team_id: 't', daemon_ids: ['d-multi', 'd-a1'] })).toBe(404);
        expect(await status('POST /v1/teams/install', 'omar', { team_id: 't', daemon_ids: ['d-a1', 'd-multi'] })).toBe(200);
    });
    it('the org permission still applies (org role without teams.install)', async () => {
        expect(await status('POST /v1/teams/install', 'nick', { team_id: 't', daemon_ids: ['d-a1'] })).toBe(403);
    });
    it('realm_id, when sent, is used as before', async () => {
        expect(await status('POST /v1/teams/install', 'mia', { team_id: 't', realm_id: 'A1' })).toBe(403);
        expect(await status('POST /v1/teams/install', 'omar', { team_id: 't', realm_id: 'A1' })).toBe(200);
    });
});

describe('tokens and callers', () => {
    it('no token → 401 on signed-in routes', async () => {
        expect(await status('POST /v1/runs/get_by_id', 'anon', { run_id: 'r-a1' })).toBe(401);
        expect(await status('POST /v1/orgs/get', 'anon')).toBe(401);
    });
    it('site admin reaches any record', async () => {
        expect(await status('POST /v1/runs/cancel', 'sam', { run_id: 'r-b1' })).toBe(200);
        expect(await status('POST /v1/settings/set', 'sam')).toBe(200);
    });
    it('admin-minted daemon token is not a site admin (S18)', async () => {
        expect(await check('POST /v1/settings/set', 'sam_daemon')).toMatchObject({ status: 403, reason: 'daemon_not_allowed' });
        expect(await status('POST /v1/runs/get_by_id', 'sam_daemon', { run_id: 'r-b1' })).toBe(403);
    });
    it('daemon token pushes state only into its own realm', async () => {
        expect(await status('POST /v1/runs/complete', 'daemon_a1', { run_id: 'r-a1' })).toBe(200);
        expect(await check('POST /v1/runs/complete', 'daemon_a1', { run_id: 'r-b1' })).toMatchObject({ status: 404, reason: 'daemon_other_realm' });
        expect(await status('POST /v1/reviews/create', 'daemon_b1', { realm_id: 'A1' })).toBe(404);
    });
    it('daemon token is refused on user routes', async () => {
        expect(await check('POST /v1/runs/cancel', 'daemon_a1', { run_id: 'r-a1' })).toMatchObject({ status: 403, reason: 'daemon_not_allowed' });
        expect(await status('POST /v1/orgs/update', 'daemon_a1', { org_id: 'acme' })).toBe(403);
    });
    it('daemon token may validate a token presented to it (cliqd checking a CLI user), nothing else on auth/*', async () => {
        expect(await status('POST /v1/auth/validate_token', 'daemon_a1')).toBe(200);
        expect(await status('POST /v1/auth/validate_token', 'sam_daemon')).toBe(200);
        expect(await status('POST /v1/auth/validate_token', 'anon')).toBe(401);
        expect(await check('POST /v1/auth/generate_token', 'daemon_a1')).toMatchObject({ status: 403, reason: 'daemon_not_allowed' });
        expect(await check('POST /v1/auth/get_tokens', 'daemon_a1')).toMatchObject({ status: 403, reason: 'daemon_not_allowed' });
    });
    it('daemon reads a review in its realm only', async () => {
        expect(await status('POST /v1/reviews/get_by_id', 'daemon_a1', { review_id: 'rv-a1' })).toBe(200);
        expect(await status('POST /v1/reviews/get_by_id', 'daemon_b1', { review_id: 'rv-a1' })).toBe(404);
    });
    it('user token pushing daemon state: allowed with a warning during the transition, operate needed', async () => {
        const d = await check('POST /v1/runs/complete', 'omar', { run_id: 'r-a1' }, true);
        expect(d).toMatchObject({ status: 200, access: { pat_daemon_write: true } });
        expect(await status('POST /v1/runs/complete', 'omar', { run_id: 'r-a1' }, false)).toBe(403);
        expect(await status('POST /v1/runs/complete', 'mia', { run_id: 'r-a1' }, true)).toBe(403);
        expect(await status('POST /v1/daemons/heartbeat', 'omar', {}, false)).toBe(403);
    });
});

describe('assigned reviewers', () => {
    it('a reviewer named on the review reads, chats and decides without a realm membership', async () => {
        expect(await status('POST /v1/reviews/get_by_id', 'nora', { review_id: 'rv-assigned' })).toBe(200);
        expect(await status('POST /v1/reviews/send_message', 'nora', { review_id: 'rv-assigned' })).toBe(200);
        expect(await status('POST /v1/reviews/verdict', 'nora', { review_id: 'rv-assigned' })).toBe(200);
    });
    it('being assigned does not allow daemon-only pushes', async () => {
        expect(await status('POST /v1/reviews/ack', 'nora', { review_id: 'rv-assigned' })).toBe(404);
    });
});

describe('org routes', () => {
    it('org permission required', async () => {
        expect(await check('POST /v1/orgs/update', 'mia', { org_id: 'acme' })).toMatchObject({ status: 403, reason: 'missing_permission' });
        expect(await status('POST /v1/orgs/update', 'adam', { org_id: 'acme' })).toBe(200);
    });
    it('owner-only permissions: admin cannot delete the org, owner can', async () => {
        expect(await status('POST /v1/orgs/delete', 'adam', { org_id: 'acme' })).toBe(403);
        expect(await status('POST /v1/orgs/delete', 'olivia', { org_id: 'acme' })).toBe(200);
    });
    it('not a member → 404', async () => {
        expect(await status('POST /v1/orgs/get_by_id', 'ben', { org_id: 'acme' })).toBe(404);
        expect(await status('POST /v1/orgs/get_by_id', 'mia', { slug: 'acme' })).toBe(200);
    });
    it('org-level records use the org permission', async () => {
        expect(await status('POST /v1/notification_channels/update', 'mia', { id: 'ch-acme' })).toBe(403);
        expect(await status('POST /v1/notification_channels/update', 'adam', { id: 'ch-acme' })).toBe(200);
    });
    it('a personal channel belongs to its owner', async () => {
        expect(await status('POST /v1/notification_channels/update', 'mia', { id: 'ch-mia' })).toBe(200);
        expect(await status('POST /v1/notification_channels/update', 'omar', { id: 'ch-mia' })).toBe(404);
    });
});

describe('lists and scope', () => {
    it('realm filter is checked; no filter is left to the service', async () => {
        expect(await status('POST /v1/runs/get', 'mia', { realm_id: 'B1' })).toBe(404);
        expect(await status('POST /v1/runs/get', 'mia', { realm_id: 'A1' })).toBe(200);
        expect(await status('POST /v1/runs/get', 'mia', {})).toBe(200);
        expect(await status('POST /v1/runs/get', 'ben', { org_id: 'acme' })).toBe(404);
    });
    it('scope-required routes need a realm or org', async () => {
        expect(await check('POST /v1/invitations/create', 'adam', {})).toMatchObject({ status: 400, reason: 'scope_required' });
        expect(await status('POST /v1/invitations/create', 'adam', { org_id: 'acme' })).toBe(200);
        expect(await status('POST /v1/invitations/create', 'omar', { realm_id: 'A1' })).toBe(403);
    });
});

describe('teams', () => {
    it('public team readable without a token; private hidden', async () => {
        expect(await status('POST /v1/teams/get_by_id', 'anon', { team_id: 't-public' })).toBe(200);
        expect(await status('POST /v1/teams/get_by_id', 'anon', { team_id: 't-private' })).toBe(404);
        expect(await status('POST /v1/teams/get_phases', 'mia', { team_id: 't-private' })).toBe(200);
        expect(await status('POST /v1/teams/get_phases', 'omar', { team_id: 't-private' })).toBe(404);
    });
});
