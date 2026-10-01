/**
 * System routes — authenticated admin-only system seed operation.
 *
 * POST   /v1/system/seed
 */
import type { Router } from 'express';
import { SystemController } from '../../controllers/system_controller.js';

export function register_system_routes(router: Router): void {
    router.post('/system/seed', SystemController.seed);
}
