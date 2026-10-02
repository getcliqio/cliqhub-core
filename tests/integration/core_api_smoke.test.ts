/**
 * Core control-plane smoke — Hub JWT/PAT auth only (no decode-only path).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import request from 'supertest';
import { Sequelize } from 'sequelize';

import { create_test_app } from '../helpers/test_container.js';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import { database_url } from '../migrated_platform/helpers/control_plane_store.js';

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

const DATABASE_URL = database_url;

async function postgres_reachable(): Promise<boolean> {
    const probe = new Sequelize(DATABASE_URL, {
        dialect: 'postgres',
        logging: false,
    });
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

/** Unsigned / forged token — Hub verify must reject. */
function forged_bearer(): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        user_id: hub_legacy_uuid(1),
        username: 'alice',
        role: 'user',
        exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    return `Bearer ${header}.${payload}.forged`;
}

function mock_hub_user(): void {
    stub_pat_auth(repos, ALICE, { once: false });
    repos.user_repo.find_profile_by_id.mockResolvedValue(ALICE);
    repos.scope_repo.find_owned_by_user.mockResolvedValue([
        { id: hub_legacy_uuid(1), slug: 'cliq', display_name: 'Cliq', visibility: 'public', scope_type: 'user', owner_id: hub_legacy_uuid(1), org_id: null },
    ]);
    repos.org_member_repo.find_orgs_by_user.mockResolvedValue([]);
    repos.scope_repo.find_member_scopes.mockResolvedValue([]);
    repos.scope_repo.find_default_scopes.mockResolvedValue([]);
    repos.scope_repo.find_by_org_ids.mockResolvedValue([]);
}

describe('core_api smoke', () => {
    beforeEach(() => vi.clearAllMocks());

    it('GET /v1/health returns 200', async () => {
        const res = await request(app).get('/v1/health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.timestamp).toBe('number');
    });

    it('POST /v1/settings/get without Bearer returns 401', async () => {
        const res = await request(app).post('/v1/settings/get').send({});
        expect(res.status).toBe(401);
        expect(res.body.ok).toBe(false);
    });

    it('POST /v1/settings/get with forged/unsigned JWT returns 401', async () => {
        const res = await request(app)
            .post('/v1/settings/get')
            .set('Authorization', forged_bearer())
            .send({});
        expect(res.status).toBe(401);
    });

    it('POST /v1/teams/list is not mounted (Core collision deferred to D3)', async () => {
        const res = await request(app).post('/v1/teams/list').send({});
        expect(res.status).toBe(404);
    });
});

const ready = await postgres_reachable();

describe.skipIf(!ready)('core_api settings/get with Hub JWT (postgres)', () => {
    beforeAll(async () => {
        const { close_control_plane_store, init_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        const { init_sequelize, close_sequelize } = await import(
            '../../src/db/sequelize.js'
        );
        const { init_models } = await import(
            '../../src/models/index.js'
        );
        const { move_registry_to_cliq_schema } = await import(
            '../../src/models/migrations/hub_schema_migrations.js'
        );
        await close_control_plane_store();
        // Registry (public) sequelize must be initialized so require_auth can query public.scopes
        const hub_sq = init_sequelize(DATABASE_URL);
        init_models(hub_sq);
        await move_registry_to_cliq_schema(hub_sq);
        await init_control_plane_store(DATABASE_URL);
    });

    afterAll(async () => {
        const { close_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        const { close_sequelize } = await import(
            '../../src/db/sequelize.js'
        );
        await close_control_plane_store();
        await close_sequelize();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mock_hub_user();
    });

    it('settings are site-admin only: a regular user gets 403 (S1/S2)', async () => {
        for (const path of ['/v1/settings/set', '/v1/settings/remove', '/v1/settings/get', '/v1/settings/get_by_key']) {
            const res = await request(app)
                .post(path)
                .set('Authorization', hub_bearer())
                .send({ key: 'docker.base_image', value: 'x' });
            expect(res.status, path).toBe(403);
        }
    });

    it('POST /v1/settings/get with valid Hub PAT returns 200', async () => {
        // Settings are site-admin only (S1/S2).
        const SITE_ADMIN = { ...ALICE, role: 'admin' as const };
        stub_pat_auth(repos, SITE_ADMIN, { once: false });
        repos.user_repo.find_profile_by_id.mockResolvedValue(SITE_ADMIN);
        const res = await request(app)
            .post('/v1/settings/get')
            .set('Authorization', hub_bearer())
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.settings)).toBe(true);
    });

    it('POST /v1/settings/get with JWT Bearer returns 401', async () => {
        const res = await request(app)
            .post('/v1/settings/get')
            .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid')
            .send({});

        expect(res.status).toBe(401);
    });
});
