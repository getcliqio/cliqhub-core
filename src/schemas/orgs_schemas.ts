import { z } from 'zod';

export const orgs_get_schema = z.object({
    /** Substring match on slug/display_name (POST body only). Preferred over `search`. */
    query: z.string().optional(),
    /** @deprecated use `query` */
    search: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    /** When true, exclude personal orgs (slug matches a username). Admin only. */
    exclude_personal: z.boolean().optional(),
    /** When true, return only orgs the caller is a member of (ignores admin privileges). */
    mine: z.boolean().optional(),
});

export const orgs_get_by_id_schema = z.object({
    org_id: z.string().uuid(),
});

export const orgs_new_schema = z.object({
    slug: z.string().min(1, 'slug is required'),
    display_name: z.string().optional(),
    admin_username: z.string().min(1, 'admin_username is required'),
    admin_email: z.string().optional(),
    admin_password: z.string().optional(),
    admin_display_name: z.string().optional(),
});

export const orgs_update_schema = z.object({
    org_id: z.string().uuid(),
    display_name: z.string().min(1, 'display_name is required'),
});

export const orgs_delete_schema = z.object({
    org_id: z.string().uuid(),
});

export const orgs_add_member_schema = z.object({
    org_id: z.string().uuid(),
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    user_id: z.string().uuid().optional(),
}).refine(
    (v) => Boolean(v.username || v.email || v.user_id != null),
    { message: 'username, email, or user_id is required' },
);

export const orgs_remove_member_schema = z.object({
    org_id: z.string().uuid(),
    user_id: z.string().uuid(),
});

export const orgs_list_roles_schema = z.object({
    org_id: z.string().uuid(),
});

export const orgs_get_role_schema = z.object({
    org_id: z.string().uuid(),
    role_id: z.string().uuid(),
});

export const orgs_create_role_schema = z.object({
    org_id: z.string().uuid(),
    slug: z.string().min(1).max(49),
    name: z.string().min(1).max(100),
    permissions: z.array(z.string()),
});

export const orgs_update_role_schema = z.object({
    org_id: z.string().uuid(),
    role_id: z.string().uuid(),
    name: z.string().min(1).max(100).optional(),
    permissions: z.array(z.string()).optional(),
}).refine(
    (d) => d.name !== undefined || d.permissions !== undefined,
    { message: 'At least one of name or permissions is required' },
);

export const orgs_delete_role_schema = z.object({
    org_id: z.string().uuid(),
    role_id: z.string().uuid(),
});

export const orgs_leave_schema = z.object({
    org_id: z.string().uuid(),
});

export const orgs_new_scope_schema = z.object({
    org_id: z.string().uuid(),
    slug: z.string().min(1, 'slug is required'),
    display_name: z.string().optional(),
    visibility: z.enum(['public', 'private']).optional(),
});

export const orgs_delete_scope_schema = z.object({
    org_id: z.string().uuid(),
    scope_id: z.string().uuid(),
});

export const orgs_assign_scope_member_schema = z.object({
    org_id: z.string().uuid(),
    scope_id: z.string().uuid(),
    user_id: z.string().uuid(),
});

export const orgs_unassign_scope_member_schema = z.object({
    org_id: z.string().uuid(),
    scope_id: z.string().uuid(),
    user_id: z.string().uuid(),
});

/**
 * POST /v1/orgs/get_reviewable_targets — org members + notification channels
 * the caller can pick as HUG reviewers / route destinations / dispatch targets.
 */
export const orgs_get_reviewable_targets_schema = z.object({
    org_id: z.string().uuid().optional(),
    /** Optional substring filter on usernames / channel names. */
    query: z.string().optional(),
});
