import type { Request, Response } from 'express';
import type pg from 'pg';

import type { NotifyService } from '../services/notify.service.js';

export class HealthController {
    constructor(
        private readonly pool: pg.Pool,
        private readonly notify_service: NotifyService,
    ) {}

    /** Liveness probe — always 200 if the process is running. */
    check = async (_req: Request, res: Response): Promise<void> => {
        try {
            const twenty_four_hours_ago = Date.now() - 86_400_000;

            const [daemons, failed, expired] = await Promise.all([
                this.pool.query<{ count: string }>(
                    `SELECT COUNT(*) as count FROM cliq.daemons WHERE status = 'online'`,
                ),
                this.pool.query<{ count: string }>(
                    `SELECT COUNT(*) as count FROM cliq.sync_command_queue
                     WHERE status = 'failed' AND created_at > $1`,
                    [twenty_four_hours_ago],
                ),
                this.pool.query<{ count: string }>(
                    `SELECT COUNT(*) as count FROM cliq.sync_command_queue
                     WHERE status = 'expired' AND created_at > $1`,
                    [twenty_four_hours_ago],
                ),
            ]);

            res.json({
                status: 'ok',
                daemons_online: parseInt(daemons.rows[0]?.count ?? '0', 10),
                failed_commands_24h: parseInt(failed.rows[0]?.count ?? '0', 10),
                expired_commands_24h: parseInt(expired.rows[0]?.count ?? '0', 10),
                notify_connected: this.notify_service.connected,
                pg_connected: true,
            });
        } catch {
            res.status(503).json({
                status: 'degraded',
                daemons_online: 0,
                failed_commands_24h: 0,
                expired_commands_24h: 0,
                notify_connected: this.notify_service.connected,
                pg_connected: false,
            });
        }
    };

    /** Readiness probe — returns 503 if critical connections are down. */
    ready = async (_req: Request, res: Response): Promise<void> => {
        if (!this.notify_service.connected) {
            res.status(503).json({ ready: false, reason: 'notify_disconnected' });
            return;
        }

        try {
            await this.pool.query('SELECT 1');
            res.json({ ready: true });
        } catch {
            res.status(503).json({ ready: false, reason: 'pg_disconnected' });
        }
    };
}
