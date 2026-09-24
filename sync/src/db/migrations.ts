import type pg from 'pg';

/**
 * Idempotent schema migrations for sync service tables.
 * Runs on every boot — uses IF NOT EXISTS / IF EXISTS guards.
 */
export async function run_migrations(pool: pg.Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Ensure the cliq schema exists (shared with backend control-plane)
        await client.query(`CREATE SCHEMA IF NOT EXISTS cliq`);

        // Command queue: holds commands from the relay waiting for daemon pickup
        await client.query(`
            CREATE TABLE IF NOT EXISTS cliq.sync_command_queue (
                id              TEXT PRIMARY KEY,
                daemon_id       TEXT NOT NULL,
                method          TEXT NOT NULL,
                path            TEXT NOT NULL,
                headers         JSONB,
                body            JSONB,
                created_at      BIGINT NOT NULL,
                expires_at      BIGINT NOT NULL,
                delivered_at    BIGINT,
                status          TEXT NOT NULL DEFAULT 'pending'
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_scq_daemon_status
            ON cliq.sync_command_queue (daemon_id, status)
            WHERE status = 'pending'
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_scq_expires
            ON cliq.sync_command_queue (expires_at)
            WHERE status IN ('pending', 'delivered')
        `);

        // Command responses: daemon delivers results here
        await client.query(`
            CREATE TABLE IF NOT EXISTS cliq.sync_command_responses (
                command_id      TEXT PRIMARY KEY,
                status_code     INT NOT NULL,
                headers         JSONB,
                body            JSONB,
                received_at     BIGINT NOT NULL
            )
        `);

        // Redelivery tracking
        await client.query(`
            ALTER TABLE cliq.sync_command_queue
                ADD COLUMN IF NOT EXISTS delivery_count INT NOT NULL DEFAULT 0
        `);
        await client.query(`
            ALTER TABLE cliq.sync_command_queue
                ADD COLUMN IF NOT EXISTS max_deliveries INT NOT NULL DEFAULT 3
        `);

        // Backend idempotency key for deduplication on relay retries
        await client.query(`
            ALTER TABLE cliq.sync_command_queue
                ADD COLUMN IF NOT EXISTS idempotency_key TEXT
        `);
        // tx_id must be unique globally — same control message must not
        // execute on a second daemon under the same tx_id.
        await client.query(`
            DROP INDEX IF EXISTS idx_sync_cmd_idempotency
        `);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_cmd_tx_id
            ON cliq.sync_command_queue (idempotency_key)
            WHERE idempotency_key IS NOT NULL
        `);

        // Drop legacy tables that are no longer needed
        await client.query(`DROP TABLE IF EXISTS cliq.dispatch_requests`);
        await client.query(`DROP TABLE IF EXISTS cliq.dispatch_request_history`);
        await client.query(`DROP TABLE IF EXISTS cliq.bundles`);
        await client.query(`DROP TABLE IF EXISTS cliq.sync_outbox`);
        await client.query(`DROP TABLE IF EXISTS cliq.sync_cursor`);
        await client.query(`DROP TABLE IF EXISTS cliq.realm_tokens`);

        await client.query('COMMIT');
        console.log('[Sync] Schema migrations complete');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
