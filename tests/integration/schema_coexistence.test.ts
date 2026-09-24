/**
 * A3: Hub `public` registry models and control-plane `cliq` store share one
 * DATABASE_URL without colliding table definitions.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Sequelize } from 'sequelize';

const DATABASE_URL =
    process.env.DATABASE_URL
    ?? 'postgresql://cliqhub:cliqhub@localhost:5432/cliqhub';

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

describe.skipIf(!ready)('schema coexistence (public + cliq)', () => {
    afterAll(async () => {
        const { close_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        const { close_sequelize } = await import('../../src/db/sequelize.js');
        await close_control_plane_store();
        await close_sequelize();
    });

    it('Hub sequelize (public) and control-plane store (cliq) work together', async () => {
        const { init_sequelize } = await import('../../src/db/sequelize.js');
        const { init_models } = await import('../../src/db/models/index.js');
        const {
            init_control_plane_store,
            get_control_plane_store,
            close_control_plane_store,
        } = await import('../../src/db/control_plane_store.js');

        await close_control_plane_store();

        const hub_sq = init_sequelize(DATABASE_URL);
        init_models(hub_sq);
        await hub_sq.authenticate();

        await init_control_plane_store(DATABASE_URL);
        const control = get_control_plane_store();

        // Distinct Sequelize instances, distinct schemas.
        expect(control.sequelize).not.toBe(hub_sq);

        await hub_sq.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = \'public\'');
        await control.sequelize.query('SELECT 1 FROM cliq.scopes WHERE slug = \'cliq\' LIMIT 1');
        await control.sequelize.query(
            'SELECT 1 FROM cliq.daemon_config WHERE daemon_id = \'__global__\' LIMIT 1',
        );

        // Control-plane Team/Scope must not be the Hub public.teams/scopes models.
        // Qualified names would throw if sync wrote into the wrong schema.
        await expect(
            control.sequelize.query('SELECT 1 FROM cliq.teams LIMIT 0'),
        ).resolves.toBeTruthy();
    }, 300_000);
});
