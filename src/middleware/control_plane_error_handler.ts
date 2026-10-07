/**
 * Core control-plane error envelope: `{ ok: false, error: string, code, details? }`.
 * Mounted at the end of every `/v1` and `/a2a` router. Every reply carries a
 * `code`: the error's own, else the one for its status (`error_handler.ts`).
 * A body that fails a route's zod schema is 422 `invalid_params` with the
 * failing fields in `details.issues`.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import { ApiError } from '../lib/api_error.js';
import { ApiError as BaseApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import { log_request_error, public_error_message } from './error_logging.js';
import { code_for } from './error_handler.js';

const log = get_logger('errors');

export function core_api_error_handler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (err instanceof ZodError) {
        log_request_error(req, 422, err);
        res.status(422).json({
            ok: false,
            error: err.errors.map(e => e.message).join(', '),
            code: 'invalid_params',
            details: { issues: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })) },
        });
        return;
    }

    // BaseController.parse_body throws errors/ApiError ({ code, status }).
    if (err instanceof BaseApiError) {
        log_request_error(req, err.status, err);
        res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
        return;
    }

    if (err instanceof ApiError) {
        log_request_error(req, err.status_code, err);
        res.status(err.status_code).json({ ok: false, error: err.message, code: code_for(err.code, err.status_code) });
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
        log_request_error(req, 400, err);
        res.status(400).json({ ok: false, error: message, code: 'bad_request' });
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
        res.status(409).json({ ok: false, error: message, code: 'conflict' });
        return;
    }

    log_request_error(req, 500, err);
    res.status(500).json({ ok: false, error: public_error_message(err), code: 'internal_error' });
}
