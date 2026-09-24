import type { Router, RequestHandler } from 'express';
import { NotificationsController } from '../../controllers/notifications_controller.js';

/** In-app inbox only — paths locked by notifications flat-cut slice. */
export function register_notifications_routes(router: Router, auth: RequestHandler): void {
    const controller = new NotificationsController();

    router.post('/notifications/get', auth, controller.wrap(controller.inbox_get));
}
