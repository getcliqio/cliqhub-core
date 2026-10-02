/**
 * Core API 6 — list sorting (integration, real Postgres).
 *
 * `sort_by` / `sort_dir` on orgs/get (site-admin list), users/get (hub list),
 * daemons/get, teams/get (catalog + site-admin modes), orgs/get_scopes,
 * workspaces/get and /internal/reports/audit; `id ASC` breaks ties everywhere
 * (realms/get and runs/get included). For each list:
 *   - an unknown key is refused (Core's validator: 422 invalid_params);
 *   - every key sorts asc and desc;
 *   - equal values page stably (id tie-breaker: pages never overlap or skip);
 *   - without sort_by the order is exactly the old default;
 *   - search and sort work together.
 * The "exact match first" default of orgs/get and users/get takes the search
 * as a bound value: a quote in the search is data, not SQL.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Sequelize } from 'sequelize';
import express from 'express';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { core_api_error_handler } from '../../src/middleware/control_plane_error_handler.js';
import { database_url } from '../migrated_platform/helpers/control_plane_store.js';

vi.mock('../../src/auth/password.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/auth/password.js')>();
    return { ...actual, verify_password: vi.fn().mockResolvedValue(true) };
});

const DATABASE_URL = database_url;

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

const ROOT = {
    id: hub_legacy_uuid(9), username: 'root9', display_name: 'root9', email: 'root9@test.com',
    role: 'admin' as unknown as 'user', suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};
const ROOT_AUTH = { user: { id: ROOT.id, username: 'root9', email: 'root9@test.com', role: 'admin' }, org_slugs: [], org_ids: [], scopes: [] } as never;

let app: express.Express;

/**
 * The real controllers on a router with Core's /v1 error handler, called as
 * a site admin (`req.auth` stubbed; route policy is covered elsewhere).
 */
async function build_app(): Promise<express.Express> {
    const [{ OrgsController }, { UsersController }, { TeamsController }, { ReportsController }, { DaemonController }, { WorkspaceController }] = await Promise.all([
        import('../../src/controllers/orgs_controller.js'), import('../../src/controllers/users_controller.js'),
        import('../../src/controllers/teams_controller.js'), import('../../src/controllers/reports_controller.js'),
        import('../../src/controllers/daemons_controller.js'), import('../../src/controllers/workspaces_controller.js'),
    ]);
    const s = await services();
    const orgs = new OrgsController(s.orgs, s.scopes);
    const users = new UsersController(s.users);
    const teams = new TeamsController(s.teams);
    const reports = new ReportsController(s.reports);
    const daemons = new DaemonController();
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as unknown as { auth: unknown }).auth = ROOT_AUTH; next(); });
    const r = express.Router();
    r.post('/v1/orgs/get', orgs.wrap(orgs.get));
    r.post('/v1/orgs/get_scopes', orgs.wrap(orgs.get_scopes));
    r.post('/v1/users/get', users.wrap(users.get));
    r.post('/v1/teams/get', teams.wrap(teams.get));
    r.post('/v1/daemons/get', daemons.wrap(daemons.get));
    r.post('/v1/workspaces/get', WorkspaceController.get);
    r.post('/internal/reports/audit', reports.wrap(reports.audit));
    r.use(core_api_error_handler);
    a.use(r);
    return a;
}

/** Real services over the real repositories. */
async function services() {
    const r = await Promise.all([
        import('../../src/repositories/org_repository.js'), import('../../src/repositories/org_member_repository.js'),
        import('../../src/repositories/scope_repository.js'), import('../../src/repositories/scope_member_repository.js'),
        import('../../src/repositories/user_repository.js'), import('../../src/repositories/team_repository.js'),
        import('../../src/repositories/audit_repository.js'), import('../../src/repositories/token_repository.js'),
        import('../../src/repositories/team_version_repository.js'), import('../../src/repositories/tag_repository.js'),
    ]);
    const [{ OrgsService }, { UsersService }, { TeamsService }, { ScopesService }, { ReportsService }, { test_config }] = await Promise.all([
        import('../../src/services/orgs_service.js'), import('../../src/services/users_service.js'),
        import('../../src/services/teams_service.js'), import('../../src/services/scopes_service.js'),
        import('../../src/services/reports_service.js'), import('../helpers/test_container.js'),
    ]);
    return {
        orgs: new OrgsService(new r[0].OrgRepository(), new r[1].OrgMemberRepository(), new r[2].ScopeRepository(), new r[3].ScopeMemberRepository(), new r[4].UserRepository(), new r[5].TeamRepository(), new r[6].AuditRepository()),
        users: new UsersService(new r[4].UserRepository(), new r[2].ScopeRepository(), new r[7].TokenRepository(), new r[6].AuditRepository(), new r[1].OrgMemberRepository(), test_config()),
        teams: new TeamsService(new r[5].TeamRepository(), new r[8].TeamVersionRepository(), new r[9].TagRepository()),
        scopes: new ScopesService(new r[2].ScopeRepository(), new r[5].TeamRepository(), new r[6].AuditRepository(), new r[0].OrgRepository(), new r[1].OrgMemberRepository(), new r[3].ScopeMemberRepository()),
        reports: new ReportsService(new r[6].AuditRepository()),
    };
}

