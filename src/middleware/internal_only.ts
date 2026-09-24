/**
 * Gate for `/internal/*` — BFF-only plane.
 *
 * When INTERNAL_API_TOKEN is set, require matching `X-Internal-Token`.
 * `require_internal` also requires an authenticated site-admin Bearer
 * (BFF forwards the operator's user PAT / `user_token`, not a JWT).
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/api_error.js';

export function require_internal(req: Request, _res: Response, next: NextFunction): void {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (expected) {
        const got = req.header('x-internal-token');
        if (got !== expected) {
            next(new ApiError('forbidden', 'Internal API: invalid or missing X-Internal-Token', 403));
            return;
        }
    }

    if (!req.auth?.user) {
        next(new ApiError('unauthorized', 'Authentication required', 401));
        return;
    }
    if (req.auth.user.role !== 'admin') {
        next(new ApiError('forbidden', 'Internal API: admin grant required', 403));
        return;
    }
    next();
}

/** Signup is unauthenticated but still internal-network + optional shared token. */
export function require_internal_network(req: Request, _res: Response, next: NextFunction): void {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) {
        next();
        return;
    }
    const got = req.header('x-internal-token');
    if (got !== expected) {
        next(new ApiError('forbidden', 'Internal API: invalid or missing X-Internal-Token', 403));
        return;
    }
    next();
}
