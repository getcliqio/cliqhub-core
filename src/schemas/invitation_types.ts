/**
 * Request bodies of the `invitations/*` routes.
 *
 * POST /v1/invitations/create       — invite (or invite again) an email to an org or realm
 * POST /v1/invitations/get          — one org's or realm's invites, filtered, sorted, paged
 * POST /v1/invitations/get_by_id    — one invite by id (org or realm)
 * POST /v1/invitations/revoke       — cancel a pending invite by id
 * POST /v1/invitations/get_by_token — public preview for the invite page
 * POST /v1/invitations/accept       — public accept or decline
 */

import { z } from 'zod';

const target_type_schema = z.enum(['org', 'realm']);

const invite_status_schema = z.enum(['pending', 'accepted', 'declined', 'revoked', 'expired']);

/** Adds an issue when the id for the target type is missing. */
function require_target_id(v: { target_type?: 'org' | 'realm'; org_id?: string; realm_id?: string }, ctx: z.RefinementCtx): void {
    if (v.target_type === 'org' && v.org_id == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'org_id is required when target_type is org', path: ['org_id'] });
    }
    if (v.target_type === 'realm' && !v.realm_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'realm_id is required when target_type is realm', path: ['realm_id'] });
    }
}

/** POST /v1/invitations/create */
export const invitations_create_schema = z.object({
    target_type: target_type_schema,
    org_id: z.string().uuid().optional(),
    realm_id: z.string().min(1).optional(),
    email: z.string().min(1, 'email is required'),
    /** `owner`: orgs only; `operator`: realms only. Default `member`. */
    role: z.enum(['owner', 'admin', 'member', 'operator']).optional(),
    /** Site admin: restore the deleted user that holds `email`. */
    reactivate: z.boolean().optional(),
}).superRefine((v, ctx) => {
    require_target_id(v, ctx);
    if (v.target_type === 'org' && v.role === 'operator') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'operator role is not valid for org invites', path: ['role'] });
    }
    if (v.target_type === 'realm' && v.role === 'owner') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'owner role is not valid for realm invites', path: ['role'] });
    }
});

/** POST /v1/invitations/get — `target_type` defaults to org when `org_id` is set, else realm. */
export const invitations_get_schema = z.object({
    target_type: target_type_schema.optional(),
    org_id: z.string().uuid().optional(),
    realm_id: z.string().min(1).optional(),
    /** Only invites in this state (a pending invite past its expiry counts as expired). */
    status: invite_status_schema.optional(),
    /** Substring match on the invited email. */
    query: z.string().optional(),
    /** Sort field, `-` first for descending; default `-created_at` (fields: services/invite_rules.ts). */
    sort: z.string().regex(/^-?[a-z_]+$/, 'sort is a field name, `-` first for descending').optional(),
    page: z.number().int().min(1).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
}).superRefine((v, ctx) => {
    if (v.org_id == null && !v.realm_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'org_id or realm_id is required', path: ['org_id'] });
    }
    require_target_id(v, ctx);
});

/** POST /v1/invitations/get_by_id and /revoke — the invite is found in either table by id. */
export const invitations_id_schema = z.object({
    invite_id: z.string().uuid(),
    target_type: target_type_schema.optional(),
});

/** POST /v1/invitations/get_by_token */
export const invitations_get_by_token_schema = z.object({
    token: z.string().min(1, 'token is required'),
});

/** POST /v1/invitations/accept — a new person also sends the account fields. */
export const invitations_accept_schema = z.object({
    token: z.string().min(1, 'token is required'),
    decision: z.enum(['accept', 'decline']),
    username: z.string().optional(),
    password: z.string().optional(),
    display_name: z.string().optional(),
});
