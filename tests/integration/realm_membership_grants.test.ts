/**
 * Full integration: realm membership + daemon tokens (unified `tokens` table).
 *
 * Model (not realm-owned token rows):
 *   - Token type is only `user` | `daemon`.
 *   - A daemon token carries permissions.domains.realms (+ access map).
 *   - Realm membership (add_member/remove_member) is separate: users and daemon ids.
 *   - Many daemon tokens may target the same realm with different access.
 *   - Many users may share a realm with different membership roles.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import request from 'supertest';
import { Sequelize } from 'sequelize';

import { create_test_app } from '../helpers/test_container.js';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';

vi.mock('../../src/auth/password.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/auth/password.js')>();
    return {
        ...actual,
        verify_password: vi.fn().mockResolvedValue(true),
    };
});

const { app, repos } = create_test_app();
const SECRET = 'test-secret';

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

const USERS = new Map<string, typeof ALICE>([
    [hub_legacy_uuid(1), ALICE],
    [hub_legacy_uuid(2), BOB],
    [hub_legacy_uuid(3), CAROL],
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
    repos.user_repo.find_by_id.mockImplementation(async (id: string) => USERS.get(id) ?? null);
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
    repos.org_member_repo.find_orgs_by_user.mockResolvedValue([]);
    repos.scope_repo.find_member_scopes.mockResolvedValue([]);
    repos.scope_repo.find_by_org_ids.mockResolvedValue([]);
}

async function create_realm(slug_suffix: string): Promise<string> {
    const slug = `grant-${slug_suffix}-${Date.now()}`;
    const created = await request(app)
        .post('/v1/realms/create')
        .set('Authorization', bearer_for(ALICE))
        .send({ slug, name: `Grant realm ${slug_suffix}` });
    expect(created.status).toBe(200);
    return created.body.realm.id as string;
}

const ready = await postgres_reachable();

describe.skipIf(!ready)('realm membership + token grants (integration)', () => {
    beforeAll(async () => {
        const { init_sequelize, close_sequelize } = await import('../../src/db/sequelize.js');
        const { init_models } = await import('../../src/db/models/index.js');
        const { migrate_hub_schema } = await import('../../src/db/hub_schema_migrations.js');
        const { close_control_plane_store, init_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        await close_control_plane_store();
        await close_sequelize();
        const sequelize = init_sequelize(DATABASE_URL);
        init_models(sequelize);
        await sequelize.sync();
        await migrate_hub_schema(sequelize);
        await sequelize.query(`
            INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
            VALUES
            ('00000000-0000-4000-8000-000000000001', 'alice', 'alice', 'alice@test.com', 'x', 'user', NOW()),
                ('00000000-0000-4000-8000-000000000002', 'bob', 'bob', 'bob@test.com', 'x', 'user', NOW()),
                ('00000000-0000-4000-8000-000000000003', 'carol', 'carol', 'carol@test.com', 'x', 'user', NOW())
            ON CONFLICT (id) DO NOTHING
        `);
        await init_control_plane_store(DATABASE_URL);
    });

    afterAll(async () => {
        const { close_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        const { close_sequelize } = await import('../../src/db/sequelize.js');
        await close_control_plane_store();
        await close_sequelize();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mock_users();
    });

    it('rejects legacy personal and daemon; accepts realm only', async () => {
        const realm_id = await create_realm('legacy-type');

        const personal = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'personal', name: 'nope' });
        expect(personal.status).toBe(422);

        const daemon_type = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'daemon', realm_id, name: 'nope' });
        expect(daemon_type.status).toBe(422);

        const realm_type = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'ok-realm' });
        expect(realm_type.status).toBe(201);
        expect(realm_type.body.data?.token).toMatch(/^cliq_dt_/);
        expect(realm_type.body.data?.realm_ids).toEqual([realm_id]);
        expect(realm_type.body.data?.name).toBe('ok-realm');
        expect(realm_type.body.data?.id).toBeTruthy();

        const list_realm = await request(app)
            .post('/v1/auth/get_tokens')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_id });
        expect(list_realm.status).toBe(200);
    });

    it('multiple users in one realm — different roles gate admin actions', async () => {
        const realm_id = await create_realm('roles-diff');

        const grant_bob = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: hub_legacy_uuid(2), role: 'operator' });
        expect(grant_bob.status).toBe(200);
        expect(grant_bob.body.member).toMatchObject({ member_type: 'user', member_id: hub_legacy_uuid(2), role: 'operator' });

        const grant_carol = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: '3', role: 'member' });
        expect(grant_carol.status).toBe(200);

        const members = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user' });
        expect(members.status).toBe(200);
        const by_id = new Map(
            (members.body.members as Array<{ member_id: string; role: string }>)
                .map((m) => [m.member_id, m.role]),
        );
        expect(by_id.get(hub_legacy_uuid(1))).toBe('admin');
        expect(by_id.get(hub_legacy_uuid(2))).toBe('operator');
        expect(by_id.get(hub_legacy_uuid(3))).toBe('member');

        // Same permission class for read: operator and member can list members.
        const bob_list = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(BOB))
            .send({ realm_id });
        expect(bob_list.status).toBe(200);
        expect((bob_list.body.members as unknown[]).length).toBeGreaterThanOrEqual(3);

        const carol_list = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(CAROL))
            .send({ realm_id });
        expect(carol_list.status).toBe(200);

        // Members may mint realm tokens; only admin may add_member / remove_member.
        const bob_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(BOB))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'bob-ok' });
        expect([200, 201]).toContain(bob_mint.status);
        expect((bob_mint.body.data?.token ?? bob_mint.body.token) as string).toMatch(/^cliq_dt_/);

        const carol_grant = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(CAROL))
            .send({ realm_id, member_type: 'daemon', member_id: `d-carol-${Date.now()}` });
        expect([400, 403]).toContain(carol_grant.status);

        const bob_grant = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(BOB))
            .send({ realm_id, member_type: 'daemon', member_id: `d-bob-${Date.now()}` });
        expect([400, 403]).toContain(bob_grant.status);

        const alice_daemon_grant = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'daemon', member_id: `d-alice-${Date.now()}` });
        expect(alice_daemon_grant.status).toBe(400);

        const alice_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'admin-ok' });
        expect([200, 201]).toContain(alice_mint.status);
        expect((alice_mint.body.data?.token ?? alice_mint.body.token) as string).toMatch(/^cliq_dt_/);
    });

    it('multiple users with the same role share the same capabilities', async () => {
        const realm_id = await create_realm('roles-same');

        await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: hub_legacy_uuid(2), role: 'operator' });
        await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: '3', role: 'operator' });

        const bob_list = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(BOB))
            .send({ realm_id });
        const carol_list = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(CAROL))
            .send({ realm_id });
        expect(bob_list.status).toBe(200);
        expect(carol_list.status).toBe(200);
        expect((bob_list.body.members as unknown[]).length)
            .toBe((carol_list.body.members as unknown[]).length);

        const bob_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(BOB))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'same-role-bob' });
        const carol_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(CAROL))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'same-role-carol' });
        expect([200, 201]).toContain(bob_mint.status);
        expect([200, 201]).toContain(carol_mint.status);
    });

    it('add_member role change upgrades membership; remove_member removes it', async () => {
        const realm_id = await create_realm('role-change');

        await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: hub_legacy_uuid(2), role: 'member' });

        const upgraded = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: hub_legacy_uuid(2), role: 'admin' });
        expect(upgraded.status).toBe(200);

        const members = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user' });
        const bob = (members.body.members as Array<{ member_id: string; role: string }>)
            .find((m) => m.member_id === hub_legacy_uuid(2));
        expect(bob?.role).toBe('admin');

        // After upgrade, bob can mint daemon tokens.
        const bob_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(BOB))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'promoted-admin' });
        expect([200, 201]).toContain(bob_mint.status);

        const revoked = await request(app)
            .post('/v1/realms/remove_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: hub_legacy_uuid(2)  });
        expect(revoked.status).toBe(200);

        const after = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user' });
        expect((after.body.members as Array<{ member_id: string }>)
            .some((m) => m.member_id === hub_legacy_uuid(2))).toBe(false);

        const bob_denied = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(BOB))
            .send({ realm_id });
        expect(bob_denied.status).toBe(403);
    });

    it('multiple daemons in one realm — shared realm token enroll (no add_member)', async () => {
        const realm_id = await create_realm('multi-daemon-same');
        const d1 = `daemon-a-${Date.now()}`;
        const d2 = `daemon-b-${Date.now()}`;

        const tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'shared-enroll' });
        expect([200, 201]).toContain(tok.status);
        const daemon_token = (tok.body.data?.token ?? tok.body.token) as string;
        expect(tok.body.data?.realm_ids ?? tok.body.realm_ids).toEqual([realm_id]);

        for (const daemon_id of [d1, d2]) {
            const reg = await request(app)
                .post('/v1/daemons/register')
                .set('Authorization', `Bearer ${daemon_token}`)
                .send({ daemon_id, hostname: daemon_id, port: 4900 });
            expect(reg.status).toBe(200);
            expect(reg.body.daemon?.daemon_id).toBe(daemon_id);
            expect(reg.body.daemon?.status).toBe('online');
            expect(reg.body.daemon?.dispatch_public_key).toBeTruthy();
        }

        const members = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'daemon' });
        const ids = (members.body.members as Array<{ member_id: string }>).map((m) => m.member_id);
        expect(ids).toEqual(expect.arrayContaining([d1, d2]));

        const listed = await request(app)
            .post('/v1/daemons/get')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id });
        expect(listed.status).toBe(200);
        const listed_ids = (listed.body.daemons as Array<{ id: string }>).map((d) => d.id);
        expect(listed_ids).toEqual(expect.arrayContaining([d1, d2]));
    });

    it('daemon tokens with different domain grants enroll differently', async () => {
        const realm_a = await create_realm('tok-a');
        const realm_b = await create_realm('tok-b');

        const tok_a = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_a], name: 'only-a' });
        expect([200, 201]).toContain(tok_a.status);
        const token_a = (tok_a.body.data?.token ?? tok_a.body.token) as string;

        const tok_both = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({
                type: 'realm',
                realm_ids: [realm_a, realm_b],
                name: 'both-realms',
            });
        expect([200, 201]).toContain(tok_both.status);
        const token_both = (tok_both.body.data?.token ?? tok_both.body.token) as string;
        const both_realms = tok_both.body.data?.realm_ids ?? tok_both.body.realm_ids;
        expect(both_realms).toEqual(expect.arrayContaining([realm_a, realm_b]));

        const denied = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${token_a}`)
            .send({
                daemon_id: `cross-${Date.now()}`,
                realm_id: realm_b,
                hostname: 'cross-host',
                port: 4901,
            });
        expect(denied.status).toBe(403);

        const ok_a = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${token_a}`)
            .send({
                daemon_id: `only-a-${Date.now()}`,
                realm_id: realm_a,
                hostname: 'a-host',
                port: 4902,
            });
        expect(ok_a.status).toBe(200);

        const ok_b = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${token_both}`)
            .send({
                daemon_id: `both-b-${Date.now()}`,
                realm_id: realm_b,
                hostname: 'b-host',
                port: 4903,
            });
        expect(ok_b.status).toBe(200);
    });

    it('same realm — multiple daemon tokens with different access maps', async () => {
        const realm_id = await create_realm('access-diff');

        const default_tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'default-access' });
        expect([200, 201]).toContain(default_tok.status);
        const default_token = (default_tok.body.data?.token ?? default_tok.body.token) as string;

        const narrow_tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({
                type: 'realm',
                realm_ids: [realm_id],
                name: 'narrow-access',
                permissions: {
                    domains: { realms: [realm_id] },
                    access: {
                        daemons: ['write'],
                        dispatch: ['read'],
                        runs: ['read'],
                    },
                },
            });
        expect([200, 201]).toContain(narrow_tok.status);
        const narrow_token = (narrow_tok.body.data?.token ?? narrow_tok.body.token) as string;
        expect(narrow_tok.body.data?.realm_ids ?? narrow_tok.body.realm_ids).toEqual([realm_id]);

        const d_default = `perm-default-${Date.now()}`;
        const d_narrow = `perm-narrow-${Date.now()}`;

        const reg_default = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${default_token}`)
            .send({ daemon_id: d_default, hostname: 'def', port: 4910 });
        expect(reg_default.status).toBe(200);

        const reg_narrow = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${narrow_token}`)
            .send({ daemon_id: d_narrow, hostname: 'nar', port: 4911 });
        expect(reg_narrow.status).toBe(200);

        // Both enroll successfully; grant shape is fixed at mint and copied at register.
        const get_default = await request(app)
            .post('/v1/daemons/get_by_id')
            .set('Authorization', bearer_for(ALICE))
            .send({ daemon_id: d_default });
        const get_narrow = await request(app)
            .post('/v1/daemons/get_by_id')
            .set('Authorization', bearer_for(ALICE))
            .send({ daemon_id: d_narrow });
        expect(get_default.status).toBe(200);
        expect(get_narrow.status).toBe(200);
        expect(get_default.body.daemon?.id).toBe(d_default);
        expect(get_narrow.body.daemon?.id).toBe(d_narrow);
        expect(get_default.body.daemon?.permissions?.access?.dispatch).toEqual(['write']);
        expect(get_narrow.body.daemon?.permissions?.access?.dispatch).toEqual(['read']);
        expect(get_default.body.daemon?.realms?.map((r: { id: string }) => r.id)).toContain(realm_id);
        expect(get_narrow.body.daemon?.realms?.map((r: { id: string }) => r.id)).toContain(realm_id);
        expect(get_default.body.daemon?.realms?.[0]?.slug).toBeTruthy();
    });

    it('two daemon tokens with identical grants behave the same at enroll', async () => {
        const realm_id = await create_realm('access-same');

        const t1 = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'twin-1' });
        const t2 = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'twin-2' });
        expect([200, 201]).toContain(t1.status);
        expect([200, 201]).toContain(t2.status);

        const token_1 = (t1.body.data?.token ?? t1.body.token) as string;
        const token_2 = (t2.body.data?.token ?? t2.body.token) as string;
        expect(token_1).not.toBe(token_2);

        const p1 = t1.body.data?.permissions ?? t1.body.permissions;
        const p2 = t2.body.data?.permissions ?? t2.body.permissions;
        expect(p1).toEqual(p2);

        const d1 = `twin-d1-${Date.now()}`;
        const d2 = `twin-d2-${Date.now()}`;
        const r1 = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${token_1}`)
            .send({ daemon_id: d1, hostname: 't1', port: 4920 });
        const r2 = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${token_2}`)
            .send({ daemon_id: d2, hostname: 't2', port: 4921 });
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);

        const g1 = await request(app)
            .post('/v1/daemons/get_by_id')
            .set('Authorization', bearer_for(ALICE))
            .send({ daemon_id: d1 });
        const g2 = await request(app)
            .post('/v1/daemons/get_by_id')
            .set('Authorization', bearer_for(ALICE))
            .send({ daemon_id: d2 });
        expect(g1.body.daemon?.permissions).toEqual(g2.body.daemon?.permissions);
    });

    it('same realm — different users (roles) + different daemon tokens (access)', async () => {
        const realm_id = await create_realm('same-realm-matrix');

        // Users with different membership roles in this one realm.
        await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: hub_legacy_uuid(2), role: 'admin' });
        await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: '3', role: 'operator' });

        const users = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user' });
        const role_by_user = new Map(
            (users.body.members as Array<{ member_id: string; role: string }>)
                .map((m) => [m.member_id, m.role]),
        );
        expect(role_by_user.get(hub_legacy_uuid(1))).toBe('admin');
        expect(role_by_user.get(hub_legacy_uuid(2))).toBe('admin');
        expect(role_by_user.get(hub_legacy_uuid(3))).toBe('operator');

        // Operator and admins may mint distinct daemon tokens for the same realm.
        const carol_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(CAROL))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'carol-ok' });
        expect([200, 201]).toContain(carol_mint.status);

        const alice_tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({
                type: 'realm',
                realm_ids: [realm_id],
                name: 'alice-full',
                permissions: {
                    domains: { realms: [realm_id] },
                    access: {
                        daemons: ['write'],
                        dispatch: ['write'],
                        runs: ['read', 'write'],
                    },
                },
            });
        expect([200, 201]).toContain(alice_tok.status);

        const bob_tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(BOB))
            .send({
                type: 'realm',
                realm_ids: [realm_id],
                name: 'bob-narrow',
                permissions: {
                    domains: { realms: [realm_id] },
                    access: {
                        daemons: ['write'],
                        dispatch: ['read'],
                        runs: ['read'],
                    },
                },
            });
        expect([200, 201]).toContain(bob_tok.status);

        expect(alice_tok.body.data?.realm_ids ?? alice_tok.body.realm_ids).toEqual([realm_id]);
        expect(bob_tok.body.data?.realm_ids ?? bob_tok.body.realm_ids).toEqual([realm_id]);

        // Listed under type=realm (+ optional realm filter) — not a separate realm-token table.
        const listed = await request(app)
            .post('/v1/auth/get_tokens')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_id });
        expect(listed.status).toBe(200);
        const names = ((listed.body.data?.tokens ?? listed.body.tokens) as Array<{ name: string }>)
            .map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['alice-full', 'bob-narrow']));

        const alice_token = (alice_tok.body.data?.token ?? alice_tok.body.token) as string;
        const bob_token = (bob_tok.body.data?.token ?? bob_tok.body.token) as string;
        const d_alice = `matrix-alice-${Date.now()}`;
        const d_bob = `matrix-bob-${Date.now()}`;

        const reg_a = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${alice_token}`)
            .send({ daemon_id: d_alice, realm_id, hostname: 'a', port: 4930 });
        const reg_b = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${bob_token}`)
            .send({ daemon_id: d_bob, realm_id, hostname: 'b', port: 4931 });
        expect(reg_a.status).toBe(200);
        expect(reg_b.status).toBe(200);

        const daemon_members = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(CAROL))
            .send({ realm_id, member_type: 'daemon' });
        expect(daemon_members.status).toBe(200);
        const daemon_ids = (daemon_members.body.members as Array<{ member_id: string }>)
            .map((m) => m.member_id);
        expect(daemon_ids).toEqual(expect.arrayContaining([d_alice, d_bob]));

        // Operator still cannot add_member as daemon; enroll is via token.
        const carol_grant = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(CAROL))
            .send({ realm_id, member_type: 'daemon', member_id: `matrix-denied-${Date.now()}` });
        expect([400, 403]).toContain(carol_grant.status);
    });

    it('users and daemons coexist; remove_member daemon does not drop users', async () => {
        const realm_id = await create_realm('mixed');
        const daemon_id = `mixed-d-${Date.now()}`;

        await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'user', member_id: hub_legacy_uuid(2), role: 'operator' });

        const tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'mixed-enroll' });
        const daemon_token = (tok.body.data?.token ?? tok.body.token) as string;
        await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${daemon_token}`)
            .send({ daemon_id, hostname: daemon_id, port: 4900 });

        const revoke_d = await request(app)
            .post('/v1/realms/remove_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'daemon', member_id: daemon_id });
        expect(revoke_d.status).toBe(200);

        const members = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id });
        const rows = members.body.members as Array<{ member_type: string; member_id: string }>;
        expect(rows.some((m) => m.member_type === 'daemon' && m.member_id === daemon_id)).toBe(false);
        expect(rows.some((m) => m.member_type === 'user' && m.member_id === hub_legacy_uuid(2))).toBe(true);
        expect(rows.some((m) => m.member_type === 'user' && m.member_id === hub_legacy_uuid(1))).toBe(true);
    });

    it('dropped grant/revoke paths are 404; add_member rejects daemon type', async () => {
        const realm_id = await create_realm('xor');

        // Hard-cut: grant/revoke aliases removed
        const dropped_grant = await request(app)
            .post('/v1/realms/grant')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, user_id: hub_legacy_uuid(2), role: 'member' });
        expect(dropped_grant.status).toBe(404);

        const dropped_revoke = await request(app)
            .post('/v1/realms/revoke')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, user_id: hub_legacy_uuid(2) });
        expect(dropped_revoke.status).toBe(404);

        const neither = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id });
        expect(neither.status).toBe(400);

        const daemon_via_add = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer_for(ALICE))
            .send({ realm_id, member_type: 'daemon', member_id: 'd1' });
        expect(daemon_via_add.status).toBe(400);
    });

    it('runtime: missing daemons:write blocks register; default grant allows heartbeat after enroll', async () => {
        const realm_id = await create_realm('runtime-access');

        const denied_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({
                type: 'realm',
                realm_ids: [realm_id],
                name: 'no-daemon-write',
                permissions: {
                    domains: { realms: [realm_id] },
                    access: { daemons: ['read'], dispatch: ['write'], runs: ['read'] },
                },
            });
        expect([200, 201]).toContain(denied_mint.status);
        const denied_token = (denied_mint.body.data?.token ?? denied_mint.body.token) as string;

        const blocked = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${denied_token}`)
            .send({ daemon_id: `blocked-${Date.now()}`, hostname: 'x', port: 4940 });
        expect(blocked.status).toBe(403);
        expect(String(blocked.body.error)).toMatch(/daemons:write/);

        const ok_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer_for(ALICE))
            .send({ type: 'realm', realm_ids: [realm_id], name: 'full-daemon' });
        expect([200, 201]).toContain(ok_mint.status);
        const ok_token = (ok_mint.body.data?.token ?? ok_mint.body.token) as string;
        const daemon_id = `hb-${Date.now()}`;

        const reg = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${ok_token}`)
            .send({ daemon_id, hostname: 'hb', port: 4941 });
        expect(reg.status).toBe(200);

        const hb = await request(app)
            .post('/v1/daemons/heartbeat')
            .set('Authorization', `Bearer ${ok_token}`)
            .send({ daemon_id });
        expect(hb.status).toBe(200);

        const forbidden_route = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', `Bearer ${ok_token}`)
            .send({});
        expect(forbidden_route.status).toBe(403);

        const foreign_hb = await request(app)
            .post('/v1/daemons/heartbeat')
            .set('Authorization', `Bearer ${ok_token}`)
            .send({ daemon_id: `not-a-member-${Date.now()}` });
        expect(foreign_hb.status).toBe(403);
    });
});
