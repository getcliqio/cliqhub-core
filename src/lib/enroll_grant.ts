import {
    default_daemon_grant,
    domain_allows_realm,
    has_access,
    normalize_grant,
    type Token_grant,
} from '../auth/grants.js';

/**
 * Resolve the enroll target realm and a grant narrowed to that single realm.
 * Multi-realm tokens must pass an explicit realm_id when primary is ambiguous.
 * Requires domains.realms ⊇ realm and access.daemons includes write.
 */
export function resolve_enroll_realm_and_grant(input: {
    token_permissions?: Record<string, unknown>;
    auth_realm_id?: string;
    requested_realm_id?: string;
}): { realm_id: string; permissions: Token_grant } {
    const realm_id = input.requested_realm_id || input.auth_realm_id;
    if (!realm_id) {
        throw new Error('realm_id is required when the token grants multiple realms');
    }

    const fallback = default_daemon_grant(realm_id);
    const grant = normalize_grant(input.token_permissions ?? {}, fallback);
    if (!domain_allows_realm(grant, realm_id)) {
        throw new Error(`Token is not granted for realm '${realm_id}'`);
    }
    if (!has_access(grant, 'daemons', 'write')) {
        throw new Error('Missing daemons:write on credential grant');
    }

    return {
        realm_id,
        permissions: {
            domains: {
                ...grant.domains,
                realms: [realm_id],
            },
            access: { ...grant.access },
        },
    };
}
