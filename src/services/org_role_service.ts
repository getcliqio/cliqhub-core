/**
 * OrgRoleService — CRUD for customizable org roles.
 *
 * Roles are named bundles of permissions. Every org starts with four
 * default roles (owner, admin, operator, member). Admins can edit
 * non-system roles and create custom roles.
 */

import { Op } from 'sequelize';
import { OrgRole, OrgMember } from '../db/models/index.js';
import { ApiError } from '../errors/api_error.js';
import {
    PERMISSION_SET,
    OWNER_ONLY_PERMISSIONS,
    require_permission,
} from '../auth/permissions.js';

const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,48}$/;
const OWNER_ONLY_SET = new Set<string>(OWNER_ONLY_PERMISSIONS);

export interface RoleDTO {
    id: string;
    org_id: string;
    slug: string;
    name: string;
    permissions: string[];
    is_system: boolean;
    is_default: boolean;
    member_count: number;
    created_at: string;
}

export class OrgRoleService {

    /** List all roles for an org, with member counts. */
    static async list(org_id: string): Promise<RoleDTO[]> {
        const roles = await OrgRole.findAll({
            where: { org_id },
            order: [['is_system', 'DESC'], ['is_default', 'DESC'], ['name', 'ASC']],
        });

        const member_counts = await OrgMember.findAll({
            where: {
                org_id,
                role_id: { [Op.in]: roles.map(r => r.id) },
            },
            attributes: ['role_id'],
        });
        const count_map = new Map<string, number>();
        for (const m of member_counts) {
            const rid = (m as any).role_id as string;
            count_map.set(rid, (count_map.get(rid) ?? 0) + 1);
        }

        return roles.map(r => ({
            id: r.id,
            org_id: r.org_id,
            slug: r.slug,
            name: r.name,
            permissions: r.permissions ?? [],
            is_system: r.is_system,
            is_default: r.is_default,
            member_count: count_map.get(r.id) ?? 0,
            created_at: r.created_at?.toISOString?.() ?? String(r.created_at),
        }));
    }

    /** Get a single role by id within an org. */
    static async get(org_id: string, role_id: string): Promise<RoleDTO> {
        const role = await OrgRole.findOne({ where: { id: role_id, org_id } });
        if (!role) throw new ApiError('not_found', 'Role not found', 404);

        const member_count = await OrgMember.count({ where: { org_id, role_id } });
        return {
            id: role.id,
            org_id: role.org_id,
            slug: role.slug,
            name: role.name,
            permissions: role.permissions ?? [],
            is_system: role.is_system,
            is_default: role.is_default,
            member_count,
            created_at: role.created_at?.toISOString?.() ?? String(role.created_at),
        };
    }

    /**
     * Create a custom role (the "Save As New Role" path).
     * Requires `org.members.manage` permission on the caller.
     */
    static async create(
        org_id: string,
        user_id: string,
        data: { slug: string; name: string; permissions: string[] },
        opts?: { site_role?: string },
    ): Promise<RoleDTO> {
        await require_permission(org_id, user_id, 'org.members.manage', opts);

        const slug = data.slug.trim().toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            throw new ApiError('invalid_params', 'Slug must be lowercase alphanumeric (a-z, 0-9, -, _), 1-49 chars', 422);
        }
        const name = data.name.trim();
        if (!name) throw new ApiError('invalid_params', 'Name is required', 422);

        const perms = validate_permissions(data.permissions);

        const existing = await OrgRole.findOne({ where: { org_id, slug } });
        if (existing) {
            throw new ApiError('conflict', `A role with slug '${slug}' already exists in this org`, 409);
        }

        const role = await OrgRole.create({
            org_id,
            slug,
            name,
            permissions: perms,
            is_system: false,
            is_default: false,
        });

        return {
            id: role.id,
            org_id: role.org_id,
            slug: role.slug,
            name: role.name,
            permissions: role.permissions ?? [],
            is_system: false,
            is_default: false,
            member_count: 0,
            created_at: role.created_at?.toISOString?.() ?? String(role.created_at),
        };
    }

    /**
     * Update an existing role's name and/or permissions (the "Save" path).
     * System roles (owner) cannot be edited.
     */
    static async update(
        org_id: string,
        user_id: string,
        role_id: string,
        data: { name?: string; permissions?: string[] },
        opts?: { site_role?: string },
    ): Promise<RoleDTO> {
        await require_permission(org_id, user_id, 'org.members.manage', opts);

        const role = await OrgRole.findOne({ where: { id: role_id, org_id } });
        if (!role) throw new ApiError('not_found', 'Role not found', 404);
        if (role.is_system) {
            throw new ApiError('forbidden', 'System roles cannot be edited', 403);
        }

        const updates: Record<string, unknown> = {};
        if (data.name !== undefined) {
            const name = data.name.trim();
            if (!name) throw new ApiError('invalid_params', 'Name cannot be empty', 422);
            updates.name = name;
        }
        if (data.permissions !== undefined) {
            updates.permissions = validate_permissions(data.permissions);
        }

        await role.update(updates);

        const member_count = await OrgMember.count({ where: { org_id, role_id } });
        return {
            id: role.id,
            org_id: role.org_id,
            slug: role.slug,
            name: role.name,
            permissions: role.permissions ?? [],
            is_system: role.is_system,
            is_default: role.is_default,
            member_count,
            created_at: role.created_at?.toISOString?.() ?? String(role.created_at),
        };
    }

    /**
     * Delete a custom role. System and default roles cannot be deleted.
     * Roles with assigned members cannot be deleted (must reassign first).
     */
    static async delete(
        org_id: string,
        user_id: string,
        role_id: string,
        opts?: { site_role?: string },
    ): Promise<{ deleted: boolean }> {
        await require_permission(org_id, user_id, 'org.members.manage', opts);

        const role = await OrgRole.findOne({ where: { id: role_id, org_id } });
        if (!role) throw new ApiError('not_found', 'Role not found', 404);
        if (role.is_system) {
            throw new ApiError('forbidden', 'System roles cannot be deleted', 403);
        }
        if (role.is_default) {
            throw new ApiError('forbidden', 'Default roles cannot be deleted', 403);
        }

        const assigned = await OrgMember.count({ where: { org_id, role_id } });
        if (assigned > 0) {
            throw new ApiError(
                'conflict',
                `Cannot delete role '${role.name}' — ${assigned} member(s) still assigned. Reassign them first.`,
                409,
            );
        }

        await role.destroy();
        return { deleted: true };
    }
}

/** Validate and deduplicate permissions. Rejects owner-only and unknown strings. */
function validate_permissions(raw: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const p of raw) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        if (OWNER_ONLY_SET.has(trimmed)) {
            throw new ApiError('invalid_params', `Permission '${trimmed}' is reserved for owners and cannot be assigned to roles`, 422);
        }
        if (!PERMISSION_SET.has(trimmed)) {
            throw new ApiError('invalid_params', `Unknown permission '${trimmed}'`, 422);
        }
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}
