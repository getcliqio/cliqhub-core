import { z } from 'zod';

const LimitField = z.number().int().min(1).max(100).optional()
    .describe('Maximum number of results to return (1–100)');

const OffsetField = z.number().int().min(0).optional()
    .describe('Zero-based offset for pagination');

/**
 * GET /v1/orgs/get — paginated org listing.
 * Without filters returns all orgs the caller is a member of (or all orgs for site admins).
 */
export const OrgsGetInput = z.object({
    query: z.string().optional()
        .describe('Substring match on slug or display_name'),
    limit: LimitField,
    offset: OffsetField,
    exclude_personal: z.boolean().optional()
        .describe('When true, omit personal orgs (slug matches a username). Site admin only.'),
    mine: z.boolean().optional()
        .describe('When true, return only orgs the caller is a member of (ignores admin privileges)'),
});

export type OrgsGetInput = z.infer<typeof OrgsGetInput>;

/**
 * Shared single-org identifier — used for get_by_id, delete, leave, list_roles.
 */
export const OrgIdInput = z.object({
    org_id: z.string().uuid()
        .describe('Org UUID'),
});

export type OrgIdInput = z.infer<typeof OrgIdInput>;

/**
 * Unified create/update input — branch on org_id presence in the controller.
 * create: org_id absent; slug + admin_username required.
 * update: org_id required; only display_name is mutable.
 */
export const OrgInput = z.object({
    org_id: z.string().uuid().optional()
        .describe('Present for update; omit to create'),
    slug: z.string().min(1).optional()
        .describe('URL-safe org identifier; required on create, immutable after creation'),
    display_name: z.string().optional()
        .describe('Human-readable org name'),
    admin_username: z.string().min(1).optional()
        .describe('Username for the initial admin member; required on create'),
    admin_email: z.string().optional()
        .describe('Email for the initial admin; used on create only'),
    admin_password: z.string().optional()
        .describe('Password for the initial admin account; used on create only'),
    admin_display_name: z.string().optional()
        .describe('Display name for the initial admin; used on create only'),
});

export type OrgInput = z.infer<typeof OrgInput>;

/**
 * Add a member to an org — at least one of username, email, or user_id is required.
 */
export const OrgsAddMemberInput = z.object({
    org_id: z.string().uuid()
        .describe('Org UUID'),
    username: z.string().min(1).optional()
        .describe('Username of the user to add'),
    email: z.string().min(1).optional()
        .describe('Email of the user to add'),
    user_id: z.string().uuid().optional()
        .describe('UUID of the user to add'),
}).refine(
    (v) => Boolean(v.username || v.email || v.user_id != null),
    { message: 'username, email, or user_id is required' },
);

export type OrgsAddMemberInput = z.infer<typeof OrgsAddMemberInput>;

/**
 * Remove a member from an org.
 */
export const OrgsRemoveMemberInput = z.object({
    org_id: z.string().uuid()
        .describe('Org UUID'),
    user_id: z.string().uuid()
        .describe('UUID of the member to remove'),
});

export type OrgsRemoveMemberInput = z.infer<typeof OrgsRemoveMemberInput>;

/**
 * Shared role identifier — used for get_role, delete_role.
 */
export const OrgRoleIdInput = z.object({
    org_id: z.string().uuid()
        .describe('Org UUID'),
    role_id: z.string().uuid()
        .describe('Role UUID'),
});

export type OrgRoleIdInput = z.infer<typeof OrgRoleIdInput>;

/**
 * Unified create/update for org custom roles — branch on role_id presence.
 * create: role_id absent; slug + name required.
 * update: role_id required; name and/or permissions required.
 */
export const OrgRoleInput = z.object({
    org_id: z.string().uuid()
        .describe('Org UUID'),
    role_id: z.string().uuid().optional()
        .describe('Present for update; omit to create'),
    slug: z.string().min(1).max(49).optional()
        .describe('URL-safe role identifier within the org; required on create'),
    name: z.string().min(1).max(100).optional()
        .describe('Human-readable role name'),
    permissions: z.array(z.string()).optional()
        .describe('Permission slugs to grant'),
});

export type OrgRoleInput = z.infer<typeof OrgRoleInput>;

/**
 * Unified create/update/delete for org-owned scopes — branch on scope_id presence.
 * create: scope_id absent; slug required.
 * update: scope_id required; at least one of display_name / visibility / owner_id required.
 * delete: scope_id required; org_id required; no other fields needed.
 */
export const OrgScopeInput = z.object({
    org_id: z.string().uuid()
        .describe('Owning org UUID'),
    scope_id: z.string().uuid().optional()
        .describe('Present for update/delete; omit to create'),
    slug: z.string().min(1).optional()
        .describe('URL-safe scope slug; required on create, immutable after creation'),
    display_name: z.string().optional()
        .describe('Human-readable scope name'),
    visibility: z.enum(['public', 'private']).optional()
        .describe('Whether the scope is publicly browsable'),
    owner_id: z.string().uuid().optional()
        .describe('Transfer ownership to this user UUID; update only'),
});

export type OrgScopeInput = z.infer<typeof OrgScopeInput>;

/**
 * Assign or unassign a user's publish access on a scope.
 * Used for both assign_scope_member and unassign_scope_member.
 */
export const OrgScopeMemberInput = z.object({
    org_id: z.string().uuid()
        .describe('Owning org UUID'),
    scope_id: z.string().uuid()
        .describe('Scope UUID'),
    user_id: z.string().uuid()
        .describe('User UUID to assign/unassign'),
});

export type OrgScopeMemberInput = z.infer<typeof OrgScopeMemberInput>;

/**
 * List scopes — explicit user_id authorization model (no "mine" implicit binding).
 *
 * Auth rules:
 * - user_id = caller's own id → always allowed
 * - user_id = other user → require org admin (if org_id provided) or site admin
 * - user_id absent → site admin only; returns full catalog
 */
export const OrgsGetScopesInput = z.object({
    user_id: z.string().uuid().optional()
        .describe('User whose publish-access scopes to list; omit for full catalog (site admin only)'),
    org_id: z.string().uuid().optional()
        .describe('Narrow results to scopes owned by this org'),
    query: z.string().optional()
        .describe('Substring match on slug or display_name'),
    limit: LimitField,
    offset: OffsetField,
});

export type OrgsGetScopesInput = z.infer<typeof OrgsGetScopesInput>;

/**
 * Org reviewer/channel picker — returns org members + notification channels
 * the caller can select as HUG reviewers or dispatch targets.
 */
export const OrgsGetReviewableTargetsInput = z.object({
    org_id: z.string().uuid()
        .describe('Org UUID; required — no header fallback'),
    query: z.string().optional()
        .describe('Substring filter on usernames or channel names'),
});

export type OrgsGetReviewableTargetsInput = z.infer<typeof OrgsGetReviewableTargetsInput>;

import { UserData } from '../users/types.js';
import { RoleData } from '../roles/types.js';
import { ScopeData } from '../scopes/types.js';

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
