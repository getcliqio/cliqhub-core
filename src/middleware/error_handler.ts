import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/api_error.js';
import { log_request_error, public_error_message } from './error_logging.js';

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
            error: { code: err.code, message: err.message },
        });
        return;
    }

    // Core control-plane ApiError uses `status_code` (no `code` field).
    if (
        err instanceof Error
        && err.name === 'ApiError'
        && typeof (err as { status_code?: unknown }).status_code === 'number'
    ) {
        const status = (err as unknown as { status_code: number }).status_code;
        log_request_error(req, status, err);
        res.status(status).json({
            ok: false,
            error: { code: 'error', message: err.message },
        });
        return;
    }

    log_request_error(req, 500, err);
    res.status(500).json({
        ok: false,
        error: { code: 'internal_error', message: public_error_message(err) },
    });
}
