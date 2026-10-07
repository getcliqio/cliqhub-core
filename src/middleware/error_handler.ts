import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/api_error.js';
import { log_request_error, public_error_message } from './error_logging.js';

/** A code for a status when the error carries none (the same words the older ApiError uses). */
export const CODE_FOR_STATUS: Record<number, string> = {
    400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
    409: 'conflict', 410: 'expired', 413: 'payload_too_large', 422: 'invalid_params', 429: 'rate_limited',
    500: 'internal_error', 503: 'service_unavailable',
};

/** The error's own code, else the one for its status, else `error`. */
export function code_for(own: unknown, status: number): string {
    return typeof own === 'string' && own.trim() ? own : CODE_FOR_STATUS[status] ?? 'error';
}

export function error_handler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (err instanceof ApiError) {
        log_request_error(req, err.status, err);
        res.status(err.status).json({
            ok: false,
            error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        });
        return;
    }

    // Core control-plane ApiError (`lib/api_error.ts`) uses `status_code` and an optional
    // machine-readable `code` (e.g. `run/stranded`): pass it through so callers can act on it.
    if (
        err instanceof Error
        && err.name === 'ApiError'
        && typeof (err as { status_code?: unknown }).status_code === 'number'
    ) {
        const status = (err as unknown as { status_code: number }).status_code;
        const code = code_for((err as { code?: unknown }).code, status);
        log_request_error(req, status, err);
        res.status(status).json({
            ok: false,
            error: { code, message: err.message },
        });
        return;
    }

    log_request_error(req, 500, err);
    res.status(500).json({
        ok: false,
        error: { code: 'internal_error', message: public_error_message(err) },
    });
}
