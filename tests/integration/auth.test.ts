import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import request from 'supertest';
import { sign_token } from '../../src/auth/jwt.js';
import {
    stub_pat_auth,
    TEST_PAT_PLAINTEXT,
} from '../helpers/pat_auth.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('$2b$10$hashed'),
    verify_password: vi.fn(),
}));

import * as pw from '../../src/auth/password.js';
import { create_test_app } from '../helpers/test_container.js';

const { app, repos } = create_test_app();
const SECRET = 'test-secret';

const ALICE_USER = {
    id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice',
    email: 'alice@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const ADMIN_USER = {
    id: hub_legacy_uuid(99), username: 'admin', display_name: 'Admin',
    email: 'admin@test.com', role: 'admin',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

describe('POST /internal/auth/signup', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with user, account, and session PAT on success', async () => {
        repos.user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
        repos.org_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.user_repo.create.mockResolvedValueOnce(1);
        repos.scope_repo.find_by_slug_with_transaction.mockResolvedValueOnce(null);
        repos.scope_repo.create.mockResolvedValueOnce(1);
        repos.user_repo.find_by_id_with_transaction.mockResolvedValueOnce(ALICE_USER);
        repos.user_repo.find_by_id.mockResolvedValue(ALICE_USER);

        const res = await request(app)
            .post('/internal/auth/signup')
            .send({
                username: 'alice',
                email: 'alice@test.com',
                password: 'password123',
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.token).toMatch(/^cliq_tok_/);
        expect(res.body.data.user.username).toBe('alice');
        expect(res.body.data.account_slug).toBe('alice');
        expect(res.body.data.default_realm_slug).toBe('alice.default');
    });

    it('returns 200 when account_slug is omitted (derived from username)', async () => {
        repos.user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
        repos.org_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.user_repo.create.mockResolvedValueOnce(1);
        repos.scope_repo.find_by_slug_with_transaction.mockResolvedValueOnce(null);
        repos.scope_repo.create.mockResolvedValueOnce(1);
        repos.user_repo.find_by_id_with_transaction.mockResolvedValueOnce(ALICE_USER);
        repos.user_repo.find_by_id.mockResolvedValue(ALICE_USER);

        const res = await request(app).post('/internal/auth/signup')
            .send({ username: 'alice', email: 'a@b.com', password: 'password123' });
        expect(res.status).toBe(200);
        expect(res.body.data.account_slug).toBe('alice');
    });

    it('returns 422 for missing fields', async () => {
        const res = await request(app).post('/internal/auth/signup').send({ username: 'alice' });
        expect(res.status).toBe(422);
    });

    it('returns 422 for invalid email', async () => {
        const res = await request(app).post('/internal/auth/signup')
            .send({ username: 'alice', email: 'not-email', password: 'password123' });
        expect(res.status).toBe(422);
    });

    it('returns 422 for short password', async () => {
        const res = await request(app).post('/internal/auth/signup')
            .send({ username: 'alice', email: 'a@b.com', password: 'short' });
        expect(res.status).toBe(422);
    });

    it('returns 409 for duplicate username', async () => {
        repos.user_repo.find_by_username_or_email.mockResolvedValueOnce({ id: hub_legacy_uuid(99) });
        const res = await request(app).post('/internal/auth/signup')
            .send({ username: 'alice', email: 'alice@test.com', password: 'password123' });
        expect(res.status).toBe(409);
    });

    it('returns 422 for reserved username', async () => {
        const res = await request(app).post('/internal/auth/signup')
            .send({ username: 'admin', email: 'a@b.com', password: 'password123' });
        expect(res.status).toBe(422);
    });
});

describe('POST /internal/auth/authenticate_user', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with session PAT and identity on valid credentials', async () => {
        repos.user_repo.find_by_username.mockResolvedValueOnce({
            id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', role: 'user', suspended_at: null,
        });
        repos.user_repo.find_by_id.mockResolvedValue(ALICE_USER);
        vi.mocked(pw.verify_password).mockResolvedValueOnce(true);

        const res = await request(app).post('/internal/auth/authenticate_user')
            .send({ username: 'alice', password: 'password123' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.token).toMatch(/^cliq_tok_/);
        expect(res.body.data.user.username).toBe('alice');
    });

    it('returns 401 for wrong password', async () => {
        repos.user_repo.find_by_username.mockResolvedValueOnce({
            id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', role: 'user', suspended_at: null,
        });
        vi.mocked(pw.verify_password).mockResolvedValueOnce(false);

        const res = await request(app).post('/internal/auth/authenticate_user')
            .send({ username: 'alice', password: 'wrong' });
        expect(res.status).toBe(401);
    });

    it('returns 401 for non-existent user', async () => {
        repos.user_repo.find_by_username.mockResolvedValueOnce(null);
        const res = await request(app).post('/internal/auth/authenticate_user')
            .send({ username: 'ghost', password: 'p' });
        expect(res.status).toBe(401);
    });

    it('returns 403 for suspended user', async () => {
        repos.user_repo.find_by_username.mockResolvedValueOnce({
            id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', role: 'user', suspended_at: '2025-06-01',
        });
        vi.mocked(pw.verify_password).mockResolvedValueOnce(true);

        const res = await request(app).post('/internal/auth/authenticate_user')
            .send({ username: 'alice', password: 'p' });
        expect(res.status).toBe(403);
    });

    it('returns 422 for missing fields', async () => {
        const res = await request(app).post('/internal/auth/authenticate_user')
            .send({ username: 'alice' });
        expect(res.status).toBe(422);
    });
});

