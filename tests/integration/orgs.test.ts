import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed_pw'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

/**
 * require_permission mock: default allows all (individual tests
 * swap to rejecting via _mock_require_permission override).
 */
let _perm_gate: (org_id: string, user_id: string, perm: string, opts?: { site_role?: string }) => Promise<void> =
    async () => {};

vi.mock('../../src/auth/permissions.js', async (importOriginal) => {
    const orig = await importOriginal() as Record<string, unknown>;
    return {
        ...orig,
        require_permission: (...args: any[]) => _perm_gate(args[0], args[1], args[2], args[3]),
    };
});

import express from 'express';
import request from 'supertest';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import { OrgsService } from '../../src/services/orgs_service.js';
import { OrgsController } from '../../src/controllers/orgs_controller.js';
import { UsersService } from '../../src/services/users_service.js';
import { UsersController } from '../../src/controllers/users_controller.js';
import { make_mock_repos, test_config } from '../helpers/test_container.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { User, Org, OrgMember, OrgRole, Scope, ScopeMember, Team } from '../../src/db/models/index.js';

const org_repo = {
    find_by_id: vi.fn().mockResolvedValue(null),
    find_by_slug: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(hub_legacy_uuid(1)),
    update_display_name: vi.fn(),
    delete_by_id: vi.fn(),
};

const scope_member_repo = {
    find_by_scope_and_user: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    create_on_conflict_ignore: vi.fn(),
    delete_by_scope_and_user: vi.fn().mockResolvedValue(1),
    delete_by_scope_id: vi.fn(),
    delete_by_user_and_org_scopes: vi.fn(),
};

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

const orgs_service = new OrgsService(
    org_repo as any,
    repos.org_member_repo as any,
    repos.scope_repo as any,
    scope_member_repo as any,
    repos.user_repo as any,
    repos.team_repo as any,
    repos.audit_repo as any,
);
const orgs_controller = new OrgsController(orgs_service);

const users_service = new UsersService(
    repos.user_repo as any,
    repos.scope_repo as any,
    repos.token_repo as any,
    repos.audit_repo as any,
    repos.org_member_repo as any,
    config,
);
const users_controller = new UsersController(users_service);

app.post('/v1/orgs/get', orgs_controller.get);
app.post('/v1/orgs/get_by_id', orgs_controller.get_by_id);
app.post('/v1/orgs/list_roles', orgs_controller.list_roles);
app.post('/internal/orgs/new', orgs_controller.new_org);
app.post('/v1/orgs/update', orgs_controller.update);
app.post('/internal/orgs/delete', orgs_controller.delete_org);
app.post('/v1/orgs/add_member', orgs_controller.add_member);
app.post('/v1/orgs/remove_member', orgs_controller.remove_member);
app.post('/internal/orgs/get_role', orgs_controller.get_role);
app.post('/internal/orgs/create_role', orgs_controller.create_role);
app.post('/internal/orgs/update_role', orgs_controller.update_role);
app.post('/internal/orgs/delete_role', orgs_controller.delete_role);
app.post('/internal/users/update_role', users_controller.update_role);
app.post('/v1/orgs/leave', orgs_controller.leave);
app.post('/v1/orgs/new_scope', orgs_controller.new_scope);
app.post('/v1/orgs/delete_scope', orgs_controller.delete_scope);
app.post('/v1/orgs/assign_scope_member', orgs_controller.assign_scope_member);
app.post('/v1/orgs/unassign_scope_member', orgs_controller.unassign_scope_member);
app.use(error_handler);

