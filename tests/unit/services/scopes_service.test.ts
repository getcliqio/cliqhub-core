import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { ScopesService } from '../../../src/services/scopes_service.js';
import { ALICE, UNAUTHED, SITE_ADMIN } from '../../helpers/fixtures.js';

/* ─── Module mocks ────────────────────────────────────────────── */

const mock_user_find_by_pk = vi.fn();
const mock_user_find_one = vi.fn();
const mock_scope_find_by_pk = vi.fn();
const mock_scope_update = vi.fn();
const mock_scope_count = vi.fn().mockResolvedValue(0);
const mock_scope_find_all = vi.fn().mockResolvedValue([]);

vi.mock('../../../src/db/models/index.js', () => ({
    User: {
        findByPk: (...args: any[]) => mock_user_find_by_pk(...args),
        findOne: (...args: any[]) => mock_user_find_one(...args),
    },
    Scope: {
        findByPk: (...args: any[]) => mock_scope_find_by_pk(...args),
        update: (...args: any[]) => mock_scope_update(...args),
        count: (...args: any[]) => mock_scope_count(...args),
        findAll: (...args: any[]) => mock_scope_find_all(...args),
    },
    Org: {
        findByPk: vi.fn().mockResolvedValue(null),
    },
}));

/* ─── Repo factories ─────────────────────────────────────────── */

function make_scope_repo() {
    return {
        find_by_slug: vi.fn(),
        create: vi.fn().mockResolvedValue(hub_legacy_uuid(1)),
        delete_by_id: vi.fn().mockResolvedValue(undefined),
    };
}

function make_team_repo() {
    return {
        list_by_scope: vi.fn().mockResolvedValue([]),
    };
}

function make_audit_repo() {
    return { create: vi.fn().mockResolvedValue(undefined) };
}

function make_org_repo() {
    return {
        find_by_slug: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), slug: 'acme' }),
    };
}

function make_org_member_repo() {
    return {
        find_by_org_and_user: vi.fn().mockResolvedValue({ role: 'admin' }),
        list_admins_by_org: vi.fn().mockResolvedValue([{ user_id: hub_legacy_uuid(1) }]),
    };
}

function make_scope_member_repo() {
    return {
        create: vi.fn().mockResolvedValue(undefined),
        create_on_conflict_ignore: vi.fn().mockResolvedValue(undefined),
        find_by_scope_and_user: vi.fn().mockResolvedValue(null),
        delete_by_scope_and_user: vi.fn().mockResolvedValue(1),
        delete_by_scope_id: vi.fn().mockResolvedValue(undefined),
    };
}

/* ─── Helper to build service ─────────────────────────────────── */

function build_service(overrides: {
    scope_repo?: ReturnType<typeof make_scope_repo>;
    team_repo?: ReturnType<typeof make_team_repo>;
    audit_repo?: ReturnType<typeof make_audit_repo>;
    org_repo?: ReturnType<typeof make_org_repo>;
    org_member_repo?: ReturnType<typeof make_org_member_repo>;
    scope_member_repo?: ReturnType<typeof make_scope_member_repo>;
} = {}) {
    const scope_repo = overrides.scope_repo ?? make_scope_repo();
    const team_repo = overrides.team_repo ?? make_team_repo();
    const audit_repo = overrides.audit_repo ?? make_audit_repo();
    const org_repo = overrides.org_repo ?? make_org_repo();
    const org_member_repo = overrides.org_member_repo ?? make_org_member_repo();
    const scope_member_repo = overrides.scope_member_repo ?? make_scope_member_repo();
    const service = new ScopesService(
        scope_repo as any,
        team_repo as any,
        audit_repo as any,
        org_repo as any,
        org_member_repo as any,
        scope_member_repo as any,
    );
    return { service, scope_repo, team_repo, audit_repo, org_repo, org_member_repo, scope_member_repo };
}

/* ================================================================
   get
   ================================================================ */

