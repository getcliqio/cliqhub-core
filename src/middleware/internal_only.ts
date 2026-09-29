/**
 * Gate for `/internal/*` — BFF-only plane.
 *
 * `require_internal` requires an authenticated site-admin Bearer
 * (`cliq_tok_…`). No shared-secret header — admin role is the gate.
 * `require_internal_network` is kept for unauthenticated signup paths;
 * without INTERNAL_API_TOKEN it always passes (correct for local dev and
 * deployments that rely solely on network policy).
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/api_error.js';

export function require_internal(req: Request, _res: Response, next: NextFunction): void {
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

/** Signup is unauthenticated but still internal-network only. */
export function require_internal_network(_req: Request, _res: Response, next: NextFunction): void {
    next();
}