const ALICE_USER = {
    id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice',
    email: 'alice@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const ADMIN_USER = {
    id: hub_legacy_uuid(99), username: 'superadmin', display_name: 'superadmin',
    email: 'admin@test.com', role: 'admin',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

function user_auth_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function admin_auth_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function mock_user_auth() {
    stub_pat_auth(repos, ALICE_USER);
}

function mock_admin_auth() {
    stub_pat_auth(repos, ADMIN_USER);
}

function mock_org_admin_auth() {
    mock_user_auth();
    _perm_gate = async () => {};
}

function mock_non_admin_auth() {
    mock_user_auth();
    _perm_gate = async (_org_id, _user_id, perm) => {
        const { ApiError } = await import('../../src/errors/api_error.js');
        throw new ApiError('forbidden', `Permission '${perm}' is required`, 403);
    };
}

// ─── GET (unified list) ────────────────────────────────────────────

describe('POST /v1/orgs/get', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns orgs for regular user', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).list_my_orgs = vi.fn().mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme', role: 'admin', member_count: 3, scope_count: 1 },
        ]);
        const res = await request(app).post('/v1/orgs/get')
            .set('Authorization', user_auth_header()).send({});
        expect(res.status).toBe(200);
        expect(res.body.data.orgs).toHaveLength(1);
        expect(res.body.data.orgs[0].slug).toBe('acme');
    });

    it('returns paginated list for admin user', async () => {
        mock_admin_auth();
        (Org.count as any).mockResolvedValueOnce(2);
        (Org.findAll as any).mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme', member_count: 3, scope_count: 1, created_at: '2025-01-01' },
            { id: hub_legacy_uuid(2), slug: 'beta', display_name: 'Beta', member_count: 1, scope_count: 1, created_at: '2025-01-02' },
        ]);
        const res = await request(app).post('/v1/orgs/get')
            .set('Authorization', admin_auth_header()).send({ limit: 50, offset: 0 });
        expect(res.status).toBe(200);
        expect(res.body.data.orgs).toHaveLength(2);
        expect(res.body.data.total).toBe(2);
    });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).post('/v1/orgs/get').send({});
        expect(res.status).toBe(401);
    });
});

// ─── GET BY ID ──────────────────────────────────────────────────────

describe('POST /v1/orgs/get_by_id', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns org details for org member', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'admin' });
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        (repos.org_member_repo as any).list_members_by_org = vi.fn().mockResolvedValueOnce([
            { user_id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice', role: 'admin' },
        ]);
        (Scope.findAll as any).mockResolvedValueOnce([
            { id: hub_legacy_uuid(10), slug: 'acme', display_name: 'Acme', visibility: 'public', member_count: 1, team_count: 0 },
        ]);
        const res = await request(app).post('/v1/orgs/get_by_id')
            .set('Authorization', user_auth_header()).send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(200);
        expect(res.body.data.slug).toBe('acme');
        expect(res.body.data.members).toHaveLength(1);
        expect(res.body.data.scopes).toHaveLength(1);
        expect(res.body.data.my_role).toBe('admin');
        expect(Array.isArray(res.body.data.roles)).toBe(true);
        expect(Array.isArray(res.body.data.available_permissions)).toBe(true);
    });

    it('returns site_admin role for admin user', async () => {
        mock_admin_auth();
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        (repos.org_member_repo as any).list_members_by_org = vi.fn().mockResolvedValueOnce([]);
        (Scope.findAll as any).mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/orgs/get_by_id')
            .set('Authorization', admin_auth_header()).send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(200);
        expect(res.body.data.my_role).toBe('site_admin');
    });

    it('returns 403 for non-member', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn().mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/get_by_id')
            .set('Authorization', user_auth_header()).send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(403);
    });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).post('/v1/orgs/get_by_id').send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(401);
    });
});

// ─── NEW (admin-only create org) ────────────────────────────────────

