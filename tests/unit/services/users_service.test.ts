import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';

setup_sequelize_mocks();

vi.mock('../../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

import { User, ApiToken, OrgMember, OrgRole, Scope, Team, Draft } from '../../../src/models/index.js';
import { hash_password, verify_password } from '../../../src/auth/password.js';
import { UsersService } from '../../../src/services/users_service.js';
import { test_config } from '../../helpers/test_container.js';
import type { AuthContext } from '../../../src/schemas/auth_types.js';

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
            find_profile_by_id: vi.fn(),
            find_by_username: vi.fn().mockResolvedValue(null),
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

        it('returns all live users for admin, each with status and deleted_at', async () => {
            const fake_users = [
                { id: hub_legacy_uuid(1), username: 'admin', status: 'active', deleted_at: null },
                { id: hub_legacy_uuid(2), username: 'john', status: 'invited', deleted_at: null },
            ];
            vi.mocked(User.count).mockResolvedValueOnce(2);
            vi.mocked(User.findAll).mockResolvedValueOnce(fake_users as any);

            const result = await service.get(admin_auth, { limit: 50, offset: 0 });

            expect(result.users).toEqual(fake_users);
            expect(result.total).toBe(2);
            expect(result.limit).toBe(50);
            expect(result.offset).toBe(0);
        });

        it('include_deleted lists deleted users with status deleted', async () => {
            const gone = new Date('2026-03-01T00:00:00.000Z');
            vi.mocked(User.count).mockResolvedValueOnce(1);
            vi.mocked(User.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(3), username: 'gone', status: 'active', deleted_at: gone }] as any);

            const result = await service.get(admin_auth, { include_deleted: true });

            expect(vi.mocked(User.count).mock.calls[0][0]).not.toHaveProperty('where.deleted_at');
            expect(result.users).toEqual([{ id: hub_legacy_uuid(3), username: 'gone', status: 'deleted', deleted_at: gone.toISOString() }]);
        });

        it('returns org members when org_id provided and user is an org member', async () => {
            repos.org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ role: 'member' });
            const fake_members = [{ User: { id: hub_legacy_uuid(3), username: 'orguser', status: 'active', deleted_at: null }, role: 'member' }];
            vi.mocked(OrgMember.findAndCountAll).mockResolvedValueOnce({ count: 1, rows: fake_members } as any);

            const result = await service.get(user_auth, { org_id: hub_legacy_uuid(10) });

            expect(result.users).toEqual([{ id: hub_legacy_uuid(3), username: 'orguser', status: 'active', deleted_at: null, org_role: 'member' }]);
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
        it('rejects reserved username', async () => {
            await expect(service.new_user(admin_auth, { username: 'admin', email: 'a@test.com' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('rejects an email a live user holds (409 conflict naming the holder)', async () => {
            repos.user_repo.find_by_email.mockResolvedValueOnce({ id: hub_legacy_uuid(5), username: 'holder', status: 'active', deleted_at: null });

            await expect(service.new_user(admin_auth, { username: 'taken', email: 'taken@test.com' }))
                .rejects.toMatchObject({ status: 409, code: 'conflict', details: { kind: 'user', field: 'email', holder: { id: hub_legacy_uuid(5), slug: 'holder' } } });
        });

        it('rejects an email a deleted user holds (409 deleted)', async () => {
            repos.user_repo.find_by_email.mockResolvedValueOnce({ id: hub_legacy_uuid(6), username: 'gone', status: 'active', deleted_at: new Date('2026-01-01T00:00:00Z') });

            await expect(service.new_user(admin_auth, { username: 'fresh', email: 'gone@test.com' }))
                .rejects.toMatchObject({ status: 409, code: 'deleted', details: { kind: 'user', id: hub_legacy_uuid(6), deleted_at: '2026-01-01T00:00:00.000Z', was_active: true } });
        });

        it('with reactivate, restores the deleted user named by the 409 instead of refusing', async () => {
            // Stop right after the restore call: the rest of the flow runs over HTTP in users_password_links.test.ts.
            const restore_user = vi.fn().mockRejectedValue(new Error('restore_user called'));
            service = new UsersService(
                repos.user_repo as any, repos.scope_repo as any, repos.token_repo as any, repos.audit_repo as any,
                repos.org_member_repo as any, config, { restore_user } as any,
            );
            repos.user_repo.find_by_email.mockResolvedValueOnce({ id: hub_legacy_uuid(6), username: 'gone', status: 'active', deleted_at: new Date('2026-01-01T00:00:00Z') });

            await expect(service.new_user(admin_auth, { username: 'fresh', email: 'gone@test.com', reactivate: true }))
                .rejects.toThrow('restore_user called');
            expect(restore_user).toHaveBeenCalledWith(admin_auth, hub_legacy_uuid(6), expect.anything());
            expect(User.create).not.toHaveBeenCalled();
        });

        it('with reactivate, a live holder still refuses (409 conflict)', async () => {
            const restore_user = vi.fn();
            service = new UsersService(
                repos.user_repo as any, repos.scope_repo as any, repos.token_repo as any, repos.audit_repo as any,
                repos.org_member_repo as any, config, { restore_user } as any,
            );
            repos.user_repo.find_by_email.mockResolvedValueOnce({ id: hub_legacy_uuid(5), username: 'holder', status: 'active', deleted_at: null });

            await expect(service.new_user(admin_auth, { username: 'taken', email: 'taken@test.com', reactivate: true }))
                .rejects.toMatchObject({ status: 409, code: 'conflict' });
            expect(restore_user).not.toHaveBeenCalled();
        });

        it('rejects invalid slug', async () => {
            await expect(service.new_user(admin_auth, { username: '123bad', email: 'x@x.com' }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });
    });

    // ── update ──────────────────────────────────────────────────────

    describe('update', () => {
        it('updates self without user_id', async () => {
            repos.user_repo.find_profile_by_id.mockResolvedValue({ id: hub_legacy_uuid(1), username: 'admin', display_name: 'Updated', email: 'admin@test.com' });

            const result = await service.update(admin_auth, { display_name: 'Updated' });

            expect(result.updated).toBe(true);
            expect(repos.user_repo.update_profile).toHaveBeenCalledWith(hub_legacy_uuid(1), { display_name: 'Updated' });
        });

        it('admin updates another user by user_id', async () => {
            repos.user_repo.find_profile_by_id.mockResolvedValue({ id: hub_legacy_uuid(2), username: 'john', display_name: 'Johnny', email: 'john@test.com' });

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
            repos.user_repo.find_profile_by_id.mockResolvedValue({
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
        it('rejects self-delete', async () => {
            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(1) }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('soft-deletes the user in one transaction and writes the audit row in it', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'target' };
            (User.findOne as any).mockResolvedValueOnce(target);

            const result = await service.delete(admin_auth, { user_id: hub_legacy_uuid(5) });

            expect(result.deleted).toBe(true);
            expect(User.destroy).not.toHaveBeenCalled();
            expect(ApiToken.destroy).not.toHaveBeenCalled();
            expect(repos.audit_repo.create).toHaveBeenCalledWith(
                hub_legacy_uuid(1), 'user.delete', 'user', hub_legacy_uuid(5),
                expect.objectContaining({ username: 'target' }), expect.anything(),
            );
        });

        it('refuses (409) and changes nothing when the user authored teams', async () => {
            (User.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(5), username: 'target' });
            vi.mocked(Team.count).mockResolvedValueOnce(2);

            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(5) }))
                .rejects.toThrow(expect.objectContaining({ status: 409, code: 'conflict' }));
            expect(User.update).not.toHaveBeenCalled();
            expect(repos.audit_repo.create).not.toHaveBeenCalled();
        });

        it('refuses with 409 owns_orgs while the user owns another org', async () => {
            const { Org } = await import('../../../src/models/index.js');
            (User.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(5), username: 'target' });
            vi.mocked(Org.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(40), slug: 'measureone' }] as any);

            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(5) }))
                .rejects.toMatchObject({ status: 409, code: 'owns_orgs', message: 'Transfer or delete these orgs first.', details: { orgs: [{ slug: 'measureone' }] } });
            expect(User.update).not.toHaveBeenCalled();
        });

        it('rejects protected username', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'cliq' };
            (User.findOne as any).mockResolvedValueOnce(target);

            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(5) }))
                .rejects.toThrow(expect.objectContaining({ status: 422 }));
        });

        it('rejects when user not found (or already deleted)', async () => {
            (User.findOne as any).mockResolvedValueOnce(null);

            await expect(service.delete(admin_auth, { user_id: hub_legacy_uuid(999) }))
                .rejects.toThrow(expect.objectContaining({ status: 404 }));
        });
    });

    // ── suspend ─────────────────────────────────────────────────────

    describe('suspend', () => {
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
                expect.objectContaining({ suspended_reason: 'spam', status: 'suspended' }),
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
        it('unsuspends user', async () => {
            const target = { id: hub_legacy_uuid(5), username: 'target' };
            (User.findByPk as any).mockResolvedValueOnce(target);

            const result = await service.unsuspend(admin_auth, { user_id: hub_legacy_uuid(5) });

            expect(result.suspended).toBe(false);
            // Status goes back to invited when the person never set a password, else active.
            expect(User.update).toHaveBeenCalledWith(
                expect.objectContaining({ suspended_at: null, suspended_reason: '', status: expect.objectContaining({ val: "CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END" }) }),
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
        const target = { id: hub_legacy_uuid(5), username: 'target', email: 't@test.com', display_name: 'T', status: 'active', deleted_at: null, suspended_at: null };

        it('unknown user → 404', async () => {
            await expect(service.reset_password(admin_auth, { user_id: hub_legacy_uuid(5) }))
                .rejects.toMatchObject({ status: 404 });
        });

        it('deleted user → 409 deleted with details', async () => {
            vi.mocked(User.findByPk).mockResolvedValueOnce({ ...target, deleted_at: new Date('2026-01-01T00:00:00Z') } as any);
            await expect(service.reset_password(admin_auth, { user_id: target.id }))
                .rejects.toMatchObject({ status: 409, code: 'deleted', details: { kind: 'user', id: target.id, deleted_at: '2026-01-01T00:00:00.000Z', was_active: true } });
        });

        it('suspended user → 409 not_active { status: suspended }', async () => {
            vi.mocked(User.findByPk).mockResolvedValueOnce({ ...target, status: 'suspended', suspended_at: new Date() } as any);
            await expect(service.reset_password(admin_auth, { user_id: target.id }))
                .rejects.toMatchObject({ status: 409, code: 'not_active', details: { status: 'suspended' } });
        });

        it('a person invited by email (no username yet) → 409 not_active { status: invited }', async () => {
            vi.mocked(User.findByPk).mockResolvedValueOnce({ ...target, username: null, status: 'invited' } as any);
            await expect(service.reset_password(admin_auth, { user_id: target.id }))
                .rejects.toMatchObject({ status: 409, code: 'not_active', details: { status: 'invited' } });
        });
    });

    describe('forgot_password', () => {
        const fake_links = (record: ReturnType<typeof vi.fn>) => new UsersService(
            repos.user_repo as any, repos.scope_repo as any, repos.token_repo as any, repos.audit_repo as any,
            repos.org_member_repo as any, config, undefined, { record_forgot_request: record } as any,
        );

        it('counts the request, then always answers { requested: true }', async () => {
            const record = vi.fn().mockResolvedValue(undefined);
            const svc = fake_links(record);
            vi.spyOn(svc, 'send_forgot_password_link').mockResolvedValue(false);
            await expect(svc.forgot_password({ email: 'nobody@test.com' })).resolves.toEqual({ requested: true });
            expect(record).toHaveBeenCalledWith('nobody@test.com');
        });

        it('over the limit → 429 rate_limited, nothing sent', async () => {
            const record = vi.fn().mockRejectedValue(Object.assign(new Error('Too many'), { status: 429, code: 'rate_limited' }));
            const svc = fake_links(record);
            const send = vi.spyOn(svc, 'send_forgot_password_link');
            await expect(svc.forgot_password({ email: 'a@test.com' })).rejects.toMatchObject({ status: 429 });
            expect(send).not.toHaveBeenCalled();
        });

        it.each([
            ['unknown', null],
            ['deleted', { id: hub_legacy_uuid(5), username: 'x', email: 'x@test.com', display_name: 'X', status: 'active', deleted_at: new Date(), suspended_at: null }],
            ['suspended', { id: hub_legacy_uuid(5), username: 'x', email: 'x@test.com', display_name: 'X', status: 'suspended', deleted_at: null, suspended_at: new Date() }],
            ['invited without username', { id: hub_legacy_uuid(5), username: null, email: 'x@test.com', display_name: 'X', status: 'invited', deleted_at: null, suspended_at: null }],
        ])('%s email: silently sends nothing', async (_label, row) => {
            vi.mocked(User.findOne).mockResolvedValueOnce(row as any);
            await expect(service.send_forgot_password_link('x@test.com')).resolves.toBe(false);
        });
    });

    // ── set_role ────────────────────────────────────────────────────

    describe('set_role', () => {
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

        it('with a reset token: rejects a short new password before touching the link', async () => {
            await expect(service.change_password_with_token({ reset_token: 'tok', new_password: 'short' }))
                .rejects.toMatchObject({ status: 422, code: 'invalid_params' });
        });

        it('with a reset token: an unusable link is refused before the password is hashed', async () => {
            const { ApiError } = await import('../../../src/errors/api_error.js');
            const assert_open = vi.fn().mockRejectedValue(new ApiError('not_found', 'This link is not valid.', 404));
            const svc = new UsersService(
                repos.user_repo as any, repos.scope_repo as any, repos.token_repo as any, repos.audit_repo as any,
                repos.org_member_repo as any, config, undefined, { assert_open } as any,
            );
            await expect(svc.change_password_with_token({ reset_token: 'nope', new_password: 'long-enough-password' }))
                .rejects.toMatchObject({ status: 404 });
            expect(assert_open).toHaveBeenCalledWith('nope');
            expect(hash_password).not.toHaveBeenCalled();
        });

        it('rejects a password longer than the maximum', async () => {
            await expect(service.change_password(user_auth, { current_password: 'old', new_password: 'x'.repeat(129) }))
                .rejects.toMatchObject({ status: 422, details: { field: 'password' } });
        });
    });

    // ── new_token ───────────────────────────────────────────────────

    // ── get_tokens ──────────────────────────────────────────────────

    // ── revoke_token ────────────────────────────────────────────────

});
