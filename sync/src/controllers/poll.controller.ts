import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import { z } from 'zod';

import type { SyncEnvConfig } from '../config/env.js';
import type { PollHoldService, Command } from '../services/poll_hold.service.js';
import { SyncError } from '../middleware/error_handler.js';

const response_schema = z.object({
    command_id: z.string(),
    status_code: z.number(),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
});

const poll_body_schema = z.object({
    daemon_id: z.string(),
    responses: z.array(response_schema).default([]),
});

/**
 * Poll controller: daemon long-poll endpoint.
 *
 * Daemon delivers command responses and picks up new commands.
 * Connection is held open until commands arrive or timeout.
 */
export class PollController {
    constructor(
        private readonly config: SyncEnvConfig,
        private readonly pool: pg.Pool,
        private readonly poll_hold: PollHoldService,
    ) {}

    poll = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const parsed = poll_body_schema.safeParse(req.body);
            if (!parsed.success) {
                throw new SyncError(400, 'invalid_body', parsed.error.message);
            }

            const { daemon_id, responses } = parsed.data;

            // Verify the authenticated daemon matches the claimed daemon_id
            if (req.daemon_auth && req.daemon_auth.daemon_id !== daemon_id) {
                throw new SyncError(403, 'forbidden', 'Token daemon_id does not match request');
            }

            // Process command responses from the daemon
            await this.process_responses(responses);

            // Update heartbeat
            await this.pool.query(`
                UPDATE cliq.daemons
                SET last_heartbeat = $1, status = 'online'
                WHERE id = $2
            `, [Date.now(), daemon_id]);

            // Check for pending commands
            const commands = await this.fetch_pending_commands(daemon_id);

            if (commands.length > 0) {
                // Commands available — respond immediately
                res.json({ commands });
                return;
            }

            // No commands — hold the connection (long-poll)
            await this.poll_hold.hold_poll(daemon_id, this.config.poll_timeout_ms);

            // After wake or timeout, check again for commands
            const woken_commands = await this.fetch_pending_commands(daemon_id);
            res.json({ commands: woken_commands });
        } catch (err) {
            next(err);
        }
    };

    private async process_responses(
        responses: z.infer<typeof response_schema>[],
    ): Promise<void> {
        for (const resp of responses) {
            // Write response to DB
            await this.pool.query(`
                INSERT INTO cliq.sync_command_responses (command_id, status_code, headers, body, received_at)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (command_id) DO NOTHING
            `, [
                resp.command_id,
                resp.status_code,
                resp.headers ? JSON.stringify(resp.headers) : null,
                JSON.stringify(resp.body ?? null),
                Date.now(),
            ]);

            // Mark command as completed
            await this.pool.query(`
                UPDATE cliq.sync_command_queue SET status = 'completed' WHERE id = $1
            `, [resp.command_id]);

            // Resolve the local pending waiter (relay caller on this instance)
            const resolved = this.poll_hold.resolve_waiter(resp.command_id, {
                status_code: resp.status_code,
                headers: resp.headers,
                body: resp.body,
            });

            // If not resolved locally, notify other instances
            if (!resolved) {
                await this.pool.query(
                    `SELECT pg_notify($1, $2)`,
                    [this.config.response_notify_channel, resp.command_id],
                );
            }
        }
    }

    private async fetch_pending_commands(daemon_id: string): Promise<Command[]> {
        const now = Date.now();
        const result = await this.pool.query<{
            id: string;
            method: string;
            path: string;
            headers: Record<string, string> | null;
            body: unknown;
            delivery_count: number;
        }>(`
            UPDATE cliq.sync_command_queue
            SET status = 'delivered', delivered_at = $1, delivery_count = delivery_count + 1
            WHERE id IN (
                SELECT id FROM cliq.sync_command_queue
                WHERE daemon_id = $2 AND status = 'pending'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, method, path, headers, body, delivery_count
        `, [now, daemon_id]);

        return result.rows.map((row) => ({
            id: row.id,
            method: row.method,
            path: row.path,
            headers: row.headers ?? undefined,
            body: row.body,
            delivery_count: row.delivery_count,
        }));
    }
}