describe('POST /internal/orgs/new', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates org with existing admin user', async () => {
        mock_admin_auth();
        org_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        (User.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(2), username: 'bob' });
        (Org.create as any).mockResolvedValueOnce({ id: hub_legacy_uuid(5), slug: 'neworg' });
        (OrgMember.create as any).mockResolvedValueOnce({});
        (Scope.create as any).mockResolvedValueOnce({ id: hub_legacy_uuid(20) });
        (ScopeMember.create as any).mockResolvedValueOnce({});
        const res = await request(app).post('/internal/orgs/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'neworg', admin_username: 'bob' });
        expect(res.status).toBe(200);
        expect(res.body.data.slug).toBe('neworg');
    });

    it('creates org and new admin user when user does not exist', async () => {
        mock_admin_auth();
        org_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        (User.findOne as any).mockResolvedValueOnce(null);
        repos.user_repo.find_by_email.mockResolvedValueOnce(null);
        (User.create as any).mockResolvedValueOnce({ id: hub_legacy_uuid(3), username: 'newadmin' });
        (Scope.create as any)
            .mockResolvedValueOnce({ id: hub_legacy_uuid(30) })
            .mockResolvedValueOnce({ id: hub_legacy_uuid(31) });
        (Org.create as any).mockResolvedValueOnce({ id: hub_legacy_uuid(6), slug: 'freshorg' });
        (OrgMember.create as any).mockResolvedValueOnce({});
        (ScopeMember.create as any).mockResolvedValueOnce({});
        const res = await request(app).post('/internal/orgs/new')
            .set('Authorization', admin_auth_header())
            .send({
                slug: 'freshorg', admin_username: 'newadmin',
                admin_email: 'new@test.com', admin_password: 'securepass123',
            });
        expect(res.status).toBe(200);
        expect(res.body.data.slug).toBe('freshorg');
    });

    it('returns 403 for non-admin user', async () => {
        mock_user_auth();
        const res = await request(app).post('/internal/orgs/new')
            .set('Authorization', user_auth_header())
            .send({ slug: 'neworg', admin_username: 'bob' });
        expect(res.status).toBe(403);
    });

    it('returns 409 when org slug already exists', async () => {
        mock_admin_auth();
        org_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'taken' });
        const res = await request(app).post('/internal/orgs/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'taken', admin_username: 'bob' });
        expect(res.status).toBe(409);
    });

    it('returns 422 for invalid slug', async () => {
        mock_admin_auth();
        const res = await request(app).post('/internal/orgs/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: '123-bad', admin_username: 'bob' });
        expect(res.status).toBe(422);
    });

    it('returns 404 when user not found and no credentials provided', async () => {
        mock_admin_auth();
        org_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        (User.findOne as any).mockResolvedValueOnce(null);
        const res = await request(app).post('/internal/orgs/new')
            .set('Authorization', admin_auth_header())
            .send({ slug: 'neworg', admin_username: 'ghost' });
        expect(res.status).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).post('/internal/orgs/new')
            .send({ slug: 'x', admin_username: 'y' });
        expect(res.status).toBe(401);
    });
});

// ─── UPDATE ─────────────────────────────────────────────────────────

describe('POST /v1/orgs/update', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 when org admin updates display_name', async () => {
        mock_org_admin_auth();
        const res = await request(app).post('/v1/orgs/update')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), display_name: 'New Name' });
        expect(res.status).toBe(200);
        expect(res.body.data.updated).toBe(true);
        expect(org_repo.update_display_name).toHaveBeenCalledWith(hub_legacy_uuid(1), 'New Name');
    });

    it('returns 403 for non-admin member', async () => {
        mock_non_admin_auth();
        const res = await request(app).post('/v1/orgs/update')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), display_name: 'X' });
        expect(res.status).toBe(403);
    });
});

// ─── DELETE (admin-only) ────────────────────────────────────────────

describe('POST /internal/orgs/delete', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes org when no teams exist', async () => {
        mock_admin_auth();
        (Org.findByPk as any).mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme' });
        (Scope.findAll as any)
            .mockResolvedValueOnce([{ slug: 'acme' }])
            .mockResolvedValueOnce([{ id: hub_legacy_uuid(10) }, { id: hub_legacy_uuid(11) }]);
        (Team.count as any).mockResolvedValueOnce(0);
        const res = await request(app).post('/internal/orgs/delete')
            .set('Authorization', admin_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(200);
        expect(res.body.data.deleted).toBe(true);
    });

    it('returns 409 when org has teams', async () => {
        mock_admin_auth();
        (Org.findByPk as any).mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme' });
        (Scope.findAll as any).mockResolvedValueOnce([{ slug: 'acme' }]);
        (Team.count as any).mockResolvedValueOnce(3);
        const res = await request(app).post('/internal/orgs/delete')
            .set('Authorization', admin_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(409);
    });

    it('returns 404 when org not found', async () => {
        mock_admin_auth();
        (Org.findByPk as any).mockResolvedValueOnce(null);
        const res = await request(app).post('/internal/orgs/delete')
            .set('Authorization', admin_auth_header())
            .send({ org_id: hub_legacy_uuid(999) });
        expect(res.status).toBe(404);
    });

    it('returns 403 for non-admin user', async () => {
        mock_user_auth();
        const res = await request(app).post('/internal/orgs/delete')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(403);
    });
});

