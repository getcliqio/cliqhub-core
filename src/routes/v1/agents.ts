/**
 * Hub Agents API routes — 1:1 with AgentsController.
 *
 * Controllers use normal async methods; `wrap` adapts them for Express.
 */

import type { Router } from 'express';
import { AgentsController } from '../../controllers/agents_controller.js';

/** Register agent catalog + settings routes on the given router. */
export function register_agents_routes(router: Router): void {
    const controller = new AgentsController();

    router.post('/agents/get', controller.wrap(controller.get));
    router.post('/agents/get_details', controller.wrap(controller.get_details));
    router.post('/agents/register', controller.wrap(controller.register));
    router.post('/agents/deregister', controller.wrap(controller.deregister));
    router.post('/agents/get_settings', controller.wrap(controller.get_settings));
    router.post('/agents/update_settings', controller.wrap(controller.update_settings));
}
