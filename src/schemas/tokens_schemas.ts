import { z } from 'zod';

/** Access level on a grant entity. */
export const access_level_schema = z.enum(['read', 'write', 'admin']);

const access_levels_schema = z.array(access_level_schema).min(1);

/**
 * Per-entity access map. Keys are Hub grant entities; values are one or more
 * of read | write | admin.
 */
export const grant_access_schema = z.object({
    users: access_levels_schema.optional(),
    orgs: access_levels_schema.optional(),
    scopes: access_levels_schema.optional().describe(
        'Manage the Hub scopes catalog (create/update/delete package namespaces). '
        + 'Which namespaces you can publish into is scope membership, not this field.',
    ),
    teams: access_levels_schema.optional(),
    drafts: access_levels_schema.optional(),
    tokens: access_levels_schema.optional(),
    realms: access_levels_schema.optional(),
    daemons: access_levels_schema.optional(),
    runs: access_levels_schema.optional(),
    dispatch: access_levels_schema.optional(),
    workspaces: access_levels_schema.optional(),
    agents: access_levels_schema.optional(),
    settings: access_levels_schema.optional(),
    notifications: access_levels_schema.optional(),
    builder: access_levels_schema.optional(),
    hug: access_levels_schema.optional(),
    reports: access_levels_schema.optional(),
});

/**
 * Package-namespace domain was removed from token grants.
 * Which `@slug/…` namespaces a caller may use comes from live scope membership
 * on the scopes resource; tokens only use `access.scopes` for catalog admin.
 */

/** Org domain: `*` or a list of org ids (optionally including `*`). */
export const domain_orgs_schema = z.union([
    z.literal('*'),
    z.array(z.union([z.number().int(), z.literal('*')])).min(1),
]);

/** Realm domain: `*` or a list of realm ids. */
export const domain_realms_schema = z.union([
    z.literal('*'),
    z.array(z.union([z.string().min(1), z.literal('*')])).min(1),
]);

export const grant_domains_schema = z.object({
    orgs: domain_orgs_schema.optional().describe(
        'Org ids where this credential may act, or `*` for all orgs the subject can reach',
    ),
    realms: domain_realms_schema.optional().describe(
        'Realm ids where this credential may act, or `*`',
    ),
});

/**
 * Token grant: where (domains) + what (access).
 * This is the only authorization surface on mint — not API capability strings.
 */
export const permissions_schema = z.object({
    domains: grant_domains_schema.optional(),
    access: grant_access_schema.optional().describe(
        'Per-entity levels: read (get/list), write (create/update/dispatch), admin (destructive tenancy)',
    ),
    /** Set by daemon bootstrap mint — revoked on `cliq logout`. */
    auto_enrolled: z.boolean().optional(),
});

/** Stored token type (includes legacy `daemon` rows). A2A is not a table row. */
export const token_type_schema = z.enum(['user', 'realm', 'daemon']);

export type Api_token_type = 'user' | 'realm' | 'daemon';

/**
 * Mint surface: user PAT, realm (daemon enroll) token, A2A realm bearer,
 * or short-lived daemon wire JWT (former /dispatch/tokens/mint).
 * A2A plaintext is stored hashed on the realm row — not in api_tokens.
 * daemon_wire is ephemeral RS256 — not stored.
 */
export const generate_token_type_schema = z.enum(['user', 'realm', 'a2a', 'daemon_wire']);

export const generate_token_schema = z.object({
    type: generate_token_type_schema.describe(
        '`user` → cliq_tok_…; `realm` → cliq_dt_…; `a2a` → cliq_a2a_…; `daemon_wire` → short-lived RS256',
    ),
    name: z.string().max(100).optional(),
    /** Required for type=realm (non-empty). User tokens omit this. */
    realm_ids: z.array(z.string().min(1)).min(1).optional().describe(
        'Realm ids for realm tokens. UI/CLI send a one-element array today.',
    ),
    /** Required for type=a2a / daemon_wire — single realm. */
    realm_id: z.string().min(1).optional(),
    /** daemon_wire only — optional JWT claims. */
    aud: z.string().optional(),
    run_id: z.string().optional(),
    action: z.enum(['execute', 'cancel', 'access']).optional(),
    permissions: permissions_schema.optional(),
}).superRefine((val, ctx) => {
    if (val.type === 'a2a' || val.type === 'daemon_wire') {
        if (val.realm_id) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `realm_id is required when type is ${val.type}`,
            path: ['realm_id'],
        });
        return;
    }
    if (val.type !== 'realm') return;
    const from_perms = val.permissions?.domains?.realms;
    const has_from_perms = (Array.isArray(from_perms) && from_perms.length > 0)
        || from_perms === '*';
    const has_realm_ids = Array.isArray(val.realm_ids) && val.realm_ids.length > 0;
    if (has_from_perms || has_realm_ids) return;
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'realm_ids (or permissions.domains.realms) is required when type is realm',
        path: ['realm_ids'],
    });
});

export const get_tokens_schema = z.object({
    type: token_type_schema.optional().describe('Filter by stored type'),
    realm_id: z.string().min(1).optional().describe('When set, list realm tokens for this realm'),
    /** Substring match on token name (POST body only). */
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
});

const token_id_schema = z.union([z.string().min(1), z.number().int()]).transform(String);

export const revoke_token_schema = z.object({
    type: token_type_schema.describe('Must match the stored token type'),
    token_id: token_id_schema,
    realm_id: z.string().min(1).optional().describe(
        'Realm admin may revoke a realm token they do not own when this is set',
    ),
});

/**
 * Rotate: user/realm rows need token_id; a2a mints a new realm bearer via realm_id
 * (same as generate_token type=a2a — A2A has no api_tokens row).
 */
export const rotate_token_schema = z.object({
    type: z.enum(['user', 'realm', 'daemon', 'a2a']).describe(
        'Stored type for user/realm; `a2a` rotates the realm A2A bearer',
    ),
    token_id: token_id_schema.optional(),
    realm_id: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
    if (val.type === 'a2a') {
        if (val.realm_id) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'realm_id is required when type is a2a',
            path: ['realm_id'],
        });
        return;
    }
    if (val.token_id) return;
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'token_id is required when type is not a2a',
        path: ['token_id'],
    });
});

export const validate_token_schema = z.object({
    token: z.string().min(1).describe('Plaintext `cliq_tok_…` or `cliq_dt_…` to introspect'),
});
