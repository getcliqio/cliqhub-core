/**
 * Internal plane vs public /v1 — positive, negative, edge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import express from 'express';
import request from 'supertest';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { require_internal, require_internal_network } from '../../src/middleware/internal_only.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { make_mock_repos, test_config } from '../helpers/test_container.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('$2b$10$hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const SECRET = 'test-secret';

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

    const internal = express.Router();
    internal.post('/auth/signup', require_internal_network, (_req, res) => {
        res.json({ ok: true, data: { signed_up: true } });
    });
    internal.post('/users/new', require_internal, (_req, res) => {
        res.json({ ok: true, data: { id: hub_legacy_uuid(1), username: 'bob' } });
    });
    app.use('/internal', internal);

    app.post('/internal/auth/authenticate_user', require_internal_network, (_req, res) => {
        res.json({ ok: true, data: { token: 'cliq_tok_x' } });
    });

    app.use(error_handler);
    return app;
}

describe('internal plane', () => {
    const repos = make_mock_repos();
    const app = build_app(repos);
    const prev_token = process.env.INTERNAL_API_TOKEN;

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.INTERNAL_API_TOKEN;
    });

    afterEach(() => {
        if (prev_token === undefined) delete process.env.INTERNAL_API_TOKEN;
        if (prev_token !== undefined) process.env.INTERNAL_API_TOKEN = prev_token;
    });

    function mock_user(user: typeof ADMIN | typeof MEMBER) {
        stub_pat_auth(repos, user);
    }

    // ── positive ──────────────────────────────────────────────────

    it('POST /internal/auth/signup succeeds without auth when token unset', async () => {
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
        expect(res.body.error.message).toMatch(/admin/i);
    });

    // ── edge ──────────────────────────────────────────────────────

    it('rejects signup when INTERNAL_API_TOKEN set and header missing', async () => {
        process.env.INTERNAL_API_TOKEN = 'secret-internal';
        const res = await request(app).post('/internal/auth/signup').send({});
        expect(res.status).toBe(403);
    });

    it('accepts signup when INTERNAL_API_TOKEN matches header', async () => {
        process.env.INTERNAL_API_TOKEN = 'secret-internal';
        const res = await request(app)
            .post('/internal/auth/signup')
            .set('X-Internal-Token', 'secret-internal')
            .send({});
        expect(res.status).toBe(200);
    });

    it('rejects admin users/new when internal token wrong', async () => {
        process.env.INTERNAL_API_TOKEN = 'secret-internal';
        mock_user(ADMIN);
        const res = await request(app)
            .post('/internal/users/new')
            .set('Authorization', `Bearer ${TEST_PAT_PLAINTEXT}`)
            .set('X-Internal-Token', 'wrong')
            .send({});
        expect(res.status).toBe(403);
    });
});

// silence unused import in typecheck paths that tree-shake test_config
void test_config;
