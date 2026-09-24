import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import express from 'express';
import request from 'supertest';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import { make_mock_repos, test_config } from '../helpers/test_container.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { ScopesService } from '../../src/services/scopes_service.js';
import { ScopesController } from '../../src/controllers/scopes_controller.js';
import { User, Scope } from '../../src/db/models/index.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const SECRET = 'test-secret';
const config = test_config();
const repos = make_mock_repos();

const app = express();
app.use(express.json());
app.use(create_auth_middleware({
    user_repo: repos.user_repo as any,
    token_repo: repos.token_repo as any,
    scope_repo: repos.scope_repo as any,
    org_member_repo: repos.org_member_repo as any,
}));

const org_repo = {
    find_by_id: vi.fn().mockResolvedValue(null),
    find_by_slug: vi.fn().mockResolvedValue(null),
};

const local_org_member_repo = {
    find_orgs_by_user: vi.fn().mockResolvedValue([]),
    find_by_org_and_user: vi.fn().mockResolvedValue(null),
    list_admins_by_org: vi.fn().mockResolvedValue([]),
};

const scope_member_repo = {
    create: vi.fn().mockResolvedValue(undefined),
    create_on_conflict_ignore: vi.fn().mockResolvedValue(undefined),
    find_by_scope_and_user: vi.fn().mockResolvedValue(null),
    delete_by_scope_and_user: vi.fn().mockResolvedValue(1),
    delete_by_scope_id: vi.fn().mockResolvedValue(undefined),
};

const scopes_service = new ScopesService(
    repos.scope_repo as any,
    repos.team_repo as any,
    repos.audit_repo as any,
    org_repo as any,
    local_org_member_repo as any,
    scope_member_repo as any,
);
const scopes_controller = new ScopesController(scopes_service);

app.post('/v1/scopes/get', scopes_controller.get);
app.post('/v1/scopes/new', scopes_controller.new_scope);
app.post('/v1/scopes/update', scopes_controller.update);
app.post('/v1/scopes/delete', scopes_controller.delete_scope);
app.post('/v1/scopes/add_user', scopes_controller.add_user);
app.post('/v1/scopes/remove_user', scopes_controller.remove_user);
app.use(error_handler);

const ADMIN_USER = {
    id: hub_legacy_uuid(1), username: 'admin1', display_name: 'Admin One',
    email: 'admin@test.com', role: 'admin',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const REGULAR_USER = {
    id: hub_legacy_uuid(2), username: 'bob', display_name: 'Bob',
    email: 'bob@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

function admin_auth_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function user_auth_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function mock_admin_auth() {
    stub_pat_auth(repos, ADMIN_USER);
}

function mock_regular_auth() {
    stub_pat_auth(repos, REGULAR_USER);
}

describe('POST /v1/scopes/get', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns paginated scope list for admin', async () => {
        mock_admin_auth();
        const mock_scopes = [
            { id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme', owner_id: hub_legacy_uuid(1), visibility: 'public', scope_type: 'org', team_count: 3, created_at: '2025-01-01', User: { username: 'admin1' } },
            { id: hub_legacy_uuid(2), slug: 'beta', display_name: 'Beta', owner_id: hub_legacy_uuid(2), visibility: 'private', scope_type: 'user', team_count: 0, created_at: '2025-02-01', User: { username: 'bob' } },
        ];
        (Scope.count as any).mockResolvedValueOnce(2);
        (Scope.findAll as any).mockResolvedValueOnce(mock_scopes);

        const res = await request(app).post('/v1/scopes/get')
            .set('Authorization', admin_auth_header()).send({});

        expect(res.status).toBe(200);
        expect(res.body.data.scopes).toHaveLength(2);
        expect(res.body.data.total).toBe(2);
        expect(res.body.data.limit).toBe(50);
        expect(res.body.data.offset).toBe(0);
    });

    it('returns 403 for non-admin user', async () => {
        mock_regular_auth();
        const res = await request(app).post('/v1/scopes/get')
            .set('Authorization', user_auth_header()).send({});
        expect(res.status).toBe(403);
    });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).post('/v1/scopes/get').send({});
        expect(res.status).toBe(401);
    });

    it('supports search filter', async () => {
        mock_admin_auth();
        (Scope.count as any).mockResolvedValueOnce(1);
        (Scope.findAll as any).mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme Corp', User: { username: 'admin1' } },
        ]);

        const res = await request(app).post('/v1/scopes/get')
            .set('Authorization', admin_auth_header()).send({ search: 'acme' });

        expect(res.status).toBe(200);
        expect(res.body.data.scopes).toHaveLength(1);
        expect(res.body.data.total).toBe(1);
    });

    it('respects custom limit and offset', async () => {
        mock_admin_auth();
        (Scope.count as any).mockResolvedValueOnce(10);
        (Scope.findAll as any).mockResolvedValueOnce([
            { id: hub_legacy_uuid(3), slug: 'third', User: null },
        ]);

        const res = await request(app).post('/v1/scopes/get')
            .set('Authorization', admin_auth_header()).send({ limit: 5, offset: 2 });

        expect(res.status).toBe(200);
        expect(res.body.data.limit).toBe(5);
        expect(res.body.data.offset).toBe(2);
    });
});

