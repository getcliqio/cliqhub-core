import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { OrgsService } from '../../../src/services/orgs_service.js';
import { ALICE, BOB, UNAUTHED, SITE_ADMIN, ORG_ADMIN } from '../../helpers/fixtures.js';

vi.mock('../../../src/db/sequelize.js', () => ({
    get_sequelize: vi.fn().mockReturnValue({
        transaction: vi.fn().mockImplementation(async (fn: any) => fn({})),
        query: vi.fn().mockResolvedValue([[], {}]),
    }),
}));

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {
        upsert_user_member: vi.fn().mockResolvedValue(undefined),
        remove_member_silent: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        list_for_user: vi.fn().mockResolvedValue({ realms: [], total: 0 }),
        ensure_org_default_realm: vi.fn().mockResolvedValue({ id: 'realm-1', slug: 'org.default' }),
        ensure_personal_realm: vi.fn().mockResolvedValue({
            default_realm_id: 'realm-personal',
            default_realm_slug: 'default',
            default_realm_qualified: 'user.default',
        }),
    },
}));

vi.mock('../../../src/db/migrate_org_roles.js', () => ({
    seed_default_roles_for_org: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/services/org_realm_sync_service.js', () => ({
    OrgRealmSyncService: {
        sync_member_removed: vi.fn().mockResolvedValue(0),
        bulk_add_to_realms: vi.fn().mockResolvedValue(0),
        list_org_realm_ids: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('../../../src/services/per_user_channel.service.js', () => ({
    ensure_per_user_channel: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Mock require_permission: resolve for ORG_ADMIN (user_id 3) and site admins,
 * reject everyone else. This lets existing _require_org_admin tests work
 * after Phase 3 switched to permission-based gates.
 */
const _mock_require_permission = vi.fn().mockImplementation(
    async (org_id: string, user_id: string, _perm: string, opts?: { site_role?: string }) => {
        if (opts?.site_role === 'admin') return;
        if (user_id === hub_legacy_uuid(3)) return;
        const { ApiError } = await import('../../../src/errors/api_error.js');
        throw new ApiError('forbidden', `Permission '${_perm}' is required`, 403);
    },
);
vi.mock('../../../src/auth/permissions.js', async (importOriginal) => {
    const orig = await importOriginal() as Record<string, unknown>;
    return {
        ...orig,
        require_permission: (...args: any[]) => _mock_require_permission(...args),
    };
});

vi.mock('../../../src/db/models/index.js', () => ({
    User: { findOne: vi.fn(), create: vi.fn(), findAll: vi.fn().mockResolvedValue([]) },
    Scope: { create: vi.fn(), findAll: vi.fn().mockResolvedValue([]), findOne: vi.fn().mockResolvedValue(null), destroy: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    Org: { create: vi.fn(), update: vi.fn().mockResolvedValue([1]), findByPk: vi.fn(), destroy: vi.fn(), count: vi.fn().mockResolvedValue(0), findAll: vi.fn().mockResolvedValue([]) },
    OrgMember: { create: vi.fn(), destroy: vi.fn(), findOne: vi.fn().mockResolvedValue({ role_id: hub_legacy_uuid(1) }), findAll: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue([1]), count: vi.fn().mockResolvedValue(0) },
    OrgRole: { findOne: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), is_system: false, permissions: ['org.members.manage', 'org.settings', 'org.scopes.manage'] }), findByPk: vi.fn().mockResolvedValue({ is_system: false, permissions: ['org.members.manage', 'org.settings', 'org.scopes.manage'] }), findAll: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(4), findOrCreate: vi.fn().mockResolvedValue([{}, false]) },
    AccountInvite: {
        findOne: vi.fn(),
        findByPk: vi.fn(),
        findAll: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue([1]),
    },
    ScopeMember: { create: vi.fn(), destroy: vi.fn() },
    Team: { count: vi.fn().mockResolvedValue(0) },
}));

vi.mock('../../../src/auth/jwt.js', () => ({
    sign_token: vi.fn().mockReturnValue('jwt-token'),
}));

function make_org_repo() {
    return {
        find_by_id: vi.fn().mockResolvedValue(null),
        find_by_slug: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(hub_legacy_uuid(1)),
        update_display_name: vi.fn(),
        delete_by_id: vi.fn(),
    };
}

function make_org_member_repo() {
    return {
        find_orgs_by_user: vi.fn().mockResolvedValue([]),
        find_by_org_and_user: vi.fn().mockResolvedValue(null),
        list_members_by_org: vi.fn().mockResolvedValue([]),
        count_admins_by_org: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
        update_role: vi.fn(),
        delete_by_org_and_user: vi.fn(),
        list_my_orgs: vi.fn().mockResolvedValue([]),
        list_admins_by_org: vi.fn().mockResolvedValue([]),
    };
}

function make_scope_repo() {
    return {
        find_owned_by_user: vi.fn(),
        find_by_org_ids: vi.fn(),
        find_member_scopes: vi.fn(),
        find_by_slug: vi.fn().mockResolvedValue(null),
        find_by_slug_with_transaction: vi.fn(),
        create: vi.fn().mockResolvedValue(hub_legacy_uuid(10)),
        delete_by_id: vi.fn(),
    };
}

function make_scope_member_repo() {
    return {
        find_by_scope_and_user: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        create_on_conflict_ignore: vi.fn(),
        delete_by_scope_and_user: vi.fn().mockResolvedValue(1),
        delete_by_scope_id: vi.fn(),
        delete_by_user_and_org_scopes: vi.fn(),
    };
}

function make_user_repo() {
    return {
        find_by_id: vi.fn(),
        find_by_username: vi.fn().mockResolvedValue(null),
        find_by_username_or_email: vi.fn(),
        find_by_email: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        find_by_id_with_transaction: vi.fn(),
        find_password_hash: vi.fn(),
        update_profile: vi.fn(),
        update_password: vi.fn(),
    };
}

function make_team_repo() {
    return {
        find_by_name_and_scope: vi.fn().mockResolvedValue(null),
        list_by_scope: vi.fn().mockResolvedValue([]),
        list_filtered: vi.fn(),
        count_filtered: vi.fn(),
        find_author_username: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        update_name: vi.fn(),
        update_listed: vi.fn(),
        update_install_count: vi.fn(),
        delete_by_id: vi.fn(),
        list_by_scope_list: vi.fn(),
    };
}

function make_audit_repo() {
    return {
        create: vi.fn(),
    };
}

function make_service(opts?: { with_audit?: boolean }) {
    const org_repo = make_org_repo();
    const org_member_repo = make_org_member_repo();
    const scope_repo = make_scope_repo();
    const scope_member_repo = make_scope_member_repo();
    const user_repo = make_user_repo();
    const team_repo = make_team_repo();
    const audit_repo = make_audit_repo();
    const service = new OrgsService(
        org_repo as any,
        org_member_repo as any,
        scope_repo as any,
        scope_member_repo as any,
        user_repo as any,
        team_repo as any,
        opts?.with_audit ? (audit_repo as any) : undefined,
    );
    return { service, org_repo, org_member_repo, scope_repo, scope_member_repo, user_repo, team_repo, audit_repo };
}

import { Org, Scope, Team } from '../../../src/db/models/index.js';

// ─── get (regular user path) ───────────────────────────────────────

describe('OrgsService — get (regular user)', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo } = make_service());
    });

    it('returns orgs for authenticated user', async () => {
        org_member_repo.list_my_orgs.mockResolvedValueOnce([{ id: hub_legacy_uuid(1), slug: 'acme' }]);

        const result = await service.get(ALICE, {});

        expect(result.orgs).toEqual([{ id: hub_legacy_uuid(1), slug: 'acme' }]);
        expect(org_member_repo.list_my_orgs).toHaveBeenCalledWith(hub_legacy_uuid(1));
    });
});