describe('ScopesService — get', () => {
    let service: ScopesService;

    beforeEach(() => {
        vi.clearAllMocks();
        const fake_scopes = [
            { id: hub_legacy_uuid(1), slug: 'alpha', display_name: 'Alpha', owner_id: hub_legacy_uuid(1), visibility: 'public', scope_type: 'user', team_count: 3, created_at: '2025-01-01', User: { username: 'alice' } },
            { id: hub_legacy_uuid(2), slug: 'beta', display_name: 'Beta', owner_id: hub_legacy_uuid(2), visibility: 'private', scope_type: 'org', team_count: 0, created_at: '2025-02-01', User: { username: 'bob' } },
        ];
        mock_scope_count.mockResolvedValueOnce(2);
        mock_scope_find_all.mockResolvedValueOnce(fake_scopes);
        const built = build_service();
        service = built.service;
    });

    it('returns paginated scopes for admin', async () => {
        const result = await service.get(SITE_ADMIN, {});

        expect(result.total).toBe(2);
        expect(result.scopes).toHaveLength(2);
        expect(result.limit).toBe(50);
        expect(result.offset).toBe(0);
    });

    it('passes search term to both queries', async () => {
        mock_scope_count.mockResolvedValueOnce(0);
        mock_scope_find_all.mockResolvedValueOnce([]);

        await service.get(SITE_ADMIN, { search: 'alp' });

        expect(mock_scope_count).toHaveBeenCalled();
        expect(mock_scope_find_all).toHaveBeenCalled();
    });

    it('caps limit to 100', async () => {
        const result = await service.get(SITE_ADMIN, { limit: 500 });
        expect(result.limit).toBe(100);
    });

    it('respects explicit limit and offset', async () => {
        const result = await service.get(SITE_ADMIN, { limit: 10, offset: 20 });
        expect(result.limit).toBe(10);
        expect(result.offset).toBe(20);
    });

    it('returns 403 for non-admin user', async () => {
        await expect(service.get(ALICE, {}))
            .rejects.toThrow('Admin access required');
    });

    it('returns 401 for unauthenticated request', async () => {
        await expect(service.get(UNAUTHED, {}))
            .rejects.toThrow('Authentication required');
    });
});

/* ================================================================
   new_scope
   ================================================================ */

