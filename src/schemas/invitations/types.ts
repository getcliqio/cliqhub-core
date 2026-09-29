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


/**
 * Canonical wire shape for an invitation.
 * Covers both org invitations and realm invitations.
 */
export const InvitationData = z.object({
    id: z.string().uuid()
        .describe('Invitation UUID'),
    email: z.string()
        .describe('Email address the invitation was sent to'),
    role: z.string()
        .describe('Role that will be granted on acceptance'),
    invited_by: z.string().uuid()
        .describe('UUID of the user who created the invitation'),
    status: z.enum(['pending', 'accepted', 'expired', 'cancelled'])
        .describe('Current lifecycle status'),
    target_type: z.enum(['org', 'realm'])
        .describe('What the invitation grants access to'),
    target_id: z.string().uuid()
        .describe('UUID of the target org or realm'),
    created_at: z.string()
        .describe('ISO timestamp of invitation creation'),
    expires_at: z.string()
        .describe('ISO timestamp of invitation expiry'),
    token: z.string().optional()
        .describe('Accept token — present only on create response, never on list'),
});

export type InvitationData = z.infer<typeof InvitationData>;
