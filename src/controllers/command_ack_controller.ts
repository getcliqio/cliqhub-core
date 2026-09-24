/**
 * Daemon command acknowledgments — Hub→daemon command_outbox completion.
 *
 * POST /v1/daemons/ack_command — daemon reports ok/error for a delivered command.
 * Under Daemons (not a separate Commands resource).
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { get_control_plane_store } from '../db/control_plane_store.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('command-ack');

const ack_command_schema = z.object({
    tx_id: z.string().min(1),
    command_tx_id: z.string().min(1),
    daemon_id: z.string().min(1),
    status: z.enum(['ok', 'error']),
    data: z.unknown().optional(),
    error: z.string().optional(),
});

export class CommandAckController {
    /**
     * POST /v1/daemons/ack_command
     *
     * Records the application-level acknowledgment for a Hub→daemon command.
     * Already-acked commands are a no-op (idempotent).
     */
    static async ack_command(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = ack_command_schema.parse(req.body);
            const store = get_control_plane_store();

            // Check if the command exists.
            const [rows] = await store.sequelize.query(
                `SELECT tx_id, acked_at FROM cliq.command_outbox WHERE tx_id = ?`,
                { replacements: [body.command_tx_id] },
            );
            const command = (rows as Array<{ tx_id: string; acked_at: number | null }>)[0];

            // Unknown command_tx_id — the command may have been dispatched
            // via direct HTTP (e.g. offer_job, execute) rather than the
            // command outbox, so there is no row to ack. Treat as no-op.
            if (!command) {
                log.debug('command_ack_unknown', { command_tx_id: body.command_tx_id });
                res.json({ ok: true });
                return;
            }

            // Already acked — no-op (idempotent).
            if (command.acked_at) {
                log.debug('command_ack_duplicate', { command_tx_id: body.command_tx_id });
                res.json({ ok: true });
                return;
            }

            await store.sequelize.query(
                `UPDATE cliq.command_outbox
                 SET acked_at = ?, ack_status = ?, ack_data = ?::jsonb, ack_error = ?
                 WHERE tx_id = ? AND acked_at IS NULL`,
                {
                    replacements: [
                        Date.now(),
                        body.status,
                        body.data !== undefined ? JSON.stringify(body.data) : null,
                        body.error ?? null,
                        body.command_tx_id,
                    ],
                },
            );

            log.info('command_acked', {
                command_tx_id: body.command_tx_id,
                daemon_id: body.daemon_id,
                status: body.status,
            });
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    }
}
