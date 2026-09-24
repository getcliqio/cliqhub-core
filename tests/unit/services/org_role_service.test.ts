/**
 * Tests for OrgRoleService — CRUD for customizable roles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

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

/**
 * Stub require_permission: always allow for user_id 1 (test admin),
 * reject for user_id 2 (test non-admin).
 */
vi.mock('../../../src/auth/permissions.js', async (importOriginal) => {
    const orig = await importOriginal() as Record<string, unknown>;
    return {
        ...orig,
        require_permission: vi.fn().mockImplementation(
            async (_org_id: string, user_id: string, perm: string) => {
                if (user_id === hub_legacy_uuid(1)) return;
                const { ApiError } = await import('../../../src/errors/api_error.js');
                throw new ApiError('forbidden', `Permission '${perm}' is required`, 403);
            },
        ),
    };
});

const mock_role_rows: any[] = [];
const mock_member_rows: any[] = [];

vi.mock('../../../src/db/models/index.js', () => ({
    OrgRole: {
        findAll: vi.fn().mockImplementation(() => Promise.resolve(mock_role_rows)),
        findOne: vi.fn().mockImplementation(({ where }: any) => {
            return Promise.resolve(
                mock_role_rows.find(
                    (r) => r.org_id === where.org_id && (r.slug === where.slug || r.id === where.id),
                ) ?? null,
            );
        }),
        findByPk: vi.fn().mockImplementation((id: number) => {
            return Promise.resolve(mock_role_rows.find(r => r.id === id) ?? null);
        }),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockImplementation((data: any) => {
            const row = { ...data, id: hub_legacy_uuid(100), created_at: new Date(), update: vi.fn(), destroy: vi.fn() };
            return Promise.resolve(row);
        }),
    },
    OrgMember: {
        findAll: vi.fn().mockImplementation(() => Promise.resolve(mock_member_rows)),
        count: vi.fn().mockResolvedValue(0),
    },
}));

import { OrgRoleService } from '../../../src/services/org_role_service.js';

const ORG_ID = hub_legacy_uuid(1);
const ADMIN_USER = hub_legacy_uuid(1);
const NON_ADMIN_USER = hub_legacy_uuid(2);

beforeEach(() => {
    vi.clearAllMocks();
    mock_role_rows.length = 0;
    mock_member_rows.length = 0;
});

describe('OrgRoleService.list', () => {
    it('returns roles with member counts', async () => {
        mock_role_rows.push(
            { id: hub_legacy_uuid(1), org_id: ORG_ID, slug: 'owner', name: 'Owner', permissions: [], is_system: true, is_default: true, created_at: new Date() },
            { id: hub_legacy_uuid(2), org_id: ORG_ID, slug: 'admin', name: 'Admin', permissions: ['org.settings'], is_system: false, is_default: true, created_at: new Date() },
        );
        mock_member_rows.push({ role_id: hub_legacy_uuid(1) }, { role_id: hub_legacy_uuid(2) }, { role_id: hub_legacy_uuid(2) });

        const roles = await OrgRoleService.list(ORG_ID);

        expect(roles).toHaveLength(2);
        expect(roles[0].slug).toBe('owner');
        expect(roles[0].member_count).toBe(1);
        expect(roles[1].slug).toBe('admin');
        expect(roles[1].member_count).toBe(2);
    });
});

