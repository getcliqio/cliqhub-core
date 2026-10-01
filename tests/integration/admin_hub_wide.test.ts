/**
 * Core API 3 — hub-wide admin reads (integration, real Postgres).
 *
 *   - `all: true` on daemons/get, realms/get, runs/get: site admins see every
 *     record (not only realms they're a member of); ignored for everyone else.
 *   - users/get `role` / `suspended`; admin orgs/get `owner_count`;
 *   - /internal/reports/audit `since_ms` / `until_ms` / `target_id`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import request from 'supertest';
import { Sequelize } from 'sequelize';

import { SequelizeAccessStore } from '../../src/auth/route_policy/store.js';
import { create_test_app } from '../helpers/test_container.js';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';

vi.mock('../../src/auth/password.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/auth/password.js')>();
    return {
        ...actual,
        verify_password: vi.fn().mockResolvedValue(true),
    };
});

const { app, repos } = create_test_app({ route_policy: new SequelizeAccessStore() });
const SECRET = 'test-secret';

let alice_org_id = hub_legacy_uuid(100);

const ALICE = {
    id: hub_legacy_uuid(1),
    username: 'alice',
    display_name: 'alice',
    email: 'alice@test.com',
    role: 'user' as const,
    suspended_at: null,
    suspended_reason: '',
    created_at: '2025-01-01',
};

const BOB = {
    id: hub_legacy_uuid(2),
    username: 'bob',
    display_name: 'bob',
    email: 'bob@test.com',
    role: 'user' as const,
    suspended_at: null,
    suspended_reason: '',
    created_at: '2025-01-01',
};

const CAROL = {
    id: hub_legacy_uuid(3),
    username: 'carol',
    display_name: 'carol',
    email: 'carol@test.com',
    role: 'user' as const,
    suspended_at: null,
    suspended_reason: '',
    created_at: '2025-01-01',
};

const ROOT = { ...CAROL, id: hub_legacy_uuid(9), username: 'root9', display_name: 'root9', email: 'root9@test.com', role: 'admin' as unknown as 'user' };

const USERS = new Map<string, typeof ALICE>([
    [hub_legacy_uuid(1), ALICE],
    [hub_legacy_uuid(2), BOB],
    [hub_legacy_uuid(3), CAROL],
    [hub_legacy_uuid(9), ROOT],
]);

const DATABASE_URL =
    process.env.DATABASE_URL
    ?? 'postgresql://cliqhub:cliqhub@localhost:5432/cliqhub';

async function postgres_reachable(): Promise<boolean> {
    const probe = new Sequelize(DATABASE_URL, { dialect: 'postgres', logging: false });
    try {
        await probe.authenticate();
        await probe.close();
        return true;
    } catch {
        try { await probe.close(); } catch { /* ignore */ }
        return false;
    }
}