describe('ScopesService — new_scope', () => {
    let service: ScopesService;
    let scope_repo: ReturnType<typeof make_scope_repo>;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        scope_repo = built.scope_repo;
        audit_repo = built.audit_repo;
    });

    it('creates a scope successfully', async () => {
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        mock_user_find_one.mockResolvedValueOnce({ id: hub_legacy_uuid(1) });

        const result = await service.new_scope(SITE_ADMIN, { slug: 'my-scope', owner_username: 'alice' });

        expect(result.id).toBe(hub_legacy_uuid(1));
        expect(result.slug).toBe('my-scope');
        expect(scope_repo.create).toHaveBeenCalledWith('my-scope', 'my-scope', hub_legacy_uuid(1), 'public', 'user', undefined, undefined);
        expect(audit_repo.create).toHaveBeenCalled();
    });

    it('uses provided display_name, visibility, and scope_type', async () => {
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        mock_user_find_one.mockResolvedValueOnce({ id: hub_legacy_uuid(5) });

        await service.new_scope(SITE_ADMIN, {
            slug: 'acme', display_name: 'Acme Corp', owner_username: 'bob',
            visibility: 'private', scope_type: 'org', org_slug: 'acme',
        });

        expect(scope_repo.create).toHaveBeenCalledWith('acme', 'Acme Corp', hub_legacy_uuid(5), 'private', 'org', undefined, hub_legacy_uuid(1));
    });

    it('lowercases the slug', async () => {
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        mock_user_find_one.mockResolvedValueOnce({ id: hub_legacy_uuid(1) });

        const result = await service.new_scope(SITE_ADMIN, { slug: 'MyScope', owner_username: 'alice' });

        expect(result.slug).toBe('myscope');
        expect(scope_repo.find_by_slug).toHaveBeenCalledWith('myscope');
    });

    it('returns 422 for invalid slug format', async () => {
        await expect(service.new_scope(SITE_ADMIN, { slug: '123-bad', owner_username: 'alice' }))
            .rejects.toThrow('Slug must start with a letter');
    });

    it('returns 422 for slug with special characters', async () => {
        await expect(service.new_scope(SITE_ADMIN, { slug: 'bad_slug!', owner_username: 'alice' }))
            .rejects.toThrow('Slug must start with a letter');
    });

    it('returns 422 for reserved slug', async () => {
        await expect(service.new_scope(SITE_ADMIN, { slug: 'admin', owner_username: 'alice' }))
            .rejects.toThrow("Scope 'admin' is reserved");
    });

    it('returns 422 for another reserved slug (cliq)', async () => {
        await expect(service.new_scope(SITE_ADMIN, { slug: 'cliq', owner_username: 'alice' }))
            .rejects.toThrow("Scope 'cliq' is reserved");
    });

    it('returns 409 when slug already exists', async () => {
        scope_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(10), slug: 'taken' });

        await expect(service.new_scope(SITE_ADMIN, { slug: 'taken', owner_username: 'alice' }))
            .rejects.toThrow('Scope already exists');
    });

    it('returns 404 when owner user not found', async () => {
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        mock_user_find_one.mockResolvedValueOnce(null);

        await expect(service.new_scope(SITE_ADMIN, { slug: 'new-scope', owner_username: 'ghost' }))
            .rejects.toThrow("User 'ghost' not found");
    });

    it('forces user scope visibility to public even if private is requested', async () => {
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        mock_user_find_one.mockResolvedValueOnce({ id: hub_legacy_uuid(1) });

        await service.new_scope(SITE_ADMIN, {
            slug: 'personal', owner_username: 'alice',
            visibility: 'private', scope_type: 'user',
        });

        expect(scope_repo.create).toHaveBeenCalledWith('personal', 'personal', hub_legacy_uuid(1), 'public', 'user', undefined, undefined);
    });

    it('allows org scope to be created as private', async () => {
        scope_repo.find_by_slug.mockResolvedValueOnce(null);
        mock_user_find_one.mockResolvedValueOnce({ id: hub_legacy_uuid(5) });

        await service.new_scope(SITE_ADMIN, {
            slug: 'acme-private', display_name: 'Acme Private', owner_username: 'bob',
            visibility: 'private', scope_type: 'org', org_slug: 'acme',
        });

        expect(scope_repo.create).toHaveBeenCalledWith('acme-private', 'Acme Private', hub_legacy_uuid(5), 'private', 'org', undefined, hub_legacy_uuid(1));
    });

    it('returns 403 for non-admin user', async () => {
        await expect(service.new_scope(ALICE, { slug: 'test', owner_username: 'alice' }))
            .rejects.toThrow(/Admin access required|Missing scopes:admin/);
    });
});

/* ================================================================
   update
   ================================================================ */

