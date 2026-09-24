/**
 * Assemble and mount all Hub HTTP routes.
 *
 * Layout: routes → controllers → services → schemas (see .cursor/rules/backend-mvc-layers.mdc).
 */

import { Router, type Application, type RequestHandler } from 'express';

import type { Container } from '../container.js';
import { create_internal_router } from './internal.js';
import { create_a2a_router } from './a2a.js';
import { require_auth } from '../middleware/core_auth.js';
import { core_api_error_handler } from '../middleware/control_plane_error_handler.js';
import { bootstrap_mesh_adapters } from '../mesh/bootstrap.js';

import { register_public_v1_routes } from './v1/health_integrations.js';
import { register_system_routes } from './v1/system.js';
import { register_daemons_routes } from './v1/daemons.js';
import { register_realms_routes } from './v1/realms.js';
import { register_teams_routes, register_teams_install_routes } from './v1/teams.js';
import { register_users_routes } from './v1/users.js';
import { register_auth_routes, register_dispatch_key_routes } from './v1/auth.js';
import { register_orgs_routes } from './v1/orgs.js';
import { register_invitations_routes } from './v1/invitations.js';
import { register_scopes_routes, register_control_scopes_routes } from './v1/scopes.js';
import { register_events_routes } from './v1/events.js';
import { register_reviews_routes } from './v1/reviews.js';
import { register_agents_routes } from './v1/agents.js';
import { register_workspaces_routes } from './v1/workspaces.js';
import { register_runs_routes } from './v1/runs.js';
import { register_settings_routes } from './v1/settings.js';
import { register_notification_channels_routes } from './v1/notification_channels.js';
import { register_notifications_routes } from './v1/notifications.js';

function mount_v1_json_404(router: Router): void {
    router.use((_req, res) => {
        res.status(404).json({
            ok: false,
            error: { code: 'not_found', message: 'Unknown API route' },
        });
    });
    router.use(core_api_error_handler);
}

/** Authenticated control-plane resources (no product DI catalog controllers). */
function register_control_resources(router: Router, auth: RequestHandler): void {
    register_system_routes(router, auth);
    register_daemons_routes(router, auth);
    register_realms_routes(router, auth);
    register_teams_install_routes(router, auth);
    register_dispatch_key_routes(router, auth);
    register_control_scopes_routes(router, auth);
    register_events_routes(router, auth);
    register_reviews_routes(router, auth);
    register_notification_channels_routes(router, auth);
    register_notifications_routes(router, auth);
    register_agents_routes(router, auth);
    register_workspaces_routes(router, auth);
    register_runs_routes(router, auth);
    register_settings_routes(router, auth);
}

/**
 * Control-plane + public `/v1` + `/a2a` for lightweight test apps that mount
 * product routes themselves.
 */
export function register_control_plane_routes(app: Application): void {
    bootstrap_mesh_adapters();

    app.use('/a2a', create_a2a_router());

    const pub = Router();
    register_public_v1_routes(pub);
    pub.use(core_api_error_handler);
    app.use('/v1', pub);

    const auth = require_auth;
    const router = Router();
    register_control_resources(router, auth);
    mount_v1_json_404(router);
    app.use('/v1', router);
}

/** Full Hub surface: internal + product `/v1` + control plane. */
export function register_routes(app: Application, container: Container): void {
    bootstrap_mesh_adapters();

    app.use('/internal', create_internal_router(container));
    app.use('/a2a', create_a2a_router());

    const pub = Router();
    register_public_v1_routes(pub);
    pub.use(core_api_error_handler);
    app.use('/v1', pub);

    const auth = require_auth;
    const router = Router();

    register_system_routes(router, auth);
    register_daemons_routes(router, auth);
    register_realms_routes(router, auth);
    register_teams_routes(router, auth, container);
    register_users_routes(router, container);
    register_auth_routes(router, auth, container);
    register_orgs_routes(router, container, auth);
    register_invitations_routes(router, container);
    register_scopes_routes(router, auth, container);
    register_events_routes(router, auth);
    register_reviews_routes(router, auth);
    register_agents_routes(router, auth);
    register_workspaces_routes(router, auth);
    register_runs_routes(router, auth);
    register_settings_routes(router, auth);
    register_notification_channels_routes(router, auth);
    register_notifications_routes(router, auth);

    mount_v1_json_404(router);
    app.use('/v1', router);
}
