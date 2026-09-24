import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mock_realm_find_all = vi.fn(async () => []);
const mock_realm_member_find_one = vi.fn(async () => null);
const mock_realm_member_create = vi.fn(async () => ({}));
const mock_realm_member_destroy = vi.fn(async () => 0);

vi.mock('../../../src/models/index.js', () => ({
    Realm: { findAll: (...a: unknown[]) => mock_realm_find_all(...a) },
    RealmMember: {
        findOne: (...a: unknown[]) => mock_realm_member_find_one(...a),
        create: (...a: unknown[]) => mock_realm_member_create(...a),
        destroy: (...a: unknown[]) => mock_realm_member_destroy(...a),
    },
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import { OrgRealmSyncService } from '../../../src/services/org_realm_sync_service.js';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('OrgRealmSyncService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('sync_member_removed', () => {
        it('removes membership from all org realms', async () => {
            mock_realm_find_all.mockResolvedValue([
                { id: 'r1', owner_user_id: '99' },
                { id: 'r2', owner_user_id: '99' },
            ]);
            mock_realm_member_destroy.mockResolvedValue(1);

            const revoked = await OrgRealmSyncService.sync_member_removed(1, 42);

            expect(revoked).toBe(2);
            expect(mock_realm_member_destroy).toHaveBeenCalledTimes(2);
        });

        it('skips realms owned by the user', async () => {
            mock_realm_find_all.mockResolvedValue([
                { id: 'r1', owner_user_id: '42' },
            ]);

            const revoked = await OrgRealmSyncService.sync_member_removed(1, 42);

            expect(revoked).toBe(0);
            expect(mock_realm_member_destroy).not.toHaveBeenCalled();
        });

        it('returns 0 when no org realms exist', async () => {
            mock_realm_find_all.mockResolvedValue([]);

            const revoked = await OrgRealmSyncService.sync_member_removed(1, 42);

            expect(revoked).toBe(0);
        });

        it('counts only realms where a row was actually removed', async () => {
            mock_realm_find_all.mockResolvedValue([
                { id: 'r1', owner_user_id: '99' },
                { id: 'r2', owner_user_id: '99' },
            ]);
            mock_realm_member_destroy
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0);

            const revoked = await OrgRealmSyncService.sync_member_removed(1, 42);

            expect(revoked).toBe(1);
        });
    });

    describe('bulk_add_to_realms', () => {
        it('grants membership on specified realms', async () => {
            mock_realm_member_find_one.mockResolvedValue(null);

            const granted = await OrgRealmSyncService.bulk_add_to_realms(
                42,
                ['r1', 'r2'],
                'member',
            );

            expect(granted).toBe(2);
            expect(mock_realm_member_create).toHaveBeenCalledTimes(2);
            expect(mock_realm_member_create).toHaveBeenCalledWith(
                expect.objectContaining({
                    realm_id: 'r1',
                    member_type: 'user',
                    member_id: '42',
                    role: 'member',
                }),
            );
        });

        it('skips realms where user already has membership', async () => {
            mock_realm_member_find_one
                .mockResolvedValueOnce({ id: 'existing' })
                .mockResolvedValueOnce(null);

            const granted = await OrgRealmSyncService.bulk_add_to_realms(
                42,
                ['r1', 'r2'],
            );

            expect(granted).toBe(1);
            expect(mock_realm_member_create).toHaveBeenCalledTimes(1);
        });

        it('returns 0 for empty realm list', async () => {
            const granted = await OrgRealmSyncService.bulk_add_to_realms(42, []);

            expect(granted).toBe(0);
        });
    });

    describe('list_org_realm_ids', () => {
        it('returns realm ids for the org', async () => {
            mock_realm_find_all.mockResolvedValue([
                { id: 'r1' },
                { id: 'r2' },
            ]);

            const ids = await OrgRealmSyncService.list_org_realm_ids(1);

            expect(ids).toEqual(['r1', 'r2']);
        });

        it('returns empty array when no realms', async () => {
            mock_realm_find_all.mockResolvedValue([]);

            const ids = await OrgRealmSyncService.list_org_realm_ids(1);

            expect(ids).toEqual([]);
        });
    });
});
