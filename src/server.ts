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
    start_hug_sweep,
    stop_hug_sweep,
} from './services/hug_expiry_sweep.service.js';
import { start_invite_sweep, stop_invite_sweep } from './services/invite_sweep.service.js';
import { settle_background } from './lib/background.js';
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

    // One time: version zips move to id keys (PLAN-team-bundle S1.2). Not fatal: until it has run,
    // versions still download from their old keys.
    const { migrate_team_zips_by_id } = await import('./models/migrations/migrate_team_zips_by_id.js');
    await migrate_team_zips_by_id({ storage: container.storage, versions: container.version_repo, settings: container.settings_repo })
        .catch((err: unknown) => log.error('team_zips_by_id_failed', { error: err instanceof Error ? err.message : String(err), note: 'old keys still serve downloads' }));

    // Every startup: published versions without team_files rows get them, from their zip or their columns
    // (PLAN-team-bundle S1.4a; built-in versions the seed just added included). Not fatal: one failing is
    // logged and tried again on the next start.
    const { backfill_team_files } = await import('./models/migrations/backfill_team_files.js');
    const { TeamFileRepository } = await import('./repositories/team_file_repository.js');
    await backfill_team_files({ storage: container.storage, versions: container.version_repo, files: new TeamFileRepository() })
        .catch((err: unknown) => log.error('team_files_backfill_failed', { error: err instanceof Error ? err.message : String(err) }));

    const app = create_app(container);

    start_run_reaper();
    start_dedup_gc();
    start_command_outbox_worker();
    start_webhook_delivery_retention();
    start_hug_sweep();
    start_invite_sweep();

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
        stop_hug_sweep();
        stop_invite_sweep();
        server.close();
        await settle_background();
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