describe('OrgRoleService.create', () => {
    it('creates a custom role', async () => {
        const role = await OrgRoleService.create(ORG_ID, ADMIN_USER, {
            slug: 'deployer',
            name: 'Deployer',
            permissions: ['teams.run', 'daemons.view'],
        });

        expect(role.slug).toBe('deployer');
        expect(role.name).toBe('Deployer');
        expect(role.permissions).toEqual(['teams.run', 'daemons.view']);
        expect(role.is_system).toBe(false);
        expect(role.is_default).toBe(false);
    });

    it('rejects duplicate slug', async () => {
        mock_role_rows.push(
            { id: hub_legacy_uuid(1), org_id: ORG_ID, slug: 'deployer', name: 'Deployer', permissions: [], is_system: false, is_default: false },
        );

        await expect(
            OrgRoleService.create(ORG_ID, ADMIN_USER, {
                slug: 'deployer',
                name: 'Another Deployer',
                permissions: [],
            }),
        ).rejects.toThrow("A role with slug 'deployer' already exists");
    });

    it('rejects owner-only permissions', async () => {
        await expect(
            OrgRoleService.create(ORG_ID, ADMIN_USER, {
                slug: 'superadmin',
                name: 'Super Admin',
                permissions: ['teams.run', 'org.delete'],
            }),
        ).rejects.toThrow("Permission 'org.delete' is reserved for owners");
    });

    it('rejects unknown permissions', async () => {
        await expect(
            OrgRoleService.create(ORG_ID, ADMIN_USER, {
                slug: 'custom',
                name: 'Custom',
                permissions: ['nonexistent.perm'],
            }),
        ).rejects.toThrow("Unknown permission 'nonexistent.perm'");
    });

    it('rejects non-admin callers', async () => {
        await expect(
            OrgRoleService.create(ORG_ID, NON_ADMIN_USER, {
                slug: 'deployer',
                name: 'Deployer',
                permissions: ['teams.run'],
            }),
        ).rejects.toThrow("Permission 'org.members.manage' is required");
    });
});

describe('OrgRoleService.update', () => {
    it('updates role name and permissions', async () => {
        const role = {
            id: hub_legacy_uuid(5),
            org_id: ORG_ID,
            slug: 'operator',
            name: 'Operator',
            permissions: ['teams.run'],
            is_system: false,
            is_default: true,
            created_at: new Date(),
            update: vi.fn().mockImplementation(function (this: any, data: any) {
                Object.assign(this, data);
                return Promise.resolve(this);
            }),
        };
        mock_role_rows.push(role);

        const updated = await OrgRoleService.update(
            ORG_ID, ADMIN_USER, hub_legacy_uuid(5),
            { name: 'Dev Operator', permissions: ['teams.run', 'runs.view'] },
        );

        expect(updated.name).toBe('Dev Operator');
        expect(role.update).toHaveBeenCalled();
    });

    it('rejects editing system (owner) role', async () => {
        mock_role_rows.push({
            id: hub_legacy_uuid(1), org_id: ORG_ID, slug: 'owner', name: 'Owner',
            permissions: [], is_system: true, is_default: true, created_at: new Date(),
        });

        await expect(
            OrgRoleService.update(ORG_ID, ADMIN_USER, hub_legacy_uuid(1), { name: 'Super Owner' }),
        ).rejects.toThrow('System roles cannot be edited');
    });
});

describe('OrgRoleService.delete', () => {
    it('deletes a custom role with no members', async () => {
        const role = {
            id: hub_legacy_uuid(50), org_id: ORG_ID, slug: 'temp', name: 'Temp',
            permissions: [], is_system: false, is_default: false,
            created_at: new Date(),
            destroy: vi.fn().mockResolvedValue(undefined),
        };
        mock_role_rows.push(role);

        const result = await OrgRoleService.delete(ORG_ID, ADMIN_USER, hub_legacy_uuid(50));

        expect(result.deleted).toBe(true);
        expect(role.destroy).toHaveBeenCalled();
    });

    it('rejects deleting default roles', async () => {
        mock_role_rows.push({
            id: hub_legacy_uuid(3), org_id: ORG_ID, slug: 'member', name: 'Member',
            permissions: [], is_system: false, is_default: true, created_at: new Date(),
        });

        await expect(
            OrgRoleService.delete(ORG_ID, ADMIN_USER, hub_legacy_uuid(3)),
        ).rejects.toThrow('Default roles cannot be deleted');
    });

    it('rejects deleting system roles', async () => {
        mock_role_rows.push({
            id: hub_legacy_uuid(1), org_id: ORG_ID, slug: 'owner', name: 'Owner',
            permissions: [], is_system: true, is_default: true, created_at: new Date(),
        });

        await expect(
            OrgRoleService.delete(ORG_ID, ADMIN_USER, hub_legacy_uuid(1)),
        ).rejects.toThrow('System roles cannot be deleted');
    });
});