// ─── get (admin path with search/pagination) ──────────────────────

describe('OrgsService — get (admin path)', () => {
    let service: OrgsService;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service } = make_service());
    });

    it('returns paginated orgs for admin without search', async () => {
        vi.mocked(Org.count).mockResolvedValueOnce(3);
        vi.mocked(Org.findAll).mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), slug: 'a' }, { id: hub_legacy_uuid(2), slug: 'b' }, { id: hub_legacy_uuid(3), slug: 'c' },
        ] as any);

        const result = await service.get(SITE_ADMIN, { limit: 10, offset: 0 });

        expect(result).toEqual({ orgs: [{ id: hub_legacy_uuid(1), slug: 'a' }, { id: hub_legacy_uuid(2), slug: 'b' }, { id: hub_legacy_uuid(3), slug: 'c' }], total: 3, limit: 10, offset: 0 });
    });

    it('returns paginated orgs for admin with search', async () => {
        vi.mocked(Org.count).mockResolvedValueOnce(1);
        vi.mocked(Org.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(1), slug: 'acme' }] as any);

        const result = await service.get(SITE_ADMIN, { search: 'acme', limit: 50, offset: 0 });

        expect(result).toEqual({ orgs: [{ id: hub_legacy_uuid(1), slug: 'acme' }], total: 1, limit: 50, offset: 0 });
    });

    it('clamps limit to 100 and defaults offset to 0', async () => {
        vi.mocked(Org.count).mockResolvedValueOnce(0);
        vi.mocked(Org.findAll).mockResolvedValueOnce([] as any);

        const result = await service.get(SITE_ADMIN, { limit: 200 });

        expect((result as any).limit).toBe(100);
        expect((result as any).offset).toBe(0);
    });
});

