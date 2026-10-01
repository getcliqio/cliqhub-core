import { Request, Response, NextFunction } from 'express';
import { seed_all } from '../lib/seed.js';
import { get_logger } from '../lib/log.js';
import { CORE_API_VERSION, CORE_STARTED_AT, CORE_VERSION } from '../lib/api_version.js';

const log = get_logger('ctrl.system');

export class SystemController {
    static async health(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        log.debug('health', {});
        let outbox_stats = { command_outbox_pending: 0, command_outbox_failed: 0, inbound_dedup_count: 0 };
        try {
            const { get_command_outbox_stats } = await import('../services/command_outbox.service.js');
            const { get_dedup_stats } = await import('../middleware/inbound_dedup.js');
            const outbox = await get_command_outbox_stats();
            const dedup = await get_dedup_stats();
            outbox_stats = { ...outbox, ...dedup };
        } catch (err) { log.debug('health_stats_unavailable', { error: err instanceof Error ? err.message : String(err) }); /* DB may not be ready */ }

        res.json({
            ok: true,
            timestamp: Date.now(),
            version: CORE_VERSION,
            api_version: CORE_API_VERSION,
            started_at: CORE_STARTED_AT,
            ...outbox_stats,
        });
    }

    static async seed(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Route policy: site admin (S21).
            log.debug('seed', { user_id: req.auth?.user?.id });
            await seed_all();
            log.info('seed_rerun', { user_id: req.auth?.user?.id, request_id: req.request_id });
            res.json({ ok: true });
        } catch (err) { next(err); }
    }
}