// ─── ADD MEMBER ─────────────────────────────────────────────────────

describe('POST /v1/orgs/add_member', () => {
    beforeEach(() => vi.clearAllMocks());

    it('adds a member successfully', async () => {
        mock_org_admin_auth();
        repos.user_repo.find_by_username.mockResolvedValueOnce({ id: hub_legacy_uuid(2), username: 'bob' });
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn().mockResolvedValueOnce(null);
        (repos.org_member_repo as any).create = vi.fn();
        const res = await request(app).post('/v1/orgs/add_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), username: 'bob' });
        expect(res.status).toBe(200);
        expect(res.body.data.username).toBe('bob');
        expect(res.body.data.role).toBe('member');
    });

    it('returns 404 when user not found', async () => {
        mock_org_admin_auth();
        repos.user_repo.find_by_username.mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/add_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), username: 'ghost' });
        expect(res.status).toBe(404);
    });

    it('returns 409 when user already a member', async () => {
        mock_org_admin_auth();
        repos.user_repo.find_by_username.mockResolvedValueOnce({ id: hub_legacy_uuid(2), username: 'bob' });
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member' });
        const res = await request(app).post('/v1/orgs/add_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), username: 'bob' });
        expect(res.status).toBe(409);
    });

    it('returns 403 for non-admin member', async () => {
        mock_non_admin_auth();
        const res = await request(app).post('/v1/orgs/add_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), username: 'bob' });
        expect(res.status).toBe(403);
    });
});

// ─── REMOVE MEMBER ──────────────────────────────────────────────────

describe('POST /v1/orgs/remove_member', () => {
    beforeEach(() => vi.clearAllMocks());

    it('removes a member successfully', async () => {
        mock_org_admin_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member' });
        (repos.org_member_repo as any).delete_by_org_and_user = vi.fn();
        const res = await request(app).post('/v1/orgs/remove_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(200);
        expect(res.body.data.removed).toBe(true);
    });

    it('returns 404 when member not found', async () => {
        mock_org_admin_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/remove_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(999) });
        expect(res.status).toBe(404);
    });

    it('returns 409 when removing last admin', async () => {
        mock_org_admin_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'admin' });
        (repos.org_member_repo as any).count_admins_by_org = vi.fn().mockResolvedValueOnce(1);
        const res = await request(app).post('/v1/orgs/remove_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(409);
    });

    it('returns 403 for non-admin member', async () => {
        mock_non_admin_auth();
        const res = await request(app).post('/v1/orgs/remove_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(403);
    });
});

// ─── LIST ROLES (Core /v1 only — no /internal twin) ─────────────────

describe('POST /v1/orgs/list_roles', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns roles for org member', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'admin' });
        (OrgRole.findAll as any).mockResolvedValueOnce([
            { id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), slug: 'admin', name: 'Admin', permissions: ['org.settings'], is_system: false, is_default: true, created_at: new Date() },
        ]);
        (OrgMember.findAll as any).mockResolvedValueOnce([{ role_id: hub_legacy_uuid(2) }]);

        const res = await request(app).post('/v1/orgs/list_roles')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(200);
        expect(res.body.data.roles).toHaveLength(1);
        expect(res.body.data.roles[0].slug).toBe('admin');
    });

    it('returns 422 for missing org_id', async () => {
        mock_user_auth();
        const res = await request(app).post('/v1/orgs/list_roles')
            .set('Authorization', user_auth_header())
            .send({});
        expect(res.status).toBe(422);
    });

    it('returns roles on public read plane', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'member' });
        (OrgRole.findAll as any).mockResolvedValueOnce([
            { id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), slug: 'member', name: 'Member', permissions: [], is_system: true, is_default: true, created_at: new Date() },
        ]);
        (OrgMember.findAll as any).mockResolvedValueOnce([{ role_id: hub_legacy_uuid(2) }]);

        const res = await request(app).post('/v1/orgs/list_roles')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(200);
        expect(res.body.data.roles[0].slug).toBe('member');
    });
});

