/**
 * EnrollGrant — resolves the target realm and access grant for a daemon enrolment request.
 *
 * A daemon enrols into a specific realm identified by domain, realm slug, or explicit
 * realm_id. `EnrollGrant.resolve` normalises the input, finds the matching realm, and
 * returns the grant level (`admin | member | none`) the enrolling token is allowed.
 *
 * Used by `daemon_acl_controller` (ACL-based enrol) and `daemons_controller` (direct enrol).
 */

import {
    default_daemon_grant,
    domain_allows_realm,
    has_access,
    normalize_grant,
    type Token_grant,
} from '../auth/grants.js';

export class EnrollGrant {
    /**
     * Resolve the target realm and token grant for a daemon enrolment request.
     *
     * Picks `requested_realm_id` over `auth_realm_id`, validates that the token
     * is actually granted for that realm, and that it carries `daemons:write`.
     *
     * @param input - Token permissions, the realm bound to the token, and the
     *   realm the daemon is requesting to enrol into.
     * @returns `{ realm_id, permissions }` — the resolved realm and narrowed grant.
     * @throws If realm is missing, the token doesn't cover it, or lacks write access.
     */
    static resolve(input: {
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
}
