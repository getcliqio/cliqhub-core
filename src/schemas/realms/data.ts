import { z } from 'zod';

/**
 * Canonical wire shape for a realm member entry.
 * Replaces Realm_member_dto in realm.service.ts.
 * Timestamps are milliseconds since epoch.
 */
export const RealmMemberData = z.object({
    id: z.string().uuid()
        .describe('Membership record UUID'),
    realm_id: z.string().uuid()
        .describe('Realm UUID this membership belongs to'),
    member_type: z.enum(['user', 'daemon', 'group'])
        .describe('Kind of principal'),
    member_id: z.string()
        .describe('UUID of the member (user_id, daemon_id, or group_id)'),
    username: z.string().nullable()
        .describe('Username for user members; null for daemons/groups'),
    role: z.enum(['admin', 'operator', 'member'])
        .describe('Member\'s role within the realm'),
    created_at: z.number()
        .describe('Epoch ms when membership was created'),
});

export type RealmMemberData = z.infer<typeof RealmMemberData>;

/**
 * Canonical wire shape for a realm.
 * Replaces Realm_dto in realm.service.ts and all inline realm shapes in the SPA.
 * Timestamps are milliseconds since epoch.
 */
export const RealmData = z.object({
    id: z.string().uuid()
        .describe('Realm UUID'),
    slug: z.string()
        .describe('Realm slug (unique within its org)'),
    org_slug: z.string().nullable()
        .describe('Owning org slug; null for personal realms'),
    qualified_slug: z.string().nullable()
        .describe('"org_slug.realm_slug" for org realms; null for personal realms'),
    name: z.string()
        .describe('Realm display name'),
    owner_user_id: z.string().uuid()
        .describe('UUID of the user who owns this realm'),
    created_by: z.string().uuid()
        .describe('UUID of the user who created this realm'),
    created_by_username: z.string().nullable()
        .describe('Username of the creator; null if account deleted'),
    created_at: z.number()
        .describe('Epoch ms of realm creation'),
    updated_at: z.number()
        .describe('Epoch ms of last update'),
    members: z.array(RealmMemberData).optional()
        .describe('Populated on get_by_id; absent on list'),
});

export type RealmData = z.infer<typeof RealmData>;
