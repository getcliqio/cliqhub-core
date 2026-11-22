/**
 * PLAN-gethugs-integration.md step 1: the per-org switch `orgs.hugs_provider` — every org is `cliqhub` until switched,
 * only `cliqhub` and `gethugs` are allowed, and running the schema steps again changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Org } from '../../src/models/index.js';
import { migrate_hub_schema } from '../../src/models/migrations/hub_schema_migrations.js';
import { hugs_provider_of } from '../../src/services/gethugs.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `gh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('the getHugs switch (orgs.hugs_provider)', () => {
    const orgs: string[] = [];

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });

    afterAll(async () => {
        await Org.destroy({ where: { id: orgs } });
        await close_test_control_plane_store();
    });

    it('a new org is on cliqhub; switching it to getHugs is seen; only the two providers are allowed', async () => {
        const org = await Org.create({ slug: uid(), display_name: 'Switch' } as never);
        orgs.push(org.id);
        expect((await Org.findByPk(org.id, { raw: true }))!.hugs_provider).toBe('cliqhub');
        expect(await hugs_provider_of(org.id)).toBe('cliqhub');

        await Org.update({ hugs_provider: 'gethugs' }, { where: { id: org.id } });
        expect(await hugs_provider_of(org.id)).toBe('gethugs');

        await expect(get_sequelize().query(`UPDATE cliq.orgs SET hugs_provider = 'other' WHERE id = :id`, { replacements: { id: org.id } })).rejects.toThrow(
            /orgs_hugs_provider_check/,
        );
        expect(await hugs_provider_of('00000000-0000-4000-8000-00000000dead')).toBe('cliqhub');
    });

    it('running the schema steps again keeps the column, its default and the switch', async () => {
        const org = await Org.create({ slug: uid(), display_name: 'Again', hugs_provider: 'gethugs' } as never);
        orgs.push(org.id);
        await migrate_hub_schema(get_sequelize());
        expect(await hugs_provider_of(org.id)).toBe('gethugs');
        const [rows] = await get_sequelize().query(
            `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'orgs' AND column_name = 'hugs_provider'`,
        );
        expect(rows).toEqual([{ column_default: "'cliqhub'::text", is_nullable: 'NO' }]);
    });
});
