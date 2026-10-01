/**
 * One place that decides how a failed request is logged, used by both error
 * handlers. Levels follow `lib/log.ts`:
 *   5xx       → error  `request_failed` (with the stack)
 *   401 / 403 → warn   `access_denied`  (source: handler — the route policy logs its own)
 *   404       → debug  `not_found`
 *   other 4xx → debug  `request_rejected` (validation, conflicts)
 * Request id, user id and token kind come from the request log context.
 */

import type { Request } from 'express';

import { get_logger } from '../lib/log.js';

const log = get_logger('errors');

export function log_request_error(req: Request, status: number, err: unknown): void {
    const base = {
        route: `${req.method ?? '?'} ${String(req.originalUrl || req.url || '').split('?')[0]}`,
        status,
    };
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) {
        log.error('request_failed', {
            ...base,
            error: {
                name: err instanceof Error ? err.name : typeof err,
                message,
                stack: err instanceof Error ? err.stack : undefined,
            },
        });
        return;
    }
    if (status === 401 || status === 403) {
        log.warn('access_denied', { ...base, source: 'handler', reason: message });
        return;
    }
    if (status === 404) {
        log.debug('not_found', { ...base, reason: message });
        return;
    }
    log.debug('request_rejected', { ...base, reason: message });
}

/** 5xx bodies never carry internal error text in production. */
export function public_error_message(err: unknown): string {
    if (process.env.NODE_ENV === 'production') return 'Internal server error';
    return err instanceof Error ? err.message : 'Unknown error';
}
