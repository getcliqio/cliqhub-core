import type { Router, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { NotificationsController } from '../../controllers/notifications_controller.js';

export function register_orgs_routes(router: Router, container: Container, auth: RequestHandler): void {
    const { orgs_controller } = container;
    const notifications = new NotificationsController();
    router.post('/orgs/get', auth, orgs_controller.get);
    router.post('/orgs/get_by_id', auth, orgs_controller.get_by_id);
    router.post('/orgs/list_roles', auth, orgs_controller.list_roles);
    router.post('/orgs/get_reviewable_targets', auth, orgs_controller.get_reviewable_targets);
    router.post('/orgs/get_notification_rules', auth, notifications.wrap(notifications.rules_list));
    router.post('/orgs/set_notification_rule', auth, notifications.wrap(notifications.rules_set));
    router.post('/orgs/remove_notification_rule', auth, notifications.wrap(notifications.rules_remove));
    router.post('/permissions/list', auth, orgs_controller.permissions_list);
}
