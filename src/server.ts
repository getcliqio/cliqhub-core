import { load_env } from './config/env.js';
import { get_logger } from './lib/log.js';
import { create_container } from './container.js';
import { create_app } from './app.js';
import { close_sequelize } from './db/sequelize.js';
import {
    close_control_plane_store,
    init_control_plane_store,
} from './db/control_plane_store.js';
import { start_run_reaper, stop_run_reaper } from './services/run_reaper.service.js';
import { start_dedup_gc, stop_dedup_gc } from './middleware/inbound_dedup.js';
import { start_command_outbox_worker, stop_command_outbox_worker } from './services/command_outbox.service.js';
import {
    start_webhook_delivery_retention,
    stop_webhook_delivery_retention,
} from './services/webhook_delivery.service.js';
import {
    start_review_expiry_sweep,
    stop_review_expiry_sweep,
} from './services/review_expiry_sweep.service.js';
const log = get_logger('server');

async function main() {
    const config = load_env();

    // Control-plane schema (`cliq`) must be ready before the HTTP server
    // accepts traffic — later slices mount /v1 control routes on this store.
    await init_control_plane_store(config.database_url);

    const container = await create_container(config);

    // Seed built-in data (agents, teams, settings) after both the
    // control-plane (`cliq`) and Hub (`public`) models are initialised.
    const { seed_all } = await import('./lib/seed.js');
    await seed_all();

    const app = create_app(container);

    start_run_reaper();
    start_dedup_gc();
    start_command_outbox_worker();
    start_webhook_delivery_retention();
    start_review_expiry_sweep();

    // Bind explicitly to '::' so the backend is reachable on Railway's
    // IPv6-only private network. Node's default behavior is system-dependent.
    const server = app.listen(config.port, '::', () => {
        log.info('listening', { port: config.port, host: '::', env: config.node_env });
    });

    const shutdown = async () => {
        log.info('shutting_down', {});
        stop_run_reaper();
        stop_dedup_gc();
        stop_command_outbox_worker();
        stop_webhook_delivery_retention();
        stop_review_expiry_sweep();
        server.close();
        await close_control_plane_store();
        await close_sequelize();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    log.fatal('startup_failed', {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
    process.exit(1);
});
