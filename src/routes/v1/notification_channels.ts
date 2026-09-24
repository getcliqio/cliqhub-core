import type { Router, RequestHandler } from 'express';
import { NotificationsController } from '../../controllers/notifications_controller.js';

export function register_notification_channels_routes(router: Router, auth: RequestHandler): void {
    const controller = new NotificationsController();

    router.post('/notification_channels/get', auth, controller.wrap(controller.channels_get));
    router.post('/notification_channels/create', auth, controller.wrap(controller.channels_create));
    router.post('/notification_channels/update', auth, controller.wrap(controller.channels_update));
    router.post('/notification_channels/remove', auth, controller.wrap(controller.channels_remove));
    router.post('/notification_channels/test', auth, controller.wrap(controller.channels_test));
}
