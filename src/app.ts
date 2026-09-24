import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import type { Container } from './container.js';
import { register_routes } from './routes/index.js';
import { error_handler } from './middleware/error_handler.js';
import { request_logging_middleware } from './middleware/request_logging.js';
import { create_auth_middleware } from './middleware/auth_middleware.js';
import { deny_daemon_token_outside_allowlist } from './middleware/daemon_token_gate.js';

/**
 * Thin app shell: middleware + route registration.
 * HTTP wiring lives under `src/routes/` (per-resource files).
 */
export function create_app(container: Container): express.Express {
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
    app.use(deny_daemon_token_outside_allowlist);

    register_routes(app, container);

    app.use(error_handler);

    return app;
}
