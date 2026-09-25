/**
 * Core control-plane error envelope: `{ ok: false, error: string }`.
 * Mounted on the core_api router only — does not change Hub registry errors.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import { ApiError } from '../lib/api_error.js';
import { ApiError as BaseApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('errors');

export function core_api_error_handler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (err instanceof ZodError) {
        res.status(400).json({ ok: false, error: err.errors.map(e => e.message).join(', ') });
        return;
    }

    // BaseController.parse_body throws errors/ApiError ({ code, status }).
    if (err instanceof BaseApiError) {
        res.status(err.status).json({ ok: false, error: err.message, code: err.code });
        return;
    }

    if (err instanceof ApiError) {
        const body: { ok: false; error: string; code?: string } = {
            ok: false,
            error: err.message,
        };
        if (err.code) body.code = err.code;
        res.status(err.status_code).json(body);
        return;
    }

    // Sequelize unique / validation → actionable 400 (e.g. duplicate workspace path)
    const sequelize_name = err && typeof err === 'object' && 'name' in err
        ? String((err as { name?: string }).name)
        : '';
    if (
        sequelize_name === 'SequelizeUniqueConstraintError'
        || sequelize_name === 'SequelizeValidationError'
    ) {
        const message = err instanceof Error ? err.message : 'Validation error';
        res.status(400).json({ ok: false, error: message });
        return;
    }

    // FK violation → 409 retryable. Signals to the daemon outbox that
    // the referenced parent row isn't in Hub yet (e.g. run create before
    // arrived before its team was upserted), so the sender should keep
    // retrying rather than backing off as a hard 4xx failure or blowing
    // up as an opaque 500.
    if (sequelize_name === 'SequelizeForeignKeyConstraintError') {
        const message = err instanceof Error ? err.message : 'Foreign key violation';
        log.warn('fk_violation_409', {
            request_id: req.request_id ?? null,
            path: req.originalUrl || req.url,
            error: message,
        });
        res.status(409).json({ ok: false, error: message });
        return;
    }

    const message = err instanceof Error ? err.message : 'Internal server error';
    log.error('unhandled_core_api_error', {
        request_id: req.request_id ?? null,
        path: req.originalUrl || req.url,
        method: req.method,
        error: message,
    });
    res.status(500).json({ ok: false, error: message });
}
