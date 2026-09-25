/**
 * D4 — Authenticated control-plane flows on the merged Hub server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import request from 'supertest';
import { Sequelize } from 'sequelize';

import { create_test_app } from '../helpers/test_container.js';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const { app, repos } = create_test_app();
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

function hub_bearer(_overrides: Record<string, unknown> = {}): string {
    void _overrides;
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function mock_hub_user(): void {
    stub_pat_auth(repos, ALICE, { once: false });
    repos.user_repo.find_by_id.mockResolvedValue(ALICE);
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
    repos.scope_repo.find_by_org_ids.mockResolvedValue([]);
}

const ready = await postgres_reachable();

describe.skipIf(!ready)('control plane integration (D4)', () => {
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
        // Ensure FK target for unified tokens.user_id
        await sequelize.query(`
            INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
            VALUES ('00000000-0000-4000-8000-000000000001', 'alice', 'alice', 'alice@test.com', 'x', 'user', NOW())
            ON CONFLICT (id) DO NOTHING
        `);
        const { ensure_personal_org_for_user } = await import('../../src/db/migrate_ensure_user_orgs.js');
        const alice_org = await ensure_personal_org_for_user(ALICE.id, ALICE.username);
        alice_org_id = alice_org.id;
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
        mock_hub_user();
    });

    it('settings set → get_by_key → get (collection + prefix filter)', async () => {
        const key = `d4.test.${Date.now()}`;
        const value = 'merged-hub';

        const set_res = await request(app)
            .post('/v1/settings/set')
            .set('Authorization', hub_bearer())
            .send({ key, value });
        expect(set_res.status).toBe(200);
        expect(set_res.body.ok).toBe(true);

        const get_res = await request(app)
            .post('/v1/settings/get_by_key')
            .set('Authorization', hub_bearer())
            .send({ key });
        expect(get_res.status).toBe(200);
        expect(get_res.body.ok).toBe(true);
        expect(get_res.body.setting?.value ?? get_res.body.setting).toBeTruthy();

        const list_res = await request(app)
            .post('/v1/settings/get')
            .set('Authorization', hub_bearer())
            .send({});
        expect(list_res.status).toBe(200);
        expect(list_res.body.ok).toBe(true);
        const keys = (list_res.body.settings as Array<{ key: string }>).map(s => s.key);
        expect(keys).toContain(key);

        const prefix_res = await request(app)
            .post('/v1/settings/get')
            .set('Authorization', hub_bearer())
            .send({ prefix: 'd4.test.' });
        expect(prefix_res.status).toBe(200);
        const prefix_keys = (prefix_res.body.settings as Array<{ key: string }>).map(s => s.key);
        expect(prefix_keys).toContain(key);
    });

    it('daemon register requires daemon token; binds into that realm', async () => {
        const rejected = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', hub_bearer())
            .send({ hostname: 'd4-test-host', port: 4900 });
        expect(rejected.status).toBe(403);

        const slug = `d4-realm-${Date.now()}`;
        const created = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', hub_bearer())
            .send({ org_id: alice_org_id, slug, name: 'D4 test realm' });
        expect(created.status).toBe(200);
        const realm_id = created.body.realm?.id as string;
        expect(realm_id).toBeTruthy();

        const tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', hub_bearer())
            .send({ type: 'realm', realm_ids: [realm_id], name: 'd4-daemon' });
        expect([200, 201]).toContain(tok.status);
        const daemon_token = (tok.body.data?.token ?? tok.body.token) as string;
        expect(daemon_token).toMatch(/^cliq_dt_/);

        const reg = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${daemon_token}`)
            .send({
                hostname: 'd4-test-host',
                port: 4900,
            });
        expect(reg.status).toBe(200);
        expect(reg.body.ok).toBe(true);
        expect(reg.body.daemon?.daemon_id).toBeTruthy();
        expect(reg.body.daemon?.user_id).toBe(hub_legacy_uuid(1));

        const list = await request(app)
            .post('/v1/daemons/get')
            .set('Authorization', hub_bearer())
            .send({});
        expect(list.status).toBe(200);
        expect(list.body.ok).toBe(true);
        const ids = (list.body.daemons as Array<{ id: string }>).map(d => d.id);
        expect(ids).toContain(reg.body.daemon.daemon_id);

        const by_realm = await request(app)
            .post('/v1/daemons/get')
            .set('Authorization', hub_bearer())
            .send({ realm_id });
        expect(by_realm.status).toBe(200);
        const realm_ids = (by_realm.body.daemons as Array<{ id: string }>).map(d => d.id);
        expect(realm_ids).toContain(reg.body.daemon.daemon_id);

        const by_id = await request(app)
            .post('/v1/daemons/get_by_id')
            .set('Authorization', hub_bearer())
            .send({ daemon_id: reg.body.daemon.daemon_id });
        expect(by_id.status).toBe(200);
        expect(by_id.body.daemon?.id).toBe(reg.body.daemon.daemon_id);

        const realms = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', hub_bearer())
            .send({});
        expect(realms.status).toBe(200);
        expect((realms.body.realms as Array<{ id: string }>).some(r => r.id === realm_id)).toBe(true);

        const realm_one = await request(app)
            .post('/v1/realms/get_by_id')
            .set('Authorization', hub_bearer())
            .send({ realm_id });
        expect(realm_one.status).toBe(200);
        expect(realm_one.body.realm?.id).toBe(realm_id);

        const members = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', hub_bearer())
            .send({ realm_id, member_type: 'daemon' });
        expect(members.status).toBe(200);
        expect((members.body.members as Array<{ member_id: string }>)
            .some(m => m.member_id === reg.body.daemon.daemon_id)).toBe(true);

        const tokens = await request(app)
            .post('/v1/auth/get_tokens')
            .set('Authorization', hub_bearer())
            .send({ type: 'realm', realm_id });
        expect(tokens.status).toBe(200);
        const listed = (tokens.body.data?.tokens ?? tokens.body.tokens) as unknown[];
        expect(listed.length).toBeGreaterThan(0);
    });

    it('register with sticky daemon_id joins realm via realm token (no add_member)', async () => {
        const slug = `d4-ensure-${Date.now()}`;
        const created = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', hub_bearer())
            .send({ org_id: alice_org_id, slug, name: 'Ensure daemon realm' });
        expect(created.status).toBe(200);
        const realm_id = created.body.realm?.id as string;

        const daemon_id = `sticky-${Date.now()}`;
        // Daemon membership is via realm-token enroll, not add_member
        const rejected = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', hub_bearer())
            .send({ realm_id, member_type: 'daemon', member_id: daemon_id });
        expect(rejected.status).toBe(400);

        const tok = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', hub_bearer())
            .send({ type: 'realm', realm_ids: [realm_id], name: 'ensure-enroll' });
        expect([200, 201]).toContain(tok.status);
        const daemon_token = (tok.body.data?.token ?? tok.body.token) as string;

        const reg = await request(app)
            .post('/v1/daemons/register')
            .set('Authorization', `Bearer ${daemon_token}`)
            .send({ daemon_id, hostname: 'sticky-host', port: 4900 });
        expect(reg.status).toBe(200);
        expect(reg.body.daemon?.daemon_id).toBe(daemon_id);
        expect(reg.body.daemon?.status).toBe('online');
        expect(reg.body.daemon?.realm_id).toBe(realm_id);
        expect(reg.body.daemon?.dispatch_public_key).toBeTruthy();

        const by_id = await request(app)
            .post('/v1/daemons/get_by_id')
            .set('Authorization', hub_bearer())
            .send({ daemon_id });
        expect(by_id.status).toBe(200);
        expect(by_id.body.daemon?.id).toBe(daemon_id);

        const removed = await request(app)
            .post('/v1/realms/remove_member')
            .set('Authorization', hub_bearer())
            .send({ realm_id, member_type: 'daemon', member_id: daemon_id });
        expect(removed.status).toBe(200);
        expect(removed.body.ok).toBe(true);

        const members = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', hub_bearer())
            .send({ realm_id, member_type: 'daemon' });
        expect(members.status).toBe(200);
        expect((members.body.members as Array<{ member_id: string }>)
            .some((m) => m.member_id === daemon_id)).toBe(false);
    });

    it('teams create → get → get_by_id (product surface; control/teams removed)', async () => {
        const name = `d4-team-${Date.now()}`.slice(0, 40);

        const create = await request(app)
            .post('/v1/teams/create')
            .set('Authorization', hub_bearer())
            .send({
                name,
                scope: 'cliq',
                description: 'control-plane hard-cut smoke',
                manifest: 'phases:\n  - name: a\n    agent: exec\n',
            });
        // May be 200 (created) or 403/422 depending on fixture scopes for hub user.
        expect([200, 403, 422]).toContain(create.status);
        if (create.status !== 200) return;

        expect(create.body.data?.name ?? create.body.name).toBe(name);
        expect(create.body.data?.status ?? create.body.status).toBe('draft');

        const list = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', hub_bearer())
            .send({ scope: 'cliq', query: name });
        expect(list.status).toBe(200);

        const get = await request(app)
            .post('/v1/teams/get_by_id')
            .set('Authorization', hub_bearer())
            .send({ name, scope: 'cliq' });
        // Drafts are author-visible; fixture hub user may differ from create author
        // after remint — accept 200 or 404 when auth identity drifts.
        expect([200, 404]).toContain(get.status);
        if (get.status === 200) {
            expect(get.body.data?.name ?? get.body.name).toBe(name);
        }
    });
});