/** Status, code and body of one request as the site admin. */
async function post(path: string, body: Record<string, unknown>) {
    const res = await request(app).post(path).send(body);
    return { status: res.status, code: res.body?.code as string | undefined, body: res.body };
}

/** Rows as a comparable list of a field. */
const pluck = <T, K extends keyof T>(rows: T[], k: K) => rows.map((r) => r[k]);
/** Collation-free ascending compare for the ASCII test values used here. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Expected order: by `value` (nulls last both ways), then id ascending. */
function expected<T>(rows: T[], value: (r: T) => string | number | null, id: (r: T) => string, dir: 'asc' | 'desc'): string[] {
    return [...rows].sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (va == null || vb == null) return va == null && vb == null ? cmp(id(a), id(b)) : va == null ? 1 : -1;
        const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : cmp(String(va), String(vb));
        return (dir === 'desc' ? -c : c) || cmp(id(a), id(b));
    }).map(id);
}

const ready = await postgres_reachable();

describe.skipIf(!ready)('Core API 6 — list sorting (integration)', () => {
    const tag = `srt${Date.now().toString(36)}`;
    const day = 86_400_000;
    const base = Date.now() - 30 * day;

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
        await init_control_plane_store(DATABASE_URL);
        app = await build_app();
    });

    afterAll(async () => {
        const { close_control_plane_store } = await import('../../src/db/control_plane_store.js');
        const { close_sequelize } = await import('../../src/db/sequelize.js');
        await close_control_plane_store();
        await close_sequelize();
    });


    // ── Unknown keys and keys from the wrong mode ──────────────────────────

    it.each([
        ['/v1/orgs/get', {}, 422],
        ['/v1/users/get', {}, 422],
        ['/v1/teams/get', {}, 422],
        ['/v1/orgs/get_scopes', {}, 422],
        ['/v1/daemons/get', { all: true }, 422],
        ['/internal/reports/audit', {}, 422],
    ] as const)('%s: an unknown sort_by or sort_dir is refused with invalid_params', async (path, extra, status) => {
        const res = await post(path, { ...extra, sort_by: 'password_hash', sort_dir: 'asc' });
        expect(res.status, JSON.stringify(res.body)).toBe(status);
        expect(res.code).toBe('invalid_params');
        expect((await post(path, { ...extra, sort_dir: 'sideways' })).status).toBe(status);
    });

    it('/v1/workspaces/get: an unknown sort_by is refused (400: this route validates with Zod directly)', async () => {
        expect((await post('/v1/workspaces/get', { sort_by: 'path' })).status).toBe(400);
        const live = await post('/v1/workspaces/get', { daemon_id: 'd-x', sort_by: 'name' });
        expect(live.status).toBe(400);
        expect(live.code).toBe('invalid_params');
    });

    it('a valid sort is accepted over HTTP (orgs/get as a site admin)', async () => {
        const res = await post('/v1/orgs/get', { query: 'zz-none', sort_by: 'slug', sort_dir: 'desc' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('teams/get: a key from the other mode, or any key in daemon / mine mode, is 400 invalid_params', async () => {
        const realm_key_in_catalog = await post('/v1/teams/get', { sort_by: 'coverage' });
        expect(realm_key_in_catalog.status).toBe(400);
        expect(realm_key_in_catalog.code).toBe('invalid_params');
        const catalog_key_in_realm = await post('/v1/teams/get', { realm_id: 'r-x', sort_by: 'install_count' });
        expect(catalog_key_in_realm.status).toBe(400);
        expect((await post('/v1/teams/get', { daemon_id: 'd-x', sort_by: 'name' })).status).toBe(400);
        expect((await post('/v1/teams/get', { mine: true, sort_by: 'name' })).status).toBe(400);
    });

    // ── orgs/get (site-admin list) ──────────────────────────────────────────

    describe('orgs/get', () => {
        type Row = { id: string; slug: string; display_name: string; member_count: string | number; scope_count: string | number; created_at: string };
        let svc: InstanceType<typeof import('../../src/services/orgs_service.js').OrgsService>;
        const seeded: Array<{ slug: string; display_name: string; members: number; scopes: number; age: number }> = [
            { slug: `${tag}o-b`, display_name: 'Delta', members: 2, scopes: 0, age: 3 },
            { slug: `${tag}o-a`, display_name: 'charlie', members: 1, scopes: 1, age: 1 },
            { slug: `${tag}o-d`, display_name: 'Alpha', members: 1, scopes: 2, age: 4 },
            { slug: `${tag}o-c`, display_name: 'bravo', members: 0, scopes: 1, age: 2 },
            { slug: `${tag}o-e`, display_name: 'echo', members: 1, scopes: 0, age: 5 },
        ];
        let all: Row[] = [];
        const list = async (p: Record<string, unknown>) => (await svc.get(ROOT_AUTH, { search: tag, limit: 100, ...p }) as { orgs: Row[] }).orgs;

        beforeAll(async () => {
            const { OrgsService } = await import('../../src/services/orgs_service.js');
            const r = await Promise.all([
                import('../../src/repositories/org_repository.js'), import('../../src/repositories/org_member_repository.js'),
                import('../../src/repositories/scope_repository.js'), import('../../src/repositories/scope_member_repository.js'),
                import('../../src/repositories/user_repository.js'), import('../../src/repositories/team_repository.js'),
                import('../../src/repositories/audit_repository.js'),
            ]);
            svc = new OrgsService(new r[0].OrgRepository(), new r[1].OrgMemberRepository(), new r[2].ScopeRepository(), new r[3].ScopeMemberRepository(), new r[4].UserRepository(), new r[5].TeamRepository(), new r[6].AuditRepository());
            const { Org, OrgMember, Scope, User } = await import('../../src/models/index.js');
            const users = await Promise.all([0, 1].map((i) => User.create({ username: `${tag}om${i}`, email: `${tag}om${i}@t.io`, password_hash: 'x' } as never)));
            for (const o of seeded) {
                const org = await Org.create({ slug: o.slug, display_name: o.display_name, created_at: new Date(base + o.age * day) } as never);
                for (let i = 0; i < o.members; i++) await OrgMember.create({ org_id: org.get('id'), user_id: users[i].get('id'), role: 'member' } as never);
                for (let i = 0; i < o.scopes; i++) await Scope.create({ slug: `${o.slug}-s${i}`, org_id: org.get('id'), scope_type: 'org' } as never);
            }
            all = await list({});
            expect(all).toHaveLength(seeded.length);
        });

        it('default (no sort_by) is unchanged: newest first', async () => {
            expect(pluck(all, 'slug')).toEqual([...seeded].sort((a, b) => b.age - a.age).map((o) => o.slug));
        });

        it('default with an exact slug match puts it first; a quote in the search is data', async () => {
            const exact = `${tag}o-c`;
            const rows = (await svc.get(ROOT_AUTH, { search: exact, limit: 100 }) as { orgs: Row[] }).orgs;
            expect(rows[0].slug).toBe(exact);
            const quoted = await svc.get(ROOT_AUTH, { search: `${tag}'); DROP TABLE orgs; --`, limit: 100 }) as { orgs: Row[]; total: number };
            expect(quoted.total).toBe(0);
            expect((await list({})).length).toBe(seeded.length);
        });

        it.each([
            ['slug', (r: Row) => r.slug],
            ['display_name', (r: Row) => r.display_name.toLowerCase()],
            ['member_count', (r: Row) => Number(r.member_count)],
            ['scope_count', (r: Row) => Number(r.scope_count)],
            ['created_at', (r: Row) => new Date(r.created_at).getTime()],
        ] as const)('sort_by %s asc and desc (search + sort together; ties by id)', async (key, value) => {
            for (const dir of ['asc', 'desc'] as const) {
                const rows = await list({ sort_by: key, sort_dir: dir });
                expect(pluck(rows, 'id'), `${key} ${dir}`).toEqual(expected(all, value, (r) => r.id, dir));
            }
        });

        it('equal values page stably (member_count has ties)', async () => {
            const full = pluck(await list({ sort_by: 'member_count', sort_dir: 'desc' }), 'id');
            const pages: string[] = [];
            for (let offset = 0; offset < full.length; offset += 2) {
                pages.push(...pluck(await list({ sort_by: 'member_count', sort_dir: 'desc', limit: 2, offset }), 'id'));
            }
            expect(pages).toEqual(full);
        });

        it('sort_by with mine is refused (the member list is unpaged, by slug)', async () => {
            await expect(svc.get(ROOT_AUTH, { mine: true, sort_by: 'slug' })).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
        });
    });

    // ── users/get (hub list) ────────────────────────────────────────────────

    describe('users/get', () => {
        type Row = { id: string; username: string; role: string; created_at: string; suspended_at: string | null };
        let svc: InstanceType<typeof import('../../src/services/users_service.js').UsersService>;
        const seeded = [
            { u: 'c', role: 'user', age: 2, suspended: 4 },
            { u: 'a', role: 'admin', age: 4, suspended: null },
            { u: 'd', role: 'user', age: 1, suspended: 1 },
            { u: 'b', role: 'user', age: 3, suspended: null },
        ];
        let all: Row[] = [];
        const list = async (p: Record<string, unknown>) => (await svc.get(ROOT_AUTH, { search: `${tag}u`, limit: 100, ...p }) as { users: Row[] }).users;

        beforeAll(async () => {
            const { UsersService } = await import('../../src/services/users_service.js');
            const { UserRepository } = await import('../../src/repositories/user_repository.js');
            const { ScopeRepository } = await import('../../src/repositories/scope_repository.js');
            const { TokenRepository } = await import('../../src/repositories/token_repository.js');
            const { AuditRepository } = await import('../../src/repositories/audit_repository.js');
            const { OrgMemberRepository } = await import('../../src/repositories/org_member_repository.js');
            const { test_config } = await import('../helpers/test_container.js');
            svc = new UsersService(new UserRepository(), new ScopeRepository(), new TokenRepository(), new AuditRepository(), new OrgMemberRepository(), test_config());
            const { User } = await import('../../src/models/index.js');
            for (const s of seeded) {
                await User.create({
                    username: `${tag}u${s.u}`, email: `${tag}u${s.u}@t.io`, password_hash: 'x', role: s.role,
                    created_at: new Date(base + s.age * day), suspended_at: s.suspended == null ? null : new Date(base + s.suspended * day),
                } as never);
            }
            all = await list({});
            expect(all).toHaveLength(seeded.length);
        });

        it('default is unchanged: newest first; an exact username match first; a quote is data', async () => {
            expect(pluck(all, 'username')).toEqual([...seeded].sort((a, b) => b.age - a.age).map((s) => `${tag}u${s.u}`));
            const exact = (await svc.get(ROOT_AUTH, { search: `${tag}uc`, limit: 100 }) as { users: Row[] }).users;
            expect(exact[0].username).toBe(`${tag}uc`);
            expect((await svc.get(ROOT_AUTH, { search: `${tag}'||'`, limit: 100 }) as { total: number }).total).toBe(0);
        });

        it.each([
            ['username', (r: Row) => r.username],
            ['role', (r: Row) => r.role],
            ['created_at', (r: Row) => new Date(r.created_at).getTime()],
            ['suspended_at', (r: Row) => (r.suspended_at ? new Date(r.suspended_at).getTime() : null)],
        ] as const)('sort_by %s asc and desc (search + sort; nulls last; ties by id)', async (key, value) => {
            for (const dir of ['asc', 'desc'] as const) {
                expect(pluck(await list({ sort_by: key, sort_dir: dir }), 'id'), `${key} ${dir}`).toEqual(expected(all, value, (r) => r.id, dir));
            }
        });

        it('equal values page stably (role has ties)', async () => {
            const full = pluck(await list({ sort_by: 'role' }), 'id');
            const paged = [...pluck(await list({ sort_by: 'role', limit: 2, offset: 0 }), 'id'), ...pluck(await list({ sort_by: 'role', limit: 2, offset: 2 }), 'id')];
            expect(paged).toEqual(full);
        });

        it('sort_by with org_id / realm_id is refused', async () => {
            await expect(svc.get(ROOT_AUTH, { org_id: hub_legacy_uuid(77), sort_by: 'username' })).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
            await expect(svc.get(ROOT_AUTH, { realm_id: 'r-x', sort_by: 'username' })).rejects.toMatchObject({ status: 400 });
        });
    });

    // ── daemons/get ─────────────────────────────────────────────────────────

    describe('daemons/get', () => {
        type Row = { id: string; name: string | null; hostname: string | null; status: string; last_heartbeat: number | null };
        const seeded = [
            { k: 'b', name: 'Zed', host: null, status: 'online', hb: 3, reg: 2 },
            { k: 'a', name: null, host: 'mango', status: 'offline', hb: null, reg: 4 },
            { k: 'd', name: 'apple', host: 'x', status: 'online', hb: 1, reg: 1 },
            { k: 'c', name: null, host: null, status: 'stale', hb: 2, reg: 3 },
        ];
        let all: Row[] = [];
        const list = async (p: Record<string, unknown>) => {
            const { DaemonService } = await import('../../src/services/daemon.service.js');
            return (await DaemonService.list(ROOT.id, { site_admin: true, query: `${tag}d`, limit: 100, ...p })).daemons as unknown as Row[];
        };

        beforeAll(async () => {
            const { Daemon } = await import('../../src/models/index.js');
            const now = Date.now();
            for (const d of seeded) {
                await Daemon.create({
                    id: `${tag}d${d.k}`, api_key_hash: 'x', name: d.name, hostname: d.host, status: d.status,
                    // Far-future heartbeats keep _mark_stale from changing the seeded status.
                    last_heartbeat: d.hb == null ? null : now + d.hb * day, capacity: 1,
                    created_at: now, last_registered_at: now - d.reg * 1000, permissions: {},
                } as never);
            }
            all = await list({});
            expect(all).toHaveLength(seeded.length);
        });

        it('default is unchanged: most recently registered first', async () => {
            expect(pluck(all, 'id')).toEqual([...seeded].sort((a, b) => a.reg - b.reg).map((d) => `${tag}d${d.k}`));
        });

        it.each([
            ['name', (r: Row) => (r.name ?? r.hostname ?? r.id).toLowerCase()],
            ['status', (r: Row) => r.status],
            ['last_heartbeat', (r: Row) => r.last_heartbeat],
        ] as const)('sort_by %s asc and desc (query + sort; ties by id)', async (key, value) => {
            for (const dir of ['asc', 'desc'] as const) {
                expect(pluck(await list({ sort_by: key, sort_dir: dir }), 'id'), `${key} ${dir}`).toEqual(expected(all, value, (r) => r.id, dir));
            }
        });

        it('equal values page stably (status has ties)', async () => {
            const full = pluck(await list({ sort_by: 'status' }), 'id');
            const paged = [...pluck(await list({ sort_by: 'status', limit: 2, offset: 0 }), 'id'), ...pluck(await list({ sort_by: 'status', limit: 2, offset: 2 }), 'id')];
            expect(paged).toEqual(full);
        });
    });

    // ── teams/get catalog + site-admin modes ────────────────────────────────

    describe('teams/get', () => {
        type Row = { id: string; name: string; install_count: number; created_at: string; updated_at: string };
        let svc: InstanceType<typeof import('../../src/services/teams_service.js').TeamsService>;
        const seeded = [
            { n: 'b', installs: 5, age: 1, upd: 4 },
            { n: 'a', installs: 5, age: 3, upd: 1 },
            { n: 'd', installs: 9, age: 2, upd: 3 },
            { n: 'c', installs: 0, age: 4, upd: 2 },
        ];
        let catalog: Row[] = [];
        let admin: Row[] = [];
        const anon = { user: null, org_slugs: [], org_ids: [], scopes: [] } as never;
        const list_catalog = async (p: Record<string, unknown>) => (await svc.get(anon, { query: `${tag}t`, limit: 100, ...p }) as { teams: Row[] }).teams;
        const list_admin = async (p: Record<string, unknown>) => (await svc.get(ROOT_AUTH, { query: `${tag}t`, listed: true, limit: 100, ...p }) as { teams: Row[] }).teams;

        beforeAll(async () => {
            const { TeamsService } = await import('../../src/services/teams_service.js');
            const { TeamRepository } = await import('../../src/repositories/team_repository.js');
            const { TeamVersionRepository } = await import('../../src/repositories/team_version_repository.js');
            const { TagRepository } = await import('../../src/repositories/tag_repository.js');
            svc = new TeamsService(new TeamRepository(), new TeamVersionRepository(), new TagRepository());
            const { Team } = await import('../../src/models/index.js');
            for (const t of seeded) {
                await Team.create({
                    name: `${tag}t${t.n}`, scope: `${tag}scope`, visibility: 'public', listed: 1, install_count: t.installs,
                    created_at: new Date(base + t.age * day), updated_at: new Date(base + t.upd * day),
                } as never);
            }
            catalog = await list_catalog({});
            admin = await list_admin({});
            expect(catalog).toHaveLength(seeded.length);
            expect(admin).toHaveLength(seeded.length);
        });

        it('defaults are unchanged: catalog most installed first; site-admin listing most recently updated first', async () => {
            expect(pluck(catalog, 'id')).toEqual(expected(catalog, (r) => r.install_count, (r) => r.id, 'desc'));
            expect(pluck(admin, 'name')).toEqual([...seeded].sort((a, b) => b.upd - a.upd).map((t) => `${tag}t${t.n}`));
        });

        it.each([
            ['name', (r: Row) => r.name.toLowerCase()],
            ['install_count', (r: Row) => r.install_count],
            // The catalog rows don't carry the dates: read them from the seed.
            ['created_at', (r: Row) => seeded.find((t) => `${tag}t${t.n}` === r.name)!.age],
            ['updated_at', (r: Row) => seeded.find((t) => `${tag}t${t.n}` === r.name)!.upd],
        ] as const)('sort_by %s asc and desc in catalog and site-admin modes (query + sort; ties by id)', async (key, value) => {
            for (const dir of ['asc', 'desc'] as const) {
                expect(pluck(await list_catalog({ sort_by: key, sort_dir: dir }), 'id'), `catalog ${key} ${dir}`).toEqual(expected(catalog, value, (r) => r.id, dir));
                expect(pluck(await list_admin({ sort_by: key, sort_dir: dir }), 'id'), `admin ${key} ${dir}`).toEqual(expected(admin, value, (r) => r.id, dir));
            }
        });

        it('equal values page stably (install_count has ties)', async () => {
            const full = pluck(await list_catalog({ sort_by: 'install_count' }), 'id');
            const paged = [...pluck(await list_catalog({ sort_by: 'install_count', limit: 2, offset: 0 }), 'id'), ...pluck(await list_catalog({ sort_by: 'install_count', limit: 2, offset: 2 }), 'id')];
            expect(paged).toEqual(full);
        });
    });

    // ── orgs/get_scopes ─────────────────────────────────────────────────────

    describe('orgs/get_scopes', () => {
        type Row = { id: string; slug: string; visibility: string; team_count?: number; created_at: string };
        let svc: InstanceType<typeof import('../../src/services/scopes_service.js').ScopesService>;
        let owner_id = '';
        const seeded = [
            { s: 'b', vis: 'private', teams: 1, age: 2 },
            { s: 'a', vis: 'public', teams: 0, age: 4 },
            { s: 'd', vis: 'public', teams: 2, age: 1 },
            { s: 'c', vis: 'private', teams: 0, age: 3 },
        ];
        let catalog: Row[] = [];
        let mine: Row[] = [];
        const list_catalog = async (p: Record<string, unknown>) => (await svc.list_catalog(ROOT_AUTH, { search: `${tag}s`, limit: 100, ...p })).scopes as Row[];
        const list_mine = async (p: Record<string, unknown>) => (await svc.get_for_user(ROOT_AUTH, owner_id, { search: `${tag}s`, limit: 100, ...p })).items as Row[];

        beforeAll(async () => {
            const { ScopesService } = await import('../../src/services/scopes_service.js');
            const r = await Promise.all([
                import('../../src/repositories/scope_repository.js'), import('../../src/repositories/team_repository.js'),
                import('../../src/repositories/audit_repository.js'), import('../../src/repositories/org_repository.js'),
                import('../../src/repositories/org_member_repository.js'), import('../../src/repositories/scope_member_repository.js'),
            ]);
            svc = new ScopesService(new r[0].ScopeRepository(), new r[1].TeamRepository(), new r[2].AuditRepository(), new r[3].OrgRepository(), new r[4].OrgMemberRepository(), new r[5].ScopeMemberRepository());
            const { Scope, Team, User } = await import('../../src/models/index.js');
            const owner = await User.create({ username: `${tag}sowner`, email: `${tag}sowner@t.io`, password_hash: 'x' } as never);
            owner_id = String(owner.get('id'));
            for (const s of seeded) {
                await Scope.create({ slug: `${tag}s${s.s}`, owner_id, visibility: s.vis, scope_type: 'user', created_at: new Date(base + s.age * day) } as never);
                for (let i = 0; i < s.teams; i++) await Team.create({ name: `${tag}st${s.s}${i}`, scope: `${tag}s${s.s}` } as never);
            }
            catalog = await list_catalog({});
            mine = await list_mine({});
            expect(catalog).toHaveLength(seeded.length);
            expect(mine).toHaveLength(seeded.length);
        });

        it('defaults are unchanged: the catalog newest first, a user\'s scopes by slug', async () => {
            expect(pluck(catalog, 'slug')).toEqual([...seeded].sort((a, b) => b.age - a.age).map((s) => `${tag}s${s.s}`));
            expect(pluck(mine, 'slug')).toEqual(seeded.map((s) => `${tag}s${s.s}`).sort());
        });

        it.each([
            ['slug', (r: Row) => r.slug],
            ['visibility', (r: Row) => r.visibility],
            ['team_count', (r: Row) => seeded.find((s) => `${tag}s${s.s}` === r.slug)!.teams],
            ['created_at', (r: Row) => new Date(r.created_at).getTime()],
        ] as const)('sort_by %s asc and desc for the catalog and a user\'s scopes (search + sort; ties by id)', async (key, value) => {
            for (const dir of ['asc', 'desc'] as const) {
                expect(pluck(await list_catalog({ sort_by: key, sort_dir: dir }), 'id'), `catalog ${key} ${dir}`).toEqual(expected(catalog, value, (r) => r.id, dir));
                expect(pluck(await list_mine({ sort_by: key, sort_dir: dir }), 'id'), `mine ${key} ${dir}`).toEqual(expected(mine, value, (r) => r.id, dir));
            }
        });

        it('equal values page stably (visibility has ties)', async () => {
            const full = pluck(await list_catalog({ sort_by: 'visibility' }), 'id');
            const paged = [...pluck(await list_catalog({ sort_by: 'visibility', limit: 2, offset: 0 }), 'id'), ...pluck(await list_catalog({ sort_by: 'visibility', limit: 2, offset: 2 }), 'id')];
            expect(paged).toEqual(full);
        });
    });

    // ── workspaces/get ──────────────────────────────────────────────────────

    describe('workspaces/get', () => {
        type Row = { id: string; name: string | null; path: string; created_at: number };
        const seeded = [
            { k: 'b', name: 'zulu', path: '/w/b', age: 2 },
            { k: 'a', name: null, path: '/w/mike', age: 4 },
            { k: 'd', name: 'alpha', path: '/w/d', age: 2 },
            { k: 'c', name: null, path: '/w/bravo', age: 1 },
        ];
        let daemon_id = '';
        let all: Row[] = [];
        const list = async (p: Record<string, unknown>) => {
            const { WorkspaceService } = await import('../../src/services/workspace.service.js');
            return (await WorkspaceService.list({ daemon_ids: [daemon_id], limit: 100, ...p })).workspaces as unknown as Row[];
        };

        beforeAll(async () => {
            const { Daemon, Workspace } = await import('../../src/models/index.js');
            daemon_id = `${tag}wsd`;
            await Daemon.create({ id: daemon_id, api_key_hash: 'x', status: 'online', last_heartbeat: Date.now() + day, capacity: 1, created_at: Date.now(), last_registered_at: Date.now(), permissions: {} } as never);
            for (const w of seeded) {
                await Workspace.create({ id: `${tag}w${w.k}`, name: w.name, path: w.path, daemon_id, created_at: base + w.age * day, updated_at: base } as never);
            }
            all = await list({});
            expect(all).toHaveLength(seeded.length);
        });

        it('default is unchanged: oldest first (equal created_at by id)', async () => {
            expect(pluck(all, 'id')).toEqual(expected(all, (r) => Number(r.created_at), (r) => r.id, 'asc'));
        });

        it.each([
            ['name', (r: Row) => (r.name ?? r.path).toLowerCase()],
            ['created_at', (r: Row) => Number(r.created_at)],
        ] as const)('sort_by %s asc and desc (ties by id)', async (key, value) => {
            for (const dir of ['asc', 'desc'] as const) {
                expect(pluck(await list({ sort_by: key, sort_dir: dir }), 'id'), `${key} ${dir}`).toEqual(expected(all, value, (r) => r.id, dir));
            }
        });

        it('equal values page stably (created_at has ties)', async () => {
            const full = pluck(await list({ sort_by: 'created_at' }), 'id');
            const paged = [...pluck(await list({ sort_by: 'created_at', limit: 2, offset: 0 }), 'id'), ...pluck(await list({ sort_by: 'created_at', limit: 2, offset: 2 }), 'id')];
            expect(paged).toEqual(full);
        });
    });

    // ── /internal/reports/audit ─────────────────────────────────────────────

    describe('reports/audit', () => {
        type Row = { id: string; action: string; created_at: string };
        let svc: InstanceType<typeof import('../../src/services/reports_service.js').ReportsService>;
        const target = `${tag}-audit`;
        const seeded = [
            { action: 'user.suspend', age: 3 },
            { action: 'org.delete', age: 1 },
            { action: 'user.suspend', age: 2 },
            { action: 'team.unlist', age: 4 },
        ];
        let all: Row[] = [];
        const list = async (p: Record<string, unknown>) => (await svc.audit(ROOT_AUTH, { target_id: target, limit: 100, ...p })).entries as Row[];

        beforeAll(async () => {
            const { ReportsService } = await import('../../src/services/reports_service.js');
            const { AuditRepository } = await import('../../src/repositories/audit_repository.js');
            svc = new ReportsService(new AuditRepository());
            const { AuditLog } = await import('../../src/models/index.js');
            for (const a of seeded) {
                await AuditLog.create({ admin_id: ROOT.id, action: a.action, target_type: 'user', target_id: target, details: '{}', created_at: new Date(base + a.age * day) } as never);
            }
            all = await list({});
            expect(all).toHaveLength(seeded.length);
        });

        it('default is unchanged: newest first', async () => {
            expect(pluck(all, 'created_at').map((d) => new Date(d).getTime())).toEqual([...seeded].map((a) => base + a.age * day).sort((a, b) => b - a));
        });

        it.each([
            ['created_at', (r: Row) => new Date(r.created_at).getTime()],
            ['action', (r: Row) => r.action],
        ] as const)('sort_by %s asc and desc (filter + sort; ties by id)', async (key, value) => {
            for (const dir of ['asc', 'desc'] as const) {
                expect(pluck(await list({ sort_by: key, sort_dir: dir }), 'id'), `${key} ${dir}`).toEqual(expected(all, value, (r) => r.id, dir));
            }
        });

        it('equal values page stably (action has ties)', async () => {
            const full = pluck(await list({ sort_by: 'action' }), 'id');
            const paged = [...pluck(await list({ sort_by: 'action', limit: 2, offset: 0 }), 'id'), ...pluck(await list({ sort_by: 'action', limit: 2, offset: 2 }), 'id')];
            expect(paged).toEqual(full);
        });
    });

    // ── Tie-breakers on lists that already sorted ───────────────────────────

    it('realms/get and runs/get break ties by id (pages never overlap)', async () => {
        const { Org, Realm, Run } = await import('../../src/models/index.js');
        const org = await Org.create({ slug: `${tag}rorg`, display_name: 'r' } as never);
        const { RealmService } = await import('../../src/services/realm.service.js');
        const { RunService } = await import('../../src/services/run.service.js');
        const now = Date.now();
        for (const k of ['b', 'd', 'a', 'c']) {
            await Realm.create({ id: `${tag}r${k}`, slug: `${tag}r${k}`, name: 'same', owner_user_id: ROOT.id, created_by: ROOT.id, org_id: org.get('id'), created_at: now, updated_at: now } as never);
            await Run.create({ run_id: `${tag}x${k}`, workspace_id: `${tag}wb`, team_id: 't', daemon_id: `${tag}wsd`, realm_id: `${tag}rb`, run_name: 'same', state: 'failed', started_at: now } as never);
        }
        const realms = async (p: Record<string, unknown>) => (await RealmService.list_for_user(ROOT.id, { site_admin: true, query: `${tag}r`, sort_by: 'name', ...p } as never)).realms.map((r: { id: string }) => r.id);
        const full = await realms({});
        expect(full).toEqual([`${tag}ra`, `${tag}rb`, `${tag}rc`, `${tag}rd`]);
        expect([...await realms({ limit: 2, offset: 0 }), ...await realms({ limit: 2, offset: 2 })]).toEqual(full);

        const runs = async (offset: number, limit: number) => (await RunService.list_recent(limit, undefined, { site_admin: true, realm_id: `${tag}rb`, sort_by: 'run_name', sort_dir: 'asc', offset })).runs.map((r: { run_id: string }) => r.run_id);
        const all_runs = await runs(0, 10);
        expect(all_runs).toEqual([`${tag}xa`, `${tag}xb`, `${tag}xc`, `${tag}xd`]);
        expect([...await runs(0, 2), ...await runs(2, 2)]).toEqual(all_runs);
    });
});
