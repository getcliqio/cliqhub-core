/**
 * Token grant model — domains (where) + per-entity access (read|write|admin).
 *
 * Package namespaces (Hub scopes / `@acme/…`) are **not** a token domain.
 * Which namespaces a caller may publish/install into comes from live scope
 * membership (owner / org / scope_members) on the scopes resource. Tokens only
 * carry `access.scopes` for managing that catalog.
 *
 * Permissions are resolved when minting user / daemon tokens.
 */

export type Access_level = 'read' | 'write' | 'admin';

export const GRANT_ENTITIES = [
    'users',
    'orgs',
    'scopes',
    'teams',
    'drafts',
    'tokens',
    'realms',
    'daemons',
    'runs',
    'dispatch',
    'workspaces',
    'agents',
    'settings',
    'notifications',
    'builder',
    'hug',
    'reports',
] as const;

export type Grant_entity = (typeof GRANT_ENTITIES)[number];

export interface Grant_domains {
    orgs?: Array<string | '*'> | '*';
    realms?: Array<string | '*'> | '*';
}

export type Grant_access = Partial<Record<Grant_entity, Access_level[]>>;

/** Stored on tokens.permissions. */
export interface Token_grant {
    domains: Grant_domains;
    access: Grant_access;
    /** @deprecated legacy PAT field — normalized away on mint */
    org_ids?: string[];
    /** @deprecated legacy PAT field */
    access_legacy?: string;
}

const LEVEL_RANK: Record<Access_level, number> = {
    read: 1,
    write: 2,
    admin: 3,
};

const MEMBER_ENTITIES: Grant_entity[] = [
    'teams', 'drafts', 'runs', 'dispatch', 'workspaces', 'agents',
    'settings', 'notifications', 'builder', 'hug', 'tokens',
    'realms', 'daemons', 'orgs', 'scopes',
];

function levels(...xs: Access_level[]): Access_level[] {
    return xs;
}

function all_admin_access(): Grant_access {
    const access: Grant_access = {};
    for (const entity of GRANT_ENTITIES) {
        access[entity] = levels('read', 'write', 'admin');
    }
    return access;
}

function member_access(): Grant_access {
    const access: Grant_access = { users: levels('read') };
    for (const entity of MEMBER_ENTITIES) {
        access[entity] = levels('read', 'write');
    }
    access.reports = levels('read');
    return access;
}

export interface Grant_subject {
    role: 'user' | 'admin';
    org_ids: string[];
    scope_slugs: string[];
    realm_ids: string[];
}

/** Default grant when minting a token for this subject (no override). */
export function default_grant_for_subject(subject: Grant_subject): Token_grant {
    if (subject.role === 'admin') {
        return {
            domains: { orgs: '*', realms: '*' },
            access: all_admin_access(),
        };
    }

    return {
        domains: {
            orgs: [...subject.org_ids],
            realms: [...subject.realm_ids],
        },
        access: member_access(),
    };
}

/** Daemon-token default grant for one or more realms. */
export function default_daemon_grant(
    realm_id: string | string[],
    org_ids: string[] = [],
): Token_grant {
    const realms = Array.isArray(realm_id) ? [...realm_id] : [realm_id];
    return {
        domains: {
            realms,
            orgs: org_ids.length > 0 ? org_ids : undefined,
        },
        access: {
            daemons: levels('write'),
            dispatch: levels('write'),
            runs: levels('read', 'write'),
        },
    };
}

/** @deprecated use default_daemon_grant(realm_ids) */
export function default_daemon_grant_for_realms(
    realm_ids: string[],
    org_ids: string[] = [],
): Token_grant {
    return default_daemon_grant(realm_ids, org_ids);
}

/** Normalize legacy `{ org_ids, access }` and partial grants into Token_grant. */
export function normalize_grant(
    raw: unknown,
    fallback: Token_grant,
): Token_grant {
    if (!raw || typeof raw !== 'object') return structuredClone(fallback);

    const obj = raw as Record<string, unknown>;
    const access_is_map = obj.access != null
        && typeof obj.access === 'object'
        && !Array.isArray(obj.access);
    const has_new_shape = obj.domains != null || access_is_map;

    // Legacy: { org_ids?, access?: string }
    if (!has_new_shape && (obj.org_ids != null || typeof obj.access === 'string')) {
        const org_ids = Array.isArray(obj.org_ids)
            ? (obj.org_ids as unknown[]).map((x) => String(x)).filter((x) => x.length > 0)
            : fallback.domains.orgs === '*'
                ? '*'
                : [...(fallback.domains.orgs as string[] ?? [])];
        const is_full = obj.access === 'full' || obj.access === 'admin' || obj.access === '*';
        return {
            domains: {
                orgs: org_ids,
                realms: fallback.domains.realms,
            },
            access: is_full ? all_admin_access() : structuredClone(fallback.access),
        };
    }

    const domains_raw = (obj.domains ?? {}) as Grant_domains & { scopes?: unknown };
    const access_raw = (obj.access ?? {}) as Grant_access;
    // Ignore legacy domains.scopes if present on stored tokens — namespaces
    // come from the scopes resource, not the grant.

    return {
        domains: {
            orgs: domains_raw.orgs ?? fallback.domains.orgs ?? [],
            realms: domains_raw.realms ?? fallback.domains.realms ?? [],
        },
        access: { ...structuredClone(fallback.access), ...access_raw },
    };
}

export function has_access(grant: Token_grant | undefined, entity: Grant_entity, need: Access_level): boolean {
    if (!grant) return false;
    const have = grant.access[entity] ?? [];
    const need_rank = LEVEL_RANK[need];
    return have.some((level) => LEVEL_RANK[level] >= need_rank);
}

function domain_allows(
    granted: Array<string | '*'> | '*' | undefined,
    target: string,
): boolean {
    if (granted == null) return false;
    if (granted === '*') return true;
    return granted.some((g) => g === '*' || g === target);
}

export function domain_allows_org(grant: Token_grant | undefined, org_id: string): boolean {
    if (!grant) return false;
    return domain_allows(grant.domains.orgs as Array<string | '*'> | '*' | undefined, org_id);
}

export function domain_allows_realm(grant: Token_grant | undefined, realm_id: string): boolean {
    if (!grant) return false;
    return domain_allows(grant.domains.realms as Array<string | '*'> | '*' | undefined, realm_id);
}

/**
 * Ensure minted grant domains ⊆ subject's domains (site admins may mint `*`).
 * Package namespaces are not clamped here — membership is live on the scopes resource.
 */
export function clamp_grant_to_subject(grant: Token_grant, subject: Grant_subject): Token_grant {
    if (subject.role === 'admin') return grant;

    const clamp_list = <T extends string>(
        wanted: Array<T | '*'> | '*' | undefined,
        allowed: T[],
    ): T[] => {
        if (wanted == null) return [];
        if (wanted === '*') return [...allowed];
        return wanted.filter((w): w is T => w !== '*' && allowed.includes(w as T));
    };

    return {
        domains: {
            orgs: clamp_list(grant.domains.orgs as Array<string | '*'> | '*', subject.org_ids),
            realms: clamp_list(grant.domains.realms as Array<string | '*'> | '*', subject.realm_ids),
        },
        access: grant.access,
    };
}