// ─── get_by_id ─────────────────────────────────────────────────────

describe('OrgsService — get_by_id', () => {
    let service: OrgsService;
    let org_repo: ReturnType<typeof make_org_repo>;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_repo, org_member_repo } = make_service());
    });

    it('returns org for member', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ role: 'member' });
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        org_member_repo.list_members_by_org.mockResolvedValueOnce([{ user_id: hub_legacy_uuid(1), role: 'member', role_id: hub_legacy_uuid(4) }]);

        const result = await service.get_by_id(ALICE, { org_id: hub_legacy_uuid(1) });

        expect(result.my_role).toBe('member');
        expect(result.slug).toBe('acme');
        expect(result.members).toEqual([{ user_id: hub_legacy_uuid(1), role: 'member', role_id: hub_legacy_uuid(4) }]);
        expect(result.roles).toEqual([]);
        expect(Array.isArray(result.available_permissions)).toBe(true);
        expect(result.available_permissions.length).toBeGreaterThan(0);
    });

    it('returns org for site admin with site_admin role', async () => {
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme' });
        org_member_repo.list_members_by_org.mockResolvedValueOnce([]);

        const result = await service.get_by_id(SITE_ADMIN, { org_id: hub_legacy_uuid(1) });

        expect(result.my_role).toBe('site_admin');
        expect(org_member_repo.find_by_org_and_user).not.toHaveBeenCalled();
    });

    it('rejects non-member with 403', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);

        await expect(service.get_by_id(BOB, { org_id: hub_legacy_uuid(1) }))
            .rejects.toThrow('You are not a member of this org');
    });
});

// ─── new_org ───────────────────────────────────────────────────────