describe('ScopesService — update', () => {
    let service: ScopesService;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    const EXISTING_SCOPE = {
        id: hub_legacy_uuid(5), slug: 'alpha', visibility: 'public', display_name: 'Alpha', owner_id: hub_legacy_uuid(1), scope_type: 'org',
    };

    const EXISTING_USER_SCOPE = {
        id: hub_legacy_uuid(6), slug: 'bob-personal', visibility: 'public', display_name: 'Bob', owner_id: hub_legacy_uuid(2), scope_type: 'user',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        audit_repo = built.audit_repo;
    });

    it('updates visibility and display_name', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(EXISTING_SCOPE);

        const result = await service.update(SITE_ADMIN, {
            scope_id: hub_legacy_uuid(5), visibility: 'private', display_name: 'Alpha Updated',
        });

        expect(result.updated).toBe(true);
        expect(mock_scope_update).toHaveBeenCalledWith(
            { visibility: 'private', display_name: 'Alpha Updated' },
            { where: { id: hub_legacy_uuid(5) } },
        );
        expect(audit_repo.create).toHaveBeenCalledWith(
            hub_legacy_uuid(99), 'scope.update', 'scope', 'alpha',
            expect.objectContaining({
                visibility: { from: 'public', to: 'private' },
                display_name: { from: 'Alpha', to: 'Alpha Updated' },
            }),
        );
    });

    it('updates owner_id', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(EXISTING_SCOPE);
        mock_user_find_by_pk.mockResolvedValueOnce({ id: hub_legacy_uuid(2) });

        const result = await service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(5), owner_id: hub_legacy_uuid(2) });

        expect(result.updated).toBe(true);
        expect(mock_scope_update).toHaveBeenCalledWith(
            { owner_id: hub_legacy_uuid(2) },
            { where: { id: hub_legacy_uuid(5) } },
        );
    });

    it('returns updated:false when no fields changed', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(EXISTING_SCOPE);

        const result = await service.update(SITE_ADMIN, {
            scope_id: hub_legacy_uuid(5), visibility: 'public', display_name: 'Alpha',
        });

        expect(result.updated).toBe(false);
        expect(mock_scope_update).not.toHaveBeenCalled();
        expect(audit_repo.create).not.toHaveBeenCalled();
    });

    it('returns 404 when scope not found', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(null);

        await expect(service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(999) }))
            .rejects.toThrow('Scope not found');
    });

    it('returns 404 when new owner not found', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(EXISTING_SCOPE);
        mock_user_find_by_pk.mockResolvedValueOnce(null);

        await expect(service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(5), owner_id: hub_legacy_uuid(888) }))
            .rejects.toThrow('Owner user not found');
    });

    it('returns 422 when setting user scope to private', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(EXISTING_USER_SCOPE);

        await expect(service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(6), visibility: 'private' }))
            .rejects.toThrow('User scopes cannot be set to private');
    });

    it('allows setting org scope to private', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(EXISTING_SCOPE);

        const result = await service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(5), visibility: 'private' });

        expect(result.updated).toBe(true);
        expect(mock_scope_update).toHaveBeenCalledWith(
            { visibility: 'private' },
            { where: { id: hub_legacy_uuid(5) } },
        );
    });

    it('returns 403 for non-admin user', async () => {
        await expect(service.update(ALICE, { scope_id: hub_legacy_uuid(5), visibility: 'private' }))
            .rejects.toThrow('Admin access required');
    });
});

/* ================================================================
   delete_scope
   ================================================================ */

describe('ScopesService — delete_scope', () => {
    let service: ScopesService;
    let scope_repo: ReturnType<typeof make_scope_repo>;
    let team_repo: ReturnType<typeof make_team_repo>;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        scope_repo = built.scope_repo;
        team_repo = built.team_repo;
        audit_repo = built.audit_repo;
    });

    it('deletes scope successfully', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce({ id: hub_legacy_uuid(5), slug: 'alpha' });
        team_repo.list_by_scope.mockResolvedValueOnce([]);

        const result = await service.delete_scope(SITE_ADMIN, { scope_id: hub_legacy_uuid(5) });

        expect(result.deleted).toBe(true);
        expect(scope_repo.delete_by_id).toHaveBeenCalledWith(hub_legacy_uuid(5));
        expect(audit_repo.create).toHaveBeenCalledWith(hub_legacy_uuid(99), 'scope.delete', 'scope', 'alpha', {});
    });

    it('returns 404 when scope not found', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce(null);

        await expect(service.delete_scope(SITE_ADMIN, { scope_id: hub_legacy_uuid(999) }))
            .rejects.toThrow('Scope not found');
    });

    it('returns 422 when scope has teams', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce({ id: hub_legacy_uuid(5), slug: 'alpha' });
        team_repo.list_by_scope.mockResolvedValueOnce([{ id: hub_legacy_uuid(1), name: 'team-a' }, { id: hub_legacy_uuid(2), name: 'team-b' }]);

        await expect(service.delete_scope(SITE_ADMIN, { scope_id: hub_legacy_uuid(5) }))
            .rejects.toThrow('Cannot delete scope with 2 team(s)');
    });

    it('returns 403 for non-admin user', async () => {
        mock_scope_find_by_pk.mockResolvedValueOnce({ id: hub_legacy_uuid(5), slug: 'alpha', org_id: null });
        await expect(service.delete_scope(ALICE, { scope_id: hub_legacy_uuid(5) }))
            .rejects.toThrow(/Admin access required|Missing scopes:admin/);
    });

    it('returns 401 for unauthenticated request', async () => {
        await expect(service.delete_scope(UNAUTHED, { scope_id: hub_legacy_uuid(5) }))
            .rejects.toThrow('Authentication required');
    });
});
