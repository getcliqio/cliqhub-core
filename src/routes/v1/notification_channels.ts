/**
 * Notification channels routes — CRUD and test for org-level delivery channels (Slack, webhook, etc.).
 *
 * POST   /v1/notification_channels/get
 * POST   /v1/notification_channels/create
 * POST   /v1/notification_channels/update
 * POST   /v1/notification_channels/remove
 * POST   /v1/notification_channels/test
 */
import type { Router } from 'express';
import { NotificationsController } from '../../controllers/notifications_controller.js';

export function register_notification_channels_routes(router: Router): void {
    const controller = new NotificationsController();

    router.post('/notification_channels/get', controller.wrap(controller.channels_get));
    router.post('/notification_channels/create', controller.wrap(controller.channels_create));
    router.post('/notification_channels/update', controller.wrap(controller.channels_update));
    router.post('/notification_channels/remove', controller.wrap(controller.channels_remove));
    router.post('/notification_channels/test', controller.wrap(controller.channels_test));
}
