/**
 * Control-plane auth guard.
 *
 * Hub `create_auth_middleware` already verified PAT (`cliq_tok_…`) or
 * realm token (`cliq_dt_…`) and set `req.auth`. This middleware does NOT
 * decode or verify tokens again — clean break, no decode-only path.
 *
 * If Hub authenticated the caller, copies identity into `req.user` for Core
 * controllers and resolves control-plane scope UUIDs from Hub scope slugs.
 */

import { Op } from 'sequelize';
import type { Request, Response, NextFunction } from 'express';

import { Scope } from '../models/index.js';
import { ApiError } from '../lib/api_error.js';

declare global {
    namespace Express {
        interface Request {
            user?: {
                user_id: string;
                email: string;
                org_ids: string[];
                scope_ids: string[];
                /** Hub account role — `admin` is site-wide. */
                role: string;
                /** Active org context for this request. */
                current_org_id?: string;
            };
        }
    }
}

/**
 * Verify the caller has access to the given control-plane scope_id.
 * Throws 403 if the scope is not in the user's accessible set.
 */
export function authorize_scope(req: Request, scope_id: string): void {
    const accessible = req.user?.scope_ids ?? [];
    if (!accessible.includes(scope_id)) {
        throw ApiError.forbidden(`Scope '${scope_id}' is not accessible to this user`);
    }
}

/**
 * Verify the caller has access to ALL given scope_ids.
 */
export function authorize_scopes(req: Request, scope_ids: string[]): void {
    for (const sid of scope_ids) {
        authorize_scope(req, sid);
    }
}

/**
 * Resolve control-plane (`cliq.scopes`) UUIDs for Hub scope slugs the user can access.
 *
 * Default scopes (`is_default = 1`, e.g. `cliq`) are always included for
 * every authenticated user — they are system-wide namespaces, not tied to
 * any particular org or `public.scopes` membership.
 */
async function resolve_control_plane_scope_ids(scope_slugs: string[]): Promise<string[]> {
    /** Default scopes every authenticated user can access. */
    const default_scopes = await Scope.findAll({
        where: { is_default: 1 },
        attributes: ['id'],
    });
    const ids = new Set(default_scopes.map((s) => s.id));

    if (scope_slugs.length > 0) {
        const user_scopes = await Scope.findAll({
            where: { slug: { [Op.in]: scope_slugs } },
            attributes: ['id'],
        });
        for (const s of user_scopes) {
            ids.add(s.id);
        }
    }

    return [...ids];
}

export async function require_auth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const hub_user = req.auth?.user;
    if (!hub_user) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
    }

    try {
        const scope_slugs = (req.auth.scopes ?? []).map(s => s.slug).filter(Boolean);
        const scope_ids = await resolve_control_plane_scope_ids(scope_slugs);
        const org_ids = (req.auth.org_ids ?? []).map(String);

        req.user = {
            user_id: String(hub_user.id),
            email: hub_user.email,
            org_ids,
            scope_ids,
            role: String(hub_user.role ?? 'user'),
            current_org_id: req.auth.current_org_id,
        };

        next();
    } catch (err) {
        res.status(401).json({ ok: false, error: (err as Error).message });
    }
}
