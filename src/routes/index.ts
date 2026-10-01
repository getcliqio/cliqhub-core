/**
 * Assemble and mount all Hub HTTP routes.
 *
 * Layout: routes → controllers → services → schemas (see .cursor/rules/backend-mvc-layers.mdc).
 *
 * Every router is mounted through `mount()` so the start-up check can match
 * each route with its line in `auth/route_policy/table.ts`.
 */

import { Router, type Application } from 'express';

import type { Container } from '../container.js';
import { create_internal_router } from './internal.js';
import { create_a2a_router } from './a2a.js';
import { core_api_error_handler } from '../middleware/control_plane_error_handler.js';
import { bootstrap_mesh_adapters } from '../mesh/bootstrap.js';
import { mount } from '../auth/route_policy/registry.js';

import { register_public_v1_routes } from './v1/health_integrations.js';
import { register_system_routes } from './v1/system.js';
import { register_daemons_routes } from './v1/daemons.js';
import { register_realms_routes } from './v1/realms.js';
import { register_mesh_routes } from './v1/mesh.js';
import { register_teams_routes } from './v1/teams.js';
import { register_users_routes } from './v1/users.js';
import { register_auth_routes, register_dispatch_key_routes } from './v1/auth.js';
import { register_orgs_routes } from './v1/orgs.js';
import { register_invitations_routes } from './v1/invitations.js';
import { register_control_scopes_routes } from './v1/scopes.js';
import { register_events_routes } from './v1/events.js';
import { register_reviews_routes } from './v1/reviews.js';
import { register_agents_routes } from './v1/agents.js';
import { register_workspaces_routes } from './v1/workspaces.js';
import { register_runs_routes } from './v1/runs.js';
import { register_settings_routes } from './v1/settings.js';
import { register_notification_channels_routes } from './v1/notification_channels.js';
import { register_notifications_routes } from './v1/notifications.js';
import { register_artifacts_routes } from './v1/artifacts.js';

function mount_v1_json_404(router: Router): void {
    // `route_not_found` (not `not_found`) so clients can tell "this Core has no
    // such route" — usually a client newer than Core — from "no such record".
    router.use((req, res) => {
        const path = (req.originalUrl || req.url).split('?')[0];
        res.status(404).json({
            ok: false,
            error: { code: 'route_not_found', message: `Unknown API route: ${req.method} ${path}` },
        });
    });
    router.use(core_api_error_handler);
}

/** Authenticated control-plane resources (no product DI catalog controllers). */
function register_control_resources(router: Router): void {
    register_system_routes(router);
    register_daemons_routes(router);
    register_realms_routes(router);
    register_mesh_routes(router);
    register_dispatch_key_routes(router);
    register_control_scopes_routes(router);
    register_events_routes(router);
    register_reviews_routes(router);
    register_notification_channels_routes(router);
    register_notifications_routes(router);
    register_agents_routes(router);
    register_workspaces_routes(router);
    register_runs_routes(router);
    register_settings_routes(router);
    register_artifacts_routes(router);
}

/**
 * Control-plane + public `/v1` + `/a2a` for lightweight test apps that mount
 * product routes themselves.
 */
export function register_control_plane_routes(app: Application): void {
    bootstrap_mesh_adapters();

    mount(app, '/a2a', create_a2a_router());

    const pub = Router();
    register_public_v1_routes(pub);
    pub.use(core_api_error_handler);
    mount(app, '/v1', pub);
    const router = Router();
    register_control_resources(router);
    mount_v1_json_404(router);
    mount(app, '/v1', router);
}

/** Full Hub surface: internal + product `/v1` + control plane. */
export function register_routes(app: Application, container: Container): void {
    bootstrap_mesh_adapters();

    mount(app, '/internal', create_internal_router(container));
    mount(app, '/a2a', create_a2a_router());

    const pub = Router();
    register_public_v1_routes(pub);
    pub.use(core_api_error_handler);
    mount(app, '/v1', pub);
    const router = Router();

    register_system_routes(router);
    register_daemons_routes(router);
    register_realms_routes(router);
    register_mesh_routes(router);
    register_teams_routes(router, container);
    register_users_routes(router, container);
    register_auth_routes(router, container);
    register_orgs_routes(router, container);
    register_invitations_routes(router, container);
    register_events_routes(router);
    register_reviews_routes(router);
    register_agents_routes(router);
    register_workspaces_routes(router);
    register_runs_routes(router);
    register_settings_routes(router);
    register_notification_channels_routes(router);
    register_notifications_routes(router);
    register_artifacts_routes(router);

    mount_v1_json_404(router);
    mount(app, '/v1', router);
}
