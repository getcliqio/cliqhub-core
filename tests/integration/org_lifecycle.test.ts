/**
 * Org create / delete and the shared name space (integration, real Postgres).
 *
 *   1. orgs/new writes everything in one transaction; a failure after the org
 *      insert leaves nothing behind (the invited owner included).
 *   3. Name conflicts say who holds the name (and send it as `details`).
 *   4. orgs/delete removes everything orgs/new created; a realm with a daemon or
 *      a run in progress blocks it (409) and nothing is removed.
 *   5. The boot repair removes orphaned scopes, restores a missing org scope and
 *      leaves valid data alone.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Sequelize } from 'sequelize';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { core_api_error_handler } from '../../src/middleware/control_plane_error_handler.js';
import { use_test_link_env } from '../helpers/link_env.js';
import { database_url } from '../migrated_platform/helpers/control_plane_store.js';

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

const ROOT_ID = hub_legacy_uuid(919);
const ROOT_AUTH = { user: { id: ROOT_ID, username: 'root919', email: 'root919@test.com', role: 'admin' }, org_slugs: [], org_ids: [], scopes: [] } as never;

const ready = await postgres_reachable();

describe.skipIf(!ready)('org lifecycle and the shared name space (integration)', () => {
    const tag = `ol${Date.now().toString(36)}`;
    let M: typeof import('../../src/models/index.js');
    let svc: InstanceType<typeof import('../../src/services/orgs_service.js').OrgsService>;
    let users: InstanceType<typeof import('../../src/services/users_service.js').UsersService>;
    let app: express.Express;
    let restore_link_env: () => void;

    beforeAll(async () => {
        restore_link_env = use_test_link_env();
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
        M = await import('../../src/models/index.js');
        await sequelize.query(`INSERT INTO cliq.users (id, username, display_name, email, password_hash, role, created_at)
            VALUES (:id, 'root919', 'root919', 'root919@test.com', 'x', 'admin', NOW()) ON CONFLICT (id) DO NOTHING`, { replacements: { id: ROOT_ID } });

        const r = await Promise.all([
            import('../../src/repositories/org_repository.js'), import('../../src/repositories/org_member_repository.js'),
            import('../../src/repositories/scope_repository.js'), import('../../src/repositories/scope_member_repository.js'),
            import('../../src/repositories/user_repository.js'), import('../../src/repositories/team_repository.js'),
            import('../../src/repositories/audit_repository.js'), import('../../src/repositories/token_repository.js'),
        ]);
        const { OrgsService } = await import('../../src/services/orgs_service.js');
        const { UsersService } = await import('../../src/services/users_service.js');
        const { ScopesService } = await import('../../src/services/scopes_service.js');
        const { OrgsController } = await import('../../src/controllers/orgs_controller.js');
        const { test_config } = await import('../helpers/test_container.js');
        const { InvitationsService } = await import('../../src/services/invitations_service.js');
        const { ReactivationService } = await import('../../src/services/reactivation.service.js');
        const reactivation = new ReactivationService();
        const invitations = new InvitationsService(new r[0].OrgRepository(), new r[2].ScopeRepository(), new r[4].UserRepository(), reactivation);
        svc = new OrgsService(new r[0].OrgRepository(), new r[1].OrgMemberRepository(), new r[2].ScopeRepository(), new r[3].ScopeMemberRepository(), new r[4].UserRepository(), new r[5].TeamRepository(), new r[6].AuditRepository(), invitations, reactivation);
        users = new UsersService(new r[4].UserRepository(), new r[2].ScopeRepository(), new r[7].TokenRepository(), new r[6].AuditRepository(), new r[1].OrgMemberRepository(), test_config());
        const scopes = new ScopesService(new r[2].ScopeRepository(), new r[5].TeamRepository(), new r[6].AuditRepository(), new r[0].OrgRepository(), new r[1].OrgMemberRepository(), new r[3].ScopeMemberRepository());
        const orgs = new OrgsController(svc, scopes);
        app = express();
        app.use(express.json());
        app.use((req, _res, next) => { (req as unknown as { auth: unknown }).auth = ROOT_AUTH; next(); });
        const router = express.Router();
        router.post('/v1/orgs/new', orgs.wrap(orgs.new_org));
        router.use(core_api_error_handler);
        app.use(router);
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        restore_link_env?.();
        const { close_control_plane_store } = await import('../../src/db/control_plane_store.js');
        const { close_sequelize } = await import('../../src/db/sequelize.js');
        await close_control_plane_store();
        await close_sequelize();
    });

    /** What exists for an org slug / a user's name (alive realms only). */
    async function footprint(slug: string, admin?: string) {
        const org = await M.Org.findOne({ where: { slug } });
        const org_id = org?.id ?? null;
        const n = async (model: { count: (o: object) => Promise<number> }, where: object) => model.count({ where });
        return {
            org: Boolean(org),
            scope: await n(M.Scope, { slug }),
            org_scopes: org_id ? await n(M.Scope, { org_id }) : 0,
            roles: org_id ? await n(M.OrgRole, { org_id }) : 0,
            members: org_id ? await n(M.OrgMember, { org_id }) : 0,
            realms: org_id ? await n(M.Realm, { org_id, deleted: false }) : 0,
            user: admin ? await n(M.User, { username: admin }) : 0,
            user_scope: admin ? await n(M.Scope, { slug: admin }) : 0,
            personal_org: admin ? await n(M.Org, { slug: admin }) : 0,
        };
    }
    const NOTHING = { org: false, scope: 0, org_scopes: 0, roles: 0, members: 0, realms: 0, user: 0, user_scope: 0, personal_org: 0 };
    const ROOT_OWNER = { owner: { user_id: ROOT_ID } };
    /** The org's default realm, as the owner's accept creates it. */
    const default_realm = async (slug: string) => {
        const { RealmService } = await import('../../src/services/realm.service.js');
        await RealmService.ensure_org_default_realm(slug, ROOT_ID, ROOT_ID);
    };

    // ── 1. one transaction ──────────────────────────────────────────────

    it('a failure after the org insert rolls everything back, the invited owner included', async () => {
        const slug = `${tag}-tx`;
        const email = `${tag}-txown@t.io`;
        const spy = vi.spyOn(M.OrgMember, 'create').mockRejectedValueOnce(new Error('forced failure after org insert'));
        await expect(svc.new_org(ROOT_AUTH, { slug, owner: { email } })).rejects.toThrow('forced failure after org insert');
        spy.mockRestore();
        expect(await footprint(slug)).toEqual(NOTHING);
        expect(await M.User.count({ where: { email } })).toBe(0);
        expect(await M.AccountInvite.count({ where: { email } })).toBe(0);
        // The same request then succeeds: nothing was left holding the names.
        await svc.new_org(ROOT_AUTH, { slug, owner: { email } });
        expect(await footprint(slug)).toMatchObject({ org: true, scope: 1, org_scopes: 1, roles: 4, members: 1, realms: 0 });
        expect(await M.User.findOne({ where: { email }, raw: true })).toMatchObject({ status: 'invited', username: null, password_hash: null });
    });

    it('an existing owner: org waiting for them with a pending owner membership and scope; audit only on success', async () => {
        const slug = `${tag}-ex`;
        const before = await M.AuditLog.count({ where: { action: 'org.create', target_id: slug } });
        const res = await svc.new_org(ROOT_AUTH, { slug, ...ROOT_OWNER });
        expect(res.org).toMatchObject({ slug, status: 'waiting_for_owner', owner: { user_id: ROOT_ID }, reactivated: false });
        expect(await footprint(slug)).toMatchObject({ org: true, scope: 1, org_scopes: 1, roles: 4, members: 1, realms: 0 });
        expect(await M.OrgMember.findOne({ where: { org_id: res.org.id, user_id: ROOT_ID }, raw: true })).toMatchObject({ status: 'pending' });
        expect(await M.AuditLog.count({ where: { action: 'org.create', target_id: slug } })).toBe(before + 1);
    });

    // ── 3. messages name the holder ─────────────────────────────────────

    it('conflicts name the holder and carry it in details (over HTTP)', async () => {
        const post = (body: Record<string, unknown>) => request(app).post('/v1/orgs/new').send(body);
        // A personal org (a user has the same name) — created the way an admin-made user gets one.
        const person = `${tag}-person`;
        await users.new_user(ROOT_AUTH, { username: person, email: `${person}@t.io`, password: 'password123' } as never);
        let res = await post({ slug: person, ...ROOT_OWNER });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ ok: false, code: 'conflict', error: `${person} is already an org — the personal org of user ${person}`, details: { kind: 'org', slug: person, personal: true, owner_username: person } });

        await svc.new_org(ROOT_AUTH, { slug: `${tag}-held`, ...ROOT_OWNER });
        res = await post({ slug: `${tag}-held`, ...ROOT_OWNER });
        expect(res.body).toMatchObject({ error: `${tag}-held is already an org`, details: { kind: 'org', personal: false } });

        // An org's scope whose org is gone (org_id cleared, as a raw org delete leaves it).
        await M.Scope.create({ slug: `${tag}-orph`, owner_id: ROOT_ID, scope_type: 'org', org_id: null } as never);
        res = await post({ slug: `${tag}-orph`, ...ROOT_OWNER });
        expect(res.body).toMatchObject({ error: `${tag}-orph is already a scope (org, not attached to any org)`, details: { kind: 'scope', scope_type: 'org', org_slug: null } });

        await M.Scope.create({ slug: `${tag}-sc`, owner_id: ROOT_ID, scope_type: 'user' } as never);
        res = await post({ slug: `${tag}-sc`, ...ROOT_OWNER });
        expect(res.body).toMatchObject({ error: `${tag}-sc is already a scope (user, owned by user root919)`, details: { kind: 'scope', scope_type: 'user', owner_username: 'root919' } });

        // A username alone (its scope and personal org were removed).
        await M.User.create({ username: `${tag}-uonly`, email: `${tag}-uonly@t.io`, password_hash: 'x' } as never);
        res = await post({ slug: `${tag}-uonly`, ...ROOT_OWNER });
        expect(res.body).toMatchObject({ error: `${tag}-uonly is already a username`, details: { kind: 'user', slug: `${tag}-uonly` } });

        // Same helper, same messages on admin user create.
        await expect(users.new_user(ROOT_AUTH, { username: `${tag}-held`, email: `${tag}-x@t.io`, password: 'password123' } as never))
            .rejects.toMatchObject({ status: 409, message: `${tag}-held is already an org` });
    });

    // ── 4. delete_org ───────────────────────────────────────────────────

    it('delete_org soft-deletes: rows and settings stay, members become former members, the name stays taken', async () => {
        const slug = `${tag}-del`;
        await svc.new_org(ROOT_AUTH, { slug, ...ROOT_OWNER });
        await default_realm(slug);
        const org = (await M.Org.findOne({ where: { slug } }))!;
        const realm = (await M.Realm.findOne({ where: { org_id: org.id, deleted: false } }))!;
        await M.AccountInvite.create({ org_id: org.id, email: `${tag}@t.io`, role: 'member', token_hash: `${tag}-h`, invited_by: ROOT_ID, expires_at: new Date(Date.now() + 86400_000) } as never);
        const channel = await M.NotificationChannel.create({ id: `${tag}-ch`, org_id: org.id, realm_id: realm.id, name: `${tag}-ch`, enabled: 1, created_at: Date.now(), updated_at: Date.now() } as never);

        await expect(svc.delete_org(ROOT_AUTH, { org_id: org.id })).resolves.toMatchObject({ id: org.id, deleted_at: expect.any(String) });

        expect(await footprint(slug)).toMatchObject({ org: true, scope: 1 });
        expect((await M.Org.findByPk(org.id))!.status).toBe('deleted');
        expect(await M.OrgRole.count({ where: { org_id: org.id } })).toBe(4);
        expect(await M.OrgMember.count({ where: { org_id: org.id, deleted_at: null } })).toBe(0);
        expect(await M.OrgMember.count({ where: { org_id: org.id } })).toBe(1);
        // The owner invite orgs/new sent and the member invite are both revoked.
        expect(await M.AccountInvite.count({ where: { org_id: org.id, status: 'revoked' } })).toBe(2);
        const gone = (await M.Realm.findByPk(realm.id))!;
        expect(gone.deleted).toBe(true);
        expect(gone.slug).toBe('default');
        expect(await M.RealmMember.count({ where: { realm_id: realm.id } })).toBe(0);
        expect(await M.NotificationChannel.count({ where: { id: channel.get('id') } })).toBe(1);
        expect(await M.AuditLog.count({ where: { action: 'org.delete', target_id: slug } })).toBe(1);
        // The name stays taken by the deleted org.
        await expect(svc.new_org(ROOT_AUTH, { slug, ...ROOT_OWNER })).rejects.toMatchObject({ status: 409, code: 'deleted' });
    });

    it('delete_org refuses while a realm has a daemon or a run in progress, and removes nothing', async () => {
        const slug = `${tag}-busy`;
        await svc.new_org(ROOT_AUTH, { slug, ...ROOT_OWNER });
        await default_realm(slug);
        const org = (await M.Org.findOne({ where: { slug } }))!;
        const realm = (await M.Realm.findOne({ where: { org_id: org.id, deleted: false } }))!;
        const now = Date.now();
        const daemon_id = `${tag}-d`;
        await M.Daemon.create({ id: daemon_id, api_key_hash: 'x', status: 'online', last_heartbeat: now, capacity: 1, created_at: now, last_registered_at: now, permissions: {} } as never);
        const member = await M.RealmMember.create({ id: crypto.randomUUID(), realm_id: realm.id, member_type: 'daemon', member_id: daemon_id, role: 'operator', created_at: now } as never);

        await expect(svc.delete_org(ROOT_AUTH, { org_id: org.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('still has 1 daemon') });
        await member.destroy();
        await M.Workspace.create({ id: `${tag}-w`, path: '/tmp/w', daemon_id, created_at: now, updated_at: now } as never);
        await M.Run.create({ run_id: `${tag}-run`, workspace_id: `${tag}-w`, team_id: 't', daemon_id, realm_id: realm.id, state: 'running', started_at: now } as never);
        await expect(svc.delete_org(ROOT_AUTH, { org_id: org.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('run(s) in progress') });

        expect(await footprint(slug)).toMatchObject({ org: true, scope: 1, roles: 4, members: 1, realms: 1 });
    });

    // ── 5. repair ───────────────────────────────────────────────────────

    it('the boot repair removes orphaned scopes, restores a missing org scope and leaves valid data alone (idempotent)', async () => {
        const { repair_namespace_orphans } = await import('../../src/models/migrations/migrate_namespace_orphans.js');
        const { get_sequelize } = await import('../../src/db/sequelize.js');
        const s = (x: string) => `${tag}-r${x}`;
        // Orphans: a user scope with no owner, an org scope whose org was deleted.
        // scopes.owner_id may CASCADE on user delete, so the ownerless scope is made directly.
        await M.Scope.create({ slug: s('gu'), owner_id: null, scope_type: 'user' } as never);
        const gone_org = await M.Org.create({ slug: s('go') } as never);
        await M.Scope.create({ slug: s('go'), owner_id: ROOT_ID, scope_type: 'org', org_id: gone_org.get('id') } as never);
        await gone_org.destroy();
        // An orphan that still has a team is kept.
        await M.Scope.create({ slug: s('gt'), owner_id: null, scope_type: 'user' } as never);
        await M.Team.create({ name: s('team'), scope: s('gt') } as never);
        // A non-personal org that lost its scope (the old partial create) gets it back.
        const bare = await M.Org.create({ slug: s('bare'), display_name: 'Bare' } as never);
        await M.OrgMember.create({ org_id: bare.get('id'), user_id: ROOT_ID, role: 'admin' } as never);
        // Valid data: a personal org without an org scope (admin-made user) and a normal org.
        const person = s('pp');
        await users.new_user(ROOT_AUTH, { username: person, email: `${person}@t.io`, password: 'password123' } as never);
        await svc.new_org(ROOT_AUTH, { slug: s('ok'), ...ROOT_OWNER });
        const valid_before = await M.Scope.count({ where: { slug: [person, s('ok')] } });

        const first = await repair_namespace_orphans(get_sequelize());
        expect(first.user_scopes_removed).toContain(s('gu'));
        expect(first.org_scopes_removed).toContain(s('go'));
        expect(first.org_scopes_created).toContain(s('bare'));
        expect(first.skipped).toContainEqual({ slug: s('gt'), reason: expect.stringContaining('1 team') });
        expect(await M.Scope.count({ where: { slug: [s('gu'), s('go')] } })).toBe(0);
        expect(await M.Scope.count({ where: { slug: s('gt') } })).toBe(1);
        const restored = (await M.Scope.findOne({ where: { slug: s('bare') } }))!;
        expect(restored.get('org_id')).toBe(bare.get('id'));
        expect((await M.Org.findByPk(bare.get('id') as string))!.get('default_scope_id')).toBe(restored.get('id'));
        expect(await M.ScopeMember.count({ where: { scope_id: restored.get('id'), user_id: ROOT_ID } })).toBe(1);
        // Valid data untouched; the personal org stays without an org scope.
        expect(await M.Scope.count({ where: { slug: [person, s('ok')] } })).toBe(valid_before);
        expect(first.org_scopes_created).not.toContain(person);

        const second = await repair_namespace_orphans(get_sequelize());
        expect(second.user_scopes_removed.filter((x) => x.startsWith(tag))).toEqual([]);
        expect(second.org_scopes_removed.filter((x) => x.startsWith(tag))).toEqual([]);
        expect(second.org_scopes_created.filter((x) => x.startsWith(tag))).toEqual([]);
    });
});
