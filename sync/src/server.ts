import { load_env } from './config/env.js';
import { create_container } from './container.js';
import { create_app } from './app.js';

async function main() {
    const config = load_env();
    const container = await create_container(config);
    const app = create_app(container);

    const server = app.listen(config.port, '::', () => {
        console.log(`[Sync] Listening on [::]:${config.port}`);
        console.log(`[Sync] Env: ${config.node_env}`);
    });

    const shutdown = async () => {
        console.log('[Sync] Shutting down...');

        // Stop accepting new connections
        server.close();

        // Stop background jobs
        container.liveness_sweep.stop();

        // Reject all in-flight waiters and release held polls so clients get a response
        container.poll_hold_service.reject_all_waiters(
            new Error('Sync service shutting down'),
        );
        container.poll_hold_service.release_all_polls();

        // Close external connections
        await container.notify_service.close();
        await container.pool.end();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[Sync] Failed to start:', err);
    process.exit(1);
});
