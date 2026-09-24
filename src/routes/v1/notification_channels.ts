import type { Router, RequestHandler } from 'express';
import { NotificationController } from '../../controllers/notifications_controller.js';

export function register_notification_channels_routes(router: Router, auth: RequestHandler): void {
    router.post('/notification_channels/get', auth, NotificationController.channels_get);
    router.post('/notification_channels/create', auth, NotificationController.channels_create);
    router.post('/notification_channels/update', auth, NotificationController.channels_update);
    router.post('/notification_channels/remove', auth, NotificationController.channels_remove);
    router.post('/notification_channels/test', auth, NotificationController.channels_test);
}
