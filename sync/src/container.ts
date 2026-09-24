import pg from 'pg';

import type { SyncEnvConfig } from './config/env.js';
import { create_pool } from './db/pool.js';
import { run_migrations } from './db/migrations.js';
import { NotifyService } from './services/notify.service.js';
import { PollHoldService } from './services/poll_hold.service.js';
import { LivenessSweep } from './services/liveness_sweep.js';
import { HealthController } from './controllers/health.controller.js';
import { RelayController } from './controllers/relay.controller.js';
import { PollController } from './controllers/poll.controller.js';
import { RegisterController } from './controllers/register.controller.js';

export interface Container {
    config: SyncEnvConfig;
    pool: pg.Pool;
    notify_service: NotifyService;
    poll_hold_service: PollHoldService;
    liveness_sweep: LivenessSweep;
    health_controller: HealthController;
    relay_controller: RelayController;
    poll_controller: PollController;
    register_controller: RegisterController;
}

export async function create_container(config: SyncEnvConfig): Promise<Container> {
    const pool = create_pool(config.database_url);

    // Run schema migrations before accepting traffic
    await run_migrations(pool);

    // Set up PG NOTIFY listener for cross-instance coordination
    const notify_service = new NotifyService(config);
    await notify_service.connect();

    const poll_hold_service = new PollHoldService(config, pool, notify_service);
    const liveness_sweep = new LivenessSweep(config, pool, poll_hold_service);
    liveness_sweep.start();

    const health_controller = new HealthController(pool, notify_service);
    const relay_controller = new RelayController(config, pool, poll_hold_service);
    const poll_controller = new PollController(config, pool, poll_hold_service);
    const register_controller = new RegisterController(config, pool, poll_hold_service);

    return {
        config,
        pool,
        notify_service,
        poll_hold_service,
        liveness_sweep,
        health_controller,
        relay_controller,
        poll_controller,
        register_controller,
    };
}
