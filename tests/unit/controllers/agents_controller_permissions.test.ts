/**
 * AgentsController role enforcement (agents.view / manage / manage.realm / reveal),
 * secret masking in get_settings, and include_usage on get.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { AgentsController } from '../../../src/controllers/agents_controller.js';
import type { AuthContext } from '../../../src/schemas/auth_types.js';
import { org_role_store, policy_status, type TestCaller } from '../../helpers/policy_decision.js';

const ORG = hub_legacy_uuid(10);
const REALM = hub_legacy_uuid(30);
const AGENT = hub_legacy_uuid(40);

vi.mock('../../../src/models/index.js', () => ({ Realm: { findByPk: vi.fn() }, AgentCatalog: {}, RealmAgentSetting: {}, OrgAgentSetting: {}, UserRealmAgentSetting: {}, OrgMember: {}, Org: {}, User: {}, OrgRole: {} }));
vi.mock('../../../src/repositories/realm_repository.js', () => ({
    RealmRepository: class { find_by_id = vi.fn(async (id: string) => (id === REALM ? { id: REALM, org_id: ORG } : null)); },
}));

const SETTINGS = {
    id: AGENT, name: 'jira', version: '1.2.0', description: null, is_system: true,
    settings: { required: [{ key: 'base_url' }, { key: 'email' }, { key: 'api_token', secret: true }], optional: [{ key: 'webhook', secret: true }] },
    values: { base_url: 'https://acme.atlassian.net', email: 'bot@acme.com', api_token: 'ATATT3xFfGF0abcd1234x7Qa', webhook: 'short' },
    source: {}, inherited: {}, configured: {}, required_total: 3, required_configured: 3, optional_total: 1, optional_configured: 1, all_required_configured: true,
};

const service = () => ({
    list: vi.fn().mockResolvedValue([{ id: AGENT, name: 'jira' }, { id: hub_legacy_uuid(41), name: 'exec' }]),
    get_by_name: vi.fn().mockResolvedValue({ id: AGENT, name: 'jira' }),
    get_by_catalog_id: vi.fn().mockResolvedValue({ id: AGENT, name: 'jira' }),
    register: vi.fn().mockResolvedValue({ entry: { id: AGENT, name: 'x' }, updated: false }),
    deregister: vi.fn().mockResolvedValue(true),
    list_settings_summary: vi.fn().mockResolvedValue([SETTINGS]),
    get_settings: vi.fn().mockResolvedValue(SETTINGS),
    update_settings: vi.fn().mockResolvedValue(true),
});

const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response & { json: ReturnType<typeof vi.fn> });
const user = (role: 'user' | 'admin' = 'user'): AuthContext => ({ user: { id: hub_legacy_uuid(1), username: 'u', role } as AuthContext['user'], org_slugs: [], org_ids: [ORG], scopes: [], auth_via: 'pat' });
const req = (body: Record<string, unknown>, auth: AuthContext) => ({ body, auth } as unknown as Request);
/** A role holding exactly these permissions. */
const role = (...perms: string[]) => vi.fn(async (_o: string, _u: string, p: string) => perms.includes(p));
const data = (r: ReturnType<typeof res>) => (r.json.mock.calls[0][0] as { data: unknown }).data;

/** The route policy for agents routes with a caller holding `perms` in ORG and `realm_role` in REALM. */
function policy_store(perms: string[], realm_role: 'operator' | 'member' | null = null) {
    return {
        ...org_role_store(),
        realm: async (id: string) => (id === REALM ? { id: REALM, org_id: ORG, owner_user_id: null, deleted: false } : null),
        realm_role: async () => realm_role,
        org_role: async (org_id: string) => (org_id === ORG ? { slug: 'custom', is_system: false, permissions: perms } : null),
    };
}
const U: TestCaller = { id: hub_legacy_uuid(1) };
const st = (route: string, body: Record<string, unknown>, perms: string[], realm_role: 'operator' | 'member' | null = null, caller: TestCaller = U) =>
    policy_status(`POST /v1/agents/${route}`, caller, body, policy_store(perms, realm_role));

