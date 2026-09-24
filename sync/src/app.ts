import express from 'express';
import helmet from 'helmet';

import type { SyncEnvConfig } from './config/env.js';
import type { Container } from './container.js';
import { error_handler } from './middleware/error_handler.js';
import { create_daemon_auth } from './middleware/daemon_auth.js';

export function create_app(container: Container): express.Express {
    const app = express();
    const { config } = container;

    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(express.json({ limit: '5mb' }));

    // Health + readiness probes — no auth required
    app.get('/healthz', container.health_controller.check);
    app.get('/healthz/ready', container.health_controller.ready);

    // Relay API — called by CliqHub backend (internal network, no auth)
    app.post('/v1/relay/:daemon_id/*path', container.relay_controller.relay);
    app.get('/v1/sync/commands/:command_id/status', container.relay_controller.get_command_status);

    // Daemon-facing API — authenticated by daemon token or JWT
    const daemon_auth = create_daemon_auth(config, container.pool);
    app.post('/v1/sync/poll', daemon_auth, container.poll_controller.poll);
    app.post('/v1/sync/register', daemon_auth, container.register_controller.register);
    app.post('/v1/sync/deregister', daemon_auth, container.register_controller.deregister);

    app.use(error_handler);

    return app;
}
