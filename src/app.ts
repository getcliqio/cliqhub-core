import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import type { Container } from './container.js';
import { register_routes } from './routes/index.js';
import { error_handler } from './middleware/error_handler.js';
import { bind_caller_to_log_context, request_logging_middleware } from './middleware/request_logging.js';
import { create_auth_middleware } from './middleware/auth_middleware.js';
import {
    check_route_policies,
    create_route_policy_middleware,
} from './middleware/enforce_route_policy.js';
import { list_routes } from './auth/route_policy/registry.js';
import { SequelizeAccessStore } from './auth/route_policy/store.js';
import type { AccessStore } from './auth/route_policy/engine.js';
import { get_logger } from './lib/log.js';

const log = get_logger('app');

export interface CreateAppOptions {
    /** Test seam for the route policy engine's data access. */
    access_store?: AccessStore;
}

/**
 * Thin app shell: middleware + route registration.
 * HTTP wiring lives under `src/routes/` (per-resource files).
 */
export function create_app(container: Container, opts: CreateAppOptions = {}): express.Express {
    const app = express();

    app.use(helmet({ contentSecurityPolicy: false }));

    if (container.config.allowed_origins.length > 0) {
        app.use(cors({
            origin: container.config.allowed_origins,
            credentials: true,
        }));
    }

    app.use(express.json({ limit: '15mb' }));
    app.use(request_logging_middleware);

    app.use(create_auth_middleware({
        user_repo: container.user_repo,
        token_repo: container.token_repo,
        scope_repo: container.scope_repo,
        org_member_repo: container.org_member_repo,
    }));
    app.use(bind_caller_to_log_context);
    // One policy per route (auth/route_policy/table.ts), applied here for every request.
    // Also decides which routes daemon tokens may call (replaces the old path allowlist).
    app.use(create_route_policy_middleware({ store: opts.access_store ?? new SequelizeAccessStore() }));

    register_routes(app, container);

    // Start-up check: a route without a policy must never be served.
    const routes = list_routes(app);
    const { missing, stale } = check_route_policies(routes);
    if (missing.length > 0) {
        log.fatal('route_without_policy', { missing });
        throw new Error(`Routes without a policy in auth/route_policy/table.ts: ${missing.join(', ')}`);
    }
    if (stale.length > 0) log.warn('policy_without_route', { stale });
    if (process.env.ROUTE_POLICY_MODE) log.warn('route_policy_mode_ignored', { value: process.env.ROUTE_POLICY_MODE, note: 'the route policy is always enforced' });
    log.info('route_policy_ready', { routes: routes.length });

    app.use(error_handler);

    return app;
}
