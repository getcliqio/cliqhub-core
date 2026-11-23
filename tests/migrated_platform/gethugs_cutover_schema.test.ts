/**
 * PLAN-gethugs-step8-cutover.md sub-step 1: no per-org switch — `orgs.hugs_provider` and `gethugs_sync.state` are gone,
 * every org has a sync row (one from before the cut-over is due), and running the schema steps again changes nothing.
 * Also the step 3 Hug pointer columns and template map.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Org } from '../../src/models/index.js';
import { migrate_hub_schema } from '../../src/models/migrations/hub_schema_migrations.js';
import { migrate_hugs_gethugs } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const uid = () => `gh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('the getHugs cut-over schema', () => {
    const orgs: string[] = [];

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });

    afterAll(async () => {
        await Org.destroy({ where: { id: orgs } });
        await close_test_control_plane_store();
    });

    it('no switch columns; an org without a sync row gets one, due; running again changes nothing', async () => {
        const org = await Org.create({ slug: uid(), display_name: 'Cut-over' } as never);
        orgs.push(org.id);
        await migrate_hub_schema(get_sequelize());
        await migrate_hub_schema(get_sequelize());
        const [cols] = await get_sequelize().query(
            `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'cliq'
             AND ((table_name = 'orgs' AND column_name = 'hugs_provider') OR (table_name = 'gethugs_sync' AND column_name = 'state'))`,
        );
        expect(cols).toEqual([]);
        const [rows] = await get_sequelize().query('SELECT synced_at FROM cliq.gethugs_sync WHERE org_id = :id', { replacements: { id: org.id } });
        expect(rows).toEqual([{ synced_at: null }]);
    });

    it('step 3 schema: the Hug pointer columns and the template map, safe to run again', async () => {
        await migrate_hugs_gethugs(get_sequelize());
        await migrate_hugs_gethugs(get_sequelize());
        const [cols] = await get_sequelize().query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'hugs'
             AND column_name IN ('gethugs_id', 'gethugs_workspace_id') ORDER BY column_name`,
        );
        expect(cols).toEqual([{ column_name: 'gethugs_id' }, { column_name: 'gethugs_workspace_id' }]);
        const [tables] = await get_sequelize().query(`SELECT to_regclass('cliq.gethugs_templates') IS NOT NULL AS present`);
        expect(tables).toEqual([{ present: true }]);
    });
});
