/**
 * Orgs routes — org CRUD, member management, custom roles, scopes, notification rules, and permissions.
 *
 * POST   /v1/orgs/get
 * POST   /v1/orgs/get_by_id
 * POST   /v1/orgs/new
 * POST   /v1/orgs/update
 * POST   /v1/orgs/delete
 * POST   /v1/orgs/leave
 * POST   /v1/orgs/add_member
 * POST   /v1/orgs/remove_member
 * POST   /v1/orgs/list_roles
 * POST   /v1/orgs/get_role
 * POST   /v1/orgs/create_role
 * POST   /v1/orgs/update_role
 * POST   /v1/orgs/delete_role
 * POST   /v1/orgs/get_scopes
 * POST   /v1/orgs/new_scope
 * POST   /v1/orgs/update_scope
 * POST   /v1/orgs/delete_scope
 * POST   /v1/orgs/assign_scope_member
 * POST   /v1/orgs/unassign_scope_member
 * POST   /v1/orgs/get_notification_rules
 * POST   /v1/orgs/set_notification_rules
 * POST   /v1/orgs/remove_notification_rules
 * POST   /v1/orgs/get_reviewable_targets
 * POST   /v1/permissions/list
 */
import type { Router } from 'express';
import type { Container } from '../../container.js';
import { NotificationsController } from '../../controllers/notifications_controller.js';

export function register_orgs_routes(router: Router, container: Container): void {
    const { orgs_controller } = container;
    const notifications = new NotificationsController();

    // ── Org CRUD ──────────────────────────────────────────────────────────────
    router.post('/orgs/get', orgs_controller.wrap(orgs_controller.get));
    router.post('/orgs/get_by_id', orgs_controller.wrap(orgs_controller.get_by_id));
    router.post('/orgs/new', orgs_controller.wrap(orgs_controller.new_org));
    router.post('/orgs/update', orgs_controller.wrap(orgs_controller.update));
    router.post('/orgs/delete', orgs_controller.wrap(orgs_controller.delete_org));
    router.post('/orgs/leave', orgs_controller.wrap(orgs_controller.leave));

    // ── Members ───────────────────────────────────────────────────────────────
    router.post('/orgs/add_member', orgs_controller.wrap(orgs_controller.add_member));
    router.post('/orgs/remove_member', orgs_controller.wrap(orgs_controller.remove_member));

    // ── Custom roles ─────────────────────────────────────────────────────────
    router.post('/orgs/list_roles', orgs_controller.wrap(orgs_controller.list_roles));
    router.post('/orgs/get_role', orgs_controller.wrap(orgs_controller.get_role));
    router.post('/orgs/create_role', orgs_controller.wrap(orgs_controller.create_role));
    router.post('/orgs/update_role', orgs_controller.wrap(orgs_controller.update_role));
    router.post('/orgs/delete_role', orgs_controller.wrap(orgs_controller.delete_role));

    // ── Scopes ────────────────────────────────────────────────────────────────
    router.post('/orgs/get_scopes', orgs_controller.wrap(orgs_controller.get_scopes));
    router.post('/orgs/new_scope', orgs_controller.wrap(orgs_controller.new_scope));
    router.post('/orgs/update_scope', orgs_controller.wrap(orgs_controller.update_scope));
    router.post('/orgs/delete_scope', orgs_controller.wrap(orgs_controller.delete_scope));
    router.post('/orgs/assign_scope_member', orgs_controller.wrap(orgs_controller.assign_scope_member));
    router.post('/orgs/unassign_scope_member', orgs_controller.wrap(orgs_controller.unassign_scope_member));

    // ── Notifications ─────────────────────────────────────────────────────────
    router.post('/orgs/get_notification_rules', notifications.wrap(notifications.rules_list));
    router.post('/orgs/set_notification_rules', notifications.wrap(notifications.rules_set));
    router.post('/orgs/remove_notification_rules', notifications.wrap(notifications.rules_remove));

    // ── Misc ──────────────────────────────────────────────────────────────────
    router.post('/orgs/get_reviewable_targets', orgs_controller.wrap(orgs_controller.get_reviewable_targets));
    router.post('/permissions/list', orgs_controller.wrap(orgs_controller.permissions_list));
}
