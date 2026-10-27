/**
 * Hug routes — requests for input from people (PLAN-hug-requests §6.3).
 *
 * POST /v1/hugs/create      (cliqd; dedup by tx_id)
 * POST /v1/hugs/close       (cliqd)
 * POST /v1/hugs/get_events  (cliqd)
 * POST /v1/hugs/get
 * POST /v1/hugs/get_by_id
 * POST /v1/hugs/respond
 */
import type { Router } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { HugsController } from '../../controllers/hugs_controller.js';

/** Mount `/v1/hugs/*`. */
export function register_hugs_routes(router: Router): void {
    const hugs = new HugsController();

    router.post('/hugs/create', with_dedup(hugs.wrap(hugs.create)));
    router.post('/hugs/close', with_dedup(hugs.wrap(hugs.close)));
    router.post('/hugs/get_events', hugs.wrap(hugs.get_events));
    router.post('/hugs/get', hugs.wrap(hugs.get));
    router.post('/hugs/get_by_id', hugs.wrap(hugs.get_by_id));
    router.post('/hugs/respond', hugs.wrap(hugs.respond));
}
