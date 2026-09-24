import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';

setup_sequelize_mocks();

vi.mock('../../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

import { User, ApiToken, OrgMember, OrgRole, Scope, Team, Draft } from '../../../src/db/models/index.js';
import { hash_password, verify_password } from '../../../src/auth/password.js';
import { UsersService } from '../../../src/services/users_service.js';
import { test_config } from '../../helpers/test_container.js';
import type { AuthContext } from '../../../src/types/vo.js';

const admin_auth: AuthContext = {
    user: { id: hub_legacy_uuid(1), username: 'admin', display_name: 'Admin', email: 'admin@test.com', role: 'admin', suspended_at: null, suspended_reason: '', created_at: '2024-01-01' },
    org_slugs: [],
    org_ids: [],
    scopes: [],
};

const user_auth: AuthContext = {
    user: { id: hub_legacy_uuid(2), username: 'john', display_name: 'John', email: 'john@test.com', role: 'user', suspended_at: null, suspended_reason: '', created_at: '2024-01-01' },
    org_slugs: [],
    org_ids: [],
    scopes: [],
};

const anon_auth: AuthContext = {
    user: null,
    org_slugs: [],
    org_ids: [],
    scopes: [],
};

function make_repos() {
    return {
        user_repo: {
            find_by_id: vi.fn(),
            find_by_username_or_email: vi.fn(),
            find_by_email: vi.fn(),
            create: vi.fn().mockResolvedValue(hub_legacy_uuid(1)),
            find_password_hash: vi.fn(),
            update_profile: vi.fn(),
            update_password: vi.fn(),
        },
        scope_repo: {
            create: vi.fn().mockResolvedValue(hub_legacy_uuid(1)),
            find_by_slug: vi.fn(),
        },
        token_repo: {
            create: vi.fn(),
            soft_revoke: vi.fn().mockResolvedValue(1),
            delete_by_id_and_user: vi.fn().mockResolvedValue(1),
            list_by_user_id: vi.fn().mockResolvedValue([]),
        },
        audit_repo: {
            create: vi.fn(),
        },
        org_member_repo: {
            find_by_org_and_user: vi.fn(),
            count_admins_by_org: vi.fn().mockResolvedValue(0),
        },
    };
}

describe('UsersService', () => {
    let service: UsersService;
    let repos: ReturnType<typeof make_repos>;
    let config: ReturnType<typeof test_config>;

    beforeEach(() => {
        vi.clearAllMocks();
        repos = make_repos();
        config = test_config();
        service = new UsersService(
            repos.user_repo as any,
            repos.scope_repo as any,
            repos.token_repo as any,
            repos.audit_repo as any,
            repos.org_member_repo as any,
            config,
        );
    });

    // ── get (list users) ────────────────────────────────────────────

    describe('get', () => {
        it('rejects unauthenticated user', async () => {
            await expect(service.get(anon_auth, {}))
                .rejects.toThrow(expect.objectContaining({ status: 401 }));
        });

        it('rejects non-admin without org_id', async () => {
            await expect(service.get(user_auth, {}))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('returns all users for admin', async () => {
            const fake_users = [{ id: hub_legacy_uuid(1), username: 'admin' }, { id: hub_legacy_uuid(2), username: 'john' }];
            vi.mocked(User.count).mockResolvedValueOnce(2);
            vi.mocked(User.findAll).mockResolvedValueOnce(fake_users as any);

            const result = await service.get(admin_auth, { limit: 50, offset: 0 });

            expect(result.users).toEqual(fake_users);
            expect(result.total).toBe(2);
            expect(result.limit).toBe(50);
            expect(result.offset).toBe(0);
        });

        it('returns org members when org_id provided and user is an org member', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ role: 'member' });
            const fake_members = [{ User: { id: hub_legacy_uuid(3), username: 'orguser' }, role: 'member' }];
            vi.mocked(OrgMember.findAndCountAll).mockResolvedValueOnce({ count: 1, rows: fake_members } as any);

            const result = await service.get(user_auth, { org_id: hub_legacy_uuid(10) });

            expect(result.users).toEqual([{ id: hub_legacy_uuid(3), username: 'orguser', org_role: 'member' }]);
            expect(result.total).toBe(1);
        });

        it('rejects org_id when user is not an org member', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);

            await expect(service.get(user_auth, { org_id: hub_legacy_uuid(10) }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });
    });

    // ── get_by_id ───────────────────────────────────────────────────

    describe('get_by_id', () => {
        it('rejects non-admin', async () => {
            vi.mocked(User.findByPk).mockResolvedValueOnce({ id: hub_legacy_uuid(1), role: 'user' } as any);
            vi.mocked(OrgMember.findAll).mockResolvedValueOnce([] as any);

            await expect(service.get_by_id(user_auth, { user_id: hub_legacy_uuid(1) }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('returns user detail for admin', async () => {
            const fake_user = { id: hub_legacy_uuid(5), username: 'target', display_name: 'Target', email: 't@t.com', role: 'user' };
            vi.mocked(User.findByPk).mockResolvedValueOnce(fake_user as any);
            vi.mocked(Scope.count).mockResolvedValueOnce(3);
            vi.mocked(Team.count).mockResolvedValueOnce(2);
            vi.mocked(ApiToken.count).mockResolvedValueOnce(1);
            vi.mocked(Draft.count).mockResolvedValueOnce(0);
            vi.mocked(OrgMember.findAll).mockResolvedValueOnce([] as any);

            const result = await service.get_by_id(admin_auth, { user_id: hub_legacy_uuid(5) });

            expect(result.username).toBe('target');
            expect(result.scope_count).toBe(3);
            expect(result.team_count).toBe(2);
            expect(result.token_count).toBe(1);
            expect(result.draft_count).toBe(0);
            expect(result.orgs).toEqual([]);
        });

        it('rejects when user not found', async () => {
            vi.mocked(User.findByPk).mockResolvedValueOnce(null);

            await expect(service.get_by_id(admin_auth, { user_id: hub_legacy_uuid(999) }))
                .rejects.toThrow(expect.objectContaining({ status: 404 }));
        });
    });

    // ── new_user ────────────────────────────────────────────────────

    describe('new_user', () => {
        it('rejects non-admin', async () => {
            await expect(service.new_user(user_auth, { username: 'x', email: 'x@x.com', password: 'longpassword' }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('creates user with scope', async () => {
            const result = await service.new_user(admin_auth, {
                username: 'newuser',
                email: 'new@test.com',
                password: 'strongpassword',
                display_name: 'New User',
            });

            expect(result.id).toBe(hub_legacy_uuid(1));
            expect(result.username).toBe('newuser');
            expect(repos.user_repo.create).toHaveBeenCalled();
            expect(repos.scope_repo.create).toHaveBeenCalled();
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.create', 'user', hub_legacy_uuid(1),
                expect.objectContaining({ username: 'newuser' }),
            );
        });

        it('rejects reserved username', async () => {
            await expect(service.new_user(admin_auth, { username: 'admin', email: 'a@test.com', password: 'longpassword' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('rejects duplicate username/email', async () => {
            repos.user_repo.find_by_username_or_email.mockResolvedValueOnce({ id: hub_legacy_uuid(5) });

            await expect(service.new_user(admin_auth, { username: 'taken', email: 'taken@test.com', password: 'longpassword' }))
                .rejects.toThrow(expect.objectContaining({ status: 409 }));
        });

        it('rejects invalid slug', async () => {
            await expect(service.new_user(admin_auth, { username: '123bad', email: 'x@x.com', password: 'longpassword' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });
    });

    // ── update ──────────────────────────────────────────────────────

    describe('update', () => {
        it('updates self without user_id', async () => {
            repos.user_repo.find_by_id.mockResolvedValue({ id: hub_legacy_uuid(1), username: 'admin', display_name: 'Updated', email: 'admin@test.com' });

            const result = await service.update(admin_auth, { display_name: 'Updated' });

            expect(result.updated).toBe(true);
            expect(repos.user_repo.update_profile).toHaveBeenCalledWith(hub_legacy_uuid(1), { display_name: 'Updated' });
        });

        it('admin updates another user by user_id', async () => {
            repos.user_repo.find_by_id.mockResolvedValue({ id: hub_legacy_uuid(2), username: 'john', display_name: 'Johnny', email: 'john@test.com' });

            const result = await service.update(admin_auth, { user_id: hub_legacy_uuid(2), display_name: 'Johnny' });

            expect(result.updated).toBe(true);
            expect(repos.user_repo.update_profile).toHaveBeenCalledWith(hub_legacy_uuid(2), { display_name: 'Johnny' });
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.update', 'user', hub_legacy_uuid(2),
                expect.objectContaining({ username: 'john' }),
            );
        });

        it('non-admin cannot update another user', async () => {
            vi.mocked(User.findByPk).mockResolvedValueOnce({ id: hub_legacy_uuid(1), role: 'user' } as any);
            vi.mocked(OrgMember.findAll).mockResolvedValueOnce([] as any);

            await expect(service.update(user_auth, { user_id: hub_legacy_uuid(1), display_name: 'Hacked' }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('org admin can update a member in a shared org', async () => {
            const org_admin_auth: AuthContext = {
                ...user_auth,
                user: { ...user_auth.user!, id: hub_legacy_uuid(2), role: 'user' },
            };
            vi.mocked(User.findByPk).mockResolvedValue({ id: hub_legacy_uuid(5), role: 'user' } as any);
            vi.mocked(OrgMember.findAll).mockResolvedValue([{ org_id: hub_legacy_uuid(10) }] as any);
            vi.mocked(OrgMember.findOne).mockResolvedValue({ org_id: hub_legacy_uuid(10) } as any);
            repos.user_repo.find_by_id.mockResolvedValue({
                id: hub_legacy_uuid(5), username: 'bob', display_name: 'Bob', email: 'bob@test.com',
            });

            const result = await service.update(org_admin_auth, {
                user_id: hub_legacy_uuid(5),
                display_name: 'Robert',
            });

            expect(result.updated).toBe(true);
            expect(repos.user_repo.update_profile).toHaveBeenCalledWith(hub_legacy_uuid(5), { display_name: 'Robert' });

            vi.mocked(User.findByPk).mockResolvedValue(null);
            vi.mocked(OrgMember.findAll).mockResolvedValue([]);
            vi.mocked(OrgMember.findOne).mockResolvedValue(null);
        });

        it('rejects empty display_name', async () => {
            await expect(service.update(admin_auth, { display_name: '   ' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('rejects duplicate email', async () => {
            repos.user_repo.find_by_email.mockResolvedValueOnce({ id: hub_legacy_uuid(5), email: 'taken@test.com' });

            await expect(service.update(admin_auth, { email: 'taken@test.com' }))
                .rejects.toThrow(expect.objectContaining({ status: 409 }));
        });
    });

    // ── delete ──────────────────────────────────────────────────────

    describe('delete', () => {
        it('rejects non-admin', async () => {
            await expect(service.delete(user_auth, { user_id: hub_legacy_uuid(1) }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('rejects self-delete', async () => {
            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(1) }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('deletes user and creates audit log', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'target' };
            (User.findByPk as any).mockResolvedValueOnce(target);
            vi.mocked(Team.count).mockResolvedValueOnce(0);
            vi.mocked(Draft.count).mockResolvedValueOnce(0);
            vi.mocked(ApiToken.count).mockResolvedValueOnce(0);
            vi.mocked(Scope.count).mockResolvedValueOnce(0);

            const result = await service.delete(admin_auth, { user_id: hub_legacy_uuid(5) });

            expect(result.deleted).toBe(true);
            expect(User.destroy).toHaveBeenCalledWith({ where: { id: hub_legacy_uuid(5) } });
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.delete', 'user', hub_legacy_uuid(5),
                expect.objectContaining({ username: 'target' }),
            );
        });

        it('rejects protected username', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'cliq' };
            (User.findByPk as any).mockResolvedValueOnce(target);

            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(5) }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('rejects when user not found', async () => {
            (User.findByPk as any).mockResolvedValueOnce(null);

            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(999) }))
                .rejects.toThrow(expect.objectContaining({ status: 404 }));
        });
    });

    // ── suspend ─────────────────────────────────────────────────────

    describe('suspend', () => {
        it('rejects non-admin', async () => {
            await expect(service.suspend(user_auth, { user_id: hub_legacy_uuid(1) }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('rejects self-suspend', async () => {
            await expect(service.suspend(admin_auth, { user_id: hub_legacy_uuid(1) }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('suspends user', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'target' };
            (User.findByPk as any).mockResolvedValueOnce(target);

            const result = await service.suspend(admin_auth, { user_id: hub_legacy_uuid(5), reason: 'spam' });

            expect(result.suspended).toBe(true);
            expect(User.update).toHaveBeenCalledWith(
                expect.objectContaining({ suspended_reason: 'spam' }),
                { where: { id: hub_legacy_uuid(5) } },
            );
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.suspend', 'user', hub_legacy_uuid(5),
                expect.objectContaining({ reason: 'spam' }),
            );
        });

        it('rejects protected username', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'cliq' };
            (User.findByPk as any).mockResolvedValueOnce(target);

            await expect(service.suspend(admin_auth, { user_id: hub_legacy_uuid(5) }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });
    });

    // ── unsuspend ───────────────────────────────────────────────────

    describe('unsuspend', () => {
        it('rejects non-admin', async () => {
            await expect(service.unsuspend(user_auth, { user_id: hub_legacy_uuid(1) }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('unsuspends user', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'target' };
            (User.findByPk as any).mockResolvedValueOnce(target);

            const result = await service.unsuspend(admin_auth, { user_id: hub_legacy_uuid(5) });

            expect(result.suspended).toBe(false);
            expect(User.update).toHaveBeenCalledWith(
                { suspended_at: null, suspended_reason: '' },
                { where: { id: hub_legacy_uuid(5) } },
            );
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.unsuspend', 'user', hub_legacy_uuid(5),
                expect.objectContaining({ username: 'target' }),
            );
        });
    });

    // ── reset_password ──────────────────────────────────────────────

    describe('reset_password', () => {
        it('rejects non-admin without org admin rights', async () => {
            vi.mocked(User.findByPk).mockResolvedValueOnce({ id: hub_legacy_uuid(1), role: 'user' } as any);
            vi.mocked(OrgMember.findAll).mockResolvedValueOnce([] as any);

            await expect(service.reset_password(user_auth, { user_id: hub_legacy_uuid(1), new_password: 'longenough' }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('resets password', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'target' };
            (User.findByPk as any).mockResolvedValueOnce(target);

            const result = await service.reset_password(admin_auth, { user_id: hub_legacy_uuid(5), new_password: 'newlongpassword' });

            expect(result.reset).toBe(true);
            expect(hash_password).toHaveBeenCalledWith('newlongpassword');
            expect(User.update).toHaveBeenCalledWith(
                { password_hash: 'hashed' },
                { where: { id: hub_legacy_uuid(5) } },
            );
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.reset_password', 'user', hub_legacy_uuid(5),
                expect.objectContaining({ username: 'target' }),
            );
        });

        it('org admin can reset password for shared org member', async () => {
            const org_admin_auth: AuthContext = {
                ...user_auth,
                user: { ...user_auth.user!, id: hub_legacy_uuid(2), role: 'user' },
            };
            vi.mocked(User.findByPk).mockResolvedValue({ id: hub_legacy_uuid(5), role: 'user', username: 'bob' } as any);
            vi.mocked(OrgMember.findAll).mockResolvedValue([{ org_id: hub_legacy_uuid(10) }] as any);
            vi.mocked(OrgMember.findOne).mockResolvedValue({ org_id: hub_legacy_uuid(10) } as any);

            const result = await service.reset_password(org_admin_auth, {
                user_id: hub_legacy_uuid(5),
                new_password: 'newlongpassword',
            });

            expect(result.reset).toBe(true);

            vi.mocked(User.findByPk).mockResolvedValue(null);
            vi.mocked(OrgMember.findAll).mockResolvedValue([]);
            vi.mocked(OrgMember.findOne).mockResolvedValue(null);
        });

        it('rejects short password', async () => {
            await expect(service.reset_password(admin_auth, { user_id: hub_legacy_uuid(5), new_password: 'short' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });
    });

    // ── set_role ────────────────────────────────────────────────────

    describe('set_role', () => {
        it('rejects non-admin', async () => {
            await expect(service.set_role(user_auth, { user_id: hub_legacy_uuid(1), role: 'admin' }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('promotes user to admin', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'target', role: 'user' };
            (User.findByPk as any).mockResolvedValueOnce(target);

            const result = await service.set_role(admin_auth, { user_id: hub_legacy_uuid(5), role: 'admin' });

            expect(result.role).toBe('admin');
            expect(User.update).toHaveBeenCalledWith({ role: 'admin' }, { where: { id: hub_legacy_uuid(5) } });
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.set_role', 'user', hub_legacy_uuid(5),
                expect.objectContaining({ from: 'user', to: 'admin' }),
            );
        });

        it('rejects demoting last admin', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'solo', role: 'admin' };
            (User.findByPk as any).mockResolvedValueOnce(target);
            (User.count as any).mockResolvedValueOnce(1);

            await expect(service.set_role(admin_auth, { user_id: hub_legacy_uuid(5), role: 'user' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('rejects demoting self', async () => {
            await expect(service.set_role(admin_auth, { user_id: hub_legacy_uuid(1), role: 'user' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });
    });

    // ── update_role (org member role assignment) ────────────────────

    describe('update_role', () => {
        it('assigns org role to member', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce({
                org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'member', role_id: hub_legacy_uuid(4),
            });
            vi.mocked(OrgRole.findOne).mockResolvedValueOnce({
                id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), slug: 'admin', is_system: false,
            } as any);
            vi.mocked(OrgMember.update).mockResolvedValueOnce([1] as any);

            const result = await service.update_role(admin_auth, {
                user_id: hub_legacy_uuid(5), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(2),
            });

            expect(result).toEqual({
                user_id: hub_legacy_uuid(5),
                org_id: hub_legacy_uuid(1),
                role_id: hub_legacy_uuid(2),
                role_slug: 'admin',
                role: 'admin',
            });
            expect(OrgMember.update).toHaveBeenCalledWith(
                { role_id: hub_legacy_uuid(2), role: 'admin' },
                { where: { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5) } },
            );
        });

        it('rejects when member not found', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);

            await expect(service.update_role(admin_auth, {
                user_id: hub_legacy_uuid(999), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(2),
            })).rejects.toThrow(expect.objectContaining({ status: 404 }));
        });

        it('rejects when role not found in org', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce({
                org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'member', role_id: hub_legacy_uuid(4),
            });
            vi.mocked(OrgRole.findOne).mockResolvedValueOnce(null);

            await expect(service.update_role(admin_auth, {
                user_id: hub_legacy_uuid(5), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(999),
            })).rejects.toThrow(expect.objectContaining({ status: 404 }));
        });

        it('rejects assigning system owner role', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce({
                org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'member', role_id: hub_legacy_uuid(4),
            });
            vi.mocked(OrgRole.findOne).mockResolvedValueOnce({
                id: hub_legacy_uuid(1), org_id: hub_legacy_uuid(1), slug: 'owner', is_system: true,
            } as any);

            await expect(service.update_role(admin_auth, {
                user_id: hub_legacy_uuid(5), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(1),
            })).rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('rejects demoting last owner', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce({
                org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'admin', role_id: hub_legacy_uuid(1),
            });
            vi.mocked(OrgRole.findOne)
                .mockResolvedValueOnce({ id: hub_legacy_uuid(4), org_id: hub_legacy_uuid(1), slug: 'member', is_system: false } as any)
                .mockResolvedValueOnce({ id: hub_legacy_uuid(1), org_id: hub_legacy_uuid(1), slug: 'owner', is_system: true } as any);
            vi.mocked(OrgMember.count).mockResolvedValueOnce(1 as any);

            await expect(service.update_role(admin_auth, {
                user_id: hub_legacy_uuid(5), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(4),
            })).rejects.toThrow(expect.objectContaining({ status: 409 }));
        });
    });

    // ── change_password ─────────────────────────────────────────────

    describe('change_password', () => {
        it('rejects unauthenticated', async () => {
            await expect(service.change_password(anon_auth, { current_password: 'old', new_password: 'newlongpw' }))
                .rejects.toThrow(expect.objectContaining({ status: 401 }));
        });

        it('changes password', async () => {
            repos.user_repo.find_password_hash.mockResolvedValueOnce('old_hash');
            vi.mocked(verify_password).mockResolvedValueOnce(true);

            const result = await service.change_password(user_auth, { current_password: 'oldpassword', new_password: 'newlongpassword' });

            expect(result.message).toBe('Password changed');
            expect(verify_password).toHaveBeenCalledWith('oldpassword', 'old_hash');
            expect(hash_password).toHaveBeenCalledWith('newlongpassword');
            expect(repos.user_repo.update_password).toHaveBeenCalledWith(hub_legacy_uuid(2), 'hashed');
        });

        it('rejects wrong current password', async () => {
            repos.user_repo.find_password_hash.mockResolvedValueOnce('old_hash');
            vi.mocked(verify_password).mockResolvedValueOnce(false);

            await expect(service.change_password(user_auth, { current_password: 'wrong', new_password: 'newlongpassword' }))
                .rejects.toThrow(expect.objectContaining({ status: 403 }));
        });

        it('rejects short new password', async () => {
            await expect(service.change_password(user_auth, { current_password: 'old', new_password: 'short' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });
    });

    // ── new_token ───────────────────────────────────────────────────

    // ── get_tokens ──────────────────────────────────────────────────

    // ── revoke_token ────────────────────────────────────────────────

});