// ─── UPDATE USER ROLE ───────────────────────────────────────────────

describe('POST /internal/users/update_role', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _perm_gate = async () => {};
    });

    it('assigns role to member', async () => {
        mock_admin_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member', role_id: hub_legacy_uuid(4) });
        (OrgRole.findOne as any).mockResolvedValueOnce({
            id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), slug: 'admin', is_system: false,
        });
        (OrgMember.update as any).mockResolvedValueOnce([1]);

        const res = await request(app).post('/internal/users/update_role')
            .set('Authorization', admin_auth_header())
            .send({ user_id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(200);
        expect(res.body.data.role_id).toBe(hub_legacy_uuid(2));
        expect(res.body.data.role_slug).toBe('admin');
        expect(res.body.data.role).toBe('admin');
    });

    it('returns 404 when member not found', async () => {
        mock_admin_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce(null);
        const res = await request(app).post('/internal/users/update_role')
            .set('Authorization', admin_auth_header())
            .send({ user_id: hub_legacy_uuid(999), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(404);
    });

    it('returns 404 when role not found in org', async () => {
        mock_admin_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member', role_id: hub_legacy_uuid(4) });
        (OrgRole.findOne as any).mockResolvedValueOnce(null);
        const res = await request(app).post('/internal/users/update_role')
            .set('Authorization', admin_auth_header())
            .send({ user_id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(999) });
        expect(res.status).toBe(404);
    });

    it('returns 403 when assigning system owner role', async () => {
        mock_admin_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member', role_id: hub_legacy_uuid(4) });
        (OrgRole.findOne as any).mockResolvedValueOnce({
            id: hub_legacy_uuid(1), org_id: hub_legacy_uuid(1), slug: 'owner', is_system: true,
        });
        const res = await request(app).post('/internal/users/update_role')
            .set('Authorization', admin_auth_header())
            .send({ user_id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(403);
    });

    it('returns 422 for missing role_id', async () => {
        mock_user_auth();
        const res = await request(app).post('/internal/users/update_role')
            .set('Authorization', user_auth_header())
            .send({ user_id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(422);
    });
});

// ─── LEAVE ──────────────────────────────────────────────────────────

describe('POST /v1/orgs/leave', () => {
    beforeEach(() => vi.clearAllMocks());

    it('leaves org as regular member', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'member' });
        (repos.org_member_repo as any).delete_by_org_and_user = vi.fn();
        const res = await request(app).post('/v1/orgs/leave')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(200);
        expect(res.body.data.left).toBe(true);
    });

    it('returns 409 when last admin tries to leave', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'admin' });
        (repos.org_member_repo as any).count_admins_by_org = vi.fn().mockResolvedValueOnce(1);
        const res = await request(app).post('/v1/orgs/leave')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(409);
    });

    it('returns 404 when not a member', async () => {
        mock_user_auth();
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/leave')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(404);
    });
});

// ─── NEW SCOPE ──────────────────────────────────────────────────────