describe('POST /internal/auth/issue_session_token', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 for site admin Bearer', async () => {
        vi.mocked(pw.verify_password).mockResolvedValue(true);
        repos.token_repo.find_by_prefix.mockResolvedValue({
            id: 'admin-tok', type: 'user', user_id: hub_legacy_uuid(99), token_hash: 'hash', permissions: {}, scopes: [],
        });
        repos.user_repo.find_by_id.mockImplementation(async (id: string) => {
            if (id === hub_legacy_uuid(99)) return ADMIN_USER;
            if (id === hub_legacy_uuid(2)) return { ...ALICE_USER, id: hub_legacy_uuid(2), username: 'bob' };
            return null;
        });
        repos.scope_repo.find_owned_by_user.mockResolvedValue([]);
        repos.org_member_repo.find_orgs_by_user.mockResolvedValue([]);
        repos.scope_repo.find_member_scopes.mockResolvedValue([]);
        repos.token_repo.create.mockResolvedValue({ id: 'session-tok' });

        const res = await request(app)
            .post('/internal/auth/issue_session_token')
            .set('Authorization', `Bearer ${TEST_PAT_PLAINTEXT}`)
            .send({ user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(200);
        expect(res.body.data.user_id).toBe(hub_legacy_uuid(2));
        expect(res.body.data.token).toMatch(/^cliq_tok_/);
    });

    it('returns 403 for non-admin Bearer', async () => {
        vi.mocked(pw.verify_password).mockResolvedValue(true);
        repos.token_repo.find_by_prefix.mockResolvedValue({
            id: 'u-tok', type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions: {}, scopes: [],
        });
        repos.user_repo.find_by_id.mockResolvedValue(ALICE_USER);
        repos.scope_repo.find_owned_by_user.mockResolvedValue([]);
        repos.org_member_repo.find_orgs_by_user.mockResolvedValue([]);
        repos.scope_repo.find_member_scopes.mockResolvedValue([]);

        const res = await request(app)
            .post('/internal/auth/issue_session_token')
            .set('Authorization', `Bearer ${TEST_PAT_PLAINTEXT}`)
            .send({ user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(403);
    });

    it('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/internal/auth/issue_session_token')
            .send({ user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(401);
    });
});

describe('POST /internal/auth/revoke_session_token', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns ok and soft_revokes matching PAT', async () => {
        repos.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: 'tok-1', type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash',
        });
        vi.mocked(pw.verify_password).mockResolvedValueOnce(true);

        const res = await request(app)
            .post('/internal/auth/revoke_session_token')
            .send({ token: TEST_PAT_PLAINTEXT });
        expect(res.status).toBe(200);
        expect(res.body.data.ok).toBe(true);
        expect(repos.token_repo.soft_revoke_by_id).toHaveBeenCalledWith('tok-1');
    });

    it('returns ok for unknown token (idempotent)', async () => {
        repos.token_repo.find_by_prefix.mockResolvedValueOnce(null);
        const res = await request(app)
            .post('/internal/auth/revoke_session_token')
            .send({ token: 'cliq_tok_unknown' });
        expect(res.status).toBe(200);
        expect(res.body.data.ok).toBe(true);
    });
});

describe('removed public JWT session routes', () => {
    it('POST /v1/auth/login returns 404', async () => {
        const res = await request(app)
            .post('/v1/auth/login')
            .send({ username: 'alice', password: 'password123' });
        expect(res.status).toBe(404);
    });

    it('POST /v1/auth/me returns 404', async () => {
        const res = await request(app).post('/v1/auth/me').send({});
        expect(res.status).toBe(404);
    });

    it('POST /v1/auth/refresh returns 404', async () => {
        const res = await request(app).post('/v1/auth/refresh').send({});
        expect(res.status).toBe(404);
    });

    it('POST /v1/auth/impersonate returns 404', async () => {
        const res = await request(app).post('/v1/auth/impersonate').send({ user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(404);
    });
});

describe('JWT Bearer is rejected', () => {
    it('scopes/get with JWT returns 401', async () => {
        const jwt = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        const res = await request(app)
            .post('/v1/scopes/get')
            .set('Authorization', `Bearer ${jwt}`)
            .send({ mine: true });
        expect(res.status).toBe(401);
    });

    it('scopes/get with cliq_dk_ returns 401', async () => {
        const res = await request(app)
            .post('/v1/scopes/get')
            .set('Authorization', 'Bearer cliq_dk_abcdef1234567890abcdef1234567890abcdef1234567890')
            .send({ mine: true });
        expect(res.status).toBe(401);
    });

    it('scopes/get with stubbed PAT returns 200', async () => {
        vi.mocked(pw.verify_password).mockResolvedValueOnce(true);
        const auth = stub_pat_auth(repos, ALICE_USER);
        const res = await request(app)
            .post('/v1/scopes/get')
            .set('Authorization', auth)
            .send({ mine: true });
        expect(res.status).toBe(200);
        expect(res.body.data.scopes).toEqual([]);
    });
});

describe('legacy /api/auth (removed)', () => {
    it('POST /api/auth/login returns 404', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: 'alice', password: 'password123' });
        expect(res.status).toBe(404);
    });

    it('POST /api/auth/me returns 404', async () => {
        const res = await request(app).post('/api/auth/me').send({});
        expect(res.status).toBe(404);
    });
});

describe('legacy /api registry (removed)', () => {
    it('POST /api/teams/get returns 404', async () => {
        const res = await request(app).post('/api/teams/get').send({});
        expect(res.status).toBe(404);
    });

    it('POST /api/users/get returns 404', async () => {
        const res = await request(app).post('/api/users/get').send({});
        expect(res.status).toBe(404);
    });
});
