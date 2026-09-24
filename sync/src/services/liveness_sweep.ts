import type pg from 'pg';

import type { SyncEnvConfig } from '../config/env.js';
import type { PollHoldService } from './poll_hold.service.js';

/**
 * Background sweep that marks unresponsive daemons offline and expires stale commands.
 * Runs every 15 seconds.
 */
export class LivenessSweep {
    private interval: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly config: SyncEnvConfig,
        private readonly pool: pg.Pool,
        private readonly poll_hold: PollHoldService,
    ) {}

    start(): void {
        this.interval = setInterval(() => this.sweep(), 15_000);
        console.log('[Sync] Liveness sweep started (every 15s)');
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    private async sweep(): Promise<void> {
        const now_ms = Date.now();
        const threshold = now_ms - this.config.liveness_threshold_ms;

        try {
            // Mark daemons offline if they haven't polled within the threshold
            const offline_daemons = await this.pool.query<{ id: string }>(`
                UPDATE cliq.daemons
                SET status = 'offline'
                WHERE status != 'offline'
                  AND last_heartbeat < $1
                RETURNING id
            `, [threshold]);

            // Requeue delivered commands for daemons that went offline (if retries remain)
            for (const daemon of offline_daemons.rows) {
                await this.pool.query(`
                    UPDATE cliq.sync_command_queue
                    SET status = 'pending', delivered_at = NULL
                    WHERE daemon_id = $1
                      AND status = 'delivered'
                      AND delivery_count < max_deliveries
                `, [daemon.id]);

                // Transition to failed if retries exhausted
                const failed = await this.pool.query<{ id: string }>(`
                    UPDATE cliq.sync_command_queue
                    SET status = 'failed'
                    WHERE daemon_id = $1
                      AND status = 'delivered'
                      AND delivery_count >= max_deliveries
                    RETURNING id
                `, [daemon.id]);

                for (const row of failed.rows) {
                    this.poll_hold.reject_waiter(
                        row.id,
                        new Error('Command failed — delivery retries exhausted'),
                    );
                }

                // Reject waiters for all remaining in-flight commands
                await this.poll_hold.reject_all_for_daemon(
                    daemon.id,
                    new Error('Daemon went offline'),
                );
            }

            // Expire stale pending/delivered commands past their TTL
            const expired = await this.pool.query<{ id: string }>(`
                UPDATE cliq.sync_command_queue
                SET status = 'expired'
                WHERE status IN ('pending', 'delivered')
                  AND expires_at < $1
                RETURNING id
            `, [now_ms]);

            for (const row of expired.rows) {
                this.poll_hold.reject_waiter(
                    row.id,
                    new Error('Command expired — daemon did not respond in time'),
                );
            }
        } catch (err) {
            console.error('[Sync] Liveness sweep error:', (err as Error).message);
        }
    }
}
