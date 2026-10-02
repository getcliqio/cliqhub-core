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
        org_delete_blocker: vi.fn().mockResolvedValue(null),
        after_org_realms_removed: vi.fn().mockResolvedValue(undefined),
        ensure_personal_realm: vi.fn().mockResolvedValue({
            default_realm_id: 'realm-personal',
            default_realm_slug: 'default',
            default_realm_qualified: 'user.default',
        }),
    },
}));

vi.mock('../../../src/models/migrations/migrate_org_roles.js', () => ({
    seed_default_roles_for_org: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/services/org_seed.service.js', () => ({
    OrgSeedService: { seed_org: vi.fn().mockResolvedValue({ channels_created: 2, rules_created: 16 }) },
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

vi.mock('../../../src/models/index.js', () => ({
    User: { findOne: vi.fn(), findByPk: vi.fn(), create: vi.fn(), findAll: vi.fn().mockResolvedValue([]) },
    Scope: { create: vi.fn(), findAll: vi.fn().mockResolvedValue([]), findOne: vi.fn().mockResolvedValue(null), destroy: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    Org: { create: vi.fn(), update: vi.fn().mockResolvedValue([1]), findByPk: vi.fn(), findOne: vi.fn(), destroy: vi.fn(), count: vi.fn().mockResolvedValue(0), findAll: vi.fn().mockResolvedValue([]) },
    Realm: { findAll: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue([0]) },
    RealmMember: { destroy: vi.fn().mockResolvedValue(0) },
    RealmInvite: { update: vi.fn().mockResolvedValue([0]) },
    OrgMember: { create: vi.fn(), destroy: vi.fn(), findOne: vi.fn().mockResolvedValue({ role_id: hub_legacy_uuid(1) }), findAll: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue([1]), count: vi.fn().mockResolvedValue(0) },
    OrgRole: { findOne: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), is_system: false, permissions: ['org.members.manage', 'org.settings', 'org.scopes.manage'] }), findByPk: vi.fn().mockResolvedValue({ is_system: false, permissions: ['org.members.manage', 'org.settings', 'org.scopes.manage'] }), findAll: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(4), findOrCreate: vi.fn().mockResolvedValue([{}, false]), destroy: vi.fn().mockResolvedValue(0) },
    AccountInvite: {
        destroy: vi.fn().mockResolvedValue(0),
        findOne: vi.fn(),
        findByPk: vi.fn(),
        findAll: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue([1]),
    },
    ScopeMember: { create: vi.fn(), destroy: vi.fn() },
    Team: { count: vi.fn().mockResolvedValue(0) },
    NotificationRule: { destroy: vi.fn().mockResolvedValue(0) },
    NotificationChannel: { destroy: vi.fn().mockResolvedValue(0) },
    OrgAgentSetting: { destroy: vi.fn().mockResolvedValue(0) },
    AgentCatalog: { destroy: vi.fn().mockResolvedValue(0) },
}));

vi.mock('../../../src/auth/jwt.js', () => ({
    sign_token: vi.fn().mockReturnValue('jwt-token'),
}));

function make_org_repo() {
    return {
        find_by_id: vi.fn().mockResolvedValue(null),
        find_by_id_with_deleted: vi.fn().mockResolvedValue(null),
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
        find_default_scopes: vi.fn().mockResolvedValue([]),
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
        find_profile_by_id: vi.fn(),
        find_by_username: vi.fn().mockResolvedValue(null),
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

import { Org, Scope, Team } from '../../../src/models/index.js';

// ─── get (regular user path) ───────────────────────────────────────

describe('OrgsService — get (regular user)', () => {
    let service: OrgsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo } = make_service());
    });

    it('returns orgs for authenticated user', async () => {
        org_member_repo.list_my_orgs.mockResolvedValueOnce([{ id: hub_legacy_uuid(1), slug: 'acme', status: 'active', owner_id: null, deleted_at: null }]);

        const result = await service.get(ALICE, {});

        expect(result.orgs).toEqual([{ id: hub_legacy_uuid(1), slug: 'acme', status: 'active', owner: null, deleted_at: null }]);
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

    const live = (id: string, slug: string) => ({ id, slug, status: 'active', owner_id: null, deleted_at: null });
    const listed = (id: string, slug: string) => ({ id, slug, status: 'active', owner: null, deleted_at: null });

    it('returns paginated live orgs for admin without search', async () => {
        vi.mocked(Org.count).mockResolvedValueOnce(3);
        vi.mocked(Org.findAll).mockResolvedValueOnce([
            live(hub_legacy_uuid(1), 'a'), live(hub_legacy_uuid(2), 'b'), live(hub_legacy_uuid(3), 'c'),
        ] as any);

        const result = await service.get(SITE_ADMIN, { limit: 10, offset: 0 });

        expect(result).toEqual({ orgs: [listed(hub_legacy_uuid(1), 'a'), listed(hub_legacy_uuid(2), 'b'), listed(hub_legacy_uuid(3), 'c')], total: 3, limit: 10, offset: 0 });
    });

    it('returns paginated orgs for admin with search', async () => {
        vi.mocked(Org.count).mockResolvedValueOnce(1);
        vi.mocked(Org.findAll).mockResolvedValueOnce([live(hub_legacy_uuid(1), 'acme')] as any);

        const result = await service.get(SITE_ADMIN, { search: 'acme', limit: 50, offset: 0 });

        expect(result).toEqual({ orgs: [listed(hub_legacy_uuid(1), 'acme')], total: 1, limit: 50, offset: 0 });
    });

    it('include_deleted lists deleted orgs with status deleted and their owner', async () => {
        const { User } = await import('../../../src/models/index.js');
        const gone = new Date('2026-03-01T00:00:00.000Z');
        vi.mocked(Org.count).mockResolvedValueOnce(1);
        vi.mocked(Org.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(1), slug: 'acme', status: 'deleted', owner_id: hub_legacy_uuid(7), deleted_at: gone }] as any);
        vi.mocked(User.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(7), username: 'olivia', status: 'active', deleted_at: null }] as any);

        const result = await service.get(SITE_ADMIN, { include_deleted: true });

        expect(vi.mocked(Org.count).mock.calls[0][0]).not.toHaveProperty('where.deleted_at');
        expect((result as any).orgs).toEqual([{ id: hub_legacy_uuid(1), slug: 'acme', status: 'deleted', owner: { username: 'olivia', status: 'active' }, deleted_at: gone.toISOString() }]);
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
        org_member_repo.list_members_by_org.mockResolvedValueOnce([
            { user_id: hub_legacy_uuid(1), role: 'member', role_id: hub_legacy_uuid(4), status: 'active', email: 'alice@test.com' },
            { user_id: hub_legacy_uuid(2), role: 'member', role_id: hub_legacy_uuid(4), status: 'pending', email: 'bob@test.com' },
        ]);

        const result = await service.get_by_id(ALICE, { org_id: hub_legacy_uuid(1) });

        expect(result.my_role).toBe('member');
        expect(result.slug).toBe('acme');
        // A plain member sees active members only, without emails.
        expect(result.members).toEqual([{ user_id: hub_legacy_uuid(1), role: 'member', role_id: hub_legacy_uuid(4), status: 'active' }]);
        expect(result.roles).toEqual([]);
        expect(Array.isArray(result.available_permissions)).toBe(true);
        expect(result.available_permissions.length).toBeGreaterThan(0);
    });

    it('returns org for site admin with site_admin role, deleted orgs included', async () => {
        const gone = new Date('2026-03-01T00:00:00.000Z');
        org_repo.find_by_id_with_deleted.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme', status: 'deleted', owner_id: null, deleted_at: gone });
        org_member_repo.list_members_by_org.mockResolvedValueOnce([]);

        const result = await service.get_by_id(SITE_ADMIN, { org_id: hub_legacy_uuid(1) });

        expect(result.my_role).toBe('site_admin');
        expect(result).toMatchObject({ status: 'deleted', owner: null, deleted_at: gone.toISOString(), pending_owner_invite: null });
        expect(org_member_repo.find_by_org_and_user).not.toHaveBeenCalled();
        expect(org_repo.find_by_id).not.toHaveBeenCalled();
    });

    it('rejects non-member with 403', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);

        await expect(service.get_by_id(BOB, { org_id: hub_legacy_uuid(1) }))
            .rejects.toThrow('You are not a member of this org');
    });
});

