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

vi.mock('../../../src/models/index.js', () => ({
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
        find_by_id: vi.fn().mockResolvedValue(null),
        find_count: vi.fn().mockResolvedValue(0),
        find_all: vi.fn().mockResolvedValue([]),
        find_catalog_page: vi.fn().mockResolvedValue([]),
        update_where: vi.fn().mockResolvedValue([1]),
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
        // Only the org named `acme` exists (scope names share the org namespace).
        find_by_slug: vi.fn().mockImplementation(async (slug: string) => (slug === 'acme' ? { id: hub_legacy_uuid(1), slug: 'acme' } : null)),
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
   list_catalog
   ================================================================ */

describe('ScopesService — list_catalog', () => {
    let service: ScopesService;
    let scope_repo: ReturnType<typeof make_scope_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const fake_scopes = [
            { id: hub_legacy_uuid(1), slug: 'alpha', display_name: 'Alpha', owner_id: hub_legacy_uuid(1), team_count: 3, created_at: '2025-01-01', User: { username: 'alice' } },
            { id: hub_legacy_uuid(2), slug: 'beta', display_name: 'Beta', owner_id: hub_legacy_uuid(2), team_count: 0, created_at: '2025-02-01', User: { username: 'bob' } },
        ];
        const built = build_service();
        service = built.service;
        scope_repo = built.scope_repo;
        scope_repo.find_count.mockResolvedValue(2);
        scope_repo.find_catalog_page.mockResolvedValue(fake_scopes);
    });

    it('returns paginated scopes for admin', async () => {
        const result = await service.list_catalog(SITE_ADMIN, {});

        expect(result.total).toBe(2);
        expect(result.scopes).toHaveLength(2);
        expect(result.limit).toBe(50);
        expect(result.offset).toBe(0);
    });

    it('passes search term to both queries', async () => {
        scope_repo.find_count.mockResolvedValueOnce(0);
        scope_repo.find_catalog_page.mockResolvedValueOnce([]);

        await service.list_catalog(SITE_ADMIN, { search: 'alp' });

        expect(scope_repo.find_count).toHaveBeenCalled();
        expect(scope_repo.find_catalog_page).toHaveBeenCalled();
    });

    it('caps limit to 100', async () => {
        const result = await service.list_catalog(SITE_ADMIN, { limit: 500 });
        expect(result.limit).toBe(100);
    });

    it('respects explicit limit and offset', async () => {
        const result = await service.list_catalog(SITE_ADMIN, { limit: 10, offset: 20 });
        expect(result.limit).toBe(10);
        expect(result.offset).toBe(20);
    });

    it('returns 403 for non-admin user', async () => {
        await expect(service.list_catalog(ALICE, {}))
            .rejects.toThrow('Admin access required');
    });

    it('returns 401 for unauthenticated request', async () => {
        await expect(service.list_catalog(UNAUTHED, {}))
            .rejects.toThrow('Authentication required');
    });
});

/* ================================================================
   update
   ================================================================ */

describe('ScopesService — update', () => {
    let service: ScopesService;
    let scope_repo: ReturnType<typeof make_scope_repo>;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    const EXISTING_SCOPE = {
        id: hub_legacy_uuid(5), slug: 'alpha', display_name: 'Alpha', owner_id: hub_legacy_uuid(1), org_id: hub_legacy_uuid(7),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        scope_repo = built.scope_repo;
        audit_repo = built.audit_repo;
    });

    it('updates display_name', async () => {
        scope_repo.find_by_id.mockResolvedValueOnce(EXISTING_SCOPE);

        const result = await service.update(SITE_ADMIN, {
            scope_id: hub_legacy_uuid(5), display_name: 'Alpha Updated',
        });

        expect(result.updated).toBe(true);
        expect(scope_repo.update_where).toHaveBeenCalledWith(
            { id: hub_legacy_uuid(5) },
            { display_name: 'Alpha Updated' },
        );
        expect(audit_repo.create).toHaveBeenCalledWith(
            hub_legacy_uuid(99), 'scope.update', 'scope', 'alpha',
            { display_name: { from: 'Alpha', to: 'Alpha Updated' } },
        );
    });

    it('updates owner_id', async () => {
        scope_repo.find_by_id.mockResolvedValueOnce(EXISTING_SCOPE);
        mock_user_find_by_pk.mockResolvedValueOnce({ id: hub_legacy_uuid(2) });

        const result = await service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(5), owner_id: hub_legacy_uuid(2) });

        expect(result.updated).toBe(true);
        expect(scope_repo.update_where).toHaveBeenCalledWith(
            { id: hub_legacy_uuid(5) },
            expect.objectContaining({ owner_id: hub_legacy_uuid(2) }),
        );
    });

    it('returns updated:false when no fields changed', async () => {
        scope_repo.find_by_id.mockResolvedValueOnce(EXISTING_SCOPE);

        const result = await service.update(SITE_ADMIN, {
            scope_id: hub_legacy_uuid(5), display_name: 'Alpha',
        });

        expect(result.updated).toBe(false);
        expect(scope_repo.update_where).not.toHaveBeenCalled();
        expect(audit_repo.create).not.toHaveBeenCalled();
    });

    it('returns 404 when scope not found', async () => {
        scope_repo.find_by_id.mockResolvedValueOnce(null);

        await expect(service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(999) }))
            .rejects.toThrow('Scope not found');
    });

    it('returns 404 when new owner not found', async () => {
        scope_repo.find_by_id.mockResolvedValueOnce(EXISTING_SCOPE);
        mock_user_find_by_pk.mockResolvedValueOnce(null);

        await expect(service.update(SITE_ADMIN, { scope_id: hub_legacy_uuid(5), owner_id: hub_legacy_uuid(888) }))
            .rejects.toThrow('Owner user not found');
    });

    it('returns 403 for non-admin user', async () => {
        await expect(service.update(ALICE, { scope_id: hub_legacy_uuid(5), display_name: 'X' }))
            .rejects.toThrow('Admin access required');
    });
});

