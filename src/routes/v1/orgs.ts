import type { Router, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { NotificationsController } from '../../controllers/notifications_controller.js';

export function register_orgs_routes(router: Router, container: Container, auth: RequestHandler): void {
    const { orgs_controller } = container;
    const notifications = new NotificationsController();

    // ── Org CRUD ──────────────────────────────────────────────────────────────
    router.post('/orgs/get',          auth, orgs_controller.wrap(orgs_controller.get));
    router.post('/orgs/get_by_id',    auth, orgs_controller.wrap(orgs_controller.get_by_id));
    router.post('/orgs/new',          auth, orgs_controller.wrap(orgs_controller.new_org));
    router.post('/orgs/update',       auth, orgs_controller.wrap(orgs_controller.update));
    router.post('/orgs/delete',       auth, orgs_controller.wrap(orgs_controller.delete_org));
    router.post('/orgs/leave',        auth, orgs_controller.wrap(orgs_controller.leave));

    // ── Members ───────────────────────────────────────────────────────────────
    router.post('/orgs/add_member',    auth, orgs_controller.wrap(orgs_controller.add_member));
    router.post('/orgs/remove_member', auth, orgs_controller.wrap(orgs_controller.remove_member));

    // ── Custom roles ─────────────────────────────────────────────────────────
    router.post('/orgs/list_roles',   auth, orgs_controller.wrap(orgs_controller.list_roles));
    router.post('/orgs/get_role',     auth, orgs_controller.wrap(orgs_controller.get_role));
    router.post('/orgs/create_role',  auth, orgs_controller.wrap(orgs_controller.create_role));
    router.post('/orgs/update_role',  auth, orgs_controller.wrap(orgs_controller.update_role));
    router.post('/orgs/delete_role',  auth, orgs_controller.wrap(orgs_controller.delete_role));

    // ── Scopes ────────────────────────────────────────────────────────────────
    router.post('/orgs/get_scopes',             auth, orgs_controller.wrap(orgs_controller.get_scopes));
    router.post('/orgs/new_scope',              auth, orgs_controller.wrap(orgs_controller.new_scope));
    router.post('/orgs/update_scope',           auth, orgs_controller.wrap(orgs_controller.update_scope));
    router.post('/orgs/delete_scope',           auth, orgs_controller.wrap(orgs_controller.delete_scope));
    router.post('/orgs/assign_scope_member',    auth, orgs_controller.wrap(orgs_controller.assign_scope_member));
    router.post('/orgs/unassign_scope_member',  auth, orgs_controller.wrap(orgs_controller.unassign_scope_member));

    // ── Notifications ─────────────────────────────────────────────────────────
    router.post('/orgs/get_notification_rules',    auth, notifications.wrap(notifications.rules_list));
    router.post('/orgs/set_notification_rules',    auth, notifications.wrap(notifications.rules_set));
    router.post('/orgs/remove_notification_rules', auth, notifications.wrap(notifications.rules_remove));

    // ── Misc ──────────────────────────────────────────────────────────────────
    router.post('/orgs/get_reviewable_targets', auth, orgs_controller.wrap(orgs_controller.get_reviewable_targets));
    router.post('/permissions/list',            auth, orgs_controller.wrap(orgs_controller.permissions_list));
}