describe('agents route policy (roles moved out of the controller)', () => {
    it('reads need agents.view', async () => {
        expect(await st('get', { org_id: ORG }, [])).toBe(403);
        expect(await st('get_details', { org_id: ORG, name: 'jira' }, [])).toBe(403);
        expect(await st('get_settings', { org_id: ORG }, [])).toBe(403);
        expect(await st('get', { org_id: ORG }, ['agents.view'])).toBe(200);
    });

    it('register / deregister need agents.manage (a realm permission is not enough)', async () => {
        expect(await st('register', { org_id: ORG, name: 'x' }, ['agents.view', 'agents.manage.realm'])).toBe(403);
        expect(await st('register', { org_id: ORG, name: 'x', realm_id: REALM }, ['agents.view', 'agents.manage.realm'], 'operator')).toBe(403);
        expect(await st('deregister', { org_id: ORG, name: 'x' }, ['agents.view', 'agents.manage.realm'])).toBe(403);
        expect(await st('deregister', { org_id: ORG, name: 'x' }, ['agents.manage'])).toBe(200);
    });

    it('org defaults need agents.manage; realm overrides need operate + agents.manage.realm in that realm', async () => {
        const operator = ['agents.view', 'agents.manage.realm'];
        expect(await st('update_settings', { org_id: ORG, id: AGENT }, operator)).toBe(403);
        expect(await st('update_settings', { org_id: ORG, id: AGENT, realm_id: REALM }, operator, null)).toBe(404);
        expect(await st('update_settings', { org_id: ORG, id: AGENT, realm_id: REALM }, operator, 'member')).toBe(403);
        expect(await st('update_settings', { org_id: ORG, id: AGENT, realm_id: REALM }, operator, 'operator')).toBe(200);
        expect(await st('update_settings', { org_id: ORG, id: AGENT }, ['agents.manage'])).toBe(200);
    });

    it('site admins pass; daemon tokens are refused', async () => {
        expect(await st('update_settings', { org_id: ORG, id: AGENT }, [], null, { id: 'sam', role: 'admin' })).toBe(200);
        expect(await st('get', { org_id: ORG }, ['agents.view'], null, { id: 'd', daemon: { realm_id: REALM } })).toBe(403);
    });
});

describe('AgentsController checks that stay in the handler', () => {
    it('masked values are refused on write (would overwrite the real secret)', async () => {
        const svc = service();
        const c = new AgentsController(svc as never, { permission_check: role('agents.manage') });
        await expect(c.update_settings(req({ org_id: ORG, id: AGENT, settings: { values: { api_token: '••••x7Qa' } } }, user()) as never, res() as never)).rejects.toMatchObject({ status_code: 400 });
        expect(svc.update_settings).not.toHaveBeenCalled();
    });

    it('realm_id must belong to org_id', async () => {
        const svc = service();
        const c = new AgentsController(svc as never, { permission_check: role('agents.manage') });
        await expect(c.update_settings(req({ org_id: hub_legacy_uuid(11), id: AGENT, realm_id: REALM, settings: { values: {} } }, user()) as never, res() as never)).rejects.toMatchObject({ status_code: 403 });
        await expect(c.get_settings(req({ org_id: hub_legacy_uuid(11), realm_id: REALM }, user()) as never, res() as never)).rejects.toMatchObject({ status_code: 403 });
        expect(svc.update_settings).not.toHaveBeenCalled();
    });
});

