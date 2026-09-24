import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import { z } from 'zod';

import type { SyncEnvConfig } from '../config/env.js';
import type { PollHoldService } from '../services/poll_hold.service.js';
import { SyncError } from '../middleware/error_handler.js';

const register_body_schema = z.object({
    daemon_id: z.string(),
    version: z.string().optional(),
    capabilities: z.record(z.unknown()).optional(),
});

const deregister_body_schema = z.object({
    daemon_id: z.string(),
    reason: z.string().optional(),
});

/**
 * Handles daemon registration and deregistration.
 * On register: marks daemon online, sets public_url to relay endpoint.
 * On deregister: marks daemon offline, expires pending commands.
 */
export class RegisterController {
    constructor(
        private readonly config: SyncEnvConfig,
        private readonly pool: pg.Pool,
        private readonly poll_hold: PollHoldService,
    ) {}

    register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const parsed = register_body_schema.safeParse(req.body);
            if (!parsed.success) {
                throw new SyncError(400, 'invalid_body', parsed.error.message);
            }

            const { daemon_id, version, capabilities } = parsed.data;

            // Verify the authenticated daemon matches
            if (req.daemon_auth && req.daemon_auth.daemon_id !== daemon_id) {
                throw new SyncError(403, 'forbidden', 'Token daemon_id does not match request');
            }

            // Build the relay public_url for this daemon
            const public_url = `${this.config.public_url}/v1/relay/${daemon_id}`;
            const now_ms = Date.now();

            // Update daemon row: set online, assign relay public_url
            await this.pool.query(`
                UPDATE cliq.daemons
                SET status = 'online',
                    last_heartbeat = $1,
                    public_url = $2
                WHERE id = $3
            `, [
                now_ms,
                public_url,
                daemon_id,
            ]);

            res.json({
                registered: true,
                poll_interval_ms: this.config.poll_timeout_ms,
                server_time: new Date().toISOString(),
            });
        } catch (err) {
            next(err);
        }
    };

    deregister = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const parsed = deregister_body_schema.safeParse(req.body);
            if (!parsed.success) {
                throw new SyncError(400, 'invalid_body', parsed.error.message);
            }

            const { daemon_id, reason } = parsed.data;

            // Verify the authenticated daemon matches
            if (req.daemon_auth && req.daemon_auth.daemon_id !== daemon_id) {
                throw new SyncError(403, 'forbidden', 'Token daemon_id does not match request');
            }

            // Mark daemon offline
            await this.pool.query(`
                UPDATE cliq.daemons SET status = 'offline' WHERE id = $1
            `, [daemon_id]);

            // Expire all pending commands for this daemon
            await this.pool.query(`
                UPDATE cliq.sync_command_queue
                SET status = 'expired'
                WHERE daemon_id = $1 AND status IN ('pending', 'delivered')
            `, [daemon_id]);

            // Reject all in-flight waiters
            await this.poll_hold.reject_all_for_daemon(
                daemon_id,
                new Error(`Daemon deregistered: ${reason || 'shutdown'}`),
            );

            // Release any held poll
            this.poll_hold.release_poll(daemon_id);

            res.json({ deregistered: true });
        } catch (err) {
            next(err);
        }
    };
}
