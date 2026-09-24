/**
 * BFF-only internal plane — not on public ingress.
 * Mounted at `/internal`.
 */

import { Router, type RequestHandler } from 'express';
import type { Container } from '../container.js';
import { require_internal, require_internal_network } from '../middleware/internal_only.js';
import { require_auth as require_core_auth } from '../middleware/core_auth.js';
import { DashboardController } from '../controllers/dashboard_controller.js';

export function create_internal_router(container: Container): Router {
    const {
        auth_controller,
        users_controller,
        orgs_controller,
        scopes_controller,
        reports_controller,
    } = container;

    const internal = Router();

    internal.post('/auth/authenticate_user', require_internal_network, auth_controller.authenticate_user);
    internal.post('/auth/issue_session_token', require_internal, auth_controller.issue_session_token);
    internal.post('/auth/revoke_session_token', require_internal_network, auth_controller.revoke_session_token);
    internal.post('/auth/signup', require_internal_network, auth_controller.signup);
    internal.post('/users/new', require_internal, users_controller.new_user);
    internal.post('/users/delete', require_internal, users_controller.delete_user);
    internal.post('/users/suspend', require_internal, users_controller.suspend);
    internal.post('/users/unsuspend', require_internal, users_controller.unsuspend);
    internal.post('/users/reset_password', require_internal, users_controller.reset_password);
    // Self-serve password change: BFF-only (internal token + caller Bearer).
    internal.post('/users/change_password', require_internal_network, users_controller.change_password);
    internal.post('/users/set_role', require_internal, users_controller.set_role);
    internal.post('/users/update_role', require_internal_network, users_controller.update_role);
    internal.post('/orgs/new', require_internal, orgs_controller.new_org);
    internal.post('/orgs/delete', require_internal, orgs_controller.delete_org);
    // Member-facing org writes: BFF-only. Reads are Core /v1 only.
    internal.post('/orgs/update', require_internal_network, orgs_controller.update);
    internal.post('/orgs/add_member', require_internal_network, orgs_controller.add_member);
    internal.post('/orgs/remove_member', require_internal_network, orgs_controller.remove_member);
    internal.post('/orgs/get_role', require_internal_network, orgs_controller.get_role);
    internal.post('/orgs/create_role', require_internal_network, orgs_controller.create_role);
    internal.post('/orgs/update_role', require_internal_network, orgs_controller.update_role);
    internal.post('/orgs/delete_role', require_internal_network, orgs_controller.delete_role);
    internal.post('/orgs/leave', require_internal_network, orgs_controller.leave);
    internal.post('/orgs/new_scope', require_internal_network, orgs_controller.new_scope);
    internal.post('/orgs/delete_scope', require_internal_network, orgs_controller.delete_scope);
    internal.post('/orgs/assign_scope_member', require_internal_network, orgs_controller.assign_scope_member);
    internal.post('/orgs/unassign_scope_member', require_internal_network, orgs_controller.unassign_scope_member);
    // Console rollups — Core only on /internal (not public Hub).
    internal.post('/dashboard/summary', require_internal_network, require_core_auth, DashboardController.summary as RequestHandler);
    internal.post('/dashboard/realms', require_internal_network, require_core_auth, DashboardController.realms_summary as RequestHandler);
    internal.post('/reports/audit', require_internal_network, reports_controller.audit);
    // Legacy internal aliases (BFF may still call these during rollout).
    internal.post('/scopes/new', require_internal, scopes_controller.new_scope);
    internal.post('/scopes/delete', require_internal, scopes_controller.delete_scope);

    return internal;
}
