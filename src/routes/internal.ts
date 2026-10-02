/**
 * BFF-only internal plane — not on public ingress.
 * Mounted at `/internal`.
 */

import { Router } from 'express';
import type { Container } from '../container.js';
import { DashboardController } from '../controllers/dashboard_controller.js';

export function create_internal_router(container: Container): Router {
    const {
        auth_controller,
        users_controller,
        orgs_controller,
        reports_controller,
    } = container;

    const internal = Router();

    internal.post('/auth/authenticate_user', auth_controller.wrap(auth_controller.authenticate_user));
    internal.post('/auth/issue_session_token', auth_controller.wrap(auth_controller.issue_session_token));
    internal.post('/auth/revoke_session_token', auth_controller.wrap(auth_controller.revoke_session_token));
    internal.post('/auth/signup', auth_controller.wrap(auth_controller.signup));
    internal.post('/users/new', users_controller.wrap(users_controller.new_user));
    internal.post('/users/delete', users_controller.wrap(users_controller.delete_user));
    internal.post('/users/suspend', users_controller.wrap(users_controller.suspend));
    internal.post('/users/unsuspend', users_controller.wrap(users_controller.unsuspend));
    internal.post('/users/reset_password', users_controller.wrap(users_controller.reset_password));
    internal.post('/users/change_password', users_controller.wrap(users_controller.change_password));
    internal.post('/users/set_role', users_controller.wrap(users_controller.set_role));
    internal.post('/users/update_role', users_controller.wrap(users_controller.update_role));
    internal.post('/orgs/new', orgs_controller.wrap(orgs_controller.new_org));
    internal.post('/orgs/delete', orgs_controller.wrap(orgs_controller.delete_org));
    // Member-facing org writes: BFF-only. Reads are Core /v1 only.
    internal.post('/orgs/update', orgs_controller.wrap(orgs_controller.update));
    internal.post('/orgs/remove_member', orgs_controller.wrap(orgs_controller.remove_member));
    internal.post('/orgs/get_role', orgs_controller.wrap(orgs_controller.get_role));
    internal.post('/orgs/create_role', orgs_controller.wrap(orgs_controller.create_role));
    internal.post('/orgs/update_role', orgs_controller.wrap(orgs_controller.update_role));
    internal.post('/orgs/delete_role', orgs_controller.wrap(orgs_controller.delete_role));
    internal.post('/orgs/leave', orgs_controller.wrap(orgs_controller.leave));
    internal.post('/orgs/new_scope', orgs_controller.wrap(orgs_controller.new_scope));
    internal.post('/orgs/update_scope', orgs_controller.wrap(orgs_controller.update_scope));
    internal.post('/orgs/delete_scope', orgs_controller.wrap(orgs_controller.delete_scope));
    internal.post('/orgs/assign_scope_member', orgs_controller.wrap(orgs_controller.assign_scope_member));
    internal.post('/orgs/unassign_scope_member', orgs_controller.wrap(orgs_controller.unassign_scope_member));
    // Console rollups — Core only on /internal (not public Hub).
    const dashboard = new DashboardController();
    internal.post('/dashboard/summary', dashboard.wrap(dashboard.summary));
    internal.post('/dashboard/realms', dashboard.wrap(dashboard.realms_summary));
    internal.post('/reports/audit', reports_controller.wrap(reports_controller.audit));
    return internal;
}
