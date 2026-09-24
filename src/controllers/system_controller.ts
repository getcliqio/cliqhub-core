import { Request, Response, NextFunction } from 'express';
import { seed_all } from '../lib/seed.js';

export class SystemController {
    static async health(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        let outbox_stats = { command_outbox_pending: 0, command_outbox_failed: 0, inbound_dedup_count: 0 };
        try {
            const { get_command_outbox_stats } = await import('../services/command_outbox.service.js');
            const { get_dedup_stats } = await import('../middleware/inbound_dedup.js');
            const outbox = await get_command_outbox_stats();
            const dedup = await get_dedup_stats();
            outbox_stats = { ...outbox, ...dedup };
        } catch { /* DB may not be ready */ }

        res.json({ ok: true, timestamp: Date.now(), ...outbox_stats });
    }

    static async seed(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            await seed_all();
            res.json({ ok: true });
        } catch (err) { next(err); }
    }
}