// ─── new_org ───────────────────────────────────────────────────────

describe('OrgsService — new_org', () => {
    const OWNER_ID = hub_legacy_uuid(50);
    const ORG_ID = hub_legacy_uuid(100);
    const INVITE_EXPIRES = new Date('2026-10-16T10:00:00Z');
    let service: OrgsService;
    let org_repo: ReturnType<typeof make_org_repo>;
    let audit_repo: ReturnType<typeof make_audit_repo>;
    let invitations: { invitee_user_id: ReturnType<typeof vi.fn>; send_in_transaction: ReturnType<typeof vi.fn>; delivery_outcome: ReturnType<typeof vi.fn> };
    let reactivation: { assert_can_reactivate: ReturnType<typeof vi.fn>; restore_org: ReturnType<typeof vi.fn>; restore_user: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
        vi.clearAllMocks();
        invitations = {
            invitee_user_id: vi.fn().mockResolvedValue(OWNER_ID),
            send_in_transaction: vi.fn().mockResolvedValue({ invite: { id: 'inv-1', expires_at: INVITE_EXPIRES }, resent: false, event: {} }),
            delivery_outcome: vi.fn().mockResolvedValue({ email_sent: false, invite_url: 'https://app.test/invite/x' }),
        };
        reactivation = {
            assert_can_reactivate: vi.fn(),
            restore_org: vi.fn().mockResolvedValue({ id: ORG_ID, slug: 'neworg' }),
            restore_user: vi.fn(),
        };
        const built = make_service({ with_audit: true });
        ({ org_repo, audit_repo } = built);
        service = new OrgsService(
            built.org_repo as any, built.org_member_repo as any, built.scope_repo as any, built.scope_member_repo as any,
            built.user_repo as any, built.team_repo as any, built.audit_repo as any, invitations as any, reactivation as any,
        );
        const { User, Scope, Org } = await import('../../../src/models/index.js');
        (Scope.create as any).mockResolvedValue({ id: hub_legacy_uuid(20), slug: 'neworg' });
        (Org.create as any).mockResolvedValue({ id: ORG_ID, slug: 'neworg' });
        (Org.findByPk as any).mockResolvedValue({ id: ORG_ID, slug: 'neworg', display_name: 'New Org', status: 'waiting_for_owner', created_at: new Date('2026-10-02T10:00:00Z') });
        (User.findByPk as any).mockResolvedValue({ id: OWNER_ID, email: 'owner@test.com', status: 'invited', deleted_at: null });
    });

    it('creates a waiting_for_owner org and sends the owner invite to an email', async () => {
        const { Org } = await import('../../../src/models/index.js');
        const result = await service.new_org(SITE_ADMIN, {
            slug: 'NewOrg', display_name: 'New Org', owner: { email: 'Owner@Test.com ', display_name: 'Owner' },
        });

        expect(invitations.invitee_user_id).toHaveBeenCalledWith(SITE_ADMIN, 'owner@test.com', expect.objectContaining({ display_name: 'Owner' }));
        expect(invitations.send_in_transaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            target: 'org', org_id: ORG_ID, email: 'owner@test.com', role: 'owner', user_id: OWNER_ID,
        }));
        expect(audit_repo.create).toHaveBeenCalledWith(SITE_ADMIN.user!.id, 'org.create', 'org', 'neworg', expect.objectContaining({ owner_invite_id: 'inv-1' }), expect.anything());
        expect(result).toEqual({
            org: {
                id: ORG_ID, slug: 'neworg', display_name: 'New Org', status: 'waiting_for_owner',
                owner: { user_id: OWNER_ID, email: 'owner@test.com', status: 'invited' },
                created_at: '2026-10-02T10:00:00.000Z', reactivated: false,
            },
            owner_invite: {
                invite_id: 'inv-1', role: 'owner', status: 'pending', expires_at: INVITE_EXPIRES.toISOString(),
                email_sent: false, invite_url: 'https://app.test/invite/x',
            },
        });
    });

    it('uses an existing user as owner without creating a user', async () => {
        await service.new_org(SITE_ADMIN, { slug: 'neworg', owner: { user_id: OWNER_ID } });
        expect(invitations.invitee_user_id).not.toHaveBeenCalled();
        expect(invitations.send_in_transaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: OWNER_ID, email: 'owner@test.com' }));
    });

    it('throws 404 for an unknown owner user_id', async () => {
        const { User } = await import('../../../src/models/index.js');
        (User.findByPk as any).mockResolvedValueOnce(null);
        await expect(service.new_org(SITE_ADMIN, { slug: 'neworg', owner: { user_id: hub_legacy_uuid(77) } }))
            .rejects.toMatchObject({ status: 404 });
    });

    it('a deleted owner is 409 deleted unless reactivate', async () => {
        const { User } = await import('../../../src/models/index.js');
        (User.findByPk as any).mockResolvedValueOnce({ id: OWNER_ID, email: 'gone@test.com', status: 'active', deleted_at: new Date('2026-09-01T00:00:00Z') });
        await expect(service.new_org(SITE_ADMIN, { slug: 'neworg', owner: { user_id: OWNER_ID } }))
            .rejects.toMatchObject({ status: 409, code: 'deleted', details: { kind: 'user', id: OWNER_ID, was_active: true } });
    });

    it('rejects an invalid owner email with 422', async () => {
        await expect(service.new_org(SITE_ADMIN, { slug: 'neworg', owner: { email: 'nope' } })).rejects.toMatchObject({ status: 422 });
    });

    it('rejects invalid slug with 422', async () => {
        await expect(service.new_org(SITE_ADMIN, { slug: '123bad', owner: { user_id: OWNER_ID } })).rejects.toThrow('Slug must start with a letter');
    });

    it('rejects reserved slug with 422', async () => {
        await expect(service.new_org(SITE_ADMIN, { slug: 'admin', owner: { user_id: OWNER_ID } })).rejects.toThrow("Slug 'admin' is reserved");
    });

    it('rejects a slug held by a live org with 409 conflict', async () => {
        org_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(1), slug: 'taken' });
        await expect(service.new_org(SITE_ADMIN, { slug: 'taken', owner: { user_id: OWNER_ID } }))
            .rejects.toMatchObject({ status: 409, message: 'taken is already an org', details: { kind: 'org', slug: 'taken', personal: false } });
        expect(invitations.send_in_transaction).not.toHaveBeenCalled();
    });

    it('a slug held by a deleted org: 409 deleted, or restored with reactivate', async () => {
        const deleted_org = { id: ORG_ID, slug: 'neworg', deleted_at: new Date('2026-09-01T00:00:00Z'), status: 'deleted', activated_at: new Date('2026-01-01T00:00:00Z') };
        org_repo.find_by_slug.mockResolvedValueOnce(deleted_org);
        await expect(service.new_org(SITE_ADMIN, { slug: 'neworg', owner: { user_id: OWNER_ID } }))
            .rejects.toMatchObject({ status: 409, code: 'deleted', details: { kind: 'org', id: ORG_ID, was_active: true } });

        org_repo.find_by_slug.mockResolvedValueOnce(deleted_org);
        const result = await service.new_org(SITE_ADMIN, { slug: 'neworg', owner: { user_id: OWNER_ID }, reactivate: true });
        expect(reactivation.assert_can_reactivate).toHaveBeenCalledWith(SITE_ADMIN);
        expect(reactivation.restore_org).toHaveBeenCalledWith(SITE_ADMIN, ORG_ID, expect.anything());
        expect(result.org.reactivated).toBe(true);
        expect(audit_repo.create).toHaveBeenCalledWith(SITE_ADMIN.user!.id, 'org.reactivate', 'org', 'neworg', expect.anything(), expect.anything());
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

});

