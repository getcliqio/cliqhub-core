import { z } from 'zod';
import { UserData } from '../users/data.js';
import { RoleData } from '../roles/data.js';
import { ScopeData } from '../scopes/data.js';

/**
 * Canonical wire shape for an org member (UserData + org-context fields).
 * Replaces BFF OrgMemberVO/OrgMemberDTO.
 */
export const OrgMemberData = UserData.extend({
    org_role: z.string().nullable()
        .describe('Custom org role slug assigned to this member; null = default member'),
    org_role_id: z.string().uuid().nullable()
        .describe('Custom org role UUID; null when default member'),
});

export type OrgMemberData = z.infer<typeof OrgMemberData>;

/**
 * Canonical wire shape for an org.
 * Serves both list items (members/roles/scopes absent) and detail views (populated).
 * Replaces BFF OrgListItemVO/OrgDetailVO/DTO and all inline org shapes in the SPA.
 */
export const OrgData = z.object({
    id: z.string().uuid()
        .describe('Org UUID'),
    slug: z.string()
        .describe('Unique org slug'),
    display_name: z.string().nullable()
        .describe('Human-readable org name; null when not set'),
    member_count: z.number().int()
        .describe('Total member count'),
    scope_count: z.number().int()
        .describe('Number of package-namespace scopes owned by this org'),
    my_role: z.string().nullable().optional()
        .describe('Caller\'s role slug in this org; absent when listing all orgs as admin'),
    created_at: z.string()
        .describe('ISO timestamp of org creation'),
    members: z.array(OrgMemberData).optional()
        .describe('Populated on get_by_id; absent on list'),
    roles: z.array(RoleData).optional()
        .describe('Populated on get_by_id; absent on list'),
    scopes: z.array(ScopeData).optional()
        .describe('Populated on get_by_id; absent on list'),
});

export type OrgData = z.infer<typeof OrgData>;