describe('get_settings secret masking', () => {
    it('masks secret values without agents.reveal (detail + summary)', async () => {
        const svc = service();
        const c = new AgentsController(svc as never, { permission_check: role('agents.view') });
        const r = res();
        await c.get_settings(req({ org_id: ORG, id: AGENT }, user()) as never, r as never);
        const v = (data(r) as typeof SETTINGS).values;
        expect(v.base_url).toBe('https://acme.atlassian.net');
        expect(v.email).toBe('bot@acme.com');
        expect(v.api_token).toBe('••••x7Qa');
        expect(v.webhook).toBe('••••'); // short secrets show no characters
        const r2 = res();
        await c.get_settings(req({ org_id: ORG }, user()) as never, r2 as never);
        expect((data(r2) as Array<typeof SETTINGS>)[0].values.api_token).toBe('••••x7Qa');
        expect(SETTINGS.values.api_token).toBe('ATATT3xFfGF0abcd1234x7Qa'); // service data not mutated
    });

    it('agents.reveal and site admins get real values', async () => {
        for (const [perm, auth] of [[role('agents.view', 'agents.reveal'), user()], [role(), user('admin')]] as const) {
            const c = new AgentsController(service() as never, { permission_check: perm });
            const r = res();
            await c.get_settings(req({ org_id: ORG, id: AGENT }, auth) as never, r as never);
            expect((data(r) as typeof SETTINGS).values.api_token).toBe('ATATT3xFfGF0abcd1234x7Qa');
        }
    });
});

describe('get include_usage', () => {
    it('adds used_by per agent (empty when unused) only when asked', async () => {
        const usage = vi.fn(async () => new Map([['jira', [{ scope: 'acme', name: 'triage', version: '1.0.0', realm_ids: [REALM] }]]]));
        const c = new AgentsController(service() as never, { permission_check: role('agents.view'), usage });
        const r = res();
        await c.get(req({ org_id: ORG, include_usage: true }, user()) as never, r as never);
        expect(usage).toHaveBeenCalledWith(ORG);
        expect(data(r)).toEqual([
            { id: AGENT, name: 'jira', used_by: [{ scope: 'acme', name: 'triage', version: '1.0.0', realm_ids: [REALM] }] },
            { id: hub_legacy_uuid(41), name: 'exec', used_by: [] },
        ]);
        const r2 = res();
        await c.get(req({ org_id: ORG }, user()) as never, r2 as never);
        expect(usage).toHaveBeenCalledTimes(1);
        expect((data(r2) as Array<Record<string, unknown>>)[0]).not.toHaveProperty('used_by');
    });
});

describe('default usage lookup', () => {
    it('without an injected lookup, include_usage uses AgentWorkflow.find_org_usage', async () => {
        const { AgentWorkflow } = await import('../../../src/lib/agent_workflow.js');
        const spy = vi.spyOn(AgentWorkflow, 'find_org_usage').mockResolvedValue(new Map([['jira', [{ scope: 'acme', name: 'triage', version: '1.0.0', realm_ids: [] }]]]) as never);
        const c = new AgentsController(service() as never, { permission_check: role('agents.view') });
        const r = res();
        await c.get(req({ org_id: ORG, include_usage: true }, user()) as never, r as never);
        expect(spy).toHaveBeenCalledWith(ORG);
        expect((data(r) as Array<{ name: string; used_by: unknown[] }>).find((a) => a.name === 'jira')!.used_by).toHaveLength(1);
        spy.mockRestore();
    });
});

describe('update_settings audit', () => {
    it('records who changed which keys — names only, never values', async () => {
        const audit = vi.fn().mockResolvedValue(undefined);
        const c = new AgentsController(service() as never, { permission_check: role('agents.manage'), audit });
        await c.update_settings(req({ org_id: ORG, id: AGENT, realm_id: REALM, settings: { values: { api_token: 'ATATT-secret', email: 'a@b.c' }, clear: ['webhook'] } }, user()) as never, res() as never);
        expect(audit).toHaveBeenCalledWith(hub_legacy_uuid(1), 'agents.update_settings', 'agent', AGENT, { org_id: ORG, realm_id: REALM, keys_set: ['api_token', 'email'], keys_cleared: ['webhook'] });
        expect(JSON.stringify(audit.mock.calls)).not.toContain('ATATT-secret');
    });

    it('an audit failure does not fail the write', async () => {
        const svc = service();
        const c = new AgentsController(svc as never, { permission_check: role('agents.manage'), audit: vi.fn().mockRejectedValue(new Error('db down')) });
        const r = res();
        await c.update_settings(req({ org_id: ORG, id: AGENT, settings: { values: { email: 'a@b.c' } } }, user()) as never, r as never);
        expect(svc.update_settings).toHaveBeenCalled();
        expect(data(r)).toBe(true);
    });
});
