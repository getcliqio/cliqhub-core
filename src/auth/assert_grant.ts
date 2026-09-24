/**
 * Resolve the effective grant for a request and assert entity access.
 */

import { ApiError } from '../errors/api_error.js';
import type { AuthContext } from '../types/vo.js';
import {
    default_daemon_grant,
    default_grant_for_subject,
    domain_allows_realm,
    has_access,
    normalize_grant,
    type Access_level,
    type Grant_entity,
    type Token_grant,
} from './grants.js';

export function resolve_effective_grant(auth: AuthContext): Token_grant {
    if (!auth.user) {
        throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    // Daemon credentials must not inherit human member grants.
    if (auth.auth_via === 'daemon_token') {
        const realm_hint = auth.realm_id
            ?? primary_realm_from_permissions(auth.token_permissions);
        const fallback = default_daemon_grant(realm_hint ?? []);
        if (!auth.token_permissions || Object.keys(auth.token_permissions).length === 0) {
            return fallback;
        }
        return normalize_grant(auth.token_permissions, fallback);
    }

    const subject = {
        role: auth.user.role,
        org_ids: auth.org_ids ?? [],
        scope_slugs: (auth.scopes ?? []).map((s) => s.slug),
        realm_ids: [] as string[],
    };
    const fallback = default_grant_for_subject(subject);

    if (!auth.token_permissions || Object.keys(auth.token_permissions).length === 0) {
        return fallback;
    }

    return normalize_grant(auth.token_permissions, fallback);
}

function primary_realm_from_permissions(
    permissions: AuthContext['token_permissions'],
): string | undefined {
    if (!permissions || typeof permissions !== 'object') return undefined;
    const domains = (permissions as { domains?: { realms?: unknown } }).domains;
    const realms = domains?.realms;
    if (!Array.isArray(realms)) return undefined;
    const first = realms.find((r): r is string => typeof r === 'string' && r !== '*');
    return first;
}

/** Ensure the credential grant includes the target realm domain. */
export function assert_realm_domain(auth: AuthContext, realm_id: string): Token_grant {
    const grant = resolve_effective_grant(auth);
    if (domain_allows_realm(grant, realm_id)) return grant;
    throw new ApiError(
        'forbidden',
        `Token is not granted for realm '${realm_id}'`,
        403,
    );
}

export function assert_access(
    auth: AuthContext,
    entity: Grant_entity,
    need: Access_level,
): Token_grant {
    const grant = resolve_effective_grant(auth);
    if (has_access(grant, entity, need)) return grant;

    throw new ApiError(
        'forbidden',
        `Missing ${entity}:${need} on credential grant`,
        403,
    );
}

/** Site-admin role OR entity admin on grant (for internal ops already gated by require_internal). */
export function assert_admin_access(auth: AuthContext, entity: Grant_entity = 'users'): Token_grant {
    if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    if (auth.user.role === 'admin') {
        return resolve_effective_grant(auth);
    }
    const grant = resolve_effective_grant(auth);
    if (has_access(grant, entity, 'admin')) return grant;
    throw new ApiError('forbidden', 'Admin access required', 403);
}
