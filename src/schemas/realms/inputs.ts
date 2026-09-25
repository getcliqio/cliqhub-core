/**
 * Realms API — Zod request schemas (SoT for inbound bodies).
 *
 * Naming: PascalCase value + type (Zod idiom).
 * Every field must have `.describe(…)` (feeds Hub OpenAPI / Mintlify).
 *
 * Tenancy: create requires body `org_id`. get optional filter.
 * get_by_id: realm_id XOR (slug + org_id) XOR (slug + org_slug).
 * Never invent org from X-Org-Id / current_org_id.
 */

import { z } from 'zod';

/** Org UUID when the call invents or filters by organization. */
export const RealmOrgIdField = z.string().uuid().describe(
    'Organization this call targets. Required on create; optional filter on get; '
    + 'required on get_by_id when resolving by slug without org_slug. '
    + 'Caller must be authorized for this org via the Bearer credential.',
);

/** POST /v1/realms/create */
export const RealmCreateInput = z.object({
    org_id: RealmOrgIdField,
    slug: z.string().min(1).describe('URL-safe realm slug unique within the org'),
    name: z.string().min(1).describe('Display name'),
});
export type RealmCreateInput = z.infer<typeof RealmCreateInput>;

/** POST /v1/realms/get — list / filter (omit org_id = all orgs the user is in). */
export const RealmGetInput = z.object({
    slug: z.string().min(1).optional().describe('Exact slug filter'),
    query: z.string().min(1).optional().describe('Substring search on slug or name'),
    owned: z.enum(['me', 'default']).optional().describe('me = owned by caller; default = personal default realm'),
    org_id: RealmOrgIdField.optional().describe('When set, only realms in this org'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (default server-side)'),
    offset: z.number().int().min(0).optional().describe('Page offset'),
    sort_by: z.enum(['slug', 'name', 'created_at', 'updated_at', 'created_by']).optional()
        .describe('Sort column'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
});
export type RealmGetInput = z.infer<typeof RealmGetInput>;

/**
 * POST /v1/realms/get_by_id — exactly one of:
 *   { realm_id } | { slug, org_id } | { slug, org_slug }
 */
export const RealmGetByIdInput = z.object({
    realm_id: z.string().min(1).optional().describe('Realm UUID'),
    slug: z.string().min(1).optional().describe('Realm slug (requires org_id or org_slug)'),
    org_id: RealmOrgIdField.optional().describe('Org UUID when resolving by slug'),
    org_slug: z.string().min(1).optional().describe('Org slug when resolving by slug'),
}).superRefine((val, ctx) => {
    const has_id = Boolean(val.realm_id?.trim());
    const has_slug = Boolean(val.slug?.trim());
    const has_org_id = Boolean(val.org_id?.trim());
    const has_org_slug = Boolean(val.org_slug?.trim());

    if (has_id && has_slug) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide realm_id or slug, not both',
            path: ['realm_id'],
        });
        return;
    }

    if (has_id) {
        if (has_org_id || has_org_slug) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'org_id / org_slug are only valid with slug, not realm_id',
                path: ['org_id'],
            });
        }
        return;
    }

    if (!has_slug) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'realm_id or slug is required',
            path: ['realm_id'],
        });
        return;
    }

    if (has_org_id && has_org_slug) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide org_id or org_slug, not both',
            path: ['org_id'],
        });
        return;
    }

    if (!has_org_id && !has_org_slug) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'slug requires org_id or org_slug',
            path: ['org_id'],
        });
    }
});
export type RealmGetByIdInput = z.infer<typeof RealmGetByIdInput>;

/** POST /v1/realms/update */
export const RealmUpdateInput = z.object({
    realm_id: z.string().min(1).describe('Realm UUID to update'),
    name: z.string().min(1).optional().describe('New display name'),
});
export type RealmUpdateInput = z.infer<typeof RealmUpdateInput>;

/** POST /v1/realms/delete */
export const RealmDeleteInput = z.object({
    realm_id: z.string().min(1).describe('Realm UUID to soft-delete'),
});
export type RealmDeleteInput = z.infer<typeof RealmDeleteInput>;

/** POST /v1/realms/get_members */
export const RealmGetMembersInput = z.object({
    realm_id: z.string().min(1).describe('Realm UUID'),
    member_type: z.enum(['user', 'daemon', 'group']).optional()
        .describe('When set, only members of this type'),
});
export type RealmGetMembersInput = z.infer<typeof RealmGetMembersInput>;

/** POST /v1/realms/add_member */
export const RealmAddMemberInput = z.object({
    realm_id: z.string().min(1).describe('Realm UUID'),
    member_type: z.enum(['user', 'daemon', 'group']).default('user')
        .describe('Member kind (daemon enroll is via realm token, not this route)'),
    member_id: z.string().min(1).describe('Hub user id when member_type=user; daemon/group id otherwise'),
    role: z.enum(['admin', 'operator', 'member']).optional().describe('Grant role'),
});
export type RealmAddMemberInput = z.infer<typeof RealmAddMemberInput>;

/** POST /v1/realms/remove_member */
export const RealmRemoveMemberInput = z.object({
    realm_id: z.string().min(1).describe('Realm UUID'),
    member_type: z.enum(['user', 'daemon', 'group']).default('user').describe('Member kind'),
    member_id: z.string().min(1).describe('Member id to remove'),
});
export type RealmRemoveMemberInput = z.infer<typeof RealmRemoveMemberInput>;

/** POST /v1/realms/add_team | remove_team */
export const RealmTeamRefInput = z.object({
    realm_id: z.string().min(1).describe('Realm UUID'),
    scope: z.string().min(1).describe('Team scope (e.g. cliq or org slug)'),
    slug: z.string().min(1).describe('Team slug'),
});
export type RealmTeamRefInput = z.infer<typeof RealmTeamRefInput>;
