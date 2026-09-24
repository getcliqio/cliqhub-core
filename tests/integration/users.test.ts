import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import request from 'supertest';
import express from 'express';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

import * as pw from '../../src/auth/password.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { UsersService } from '../../src/services/users_service.js';
import { UsersController } from '../../src/controllers/users_controller.js';
import { TokensController } from '../../src/controllers/tokens_controller.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { User, ApiToken, Scope, Team, Draft, OrgMember, Org } from '../../src/db/models/index.js';
import type { EnvConfig } from '../../src/config/env.js';

const SECRET = 'test-secret';

const config: EnvConfig = {
    port: 4000,
    database_url: 'postgres://test:test@localhost/test',
    jwt_expires_in: '30d',
    packages_path: '/tmp/test-packages',
    storage_backend: 'local',
    s3_endpoint: '', s3_bucket: '', s3_access_key_id: '', s3_secret_access_key: '',
    allowed_origins: [],
    node_env: 'test',
    rate_limit_public_rpm: 100, rate_limit_auth_rpm: 200, rate_limit_window_ms: 60000,
};

const ADMIN_USER = {
    id: hub_legacy_uuid(1), username: 'admin', display_name: 'Admin',
    email: 'admin@test.com', role: 'admin',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const REGULAR_USER = {
    id: hub_legacy_uuid(2), username: 'john', display_name: 'John',
    email: 'john@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-02',
};

const auth_repos = {
    user_repo: {
        find_by_id: vi.fn().mockResolvedValue(null),
    },
    token_repo: {
        find_by_prefix: vi.fn().mockResolvedValue(null),
        update_last_used: vi.fn().mockResolvedValue(undefined),
    },
    scope_repo: {
        find_owned_by_user: vi.fn().mockResolvedValue([]),
        find_by_org_ids: vi.fn().mockResolvedValue([]),
        find_member_scopes: vi.fn().mockResolvedValue([]),
    },
    org_member_repo: {
        find_orgs_by_user: vi.fn().mockResolvedValue([]),
    },
};

const service_repos = {
    user_repo: {
        find_by_id: vi.fn().mockResolvedValue(null),
        find_by_username_or_email: vi.fn().mockResolvedValue(null),
        find_by_email: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(hub_legacy_uuid(10)),
        find_by_id_with_transaction: vi.fn().mockResolvedValue(null),
        find_password_hash: vi.fn().mockResolvedValue(null),
        update_profile: vi.fn(),
        update_password: vi.fn(),
    },
    scope_repo: {
        create: vi.fn().mockResolvedValue(1),
        find_by_slug_with_transaction: vi.fn().mockResolvedValue(null),
    },
    token_repo: {
        create: vi.fn(),
        delete_by_id_and_user: vi.fn().mockResolvedValue(0),
        list_by_user_id: vi.fn().mockResolvedValue([]),
    },
    audit_repo: {
        create: vi.fn(),
    },
    org_member_repo: {
        find_by_org_and_user: vi.fn().mockResolvedValue(null),
    },
};

const token_repo_for_controller = {
    find_by_prefix: vi.fn().mockResolvedValue(null),
    update_last_used: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: 'tok-1' }),
    find_by_id: vi.fn().mockResolvedValue(null),
    soft_revoke: vi.fn().mockResolvedValue(0),
    delete_by_id_and_user: vi.fn().mockResolvedValue(0),
    list_by_user_id: vi.fn().mockResolvedValue([]),
    list_daemon_tokens_for_realm: vi.fn().mockResolvedValue([]),
    count_by_user_id: vi.fn().mockResolvedValue(0),
    update_hash: vi.fn(),
    update_permissions: vi.fn(),
};

const users_service = new UsersService(
    service_repos.user_repo as any,
    service_repos.scope_repo as any,
    service_repos.token_repo as any,
    service_repos.audit_repo as any,
    service_repos.org_member_repo as any,
    config,
);
const users_controller = new UsersController(users_service);

const tokens_controller = new TokensController(token_repo_for_controller as any, service_repos.org_member_repo as any);

const app = express();
app.use(express.json());
app.use(create_auth_middleware({
    user_repo: auth_repos.user_repo as any,
    token_repo: auth_repos.token_repo as any,
    scope_repo: auth_repos.scope_repo as any,
    org_member_repo: auth_repos.org_member_repo as any,
}));

app.post('/v1/users/get', users_controller.get);
app.post('/v1/users/get_by_id', users_controller.get_by_id);
app.post('/internal/users/new', users_controller.new_user);
app.post('/v1/users/update', users_controller.update);
app.post('/internal/users/delete', users_controller.delete_user);
app.post('/internal/users/suspend', users_controller.suspend);
app.post('/internal/users/change_password', users_controller.change_password);
app.post('/v1/auth/generate_token', tokens_controller.generate_token);
app.post('/v1/auth/get_tokens', tokens_controller.get_tokens);
app.post('/v1/auth/revoke_token', tokens_controller.revoke_token);
app.use(error_handler);

function admin_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function user_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function mock_admin_auth() {
    stub_pat_auth(auth_repos as any, ADMIN_USER);
}

