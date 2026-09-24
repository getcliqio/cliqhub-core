/**
 * D3: Core colliding paths live only under /v1/control/* and /v1/dispatch/*.
 * Hub registry keeps /v1/teams/* and /v1/scopes/* (different handlers).
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
        { id: hub_legacy_uuid(1), slug: 'cliq', display_name: 'Cliq', visibility: 'public', scope_type: 'user', owner_id: hub_legacy_uuid(1), org_id: null },
    ]);
    repos.org_member_repo.find_orgs_by_user.mockResolvedValue([]);
    repos.scope_repo.find_member_scopes.mockResolvedValue([]);
    repos.scope_repo.find_by_org_ids.mockResolvedValue([]);
}

describe('core_api collision renames (D3)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('legacy Core /v1/auth/keys/public is not mounted (404)', async () => {
        mock_hub_user();
        const res = await request(app)
            .post('/v1/auth/keys/public')
            .set('Authorization', hub_bearer())
            .send({});
        expect(res.status).toBe(404);
    });

    it('legacy Core /v1/teams/list is not mounted (404 — registry has no list)', async () => {
        mock_hub_user();
        const res = await request(app)
            .post('/v1/teams/list')
            .set('Authorization', hub_bearer())
            .send({});
        expect(res.status).toBe(404);
    });

    it('legacy Core /v1/scopes/list is not mounted (404)', async () => {
        mock_hub_user();
        const res = await request(app)
            .post('/v1/scopes/list')
            .set('Authorization', hub_bearer())
            .send({});
        expect(res.status).toBe(404);
    });

    it('legacy deprecated /v1/orgs/dispatch-public-key is not mounted (404)', async () => {
        const res = await request(app).post('/v1/orgs/dispatch-public-key').send({});
        expect(res.status).toBe(404);
    });
});

const ready = await postgres_reachable();

describe.skipIf(!ready)('core_api control + dispatch paths (postgres)', () => {
    beforeAll(async () => {
        const { close_control_plane_store, init_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        const { close_sequelize, init_sequelize } = await import(
            '../../src/db/sequelize.js'
        );
        const { init_models } = await import('../../src/db/models/index.js');

        await close_control_plane_store();
        await close_sequelize();

        /** The auth-side sequelize (User, Org, OrgMember) is a separate
         *  connection from the control-plane sequelize. RealmService.create
         *  needs it initialized to look up the caller's user row and mint
         *  a personal org for the NOT NULL realms.org_id. */
        const sequelize = init_sequelize(DATABASE_URL);
        init_models(sequelize);
        await sequelize.sync();

        await init_control_plane_store(DATABASE_URL);

        /** Seed alice (user_id=1) — otherwise the personal-org lookup
         *  finds no username and realm create fails notNull. */
        await sequelize.query(`
            INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
            VALUES ('00000000-0000-4000-8000-000000000001', 'alice', 'Alice', 'alice@test.com', 'x', 'user', NOW())
            ON CONFLICT (id) DO NOTHING
        `);
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

    it('POST /v1/teams/get returns 200', async () => {
        const res = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', hub_bearer())
            .send({});
        expect(res.status).toBe(200);
        const teams = res.body.data?.teams ?? res.body.teams;
        expect(Array.isArray(teams)).toBe(true);
    });

    it('POST /v1/control/scopes/get returns 200', async () => {
        const res = await request(app)
            .post('/v1/control/scopes/get')
            .set('Authorization', hub_bearer())
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.scopes)).toBe(true);
    });

    it('POST /v1/realms/keys/public is not mounted (404 — moved to /auth)', async () => {
        const res = await request(app)
            .post('/v1/realms/keys/public')
            .set('Authorization', hub_bearer())
            .send({ realm_id: 'any' });
        expect(res.status).toBe(404);
    });

    it('POST /v1/auth/get_dispatch_public_key without realm_id returns 400', async () => {
        const res = await request(app)
            .post('/v1/auth/get_dispatch_public_key')
            .set('Authorization', hub_bearer())
            .send({});
        expect(res.status).toBe(400);
    });

    it('POST /v1/auth/get_dispatch_public_key with realm_id returns 200', async () => {
        const created = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', hub_bearer())
            .send({ slug: `disp-key-${Date.now()}`.slice(0, 40), name: 'Dispatch key realm' });
        if (created.status !== 200) {
            throw new Error(`/v1/realms/create failed: ${created.status} ${JSON.stringify(created.body)}`);
        }
        expect(created.status).toBe(200);
        const realm_id = created.body.realm?.id as string;
        expect(realm_id).toBeTruthy();

        const res = await request(app)
            .post('/v1/auth/get_dispatch_public_key')
            .set('Authorization', hub_bearer())
            .send({ realm_id });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.public_key_pem).toContain('BEGIN PUBLIC KEY');
        expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY/i);
        expect(res.body.realm_id).toBe(realm_id);
    });

    it('POST /v1/auth/rotate_dispatch_key rotates keypair', async () => {
        const created = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', hub_bearer())
            .send({ slug: `disp-rot-${Date.now()}`.slice(0, 40), name: 'Dispatch rotate realm' });
        expect(created.status).toBe(200);
        const realm_id = created.body.realm?.id as string;

        const before = await request(app)
            .post('/v1/auth/get_dispatch_public_key')
            .set('Authorization', hub_bearer())
            .send({ realm_id });
        expect(before.status).toBe(200);
        const pem_before = before.body.public_key_pem as string;

        const rotated = await request(app)
            .post('/v1/auth/rotate_dispatch_key')
            .set('Authorization', hub_bearer())
            .send({ realm_id });
        expect(rotated.status).toBe(200);
        expect(rotated.body.ok).toBe(true);
        expect(rotated.body.public_key_pem).toContain('BEGIN PUBLIC KEY');
        expect(rotated.body.public_key_pem).not.toBe(pem_before);
        expect(JSON.stringify(rotated.body)).not.toMatch(/PRIVATE KEY/i);
    });
});
