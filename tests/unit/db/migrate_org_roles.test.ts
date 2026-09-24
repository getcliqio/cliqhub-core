/**
 * Tests for the org roles migration — seeding default roles.
 *
 * Uses mocked Sequelize models to verify the seeding logic
 * without a real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: vi.fn().mockReturnValue({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    }),
}));

vi.mock('../../../src/db/models/index.js', () => ({
    Org: {
        findAll: vi.fn(),
        sequelize: {
            query: vi.fn().mockResolvedValue([[], { rowCount: 0 }]),
        },
    },
    OrgMember: {
        findAll: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
    },
    OrgRole: {
        count: vi.fn(),
        findOrCreate: vi.fn(),
        findOne: vi.fn(),
    },
}));

import { seed_default_roles_for_org } from '../../../src/db/migrate_org_roles.js';
import { OrgRole } from '../../../src/db/models/index.js';
import { DEFAULT_ROLES } from '../../../src/auth/permissions.js';

const mocked_role = vi.mocked(OrgRole);

describe('seed_default_roles_for_org', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates all four default roles when none exist', async () => {
        mocked_role.count.mockResolvedValue(0 as never);
        mocked_role.findOrCreate.mockResolvedValue([{}, true] as never);

        const result = await seed_default_roles_for_org(hub_legacy_uuid(42));

        expect(result).toBe(true);
        expect(mocked_role.findOrCreate).toHaveBeenCalledTimes(DEFAULT_ROLES.length);

        // Verify the owner role is marked is_system.
        const owner_call = mocked_role.findOrCreate.mock.calls.find(
            (c: unknown[]) => (c[0] as { where: { slug: string } }).where.slug === 'owner',
        );
        expect(owner_call).toBeDefined();
        const owner_defaults = (owner_call![0] as { defaults: { is_system: boolean } }).defaults;
        expect(owner_defaults.is_system).toBe(true);
    });

    it('skips seeding when roles already exist', async () => {
        mocked_role.count.mockResolvedValue(4 as never);

        const result = await seed_default_roles_for_org(hub_legacy_uuid(42));

        expect(result).toBe(false);
        expect(mocked_role.findOrCreate).not.toHaveBeenCalled();
    });

    it('uses findOrCreate for idempotency', async () => {
        mocked_role.count.mockResolvedValue(2 as never);
        mocked_role.findOrCreate.mockResolvedValue([{}, false] as never);

        const result = await seed_default_roles_for_org(hub_legacy_uuid(42));

        expect(result).toBe(true);
        expect(mocked_role.findOrCreate).toHaveBeenCalledTimes(DEFAULT_ROLES.length);
    });

    it('passes correct org_id to each role', async () => {
        mocked_role.count.mockResolvedValue(0 as never);
        mocked_role.findOrCreate.mockResolvedValue([{}, true] as never);

        await seed_default_roles_for_org(hub_legacy_uuid(99));

        for (const call of mocked_role.findOrCreate.mock.calls) {
            const args = call[0] as { where: { org_id: string }; defaults: { org_id: string } };
            expect(args.where.org_id).toBe(hub_legacy_uuid(99));
            expect(args.defaults.org_id).toBe(hub_legacy_uuid(99));
        }
    });
});