function mock_user_auth() {
    stub_pat_auth(auth_repos as any, REGULAR_USER);
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ── POST /v1/users/get ──────────────────────────────────────────────

describe('POST /v1/users/get', () => {
    it('returns 401 for unauthenticated', async () => {
        const res = await request(app).post('/v1/users/get').send({});
        expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin without org_id', async () => {
        mock_user_auth();
        const res = await request(app)
            .post('/v1/users/get')
            .set('Authorization', user_header())
            .send({});
        expect(res.status).toBe(403);
    });

    it('returns users for admin', async () => {
        mock_admin_auth();
        vi.mocked(User.count).mockResolvedValueOnce(1 as any);
        vi.mocked(User.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(1), username: 'john' }] as any);

        const res = await request(app)
            .post('/v1/users/get')
            .set('Authorization', admin_header())
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.users).toHaveLength(1);
        expect(res.body.data.total).toBe(1);
    });

    it('returns org members with org_id for org admin', async () => {
        mock_user_auth();
        service_repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ role: 'admin' });
        vi.mocked(OrgMember.findAndCountAll).mockResolvedValueOnce({
            count: 1,
            rows: [{ role: 'admin', User: { id: hub_legacy_uuid(2), username: 'john', display_name: 'John', email: 'john@test.com', role: 'user', suspended_at: null, created_at: '2025-01-02' } }],
        } as any);

        const res = await request(app)
            .post('/v1/users/get')
            .set('Authorization', user_header())
            .send({ org_id: hub_legacy_uuid(1) });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.users).toHaveLength(1);
    });
});

// ── POST /v1/users/get_by_id ────────────────────────────────────────

