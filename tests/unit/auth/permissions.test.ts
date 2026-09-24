/**
 * Tests for require_permission — the core permission enforcement gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/db/models/index.js', () => ({
    OrgMember: { findOne: vi.fn() },
    OrgRole: { findByPk: vi.fn() },
}));

vi.mock('../../../src/errors/api_error.js', () => ({
    ApiError: class extends Error {
        code: string;
        status: number;
        constructor(code: string, message: string, status: number) {
            super(message);
            this.code = code;
            this.status = status;
        }
    },
}));

import { require_permission } from '../../../src/auth/permissions.js';
import { OrgMember, OrgRole } from '../../../src/db/models/index.js';

beforeEach(() => vi.clearAllMocks());

describe('require_permission', () => {
    it('allows site admins unconditionally', async () => {
        await expect(
            require_permission(1, 99, 'realms.delete', { site_role: 'admin' }),
        ).resolves.toBeUndefined();

        expect(OrgMember.findOne).not.toHaveBeenCalled();
    });

    it('rejects non-members', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(null);

        await expect(
            require_permission(1, 42, 'teams.run'),
        ).rejects.toThrow('You are not a member of this organization');
    });

    it('rejects members with no role_id', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(
            { role_id: null } as any,
        );

        await expect(
            require_permission(1, 42, 'teams.run'),
        ).rejects.toThrow('No role assigned');
    });

    it('allows the owner (system) role unconditionally', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(
            { role_id: hub_legacy_uuid(10) } as any,
        );
        vi.mocked(OrgRole.findByPk).mockResolvedValueOnce(
            { is_system: true, permissions: [] } as any,
        );

        await expect(
            require_permission(1, 5, 'org.settings'),
        ).resolves.toBeUndefined();
    });

    it('allows when role has the required permission', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(
            { role_id: hub_legacy_uuid(20) } as any,
        );
        vi.mocked(OrgRole.findByPk).mockResolvedValueOnce(
            { is_system: false, permissions: ['teams.run', 'runs.view'] } as any,
        );

        await expect(
            require_permission(1, 5, 'teams.run'),
        ).resolves.toBeUndefined();
    });

    it('rejects when role does not have the required permission', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(
            { role_id: hub_legacy_uuid(20) } as any,
        );
        vi.mocked(OrgRole.findByPk).mockResolvedValueOnce(
            { is_system: false, permissions: ['runs.view'] } as any,
        );

        await expect(
            require_permission(1, 5, 'realms.delete'),
        ).rejects.toThrow("Permission 'realms.delete' is required");
    });

    it('rejects when role record is missing', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(
            { role_id: hub_legacy_uuid(999) } as any,
        );
        vi.mocked(OrgRole.findByPk).mockResolvedValueOnce(null);

        await expect(
            require_permission(1, 5, 'teams.run'),
        ).rejects.toThrow('Role not found');
    });
});
