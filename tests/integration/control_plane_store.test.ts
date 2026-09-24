/**
 * Live Postgres: schema `cliq` is created and store tables sync on init.
 *
 * Requires DATABASE_URL (defaults to local docker-compose credentials).
 * Skips when Postgres is unreachable so unit CI stays green offline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Sequelize } from 'sequelize';

const DATABASE_URL =
    process.env.DATABASE_URL
    ?? 'postgresql://cliqhub:cliqhub@localhost:5432/cliqhub';

/** Local Hub DBs re-run full schema migrations on every init (~2–3 min). */
const INIT_TIMEOUT_MS = 300_000;

async function postgres_reachable(): Promise<boolean> {
    const probe = new Sequelize(DATABASE_URL, {
        dialect: 'postgres',
        logging: false,
    });
    try {
        await probe.authenticate();
        await probe.close();
        return true;
    } catch {
        try { await probe.close(); } catch { /* ignore */ }
        return false;
    }
}

const ready = await postgres_reachable();

describe.skipIf(!ready)('control_plane_store (postgres)', () => {
    beforeAll(async () => {
        const { close_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        await close_control_plane_store();
    });

    afterAll(async () => {
        const { close_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        await close_control_plane_store();
    });

    it('creates schema cliq and store tables on init', async () => {
        const { init_control_plane_store, get_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );

        await init_control_plane_store(DATABASE_URL);
        const { sequelize } = get_control_plane_store();

        const [schema_rows] = await sequelize.query(
            `SELECT 1 AS ok FROM information_schema.schemata WHERE schema_name = 'cliq'`,
        );
        expect(schema_rows.length).toBeGreaterThan(0);

        // Qualified table names prove schema + sync landed (not search_path alone).
        await sequelize.query('SELECT 1 FROM cliq.daemons LIMIT 0');
        await sequelize.query('SELECT 1 FROM cliq.daemon_config LIMIT 0');
        await sequelize.query('SELECT 1 FROM cliq.scopes LIMIT 0');

        const [scope_rows] = await sequelize.query(
            `SELECT slug FROM cliq.scopes WHERE slug IN ('cliq', 'measureone')`,
        );
        expect(scope_rows.length).toBe(2);

        const [setting_rows] = await sequelize.query(
            `SELECT key FROM cliq.daemon_config
             WHERE daemon_id = '__global__' AND key = 'logging.level'`,
        );
        expect(setting_rows.length).toBe(1);
    }, INIT_TIMEOUT_MS);

    it('seed is idempotent — second boot inserts zero new seed rows', async () => {
        const { seed_control_plane } = await import(
            '../../src/db/control_plane_seed.js'
        );
        const { init_control_plane_store, close_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );

        await close_control_plane_store();
        await init_control_plane_store(DATABASE_URL);
        const again = await seed_control_plane();
        expect(again.scopes_inserted).toBe(0);
        expect(again.settings_inserted).toBe(0);
    }, INIT_TIMEOUT_MS);

    it('migrate is idempotent on a second init after close', async () => {
        const mod = await import('../../src/db/control_plane_store.js');
        await mod.close_control_plane_store();
        await mod.init_control_plane_store(DATABASE_URL);
        await mod.close_control_plane_store();
        await mod.init_control_plane_store(DATABASE_URL);

        const { sequelize } = mod.get_control_plane_store();
        await sequelize.query('SELECT 1 FROM cliq.daemons LIMIT 0');
    }, INIT_TIMEOUT_MS);

    it('coexists with public schema (Hub registry tables)', async () => {
        const mod = await import('../../src/db/control_plane_store.js');
        await mod.close_control_plane_store();
        await mod.init_control_plane_store(DATABASE_URL);

        const hub = new Sequelize(DATABASE_URL, {
            dialect: 'postgres',
            logging: false,
        });

        try {
            // public.users may already exist from Hub bootstrap; querying the
            // schema list must not conflict with control-plane schema cliq.
            await hub.query(
                `SELECT table_name FROM information_schema.tables
                 WHERE table_schema = 'public' LIMIT 1`,
            );
            await mod.get_control_plane_store().sequelize.query(
                'SELECT 1 FROM cliq.daemon_config LIMIT 0',
            );
        } finally {
            await hub.close();
        }
    }, INIT_TIMEOUT_MS);
});
