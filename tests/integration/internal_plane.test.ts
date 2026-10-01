/**
 * Internal plane vs public /v1 — positive, negative, edge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import express from 'express';
import request from 'supertest';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { create_route_policy_middleware } from '../../src/middleware/enforce_route_policy.js';
import type { AccessStore } from '../../src/auth/route_policy/engine.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { make_mock_repos, test_config } from '../helpers/test_container.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('$2b$10$hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const ADMIN = {
    id: hub_legacy_uuid(99), username: 'admin', display_name: 'Admin',
    email: 'admin@test.com', role: 'admin' as const,
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const MEMBER = {
    id: hub_legacy_uuid(1), username: 'alice', display_name: 'Alice',
    email: 'alice@test.com', role: 'user' as const,
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

function build_app(repos: ReturnType<typeof make_mock_repos>) {
    const app = express();
    app.use(express.json());
    app.use(create_auth_middleware({
        user_repo: repos.user_repo as any,
        token_repo: repos.token_repo as any,
        scope_repo: repos.scope_repo as any,
        org_member_repo: repos.org_member_repo as any,
    }));
    // bff_only / site_admin policies never consult the store.
    app.use(create_route_policy_middleware({ store: {} as AccessStore }));

    const internal = express.Router();
    internal.post('/auth/signup', (_req, res) => {
        res.json({ ok: true, data: { signed_up: true } });
    });
    internal.post('/users/new', (_req, res) => {
        res.json({ ok: true, data: { id: hub_legacy_uuid(1), username: 'bob' } });
    });
    app.use('/internal', internal);

    app.post('/internal/auth/authenticate_user', (_req, res) => {
        res.json({ ok: true, data: { token: 'cliq_tok_x' } });
    });

    app.use(error_handler);
    return app;
}

describe('internal plane', () => {
    const repos = make_mock_repos();
    const app = build_app(repos);

    beforeEach(() => {
        vi.clearAllMocks();
    });

    function mock_user(user: typeof ADMIN | typeof MEMBER) {
        stub_pat_auth(repos, user);
    }

    // ── positive ──────────────────────────────────────────────────

    it('POST /internal/auth/signup succeeds without auth', async () => {
        const res = await request(app).post('/internal/auth/signup').send({});
        expect(res.status).toBe(200);
        expect(res.body.data.signed_up).toBe(true);
    });

    it('POST /internal/users/new succeeds for site admin', async () => {
        mock_user(ADMIN);
        const res = await request(app)
            .post('/internal/users/new')
            .set('Authorization', `Bearer ${TEST_PAT_PLAINTEXT}`)
            .send({ username: 'bob' });
        expect(res.status).toBe(200);
        expect(res.body.data.username).toBe('bob');
    });

    it('POST /internal/auth/authenticate_user is on internal plane', async () => {
        const res = await request(app).post('/internal/auth/authenticate_user').send({});
        expect(res.status).toBe(200);
    });

    it('POST /v1/auth/login is not mounted (404)', async () => {
        const res = await request(app).post('/v1/auth/login').send({});
        expect(res.status).toBe(404);
    });

    // ── negative ──────────────────────────────────────────────────

    it('POST /v1/auth/signup is not mounted (404)', async () => {
        const res = await request(app).post('/v1/auth/signup').send({});
        expect(res.status).toBe(404);
    });

    it('POST /internal/users/new rejects unauthenticated', async () => {
        const res = await request(app).post('/internal/users/new').send({});
        expect(res.status).toBe(401);
    });

    it('POST /internal/users/new rejects non-admin member', async () => {
        mock_user(MEMBER);
        const res = await request(app)
            .post('/internal/users/new')
            .set('Authorization', `Bearer ${TEST_PAT_PLAINTEXT}`)
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('forbidden');
    });
});

// silence unused import in typecheck paths that tree-shake test_config
void test_config;
