/**
 * Regression tests for org-scoped realm lookups used by the dashboard
 * runs list. Before the X-Org-Id header fix, `/v1/runs/get` would
 * return runs from every org the user has ever touched — the org
 * switcher up top became decorative. `list_realm_ids_for_user_in_org`
 * is the new intersection helper that wires the header into the
 * realm gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({ query: vi.fn() }),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    }),
}));

// vi.mock factories are hoisted above imports; use vi.hoisted so the
// spy references stay live in both the factory and the test cases.
const mocks = vi.hoisted(() => ({
    member_find: vi.fn(),
    realm_find: vi.fn(),
}));
const mock_member_find = mocks.member_find;
const mock_realm_find = mocks.realm_find;

vi.mock('../../../src/models/index.js', () => ({
    RealmMember: { findAll: mocks.member_find },
    Realm: { findAll: mocks.realm_find },
    Daemon: { findByPk: vi.fn() },
    Run: {},
    Team: {},
    Scope: {},
    RealmDispatchQueue: {},
}));

import { RealmService } from '../../../src/services/realm.service.js';

describe('RealmService.list_realm_ids_for_user_in_org', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the intersection of the user\'s realms and the org', async () => {
        // User is a member of three realms across two orgs.
        mock_member_find.mockResolvedValueOnce([
            { realm_id: 'r-in-org-1' },
            { realm_id: 'r-in-org-2' },
            { realm_id: 'r-other-org' },
        ]);
        // Only two of those belong to org #7.
        mock_realm_find.mockResolvedValueOnce([
            { id: 'r-in-org-1' },
            { id: 'r-in-org-2' },
        ]);

        const out = await RealmService.list_realm_ids_for_user_in_org('user-42', hub_legacy_uuid(7));

        expect(out).toEqual(['r-in-org-1', 'r-in-org-2']);
        // Assert the Realm.findAll was scoped by org — this is the whole
        // point of the helper.
        const [realm_call] = mock_realm_find.mock.calls[0];
        expect(realm_call.where.org_id).toBe(hub_legacy_uuid(7));
        // ALIVE filter must be applied so soft-deleted realms don't leak.
        expect(realm_call.where.deleted).toBe(false);
    });

    it('short-circuits without a Realm.findAll call when the user has no realms at all', async () => {
        mock_member_find.mockResolvedValueOnce([]);
        const out = await RealmService.list_realm_ids_for_user_in_org('user-42', hub_legacy_uuid(7));
        expect(out).toEqual([]);
        expect(mock_realm_find).not.toHaveBeenCalled();
    });

    it('returns an empty list when the user has realms but none in the requested org', async () => {
        mock_member_find.mockResolvedValueOnce([{ realm_id: 'r-other-org' }]);
        mock_realm_find.mockResolvedValueOnce([]);
        const out = await RealmService.list_realm_ids_for_user_in_org('user-42', hub_legacy_uuid(99));
        expect(out).toEqual([]);
    });
});