describe('OrgsService — new_org', () => {
    let service: OrgsService;
    let org_repo: ReturnType<typeof make_org_repo>;
    let scope_repo: ReturnType<typeof make_scope_repo>;
    let user_repo: ReturnType<typeof make_user_repo>;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ({ service, org_repo, scope_repo, user_repo, audit_repo } = make_service({ with_audit: true }));
        const { User, Scope, Org, OrgMember, ScopeMember } = await import('../../../src/db/models/index.js');
        (User.findOne as any).mockResolvedValue(null);
        (User.create as any).mockResolvedValue({ id: hub_legacy_uuid(50), username: 'newadmin' });
        (Scope.create as any).mockResolvedValue({ id: hub_legacy_uuid(20), slug: 'neworg' });
        (Org.create as any).mockResolvedValue({ id: hub_legacy_uuid(100), slug: 'neworg' });
        (OrgMember.create as any).mockResolvedValue({});
        (ScopeMember.create as any).mockResolvedValue({});
    });

    it('creates org with existing user', async () => {
        const { User } = await import('../../../src/db/models/index.js');
        (User.findOne as any).mockResolvedValueOnce({ id: hub_legacy_uuid(5), username: 'existingadmin' });

        const result = await service.new_org(SITE_ADMIN, {
            slug: 'neworg', admin_username: 'existingadmin',
        });

        expect(result).toEqual({
            id: hub_legacy_uuid(100),
            slug: 'neworg',
            scope_id: hub_legacy_uuid(20),
            scope_slug: 'neworg',
            default_scope_id: hub_legacy_uuid(20),
        });
    });

    it('creates org and new user when user does not exist', async () => {
        const { User } = await import('../../../src/db/models/index.js');
        (User.findOne as any).mockResolvedValueOnce(null);

        const result = await service.new_org(SITE_ADMIN, {
            slug: 'neworg', admin_username: 'newadmin',
            admin_email: 'new@test.com', admin_password: 'longpassword',
            admin_display_name: 'New Admin',
        });

        expect(result.id).toBe(hub_legacy_uuid(100));
        expect(result.slug).toBe('neworg');
        expect(result.scope_id).toBe(hub_legacy_uuid(20));
        expect(result).not.toHaveProperty('realm_id');
        expect(User.create).toHaveBeenCalled();
        expect(audit_repo.create).toHaveBeenCalled();
    });

    it('throws 404 when user not found and no email/password provided', async () => {
        const { User } = await import('../../../src/db/models/index.js');
        (User.findOne as any).mockResolvedValueOnce(null);

        await expect(service.new_org(SITE_ADMIN, {
            slug: 'neworg', admin_username: 'ghost',
        })).rejects.toThrow("User 'ghost' not found");
    });

    it('rejects non-admin with 403', async () => {
        await expect(service.new_org(ALICE, {
            slug: 'neworg', admin_username: 'someone',
        })).rejects.toThrow('Admin access required');
    });

    it('rejects invalid slug with 422', async () => {
        await expect(service.new_org(SITE_ADMIN, {
            slug: '123bad', admin_username: 'someone',
        })).rejects.toThrow('Slug must start with a letter');
    });

    it('rejects reserved slug with 422', async () => {
        await expect(service.new_org(SITE_ADMIN, {
            slug: 'admin', admin_username: 'someone',
        })).rejects.toThrow("Slug 'admin' is reserved");
    });

    it('rejects duplicate org slug with 409', async () => {
        org_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'taken' });

        await expect(service.new_org(SITE_ADMIN, {
            slug: 'taken', admin_username: 'someone',
        })).rejects.toThrow('An org with that slug already exists');
    });
});

// ─── update ────────────────────────────────────────────────────────

describe('OrgsService — update', () => {
    let service: OrgsService;
    let org_repo: ReturnType<typeof make_org_repo>;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_repo, org_member_repo } = make_service());
    });

    it('updates display name for org admin', async () => {
        const result = await service.update(ORG_ADMIN, { org_id: hub_legacy_uuid(1), display_name: 'New Name' });

        expect(result.updated).toBe(true);
        expect(org_repo.update_display_name).toHaveBeenCalledWith(hub_legacy_uuid(1), 'New Name');
    });

    it('rejects non-admin member with 403', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'member' });

        await expect(service.update(ALICE, { org_id: hub_legacy_uuid(1), display_name: 'New Name' }))
            .rejects.toThrow("Permission 'org.members.manage' is required");
    });
});

// ─── delete_org ────────────────────────────────────────────────────

describe('OrgsService — delete_org', () => {
    let service: OrgsService;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ({ service, audit_repo } = make_service({ with_audit: true }));
        const { Org, Scope, ScopeMember, OrgMember } = await import('../../../src/db/models/index.js');
        (Org.findByPk as any).mockResolvedValue({ id: hub_legacy_uuid(1), slug: 'acme' });
        (Scope.findAll as any).mockResolvedValue([{ id: hub_legacy_uuid(10) }, { id: hub_legacy_uuid(11) }]);
        (Scope.destroy as any).mockResolvedValue(2);
        (ScopeMember.destroy as any).mockResolvedValue(3);
        (OrgMember.destroy as any).mockResolvedValue(1);
        (Org.destroy as any).mockResolvedValue(1);
    });

    it('deletes org successfully when no teams', async () => {
        vi.mocked(Team.count).mockResolvedValueOnce(0);

        const result = await service.delete_org(SITE_ADMIN, { org_id: hub_legacy_uuid(1) });

        expect(result.deleted).toBe(true);
        expect(audit_repo.create).toHaveBeenCalled();
    });

    it('throws 404 when org not found', async () => {
        (Org.findByPk as any).mockResolvedValueOnce(null);

        await expect(service.delete_org(SITE_ADMIN, { org_id: hub_legacy_uuid(999) }))
            .rejects.toThrow('Org not found');
    });

    it('throws 409 when org has teams', async () => {
        vi.mocked(Team.count).mockResolvedValueOnce(3);

        await expect(service.delete_org(SITE_ADMIN, { org_id: hub_legacy_uuid(1) }))
            .rejects.toThrow('Cannot delete org with 3 team(s)');
    });
});

