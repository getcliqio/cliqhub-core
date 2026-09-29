import { z } from 'zod';

/**
 * Token permission grant — domain + access level structure.
 * Replaces TokenPermissionsVo for wire responses.
 */
export const TokenPermissionsData = z.object({
    domains: z.object({
        orgs: z.union([z.array(z.string()), z.literal('*')]).optional()
            .describe('Org slugs or UUIDs this token is scoped to; "*" for all'),
        realms: z.union([z.array(z.string()), z.literal('*')]).optional()
            .describe('Realm slugs or UUIDs this token is scoped to; "*" for all'),
    }).optional()
        .describe('Domain restrictions on the token'),
    access: z.record(z.array(z.enum(['read', 'write', 'admin']))).optional()
        .describe('Per-resource access levels'),
}).describe('Token permission grant');

export type TokenPermissionsData = z.infer<typeof TokenPermissionsData>;

/**
 * Canonical wire shape for a personal access token (PAT).
 * Plaintext token value is only present on create/rotate — never on list/get.
 */
export const TokenData = z.object({
    id: z.string().uuid()
        .describe('Token UUID'),
    type: z.enum(['user', 'realm'])
        .describe('"user" = PAT; "realm" = realm-scoped token'),
    name: z.string()
        .describe('Human-assigned token name'),
    realm_id: z.string().uuid().optional()
        .describe('For realm tokens: the realm this token is scoped to'),
    permissions: TokenPermissionsData
        .describe('Permission grant on this token'),
    created_at: z.string()
        .describe('ISO timestamp of token creation'),
    last_used_at: z.string().nullable()
        .describe('ISO timestamp of last successful use; null if never used'),
    revoked_at: z.string().nullable()
        .describe('ISO timestamp of revocation; null if active'),
    token: z.string().optional()
        .describe('Plaintext token value — present only on create/rotate, never on list'),
});

export type TokenData = z.infer<typeof TokenData>;
