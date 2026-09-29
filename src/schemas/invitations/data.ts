import { z } from 'zod';

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
