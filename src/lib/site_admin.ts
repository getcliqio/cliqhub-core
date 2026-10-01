/**
 * AdminCheck — site-admin predicate for request-level access control.
 *
 * `AdminCheck.is_site_admin(req)` returns true when the authenticated user
 * carries the `admin` role, granting elevated access (e.g. viewing raw logs).
 * All other roles — including daemon tokens — return false.
 */

import type { Request } from 'express';

export class AdminCheck {
    /**
     * Return `true` when the request was made by a site admin.
     *
     * Reads `req.auth.user.role`; daemon tokens and unauthenticated requests
     * always return `false`.
     */
    static is_site_admin(req: Request): boolean {
        // A daemon token carries its creator as `user`; an admin-minted daemon
        // token must not inherit site-admin power (S18).
        if (req.auth?.auth_via === 'daemon_token') return false;
        return req.auth?.user?.role === 'admin';
    }
}
