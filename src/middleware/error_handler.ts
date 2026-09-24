import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('errors');

export function error_handler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    const request_id = req.request_id;

    if (err instanceof ApiError) {
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
        res.status(status).json({
            ok: false,
            error: { code: 'error', message: err.message },
        });
        return;
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error('unhandled_error', {
        request_id: request_id ?? null,
        path: req.originalUrl || req.url,
        method: req.method,
        error: message,
    });

    res.status(500).json({
        ok: false,
        error: {
            code: 'internal_error',
            message: process.env.NODE_ENV === 'production'
                ? 'Internal server error'
                : message,
        },
    });
}