// ─── add_member ────────────────────────────────────────────────────

describe('OrgsService — add_member', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let user_repo: ReturnType<typeof make_user_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo, user_repo } = make_service());
    });

    it('adds user as member', async () => {
        // require_permission is mocked to allow ORG_ADMIN, so no repo admin check.
        // Only the "is already member?" check uses find_by_org_and_user.
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);
        user_repo.find_by_username.mockResolvedValueOnce({ id: hub_legacy_uuid(5), username: 'charlie' });

        const result = await service.add_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), username: 'charlie' });

        expect(result).toEqual({ user_id: hub_legacy_uuid(5), username: 'charlie', role: 'member' });
        expect(org_member_repo.create).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(5), 'member');
    });

    it('rejects non-existent user with 404', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);
        user_repo.find_by_username.mockResolvedValueOnce(null);

        await expect(service.add_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), username: 'ghost' }))
            .rejects.toThrow('User not found');
    });

    it('rejects duplicate member with 409', async () => {
        org_member_repo.find_by_org_and_user
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'member' });
        user_repo.find_by_username.mockResolvedValueOnce({ id: hub_legacy_uuid(5), username: 'charlie' });

        await expect(service.add_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), username: 'charlie' }))
            .rejects.toThrow('User is already a member');
    });
});

// ─── remove_member ─────────────────────────────────────────────────

describe('OrgsService — remove_member', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let scope_member_repo: ReturnType<typeof make_scope_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo, scope_member_repo } = make_service());
    });

    it('removes a member', async () => {
        org_member_repo.find_by_org_and_user
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'member' });

        const result = await service.remove_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5) });

        expect(result.removed).toBe(true);
        expect(scope_member_repo.delete_by_user_and_org_scopes).toHaveBeenCalledWith(hub_legacy_uuid(5), hub_legacy_uuid(1));
        expect(org_member_repo.delete_by_org_and_user).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(5));
    });

    it('rejects removing last admin with 409', async () => {
        org_member_repo.find_by_org_and_user
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'admin' });
        org_member_repo.count_admins_by_org.mockResolvedValueOnce(1);

        await expect(service.remove_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5) }))
            .rejects.toThrow('Cannot remove the last org admin');
    });

    it('rejects non-admin with 403', async () => {
        await expect(service.remove_member(ALICE, { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5) }))
            .rejects.toThrow("Permission 'org.members.manage' is required");
    });
});

// ─── leave ─────────────────────────────────────────────────────────

describe('OrgsService — leave', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let scope_member_repo: ReturnType<typeof make_scope_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo, scope_member_repo } = make_service());
    });

    it('leaves org as non-admin member', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'member' });

        const result = await service.leave(ALICE, { org_id: hub_legacy_uuid(1) });

        expect(result.left).toBe(true);
        expect(scope_member_repo.delete_by_user_and_org_scopes).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(1));
        expect(org_member_repo.delete_by_org_and_user).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(1));
    });

    it('rejects when last admin tries to leave', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(3), role: 'admin' });
        org_member_repo.count_admins_by_org.mockResolvedValueOnce(1);

        await expect(service.leave(ORG_ADMIN, { org_id: hub_legacy_uuid(1) }))
            .rejects.toThrow('Cannot leave as the last org admin');
    });

    it('allows admin to leave when other admins exist', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(3), role: 'admin' });
        org_member_repo.count_admins_by_org.mockResolvedValueOnce(2);

        const result = await service.leave(ORG_ADMIN, { org_id: hub_legacy_uuid(1) });

        expect(result.left).toBe(true);
    });

    it('rejects when not a member', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);

        await expect(service.leave(ALICE, { org_id: hub_legacy_uuid(1) }))
            .rejects.toThrow('You are not a member of this org');
    });
});

// ─── new_scope ─────────────────────────────────────────────────────