describe('POST /v1/orgs/new_scope', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a scope successfully', async () => {
        mock_org_admin_auth();
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        repos.scope_repo.find_by_slug.mockResolvedValueOnce(null);
        repos.scope_repo.create.mockResolvedValueOnce(hub_legacy_uuid(10));
        (repos.org_member_repo as any).list_admins_by_org = vi.fn().mockResolvedValueOnce([{ user_id: hub_legacy_uuid(1) }]);
        const res = await request(app).post('/v1/orgs/new_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), slug: 'acme-tools' });
        expect(res.status).toBe(200);
        expect(res.body.data.slug).toBe('acme-tools');
        expect(res.body.data.id).toBe(hub_legacy_uuid(10));
    });

    it('returns 422 for slug not matching org prefix', async () => {
        mock_org_admin_auth();
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        const res = await request(app).post('/v1/orgs/new_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), slug: 'other-tools' });
        expect(res.status).toBe(422);
    });

    it('returns 422 for invalid slug format', async () => {
        mock_org_admin_auth();
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        const res = await request(app).post('/v1/orgs/new_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), slug: '123-bad' });
        expect(res.status).toBe(422);
    });

    it('returns 409 for duplicate slug', async () => {
        mock_org_admin_auth();
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        repos.scope_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(5), slug: 'acme-tools' });
        const res = await request(app).post('/v1/orgs/new_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), slug: 'acme-tools' });
        expect(res.status).toBe(409);
    });

    it('returns 403 for non-admin member', async () => {
        mock_non_admin_auth();
        const res = await request(app).post('/v1/orgs/new_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), slug: 'acme-tools' });
        expect(res.status).toBe(403);
    });
});

// ─── DELETE SCOPE ───────────────────────────────────────────────────

describe('POST /internal/orgs/delete_scope', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes a scope successfully', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(10), slug: 'acme-tools', org_id: hub_legacy_uuid(1) });
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        repos.team_repo.list_by_scope.mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/orgs/delete_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10) });
        expect(res.status).toBe(200);
        expect(res.body.data.deleted).toBe(true);
    });

    it('returns 409 when scope has teams', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(10), slug: 'acme-tools', org_id: hub_legacy_uuid(1) });
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        repos.team_repo.list_by_scope.mockResolvedValueOnce([{ id: hub_legacy_uuid(1), name: 'my-team' }]);
        const res = await request(app).post('/v1/orgs/delete_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10) });
        expect(res.status).toBe(409);
    });

    it('returns 409 when deleting default org scope', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(10), slug: 'acme', org_id: hub_legacy_uuid(1) });
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        const res = await request(app).post('/v1/orgs/delete_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10) });
        expect(res.status).toBe(409);
    });

    it('returns 404 when scope not found in org', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/delete_scope')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(999) });
        expect(res.status).toBe(404);
    });
});

// ─── ASSIGN SCOPE MEMBER ───────────────────────────────────────────

describe('POST /v1/orgs/assign_scope_member', () => {
    beforeEach(() => vi.clearAllMocks());

    it('assigns user to scope successfully', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(10) });
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member' });
        scope_member_repo.find_by_scope_and_user.mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/assign_scope_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(200);
        expect(res.body.data.assigned).toBe(true);
    });

    it('returns 409 when user is not an org member', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(10) });
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/assign_scope_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(409);
    });

    it('returns 409 when user already assigned to scope', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(10) });
        (repos.org_member_repo as any).find_by_org_and_user = vi.fn()
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member' });
        scope_member_repo.find_by_scope_and_user.mockResolvedValueOnce({ scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(2) });
        const res = await request(app).post('/v1/orgs/assign_scope_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(409);
    });

    it('returns 404 when scope not found in org', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/assign_scope_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(999), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(404);
    });
});

// ─── UNASSIGN SCOPE MEMBER ─────────────────────────────────────────

describe('POST /v1/orgs/unassign_scope_member', () => {
    beforeEach(() => vi.clearAllMocks());

    it('unassigns user from scope successfully', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(10) });
        scope_member_repo.delete_by_scope_and_user.mockResolvedValueOnce(1);
        const res = await request(app).post('/v1/orgs/unassign_scope_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(200);
        expect(res.body.data.removed).toBe(true);
    });

    it('returns 403 for non-admin member', async () => {
        mock_non_admin_auth();
        const res = await request(app).post('/v1/orgs/unassign_scope_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(403);
    });

    it('returns 404 when scope not found in org', async () => {
        mock_org_admin_auth();
        (Scope.findOne as any).mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/orgs/unassign_scope_member')
            .set('Authorization', user_auth_header())
            .send({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(999), user_id: hub_legacy_uuid(2) });
        expect(res.status).toBe(404);
    });
});
