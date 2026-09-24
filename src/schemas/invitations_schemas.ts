import { z } from 'zod';

const target_type_schema = z.enum(['org', 'realm']);

export const invitations_create_schema = z.object({
    target_type: target_type_schema,
    org_id: z.string().uuid().optional(),
    realm_id: z.string().min(1).optional(),
    email: z.string().min(1, 'email is required'),
    role: z.enum(['admin', 'member', 'operator']).optional(),
}).superRefine((v, ctx) => {
    if (v.target_type === 'org' && v.org_id == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'org_id is required when target_type is org', path: ['org_id'] });
    }
    if (v.target_type === 'realm' && !v.realm_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'realm_id is required when target_type is realm', path: ['realm_id'] });
    }
    if (v.target_type === 'org' && v.role === 'operator') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'operator role is not valid for org invites', path: ['role'] });
    }
});

/** List/search pending invites in one org or realm the caller belongs to. */
export const invitations_get_schema = z.object({
    target_type: target_type_schema,
    org_id: z.string().uuid().optional(),
    realm_id: z.string().min(1).optional(),
    /** Substring match on invite email (within the scoped org/realm). */
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
}).superRefine((v, ctx) => {
    if (v.target_type === 'org' && v.org_id == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'org_id is required when target_type is org', path: ['org_id'] });
    }
    if (v.target_type === 'realm' && !v.realm_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'realm_id is required when target_type is realm', path: ['realm_id'] });
    }
});

/** Fetch one invite by id — only if caller belongs to that invite's org/realm. */
export const invitations_get_by_id_schema = z.object({
    target_type: target_type_schema,
    invite_id: z.string().uuid(),
});

export const invitations_revoke_schema = z.object({
    target_type: target_type_schema,
    invite_id: z.string().uuid(),
});

export const invitations_get_by_token_schema = z.object({
    token: z.string().min(1, 'token is required'),
});

export const invitations_accept_schema = z.object({
    token: z.string().min(1, 'token is required'),
    username: z.string().optional(),
    password: z.string().optional(),
    display_name: z.string().optional(),
});