describe('OrgsService — new_scope', () => {
    let service: OrgsService;
    let org_repo: ReturnType<typeof make_org_repo>;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let scope_repo: ReturnType<typeof make_scope_repo>;
    let scope_member_repo: ReturnType<typeof make_scope_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_repo, org_member_repo, scope_repo, scope_member_repo } = make_service());
    });

    it('creates scope with matching org slug prefix', async () => {
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme' });
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        org_member_repo.list_admins_by_org.mockResolvedValueOnce([{ user_id: hub_legacy_uuid(3) }, { user_id: hub_legacy_uuid(7) }]);

        const result = await service.new_scope(ORG_ADMIN, { org_id: hub_legacy_uuid(1), slug: 'acme-dev' });

        expect(result).toEqual({ id: hub_legacy_uuid(10), slug: 'acme-dev' });
        expect(scope_repo.create).toHaveBeenCalledWith('acme-dev', 'acme-dev', hub_legacy_uuid(3), 'public', 'org', undefined, hub_legacy_uuid(1));
        expect(scope_member_repo.create_on_conflict_ignore).toHaveBeenCalledTimes(2);
    });

    it('rejects slug not matching org prefix', async () => {
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme' });

        await expect(service.new_scope(ORG_ADMIN, { org_id: hub_legacy_uuid(1), slug: 'other-scope' }))
            .rejects.toThrow("Scope slug must be 'acme' or start with 'acme-'");
    });

    it('rejects duplicate scope slug with 409', async () => {
        org_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme' });
        scope_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(5), slug: 'acme-dev' });

        await expect(service.new_scope(ORG_ADMIN, { org_id: hub_legacy_uuid(1), slug: 'acme-dev' }))
            .rejects.toThrow('A scope with that slug already exists');
    });

    it('rejects when org not found', async () => {
        org_repo.find_by_id.mockResolvedValueOnce(null);

        await expect(service.new_scope(ORG_ADMIN, { org_id: hub_legacy_uuid(1), slug: 'acme-dev' }))
            .rejects.toThrow('Org not found');
    });

    it('rejects non-admin with 403', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'member' });

        await expect(service.new_scope(ALICE, { org_id: hub_legacy_uuid(1), slug: 'acme-dev' }))
            .rejects.toThrow("Permission 'org.members.manage' is required");
    });
});

// ─── delete_scope ──────────────────────────────────────────────────

describe('OrgsService — delete_scope', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo } = make_service());
    });

    it('rejects non-admin with 403', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'member' });

        await expect(service.delete_scope(ALICE, { org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10) }))
            .rejects.toThrow("Permission 'org.members.manage' is required");
    });

    it('rejects when scope not found in org', async () => {
        vi.mocked(Scope.findOne).mockResolvedValueOnce(null);

        await expect(service.delete_scope(ORG_ADMIN, { org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(999) }))
            .rejects.toThrow('Scope not found in this org');
    });
});

// ─── assign_scope_member ───────────────────────────────────────────

describe('OrgsService — assign_scope_member', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let scope_member_repo: ReturnType<typeof make_scope_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo, scope_member_repo } = make_service());
    });

    it('assigns scope member successfully', async () => {
        org_member_repo.find_by_org_and_user
            .mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(5), role: 'member' });
        vi.mocked(Scope.findOne).mockResolvedValueOnce({ id: hub_legacy_uuid(10) } as any);

        const result = await service.assign_scope_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(5) });

        expect(result.assigned).toBe(true);
        expect(scope_member_repo.create).toHaveBeenCalledWith(hub_legacy_uuid(10), hub_legacy_uuid(5));
    });

    it('rejects when scope not in org', async () => {
        vi.mocked(Scope.findOne).mockResolvedValueOnce(null);

        await expect(service.assign_scope_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(999), user_id: hub_legacy_uuid(5) }))
            .rejects.toThrow('Scope not found in this org');
    });
});

// ─── unassign_scope_member ─────────────────────────────────────────

describe('OrgsService — unassign_scope_member', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let scope_member_repo: ReturnType<typeof make_scope_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo, scope_member_repo } = make_service());
    });

    it('unassigns scope member successfully', async () => {
        scope_member_repo.delete_by_scope_and_user.mockResolvedValueOnce(1);
        vi.mocked(Scope.findOne).mockResolvedValueOnce({ id: hub_legacy_uuid(10) } as any);

        const result = await service.unassign_scope_member(ORG_ADMIN, { org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(5) });

        expect(result.removed).toBe(true);
    });

    it('rejects non-admin with 403', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), role: 'member' });

        await expect(service.unassign_scope_member(ALICE, { org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(10), user_id: hub_legacy_uuid(5) }))
            .rejects.toThrow("Permission 'org.members.manage' is required");
    });
});