describe('POST /v1/scopes/new', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a new scope as admin', async () => {
        mock_admin_auth();
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        (User.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(1) });
        repos.scope_repo.create.mockResolvedValueOnce(hub_legacy_uuid(10));

        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'newscope', owner_username: 'admin1' });

        expect(res.status).toBe(201);
        expect(res.body.data.id).toBe(hub_legacy_uuid(10));
        expect(res.body.data.slug).toBe('newscope');
        expect(repos.audit_repo.create).toHaveBeenCalledOnce();
    });

    it('returns 403 for non-admin user', async () => {
        mock_regular_auth();
        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', user_auth_header())
            .send({ slug: 'newscope', owner_username: 'admin1' });
        expect(res.status).toBe(403);
    });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).post('/v1/scopes/new')
            .send({ slug: 'newscope', owner_username: 'admin1' });
        expect(res.status).toBe(401);
    });

    it('returns 422 for invalid slug', async () => {
        mock_admin_auth();
        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: '123-bad', owner_username: 'admin1' });
        expect(res.status).toBe(422);
    });

    it('returns 422 for reserved slug', async () => {
        mock_admin_auth();
        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'admin', owner_username: 'admin1' });
        expect(res.status).toBe(422);
    });

    it('returns 409 for duplicate slug', async () => {
        mock_admin_auth();
        repos.scope_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(5), slug: 'existing' });

        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'existing', owner_username: 'admin1' });
        expect(res.status).toBe(409);
    });

    it('returns 404 when owner user not found', async () => {
        mock_admin_auth();
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        (User.findOne as any).mockResolvedValueOnce(null);

        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'newscope', owner_username: 'ghost' });
        expect(res.status).toBe(404);
    });

    it('returns 422 when slug is missing', async () => {
        mock_admin_auth();
        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ owner_username: 'admin1' });
        expect(res.status).toBe(422);
    });

    it('forces user scope visibility to public even if private is requested', async () => {
        mock_admin_auth();
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        (User.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(1) });
        repos.scope_repo.create.mockResolvedValueOnce(hub_legacy_uuid(11));

        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'personal', owner_username: 'admin1', visibility: 'private', scope_type: 'user' });

        expect(res.status).toBe(201);
        expect(repos.scope_repo.create).toHaveBeenCalledWith(
            'personal', 'personal', hub_legacy_uuid(1), 'public', 'user', undefined, undefined,
        );
    });

    it('allows org scope to be created as private', async () => {
        mock_admin_auth();
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        (User.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(1) });
        repos.scope_repo.create.mockResolvedValueOnce(hub_legacy_uuid(12));
        org_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(10), slug: 'acme' });
        local_org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ role: 'admin' });

        const res = await request(app).post('/v1/scopes/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'acme-internal', owner_username: 'admin1', visibility: 'private', scope_type: 'org', org_slug: 'acme' });

        expect(res.status).toBe(201);
        expect(repos.scope_repo.create).toHaveBeenCalledWith(
            'acme-internal', 'acme-internal', hub_legacy_uuid(1), 'private', 'org', undefined, hub_legacy_uuid(10),
        );
    });
});

