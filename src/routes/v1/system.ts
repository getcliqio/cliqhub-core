import type { Router, RequestHandler } from 'express';
import { SystemController } from '../../controllers/system_controller.js';

export function register_system_routes(router: Router, auth: RequestHandler): void {
    router.post('/system/seed', auth, SystemController.seed);
}