describe('POST /v1/users/get_by_id', () => {
    it('returns 403 for non-admin', async () => {
        mock_user_auth();
        vi.mocked(User.findByPk).mockResolvedValueOnce({ id: hub_legacy_uuid(1), role: 'user' } as any);
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce([] as any);
        const res = await request(app)
            .post('/v1/users/get_by_id')
            .set('Authorization', user_header())
            .send({ user_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(403);
    });

    it('returns user detail for admin', async () => {
        mock_admin_auth();
        vi.mocked(User.findByPk).mockResolvedValueOnce({ id: hub_legacy_uuid(2), username: 'john', display_name: 'John', email: 'john@test.com', role: 'user', suspended_at: null, suspended_reason: '', created_at: '2025-01-02' } as any);
        vi.mocked(Scope.count).mockResolvedValueOnce(3 as any);
        vi.mocked(Team.count).mockResolvedValueOnce(5 as any);
        vi.mocked(ApiToken.count).mockResolvedValueOnce(1 as any);
        vi.mocked(Draft.count).mockResolvedValueOnce(0 as any);
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce([] as any);

        const res = await request(app)
            .post('/v1/users/get_by_id')
            .set('Authorization', admin_header())
            .send({ user_id: hub_legacy_uuid(2) });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.username).toBe('john');
    });

    it('returns 404 when user not found', async () => {
        mock_admin_auth();
        vi.mocked(User.findByPk).mockResolvedValueOnce(null);

        const res = await request(app)
            .post('/v1/users/get_by_id')
            .set('Authorization', admin_header())
            .send({ user_id: hub_legacy_uuid(999) });

        expect(res.status).toBe(404);
    });
});

// ── POST /internal/users/new ──────────────────────────────────────────────

describe('POST /internal/users/new', () => {
    it('returns 403 for non-admin', async () => {
        mock_user_auth();
        const res = await request(app)
            .post('/internal/users/new')
            .set('Authorization', user_header())
            .send({ username: 'newuser', email: 'new@test.com', password: 'password123' });
        expect(res.status).toBe(403);
    });

    it('creates user for admin', async () => {
        mock_admin_auth();
        service_repos.user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
        service_repos.user_repo.create.mockResolvedValueOnce(hub_legacy_uuid(10));
        service_repos.scope_repo.create.mockResolvedValueOnce(hub_legacy_uuid(1));

        const res = await request(app)
            .post('/internal/users/new')
            .set('Authorization', admin_header())
            .send({ username: 'newuser', email: 'new@test.com', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.id).toBe(hub_legacy_uuid(10));
        expect(res.body.data.username).toBe('newuser');
    });

    it('returns 422 for missing username', async () => {
        mock_admin_auth();
        const res = await request(app)
            .post('/internal/users/new')
            .set('Authorization', admin_header())
            .send({});
        expect(res.status).toBe(422);
    });
});

// ── POST /v1/users/update ───────────────────────────────────────────

describe('POST /v1/users/update', () => {
    it('updates own profile without user_id', async () => {
        mock_user_auth();
        service_repos.user_repo.update_profile.mockResolvedValueOnce(undefined);
        service_repos.user_repo.find_by_id.mockResolvedValueOnce({
            ...REGULAR_USER, display_name: 'New',
        });

        const res = await request(app)
            .post('/v1/users/update')
            .set('Authorization', user_header())
            .send({ display_name: 'New' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.updated).toBe(true);
    });

    it('returns 403 when non-admin updates another user', async () => {
        mock_user_auth();
        vi.mocked(User.findByPk).mockResolvedValueOnce({ id: hub_legacy_uuid(99), role: 'user' } as any);
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce([] as any);
        const res = await request(app)
            .post('/v1/users/update')
            .set('Authorization', user_header())
            .send({ user_id: hub_legacy_uuid(99), display_name: 'X' });
        expect(res.status).toBe(403);
    });

    it('returns 422 for empty body', async () => {
        mock_user_auth();
        const res = await request(app)
            .post('/v1/users/update')
            .set('Authorization', user_header())
            .send({});
        expect(res.status).toBe(422);
    });
});

// ── POST /internal/users/delete ───────────────────────────────────────────

describe('POST /internal/users/delete', () => {
    it('returns 403 for non-admin', async () => {
        mock_user_auth();
        const res = await request(app)
            .post('/internal/users/delete')
            .set('Authorization', user_header())
            .send({ user_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(403);
    });

    it('returns 422 for self-delete', async () => {
        mock_admin_auth();
        const res = await request(app)
            .post('/internal/users/delete')
            .set('Authorization', admin_header())
            .send({ user_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(422);
    });
});

// ── POST /internal/users/suspend ─────────────────────────────────────────

describe('POST /internal/users/suspend', () => {
    it('returns 403 for non-admin', async () => {
        mock_user_auth();
        const res = await request(app)
            .post('/internal/users/suspend')
            .set('Authorization', user_header())
            .send({ user_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(403);
    });

    it('suspends user for admin', async () => {
        mock_admin_auth();
        vi.mocked(User.findByPk).mockResolvedValueOnce({ id: hub_legacy_uuid(2), username: 'john' } as any);
        vi.mocked(User.update).mockResolvedValueOnce([1] as any);

        const res = await request(app)
            .post('/internal/users/suspend')
            .set('Authorization', admin_header())
            .send({ user_id: hub_legacy_uuid(2), reason: 'spam' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.suspended).toBe(true);
    });
});

// ── POST /internal/users/change_password ──────────────────────────────────

describe('POST /internal/users/change_password', () => {
    it('returns 401 for unauthenticated', async () => {
        const res = await request(app)
            .post('/internal/users/change_password')
            .send({ current_password: 'old', new_password: 'newpass123' });
        expect(res.status).toBe(401);
    });

    it('changes password', async () => {
        mock_user_auth();
        service_repos.user_repo.find_password_hash.mockResolvedValueOnce('existing_hash');
        vi.mocked(pw.verify_password).mockResolvedValueOnce(true);

        const res = await request(app)
            .post('/internal/users/change_password')
            .set('Authorization', user_header())
            .send({ current_password: 'oldpass123', new_password: 'newpass123' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.message).toBe('Password changed');
    });
});

// ── POST /v1/auth/generate_token ────────────────────────────────────────

describe('POST /v1/auth/generate_token', () => {
    it('creates token for authenticated user', async () => {
        mock_user_auth();

        const res = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', user_header())
            .send({ type: 'user', name: 'My Token' });

        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.token).toMatch(/^cliq_tok_/);
        expect(res.body.data.name).toBe('My Token');
    });

    it('creates token with default name when none provided', async () => {
        mock_user_auth();
        const res = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', user_header())
            .send({ type: 'user' });
        expect(res.status).toBe(201);
        expect(res.body.data.name).toBe('API token');
    });

    it('returns 401 for unauthenticated', async () => {
        const res = await request(app)
            .post('/v1/auth/generate_token')
            .send({ type: 'user', name: 'Token' });
        expect(res.status).toBe(401);
    });
});

// ── POST /v1/auth/get_tokens ───────────────────────────────────────

describe('POST /v1/auth/get_tokens', () => {
    it('returns own tokens for regular user', async () => {
        mock_user_auth();
        token_repo_for_controller.list_by_user_id.mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), name: 'CLI token', permissions: {}, created_at: '2025-01-01', last_used_at: null },
        ]);
        token_repo_for_controller.count_by_user_id.mockResolvedValueOnce(1);

        const res = await request(app)
            .post('/v1/auth/get_tokens')
            .set('Authorization', user_header())
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.tokens).toHaveLength(1);
    });
});

// ── POST /v1/auth/revoke_token ─────────────────────────────────────

describe('POST /v1/auth/revoke_token', () => {
    it('revokes own token for user', async () => {
        mock_user_auth();
        token_repo_for_controller.find_by_id.mockResolvedValueOnce({
            id: 'tok-5', type: 'user', user_id: hub_legacy_uuid(2), name: 'x', permissions: {}, revoked_at: null,
        });
        token_repo_for_controller.soft_revoke.mockResolvedValueOnce(1);

        const res = await request(app)
            .post('/v1/auth/revoke_token')
            .set('Authorization', user_header())
            .send({ type: 'user', token_id: 'tok-5' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.revoked).toBe(true);
    });

    it('returns 401 for unauthenticated', async () => {
        const res = await request(app)
            .post('/v1/auth/revoke_token')
            .send({ type: 'user', token_id: 5 });
        expect(res.status).toBe(401);
    });
});