describe('POST /v1/scopes/update', () => {
    beforeEach(() => vi.clearAllMocks());

    it('updates org scope visibility to private', async () => {
        mock_admin_auth();
        (Scope.findByPk as any).mockResolvedValueOnce({
            id: hub_legacy_uuid(1), slug: 'acme', visibility: 'public', display_name: 'Acme', owner_id: hub_legacy_uuid(1), scope_type: 'org',
        });

        const res = await request(app).post('/v1/scopes/update')
            .set('Authorization', admin_auth_header())
            .send({ scope_id: hub_legacy_uuid(1), visibility: 'private', display_name: 'Acme Corp' });

        expect(res.status).toBe(200);
        expect(res.body.data.updated).toBe(true);
        expect(Scope.update).toHaveBeenCalled();
        expect(repos.audit_repo.create).toHaveBeenCalledOnce();
    });

    it('returns 422 when setting user scope to private', async () => {
        mock_admin_auth();
        (Scope.findByPk as any).mockResolvedValueOnce({
            id: hub_legacy_uuid(2), slug: 'bob', visibility: 'public', display_name: 'Bob', owner_id: hub_legacy_uuid(2), scope_type: 'user',
        });

        const res = await request(app).post('/v1/scopes/update')
            .set('Authorization', admin_auth_header())
            .send({ scope_id: hub_legacy_uuid(2), visibility: 'private' });

        expect(res.status).toBe(422);
        expect(res.body.error.message).toContain('User scopes cannot be set to private');
    });

    it('returns 404 when scope not found', async () => {
        mock_admin_auth();
        (Scope.findByPk as any).mockResolvedValueOnce(null);

        const res = await request(app).post('/v1/scopes/update')
            .set('Authorization', admin_auth_header())
            .send({ scope_id: hub_legacy_uuid(999) });
        expect(res.status).toBe(404);
    });

    it('returns updated false when no changes', async () => {
        mock_admin_auth();
        (Scope.findByPk as any).mockResolvedValueOnce({
            id: hub_legacy_uuid(1), slug: 'acme', visibility: 'public', display_name: 'Acme', owner_id: hub_legacy_uuid(1), scope_type: 'org',
        });

        const res = await request(app).post('/v1/scopes/update')
            .set('Authorization', admin_auth_header())
            .send({ scope_id: hub_legacy_uuid(1), visibility: 'public', display_name: 'Acme' });

        expect(res.status).toBe(200);
        expect(res.body.data.updated).toBe(false);
        expect(Scope.update).not.toHaveBeenCalled();
    });
});

describe('POST /v1/scopes/delete', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes scope as admin', async () => {
        mock_admin_auth();
        (Scope.findByPk as any).mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme' });
        repos.team_repo.list_by_scope.mockResolvedValueOnce([]);

        const res = await request(app).post('/v1/scopes/delete')
            .set('Authorization', admin_auth_header())
            .send({ scope_id: hub_legacy_uuid(1) });

        expect(res.status).toBe(200);
        expect(res.body.data.deleted).toBe(true);
        expect(repos.scope_repo.delete_by_id).toHaveBeenCalledWith(hub_legacy_uuid(1));
        expect(repos.audit_repo.create).toHaveBeenCalledOnce();
    });

    it('returns 404 when scope not found', async () => {
        mock_admin_auth();
        (Scope.findByPk as any).mockResolvedValueOnce(null);

        const res = await request(app).post('/v1/scopes/delete')
            .set('Authorization', admin_auth_header())
            .send({ scope_id: hub_legacy_uuid(999) });
        expect(res.status).toBe(404);
    });

    it('returns 422 when scope has teams', async () => {
        mock_admin_auth();
        (Scope.findByPk as any).mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme' });
        repos.team_repo.list_by_scope.mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), name: 'team-a' },
            { id: hub_legacy_uuid(2), name: 'team-b' },
        ]);

        const res = await request(app).post('/v1/scopes/delete')
            .set('Authorization', admin_auth_header())
            .send({ scope_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toContain('2 team(s)');
    });
});