// ─── delete_org ────────────────────────────────────────────────────

describe('OrgsService — delete_org', () => {
    let service: OrgsService;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ({ service, audit_repo } = make_service({ with_audit: true }));
        const { Org, Scope, ScopeMember, OrgMember } = await import('../../../src/models/index.js');
        (Org.findOne as any).mockResolvedValue({ id: hub_legacy_uuid(1), slug: 'acme' });
        (Scope.findAll as any).mockResolvedValue([{ id: hub_legacy_uuid(10) }, { id: hub_legacy_uuid(11) }]);
        (Scope.destroy as any).mockResolvedValue(2);
        (ScopeMember.destroy as any).mockResolvedValue(3);
        (OrgMember.destroy as any).mockResolvedValue(1);
        (Org.destroy as any).mockResolvedValue(1);
    });

    it('soft-deletes the org when it has no teams: { id, deleted_at }, rows kept', async () => {
        vi.mocked(Team.count).mockResolvedValueOnce(0);

        const result = await service.delete_org(SITE_ADMIN, { org_id: hub_legacy_uuid(1) });

        expect(result).toEqual({ id: hub_legacy_uuid(1), deleted_at: expect.any(String) });
        expect(Org.destroy).not.toHaveBeenCalled();
        expect(audit_repo.create).toHaveBeenCalled();
    });

    it('an owner (not a site admin) deletes their org once the route policy let them through', async () => {
        vi.mocked(Team.count).mockResolvedValueOnce(0);
        const result = await service.delete_org(ALICE, { org_id: hub_legacy_uuid(1) });
        expect(result.id).toBe(hub_legacy_uuid(1));
    });

    it('a personal org (slug = a username) cannot be deleted by its owner → 409', async () => {
        const made = make_service({ with_audit: true });
        made.user_repo.find_by_username.mockResolvedValueOnce({ id: ALICE.user!.id, username: 'acme' });
        await expect(made.service.delete_org(ALICE, { org_id: hub_legacy_uuid(1) }))
            .rejects.toMatchObject({ status: 409 });
    });

    it('throws 404 when org not found', async () => {
        (Org.findOne as any).mockResolvedValueOnce(null);

        await expect(service.delete_org(SITE_ADMIN, { org_id: hub_legacy_uuid(999) }))
            .rejects.toThrow('Org not found');
    });

    it('throws 409 when org has teams', async () => {
        vi.mocked(Team.count).mockResolvedValueOnce(3);

        await expect(service.delete_org(SITE_ADMIN, { org_id: hub_legacy_uuid(1) }))
            .rejects.toThrow('Cannot delete org with 3 team(s)');
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
            .rejects.toMatchObject({ status: 409, code: 'conflict', details: { kind: 'scope', slug: 'acme-dev' } });
    });

    it('rejects when org not found', async () => {
        org_repo.find_by_id.mockResolvedValueOnce(null);

        await expect(service.new_scope(ORG_ADMIN, { org_id: hub_legacy_uuid(1), slug: 'acme-dev' }))
            .rejects.toThrow('Org not found');
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

});
