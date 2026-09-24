import { z } from 'zod';

export const scopes_get_schema = z.object({
    /** When true, return the caller's scopes (not admin-wide catalog). */
    mine: z.boolean().optional(),
    /** Substring match on slug/display_name (POST body only). Preferred over `search`. */
    query: z.string().optional(),
    /** @deprecated use `query` */
    search: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
});

export const scopes_new_schema = z.object({
    slug: z.string().min(1, 'slug is required'),
    display_name: z.string().optional(),
    /** Defaults to the caller when omitted (org-admin create). Required for site-admin user scopes. */
    owner_username: z.string().min(1).optional(),
    visibility: z.enum(['public', 'private']).optional(),
    scope_type: z.enum(['user', 'org']).optional(),
    org_slug: z.string().optional(),
    org_id: z.string().uuid().optional(),
}).superRefine((val, ctx) => {
    const is_org = val.scope_type === 'org' || val.org_id != null || val.org_slug != null;
    if (is_org && val.org_id == null && !val.org_slug) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'org_id or org_slug is required for org scopes',
            path: ['org_id'],
        });
    }
});

export const scopes_update_schema = z.object({
    scope_id: z.string().uuid(),
    visibility: z.enum(['public', 'private']).optional(),
    display_name: z.string().optional(),
    owner_id: z.string().uuid().optional(),
});

export const scopes_delete_schema = z.object({
    scope_id: z.string().uuid(),
});

export const scopes_add_user_schema = z.object({
    scope_id: z.string().uuid(),
    user_id: z.string().uuid(),
});

export const scopes_remove_user_schema = z.object({
    scope_id: z.string().uuid(),
    user_id: z.string().uuid(),
});