function bearer_for(user: typeof ALICE): string {
    repos.token_repo.find_by_prefix.mockResolvedValueOnce({
        id: `tok-${user.id}`,
        type: 'user',
        user_id: user.id,
        token_hash: 'hash',
        permissions: {},
        scopes: [],
    });
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function mock_users(): void {
    stub_pat_auth(repos, ALICE, { once: false });
    repos.user_repo.find_profile_by_id.mockImplementation(async (id: string) => USERS.get(id) ?? null);
    repos.scope_repo.find_owned_by_user.mockResolvedValue([
        {
            id: hub_legacy_uuid(1),
            slug: 'cliq',
            display_name: 'Cliq',
            visibility: 'public',
            scope_type: 'user',
            owner_id: hub_legacy_uuid(1),
            org_id: null,
        },
    ]);
    repos.org_member_repo.find_orgs_by_user.mockResolvedValue([
        { org_id: alice_org_id, slug: 'alice', role: 'owner' },
    ]);
    repos.scope_repo.find_member_scopes.mockResolvedValue([]);
    repos.scope_repo.find_default_scopes.mockResolvedValue([]);
    repos.scope_repo.find_by_org_ids.mockResolvedValue([]);
}

async function create_realm(slug_suffix: string): Promise<string> {
    const slug = `hub-${slug_suffix}-${Date.now()}`;
    const created = await request(app)
        .post('/v1/realms/create')
        .set('Authorization', bearer_for(ALICE))
        .send({ org_id: alice_org_id, slug, name: `Grant realm ${slug_suffix}` });
    expect(created.status).toBe(200);
    return created.body.realm.id as string;
}

const ready = await postgres_reachable();

describe.skipIf(!ready)('Core API 3 — hub-wide admin reads (integration)', () => {
    const stamp = Date.now();
    const D1 = `hubd-${stamp}-a`;
    let realm_id = '';

    beforeAll(async () => {
        const { init_sequelize, close_sequelize } = await import('../../src/db/sequelize.js');
        const { init_models } = await import('../../src/models/index.js');
        const { migrate_hub_schema, move_registry_to_cliq_schema } = await import('../../src/models/migrations/hub_schema_migrations.js');
        const { close_control_plane_store, init_control_plane_store } = await import('../../src/db/control_plane_store.js');
        await close_control_plane_store();
        await close_sequelize();
        const sequelize = init_sequelize(DATABASE_URL);
        init_models(sequelize);
        await move_registry_to_cliq_schema(sequelize);
        await sequelize.sync();
        await migrate_hub_schema(sequelize);
        await sequelize.query(`
            INSERT INTO users (id, username, display_name, email, password_hash, role, created_at, suspended_at)
            VALUES
                ('00000000-0000-4000-8000-000000000001', 'alice', 'alice', 'alice@test.com', 'x', 'user', NOW(), NULL),
                ('00000000-0000-4000-8000-000000000002', 'bob', 'bob', 'bob@test.com', 'x', 'user', NOW(), NOW()),
                ('00000000-0000-4000-8000-000000000003', 'carol', 'carol', 'carol@test.com', 'x', 'user', NOW(), NULL),
                ('00000000-0000-4000-8000-000000000009', 'root9', 'root9', 'root9@test.com', 'x', 'admin', NOW(), NULL)
            ON CONFLICT (id) DO NOTHING
        `);
        await sequelize.query(`UPDATE users SET suspended_at = NOW() WHERE id = '00000000-0000-4000-8000-000000000002'`);
        const { ensure_personal_org_for_user } = await import('../../src/models/migrations/migrate_ensure_user_orgs.js');
        const alice_org = await ensure_personal_org_for_user(ALICE.id, ALICE.username);
        alice_org_id = alice_org.id;
        await init_control_plane_store(DATABASE_URL);
    });

    afterAll(async () => {
        const { close_control_plane_store } = await import('../../src/db/control_plane_store.js');
        const { close_sequelize } = await import('../../src/db/sequelize.js');
        await close_control_plane_store();
        await close_sequelize();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mock_users();
    });

    async function seed(): Promise<void> {
        if (realm_id) return;
        realm_id = await create_realm('a');
        const { Daemon, RealmMember, Run, Workspace } = await import('../../src/models/index.js');
        const now = Date.now();
        await Daemon.create({ id: D1, api_key_hash: 'x', name: D1, status: 'online', last_heartbeat: now, capacity: 1, created_at: now, last_registered_at: now, permissions: {} } as never);
        await Workspace.create({ id: `hubw-${stamp}`, path: `/tmp/hubw-${stamp}`, daemon_id: D1, created_at: now, updated_at: now } as never);
        await RealmMember.create({ id: crypto.randomUUID(), realm_id, member_type: 'daemon', member_id: D1, role: 'operator', created_at: now } as never);
        await Run.create({ run_id: `hubr-${stamp}`, workspace_id: `hubw-${stamp}`, team_id: 't', daemon_id: D1, realm_id, state: 'failed', started_at: now } as never);
    }

    const post = (path: string, who: typeof ALICE, body: Record<string, unknown>) => request(app).post(path).set('Authorization', bearer_for(who)).send(body);
    const ids = (res: request.Response) => (res.body.data.items as Array<{ id?: string; run_id?: string }>).map((x) => x.id ?? x.run_id);

    it('realms/get: all:true lists every realm for a site admin, and is ignored for members', async () => {
        await seed();
        const admin = await post('/v1/realms/get', ROOT, { all: true, limit: 100, query: 'hub-a' });
        expect(admin.status).toBe(200);
        expect(ids(admin)).toContain(realm_id);
        const scoped = await post('/v1/realms/get', ROOT, { limit: 100, query: 'hub-a' });
        expect(ids(scoped)).not.toContain(realm_id);
        const bob = await post('/v1/realms/get', BOB, { all: true, limit: 100, query: 'hub-a' });
        expect(ids(bob)).not.toContain(realm_id);
        const by_org = await post('/v1/realms/get', ROOT, { all: true, org_id: alice_org_id, limit: 100 });
        expect(ids(by_org)).toContain(realm_id);
    });

    it('daemons/get: all:true hub-wide (and per org) for site admins; members still need org_id', async () => {
        await seed();
        const admin = await post('/v1/daemons/get', ROOT, { all: true, query: D1 });
        expect(admin.status).toBe(200);
        expect(ids(admin)).toEqual([D1]);
        const by_org = await post('/v1/daemons/get', ROOT, { all: true, org_id: alice_org_id, query: D1 });
        expect(ids(by_org)).toEqual([D1]);
        const bob = await post('/v1/daemons/get', BOB, { all: true });
        expect(bob.status).toBe(422);
        const bob_runs = await post('/v1/runs/get', BOB, { all: true });
        expect(bob_runs.status).toBe(422);
    });

    it('runs/get: all:true shows every run to a site admin', async () => {
        await seed();
        const admin = await post('/v1/runs/get', ROOT, { all: true, state: 'failed', limit: 100 });
        expect(admin.status, JSON.stringify(admin.body)).toBe(200);
        expect(ids(admin)).toContain(`hubr-${stamp}`);
        const by_org = await post('/v1/runs/get', ROOT, { all: true, org_id: alice_org_id, limit: 100 });
        expect(ids(by_org)).toContain(`hubr-${stamp}`);
        const plain = await post('/v1/runs/get', ROOT, { org_id: alice_org_id, state: 'failed', limit: 100 });
        expect(ids(plain)).not.toContain(`hubr-${stamp}`);
    });

    const ROOT_AUTH = { user: { id: ROOT.id, username: 'root9', email: 'root9@test.com', role: 'admin' }, org_slugs: [], org_ids: [], scopes: [] } as never;

    it('users/get: role and suspended filters (site admin list)', async () => {
        const { UsersService } = await import('../../src/services/users_service.js');
        const { UserRepository } = await import('../../src/repositories/user_repository.js');
        const { ScopeRepository } = await import('../../src/repositories/scope_repository.js');
        const { TokenRepository } = await import('../../src/repositories/token_repository.js');
        const { AuditRepository } = await import('../../src/repositories/audit_repository.js');
        const { OrgMemberRepository } = await import('../../src/repositories/org_member_repository.js');
        const { test_config } = await import('../helpers/test_container.js');
        const svc = new UsersService(new UserRepository(), new ScopeRepository(), new TokenRepository(), new AuditRepository(), new OrgMemberRepository(), test_config());
        const { User } = await import('../../src/models/index.js');
        const tag = `hubf${stamp}`;
        await User.create({ username: `${tag}-adm`, display_name: 'a', email: `${tag}-adm@t.io`, password_hash: 'x', role: 'admin' } as never);
        await User.create({ username: `${tag}-sus`, display_name: 's', email: `${tag}-sus@t.io`, password_hash: 'x', role: 'user', suspended_at: new Date() } as never);
        await User.create({ username: `${tag}-ok`, display_name: 'o', email: `${tag}-ok@t.io`, password_hash: 'x', role: 'user' } as never);
        const names = (r: { users: Array<{ username: string }> }) => r.users.map((u) => u.username).sort();
        expect(names(await svc.get(ROOT_AUTH, { search: tag, role: 'admin' }))).toEqual([`${tag}-adm`]);
        expect(names(await svc.get(ROOT_AUTH, { search: tag, suspended: true }))).toEqual([`${tag}-sus`]);
        expect(names(await svc.get(ROOT_AUTH, { search: tag, suspended: false, role: 'user' }))).toEqual([`${tag}-ok`]);
        expect((await svc.get(ROOT_AUTH, { search: tag })).total).toBe(3);
        const { users_get_schema } = await import('../../src/schemas/user_types.js');
        expect(users_get_schema.parse({ role: 'admin', suspended: true })).toMatchObject({ role: 'admin', suspended: true });
    });

    it('orgs/get (site admin): owner_count per org', async () => {
        const { OrgsService } = await import('../../src/services/orgs_service.js');
        const repos = await Promise.all([
            import('../../src/repositories/org_repository.js'), import('../../src/repositories/org_member_repository.js'),
            import('../../src/repositories/scope_repository.js'), import('../../src/repositories/scope_member_repository.js'),
            import('../../src/repositories/user_repository.js'), import('../../src/repositories/team_repository.js'),
            import('../../src/repositories/audit_repository.js'),
        ]);
        const svc = new OrgsService(new repos[0].OrgRepository(), new repos[1].OrgMemberRepository(), new repos[2].ScopeRepository(), new repos[3].ScopeMemberRepository(), new repos[4].UserRepository(), new repos[5].TeamRepository(), new repos[6].AuditRepository());
        const { OrgMember, OrgRole } = await import('../../src/models/index.js');
        const count = async () => {
            const res = await svc.get(ROOT_AUTH, { search: 'alice', limit: 100 }) as { orgs: Array<{ id: string; owner_count: string | number }> };
            return Number(res.orgs.find((o) => o.id === alice_org_id)!.owner_count);
        };
        const role = async (slug: string) => (await OrgRole.findOne({ where: { org_id: alice_org_id, slug } }))?.get('id') as string | undefined;
        const owner_id = await role('owner');
        const admin_id = await role('admin');
        if (owner_id && admin_id) {
            await OrgMember.update({ role_id: admin_id } as never, { where: { org_id: alice_org_id, user_id: ALICE.id } });
            expect(await count()).toBe(0);
            await OrgMember.update({ role_id: owner_id } as never, { where: { org_id: alice_org_id, user_id: ALICE.id } });
            expect(await count()).toBe(1);
        }
        // Not yet backfilled (role_id NULL): the legacy admin counts, as migrate_org_roles will promote them.
        await OrgMember.update({ role_id: null } as never, { where: { org_id: alice_org_id, user_id: ALICE.id } });
        expect(await count()).toBe(1);
    });

    it('reports/audit: since_ms / until_ms / target_id', async () => {
        const { AuditLog } = await import('../../src/models/index.js');
        const { ReportsService } = await import('../../src/services/reports_service.js');
        const { AuditRepository } = await import('../../src/repositories/audit_repository.js');
        const svc = new ReportsService(new AuditRepository());
        const target = `hub-target-${stamp}`;
        await AuditLog.create({ admin_id: ROOT.id, action: 'user.suspend', target_type: 'user', target_id: target, details: '{}', created_at: new Date(Date.now() - 3 * 86400_000) } as never);
        await AuditLog.create({ admin_id: ROOT.id, action: 'user.unsuspend', target_type: 'user', target_id: target, details: '{}' } as never);
        const all = await svc.audit(ROOT_AUTH, { target_id: target });
        expect(all.total).toBe(2);
        const recent = await svc.audit(ROOT_AUTH, { target_id: target, since_ms: Date.now() - 86400_000 });
        expect(recent.entries.map((e: { action: string }) => e.action)).toEqual(['user.unsuspend']);
        const older = await svc.audit(ROOT_AUTH, { target_id: target, until_ms: Date.now() - 86400_000 });
        expect(older.entries.map((e: { action: string }) => e.action)).toEqual(['user.suspend']);
        const { reports_audit_schema } = await import('../../src/schemas/report_types.js');
        expect(reports_audit_schema.parse({ since_ms: 1, until_ms: 2, target_id: 'x' })).toEqual({ since_ms: 1, until_ms: 2, target_id: 'x' });
    });
});
