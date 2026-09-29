import { z } from 'zod';

/**
 * Canonical wire shape for an org custom role.
 * Replaces the inline RoleDTO in org_role_service.ts and BFF OrgRoleVO/OrgRoleDTO.
 */
export const RoleData = z.object({
    id: z.string().uuid()
        .describe('Role UUID'),
    org_id: z.string().uuid()
        .describe('Owning org UUID'),
    slug: z.string()
        .describe('URL-safe role identifier within the org'),
    name: z.string()
        .describe('Human-readable role name'),
    permissions: z.array(z.string())
        .describe('Permission slugs granted by this role'),
    is_system: z.boolean()
        .describe('True for built-in roles that cannot be deleted'),
    is_default: z.boolean()
        .describe('True if assigned to new org members automatically'),
    member_count: z.number().int()
        .describe('Number of org members currently assigned this role'),
    created_at: z.string()
        .describe('ISO timestamp of role creation'),
});

export type RoleData = z.infer<typeof RoleData>;
