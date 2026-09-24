/**
 * Daemon tokens (`cliq_dt_…`) may only hit an allowlisted set of routes.
 * Entity access (`daemons`/`dispatch`/`runs`) is asserted inside those handlers.
 */

import type { Request, Response, NextFunction } from 'express';

/** Paths (as Express `req.path`) that accept `auth_via === 'daemon_token'`. */
export const DAEMON_TOKEN_ALLOWED_PATHS = new Set([
    '/v1/daemons/register',
    '/v1/daemons/heartbeat',
    '/v1/daemons/deregister',
    '/v1/auth/acl',
    '/v1/runs/claim',
    '/v1/sync/ingest',
    '/v1/settings/get',
    '/v1/events/submit',
    // State push (runs) — workspace row is ensured inside runs/create
    '/v1/runs/create',
    '/v1/runs/complete',
    '/v1/runs/report_activity',
    '/v1/runs/append_logs',
    '/v1/runs/report_telemetry',
    '/v1/runs/artifacts/create',
    '/v1/runs/update_status',
    '/v1/runs/resume',
    '/v1/daemons/ack_command',
    // HUG — daemon/agent create + poll + ack + agent messages; verdict stays human/session-only
    '/v1/reviews/create',
    '/v1/reviews/get_by_id',
    '/v1/reviews/ack',
    '/v1/reviews/send_message',
]);

export function deny_daemon_token_outside_allowlist(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    if (req.auth?.auth_via !== 'daemon_token') {
        next();
        return;
    }

    if (DAEMON_TOKEN_ALLOWED_PATHS.has(req.path)) {
        next();
        return;
    }

    res.status(403).json({
        ok: false,
        error: {
            code: 'forbidden',
            message: 'Daemon token not allowed on this route',
        },
    });
}
