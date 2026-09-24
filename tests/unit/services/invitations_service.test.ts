import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { InvitationsService } from '../../../src/services/invitations_service.js';
import { UNAUTHED, ORG_ADMIN } from '../../helpers/fixtures.js';

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
        create_invite: vi.fn(),
        list_invites: vi.fn().mockResolvedValue([]),
        revoke_invite: vi.fn(),
        get_invite_by_token: vi.fn(),
        accept_invite: vi.fn(),
    },
}));

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
    Org: { findByPk: vi.fn().mockResolvedValue({ slug: 'acme' }) },
    AccountInvite: {
        findOne: vi.fn(),
        findByPk: vi.fn(),
        findAll: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue([1]),
    },
}));

vi.mock('../../../src/auth/jwt.js', () => ({
    sign_token: vi.fn().mockReturnValue('jwt-token'),
}));

vi.mock('../../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed'),
}));

function make_org_repo() {
    return {
        find_by_id: vi.fn().mockResolvedValue(null),
    };
}

function make_org_member_repo() {
    return {
        find_orgs_by_user: vi.fn().mockResolvedValue([]),
        find_by_org_and_user: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
    };
}

function make_scope_repo() {
    return {
        find_by_slug: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(10),
    };
}

function make_user_repo() {
    return {
        find_by_id: vi.fn(),
        find_by_username_or_email: vi.fn(),
        find_by_email: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
    };
}

function make_service(opts?: { with_config?: boolean }) {
    const org_repo = make_org_repo();
    const org_member_repo = make_org_member_repo();
    const scope_repo = make_scope_repo();
    const user_repo = make_user_repo();
    const config = opts?.with_config
        ? { jwt_secret: 'test-secret', jwt_expires_in: '1h' } as any
        : undefined;
    const service = new InvitationsService(
        org_repo as any,
        org_member_repo as any,
        scope_repo as any,
        user_repo as any,
        config,
    );
    return { service, org_repo, org_member_repo, scope_repo, user_repo };
}

describe('InvitationsService — create (org)', () => {
    let service: InvitationsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let user_repo: ReturnType<typeof make_user_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo, user_repo } = make_service());
    });

    it('adds existing user immediately', async () => {
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);
        user_repo.find_by_email.mockResolvedValueOnce({ id: hub_legacy_uuid(8) });
        user_repo.find_by_id.mockResolvedValueOnce({ id: hub_legacy_uuid(8), username: 'existing' });

        const result = await service.create(ORG_ADMIN, {
            target_type: 'org',
            org_id: hub_legacy_uuid(1),
            email: 'existing@test.com',
        });

        expect(result).toEqual({
            target_type: 'org',
            status: 'added',
            user_id: hub_legacy_uuid(8),
            username: 'existing',
            role: 'member',
        });
        expect(org_member_repo.create).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(8), 'member');
    });

    it('creates pending invite for unknown email', async () => {
        const { AccountInvite } = await import('../../../src/db/models/index.js');
        user_repo.find_by_email.mockResolvedValueOnce(null);
        (AccountInvite.findOne as any).mockResolvedValueOnce(null);
        (AccountInvite.create as any).mockResolvedValueOnce({ id: hub_legacy_uuid(42) });

        const result = await service.create(ORG_ADMIN, {
            target_type: 'org',
            org_id: hub_legacy_uuid(1),
            email: 'new@test.com',
        });

        expect(result.status).toBe('pending');
        expect(result.target_type).toBe('org');
        expect(result.invite_id).toBe(hub_legacy_uuid(42));
        expect(result.token).toBeTruthy();
        expect(AccountInvite.create).toHaveBeenCalled();
    });
});

describe('InvitationsService — accept (org)', () => {
    let service: InvitationsService;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let user_repo: ReturnType<typeof make_user_repo>;
    let scope_repo: ReturnType<typeof make_scope_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ service, org_member_repo, user_repo, scope_repo } = make_service({ with_config: true }));
    });

    it('creates user without Account and joins org', async () => {
        const { AccountInvite } = await import('../../../src/db/models/index.js');
        (AccountInvite.findOne as any).mockResolvedValueOnce({
            id: hub_legacy_uuid(7),
            org_id: hub_legacy_uuid(1),
            email: 'invitee@test.com',
            role: 'member',
            status: 'pending',
            expires_at: new Date(Date.now() + 60_000),
        });
        user_repo.find_by_email.mockResolvedValueOnce(null);
        user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
        user_repo.create.mockResolvedValueOnce(hub_legacy_uuid(77));
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        org_member_repo.find_by_org_and_user.mockResolvedValueOnce(null);
        org_member_repo.find_orgs_by_user.mockResolvedValueOnce([{ org_id: hub_legacy_uuid(1) }]);

        const result = await service.accept(UNAUTHED, {
            token: 'a'.repeat(64),
            username: 'invitee',
            password: 'longpassword',
        });

        expect(result.accepted).toBe(true);
        expect(result.target_type).toBe('org');
        expect(result.user_id).toBe(hub_legacy_uuid(77));
        expect(result.token).toBeTruthy();
        expect(user_repo.create).toHaveBeenCalled();
        expect(scope_repo.create).toHaveBeenCalled();
        expect(org_member_repo.create).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(77), 'member');
        expect(AccountInvite.update).toHaveBeenCalled();
    });
});
