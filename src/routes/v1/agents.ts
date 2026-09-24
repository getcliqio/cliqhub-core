/**
 * Hub Agents API routes — four POST endpoints for agent catalog CRUD.
 *
 * Controller is instantiated (not static). Methods are bound so Express
 * can call them without losing `this` context.
 */

import type { Router, RequestHandler } from 'express';
import { AgentController } from '../../controllers/agents_controller.js';

/** Register the four agent catalog routes on the given router. */
export function register_agents_routes(router: Router, auth: RequestHandler): void {
    const controller = new AgentController();

    router.post('/agents/get', auth, controller.get.bind(controller));
    router.post('/agents/get_by_id', auth, controller.get_by_id.bind(controller));
    router.post('/agents/register', auth, controller.register.bind(controller));
    router.post('/agents/deregister', auth, controller.deregister.bind(controller));
    router.post('/agents/get_settings', auth, controller.get_settings.bind(controller));
    router.post('/agents/update_settings', auth, controller.update_settings.bind(controller));
}
