import { z } from 'zod';

/**
 * Canonical wire shape for a package-namespace scope.
 * Replaces ScopeVo / BFF ScopeVO/ScopeDTO for all wire responses.
 * Note: /v1/control/scopes/* is a separate concept (daemon ACL) and uses its own types.
 */
export const ScopeData = z.object({
    id: z.string().uuid()
        .describe('Scope UUID'),
    slug: z.string()
        .describe('Unique scope slug (e.g. "acme" or "acme/tools")'),
    display_name: z.string().nullable()
        .describe('Human-readable name; null when not set'),
    owner_id: z.string().uuid().nullable()
        .describe('UUID of the user who created it (null for a seeded scope)'),
    org_id: z.string().uuid().nullable()
        .describe('The org the scope belongs to (PLAN-team-visibility §3.1)'),
    member_count: z.number().int().optional()
        .describe('Number of users with publish access (included on detail views)'),
    team_count: z.number().int().optional()
        .describe('Number of teams published under this scope (included on detail views)'),
    org_slug: z.string().nullable().optional()
        .describe('Slug of the owning org (site-admin catalog listing)'),
    created_at: z.string()
        .describe('ISO timestamp of scope creation'),
});

export type ScopeData = z.infer<typeof ScopeData>;
