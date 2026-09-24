import type { Request, Response, NextFunction } from 'express';
import { AgentCardService } from '../services/agent_card.service.js';

/**
 * Public A2A discovery — no session auth.
 * Mounted at GET /a2a/o/:org/r/:slug/.well-known/agent-card.json
 */
export class A2aPublicController {
    static async agent_card(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const slug = String(req.params.slug ?? '').trim();
            const org_slug = String(req.params.org ?? '').trim();

            // Resolve org_id from the URL org slug.
            let org_id: string | undefined;
            if (org_slug) {
                const { Org } = await import('../db/models/index.js');
                const org = await Org.findOne({ where: { slug: org_slug } });
                if (org) org_id = org.id;
            }

            const card = await AgentCardService.build_for_slug(slug, { org_id });
            res.setHeader('Cache-Control', 'public, max-age=60');
            res.json(card);
        } catch (err) {
            next(err);
        }
    }
}
