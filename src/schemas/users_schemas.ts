import { z } from 'zod';

export const users_get_schema = z.object({
    org_id: z.string().uuid().optional(),
    /**
     * When set, search Hub users for realm invite (excludes current members).
     * Replaces /v1/realms/search_users.
     */
    realm_id: z.string().min(1).optional(),
    /** Substring match on username/email (POST body only). Preferred over `search`. */
    query: z.string().optional(),
    /** @deprecated use `query` */
    search: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
});

export const users_get_by_id_schema = z.object({
    user_id: z.string().uuid(),
    /**
     * When true, include the JSON preferences bag (e.g. event_alerts).
     * Default false — preferences are not part of the directory detail.
     */
    include_preferences: z.boolean().optional().default(false),
});

export const users_new_schema = z.object({
    username: z.string().min(1, 'username is required'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    display_name: z.string().optional(),
    role: z.enum(['user', 'admin']).optional(),
});

export const users_update_schema = z.object({
    user_id: z.string().uuid().optional(),
    display_name: z.string().optional(),
    email: z.string().optional(),
    /**
     * Shallow-merge into users.preferences JSONB.
     * Events UI: { event_alerts: { hug, my_runs, all, *_seen_at } }.
     */
    preferences: z.record(z.string(), z.unknown()).optional(),
}).refine(
    (d) =>
        d.display_name !== undefined
        || d.email !== undefined
        || d.preferences !== undefined,
    { message: 'At least one of display_name, email, or preferences is required' },
);

export const users_delete_schema = z.object({
    user_id: z.string().uuid(),
});

export const users_suspend_schema = z.object({
    user_id: z.string().uuid(),
    reason: z.string().optional(),
});

export const users_unsuspend_schema = z.object({
    user_id: z.string().uuid(),
});

export const users_reset_password_schema = z.object({
    user_id: z.string().uuid(),
    new_password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const users_set_role_schema = z.object({
    user_id: z.string().uuid(),
    role: z.enum(['user', 'admin'], { message: 'Role must be "user" or "admin"' }),
});

/** Assign an org role definition to a member (not site-admin set_role). */
export const users_update_role_schema = z.object({
    user_id: z.string().uuid(),
    org_id: z.string().uuid(),
    role_id: z.string().uuid(),
});

export const users_change_password_schema = z.object({
    current_password: z.string().min(1, 'current_password is required'),
    new_password: z.string().min(1, 'new_password is required'),
});
