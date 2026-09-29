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
    visibility: z.enum(['public', 'private'])
        .describe('Whether the scope is publicly browsable'),
    scope_type: z.enum(['user', 'org'])
        .describe('"user" scopes are owned by a single user; "org" scopes are owned by an org'),
    owner_id: z.string().uuid()
        .describe('UUID of the owning user (user scopes) or org (org scopes)'),
    org_id: z.string().uuid().nullable()
        .describe('Owning org UUID for org scopes; null for user scopes'),
    member_count: z.number().int().optional()
        .describe('Number of users with publish access (included on detail views)'),
    team_count: z.number().int().optional()
        .describe('Number of teams published under this scope (included on detail views)'),
    created_at: z.string()
        .describe('ISO timestamp of scope creation'),
});

export type ScopeData = z.infer<typeof ScopeData>;
