/**
 * Realm Hub routes — Realms CRUD/members/teams + A2A admin + realm notification rules.
 *
 * Mesh account/org mounts live in `routes/v1/mesh.ts` (not here).
 */

import type { Router, RequestHandler } from 'express';
import { RealmController } from '../../controllers/realms_controller.js';
import { RealmA2aController } from '../../controllers/realm_a2a_controller.js';
import { NotificationsController } from '../../controllers/notifications_controller.js';

export function register_realms_routes(router: Router, auth: RequestHandler): void {
    const realms = new RealmController();
    const notifications = new NotificationsController();

    // Realm hard-cut: no get_by_slug / grant / revoke / search_users / team-list / members/* twins.
    router.post('/realms/create', auth, realms.wrap(realms.create));
    router.post('/realms/get', auth, realms.wrap(realms.get));
    router.post('/realms/get_by_id', auth, realms.wrap(realms.get_by_id));
    router.post('/realms/update', auth, realms.wrap(realms.update));
    router.post('/realms/delete', auth, realms.wrap(realms.delete));
    router.post('/realms/get_members', auth, realms.wrap(realms.get_members));
    router.post('/realms/add_member', auth, realms.wrap(realms.add_member));
    router.post('/realms/remove_member', auth, realms.wrap(realms.remove_member));
    router.post('/realms/add_team', auth, realms.wrap(realms.add_team));
    router.post('/realms/remove_team', auth, realms.wrap(realms.remove_team));
    router.post('/realms/get_notification_rules', auth, notifications.wrap(notifications.rules_list));
    router.post('/realms/set_notification_rule', auth, notifications.wrap(notifications.rules_set));
    router.post('/realms/remove_notification_rule', auth, notifications.wrap(notifications.rules_remove));
    router.post('/realms/a2a', auth, RealmA2aController.handle);
}
