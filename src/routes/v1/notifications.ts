import type { Router, RequestHandler } from 'express';
import { NotificationController } from '../../controllers/notifications_controller.js';

/** Delivered in-app inbox only (not channels/rules). */
export function register_notifications_routes(router: Router, auth: RequestHandler): void {
    router.post('/notifications/get', auth, NotificationController.inbox_get);
}
