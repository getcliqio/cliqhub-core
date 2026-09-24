/**
 * Public A2A discovery + invoke. Mounted at `/a2a`.
 */

import { Router } from 'express';
import { A2aPublicController } from '../controllers/a2a_public_controller.js';
import { A2aSendController } from '../controllers/a2a_send_controller.js';
import { core_api_error_handler } from '../middleware/control_plane_error_handler.js';

export function create_a2a_router(): Router {
    const a2a_pub = Router();
    a2a_pub.get('/o/:org/r/:slug/.well-known/agent-card.json', A2aPublicController.agent_card);
    a2a_pub.post('/o/:org/r/:slug/send', A2aSendController.send);
    a2a_pub.use(core_api_error_handler);
    return a2a_pub;
}
