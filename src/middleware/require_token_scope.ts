/**
 * `require_token_scope(name)` — enforcement middleware for API capability
 * scopes on Forge-facing routes (JIRA plugin).
 *
 * Hub auth is PAT (`cliq_tok_…`) or realm token (`cliq_dt_…`) only — no JWT.
 * Entity grants live on `token_permissions` / `default_grant_for_subject`
 * (explicit on every minted session PAT). This middleware only gates the
 * separate capability-scopes array used by Forge integrations.
 *
 * Rules:
 *  - daemon_token auth → always allow (gated elsewhere).
 *  - PAT with empty / absent capability scopes → allow for this slice
 *    (Hub entity access is enforced via permissions grants, not this array).
 *  - PAT with non-empty capability scopes → require `name` in the array.
 *    Otherwise 403 naming the missing scope.
 *  - No auth (`req.auth.user` missing) → 401.
 *
 * Usage: `router.post('/runs/enqueue', auth, require_token_scope('dispatch'), handler);`
 */

import type { Request, Response, NextFunction } from 'express';

export function require_token_scope(scope_name: string) {
    return function _require_token_scope(
        req: Request, res: Response, next: NextFunction,
    ): void {
        if (!req.auth?.user) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }

        // Realm/daemon tokens: capability scopes do not apply.
        if (req.auth.auth_via !== 'pat') return next();

        const scopes = req.auth.token_scopes;
        // Empty / absent capability scopes → allow (entity grants are separate).
        if (!scopes || scopes.length === 0) return next();

        if (!scopes.includes(scope_name)) {
            res.status(403).json({
                ok: false,
                error: `token missing required scope '${scope_name}'`,
            });
            return;
        }
        return next();
    };
}
