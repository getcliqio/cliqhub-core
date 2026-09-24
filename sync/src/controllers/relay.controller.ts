import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import { v4 as uuid } from 'uuid';

import type { SyncEnvConfig } from '../config/env.js';
import type { PollHoldService, CommandResponse } from '../services/poll_hold.service.js';
import { SyncError } from '../middleware/error_handler.js';

/**
 * Relay controller: transparent proxy for the CliqHub API.
 *
 * The backend POSTs here thinking it's talking to a daemon.
 * We queue the command, wake the daemon's poll, and hold the
 * backend's connection until the daemon responds (or timeout).
 */
export class RelayController {
    constructor(
        private readonly config: SyncEnvConfig,
        private readonly pool: pg.Pool,
        private readonly poll_hold: PollHoldService,
    ) {}

    relay = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const daemon_id = String(req.params.daemon_id);
            const wildcard = req.params.path;
            const command_path = '/' + (Array.isArray(wildcard) ? wildcard.join('/') : (wildcard || ''));
            // Control-message tx_id lives in the JSON body (not headers).
            const body_tx = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
                ? (req.body as Record<string, unknown>).tx_id
                : undefined;
            const idempotency_key = typeof body_tx === 'string' && body_tx.trim()
                ? body_tx.trim()
                : undefined;

            // Verify daemon is online
            const daemon_check = await this.pool.query<{ status: string }>(
                `SELECT status FROM cliq.daemons WHERE id = $1`,
                [daemon_id],
            );

            if (!daemon_check.rows[0]) {
                throw new SyncError(404, 'daemon_not_found', `Daemon ${daemon_id} not found`);
            }

            if (daemon_check.rows[0].status !== 'online') {
                throw new SyncError(503, 'daemon_offline', `Daemon ${daemon_id} is offline`);
            }

            // Idempotency check: body.tx_id is globally unique across daemons
            if (idempotency_key) {
                const existing = await this.pool.query<{ id: string; status: string; daemon_id: string }>(`
                    SELECT id, status, daemon_id FROM cliq.sync_command_queue
                    WHERE idempotency_key = $1
                `, [idempotency_key]);

                if (existing.rows[0]) {
                    const cmd = existing.rows[0];

                    // Already completed — return cached response
                    if (cmd.status === 'completed') {
                        const cached = await this.pool.query<{ status_code: number; body: unknown }>(`
                            SELECT status_code, body FROM cliq.sync_command_responses
                            WHERE command_id = $1
                        `, [cmd.id]);

                        if (cached.rows[0]) {
                            res.status(cached.rows[0].status_code).json(cached.rows[0].body);
                            return;
                        }
                    }

                    // Still in-flight — attach to existing waiter
                    if (cmd.status === 'pending' || cmd.status === 'delivered') {
                        const response = await this._wait_or_timeout(res, cmd.id);
                        if (response) {
                            res.status(response.status_code).json(response.body);
                        }
                        return;
                    }

                    // Failed/expired — let the backend know
                    throw new SyncError(503, 'command_failed', `Previous command ${cmd.status}`);
                }
            }

            // Queue the command
            const command_id = uuid();
            const now_ms = Date.now();

            await this.pool.query(`
                INSERT INTO cliq.sync_command_queue
                    (id, daemon_id, method, path, headers, body, created_at, expires_at, status, idempotency_key)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
            `, [
                command_id,
                daemon_id,
                req.method,
                command_path,
                JSON.stringify(this.extract_forwarded_headers(req)),
                JSON.stringify(req.body),
                now_ms,
                now_ms + this.config.command_ttl_ms,
                idempotency_key ?? null,
            ]);

            // Wake the daemon's held poll (local instance)
            this.poll_hold.wake_poll(daemon_id);

            // Notify other instances via PG NOTIFY
            await this.pool.query(
                `SELECT pg_notify($1, $2)`,
                [this.config.notify_channel, daemon_id],
            );

            // Hold the backend caller's connection until daemon responds
            const response = await this._wait_or_timeout(res, command_id);
            if (response) {
                res.status(response.status_code).json(response.body);
            }
        } catch (err) {
            next(err);
        }
    };

    /** Query a command's current status. Used by the backend to check in-flight commands. */
    get_command_status = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const command_id = req.params.command_id;
            const result = await this.pool.query<{
                status: string;
                delivery_count: number;
                created_at: string;
            }>(`
                SELECT status, delivery_count, created_at
                FROM cliq.sync_command_queue WHERE id = $1
            `, [command_id]);

            if (!result.rows[0]) {
                throw new SyncError(404, 'not_found', 'Command not found');
            }

            res.json(result.rows[0]);
        } catch (err) {
            next(err);
        }
    };

    private async _wait_or_timeout(res: Response, command_id: string): Promise<CommandResponse | null> {
        try {
            return await this.poll_hold.wait_for_response(command_id);
        } catch {
            res.status(503).json({
                ok: false,
                error: { code: 'timeout', message: 'Daemon did not respond in time' },
            });
            return null;
        }
    }

    private extract_forwarded_headers(req: Request): Record<string, string> {
        const forwarded: Record<string, string> = {};
        const ct = req.headers['content-type'];
        if (ct && typeof ct === 'string') {
            forwarded['content-type'] = ct;
        }
        const rid = req.headers['x-request-id'];
        if (rid && typeof rid === 'string') {
            forwarded['x-request-id'] = rid;
        }
        return forwarded;
    }
}
