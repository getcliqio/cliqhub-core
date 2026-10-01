/**
 * Notifications routes — in-app inbox retrieval for the authenticated user.
 *
 * POST   /v1/notifications/get
 */
import type { Router } from 'express';
import { NotificationsController } from '../../controllers/notifications_controller.js';

/** In-app inbox only — paths locked by notifications flat-cut slice. */
export function register_notifications_routes(router: Router): void {
    const controller = new NotificationsController();

    router.post('/notifications/get', controller.wrap(controller.inbox_get));
}
