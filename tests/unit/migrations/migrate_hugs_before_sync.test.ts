/**
 * migrate_hugs_before_sync — the Hug schema startup needs before `sequelize.sync()`: the Hug tables are created from
 * their SQL, with their cascading foreign keys and getHugs' required ids, before sync could create them from the models.
 */
import { describe, expect, it } from 'vitest';
import type { Sequelize } from 'sequelize';

import { migrate_hugs_before_sync } from '../../../src/models/migrations/control_plane_schema_migrations.js';

/** A fake connection recording its statements. */
function fake(dialect = 'postgres') {
    const sql: string[] = [];
    const sq = {
        getDialect: () => dialect,
        query: async (q: string) => {
            sql.push(q.replace(/\s+/g, ' ').trim());
            return [[], null];
        },
    } as unknown as Sequelize;
    return { sq, sql };
}

describe('migrate_hugs_before_sync', () => {
    it('ensures hugs, hug_events and hug_bundles — nothing else (PLAN-gethugs-step8-cutover.md)', async () => {
        const { sq, sql } = fake();
        await migrate_hugs_before_sync(sq);
        expect(sql.filter((q) => q.startsWith('CREATE TABLE IF NOT EXISTS cliq."hug')).map((q) => q.match(/cliq\."([a-z_]+)"/)![1]))
            .toEqual(['hugs', 'hug_events', 'hug_bundles']);
        expect(sql.some((q) => q.includes('RENAME COLUMN'))).toBe(false);
    });

    it('the Hug tables carry their constraints (sync from the models would not)', async () => {
        const { sq, sql } = fake();
        await migrate_hugs_before_sync(sq);
        const table = (name: string) => sql.find((q) => q.startsWith(`CREATE TABLE IF NOT EXISTS cliq."${name}"`)) ?? '';
        expect(table('hug_events')).toContain('REFERENCES cliq."hugs"("id") ON DELETE CASCADE');
        expect(table('hug_events')).toContain('PRIMARY KEY ("hug_id", "seq")');
        expect(table('hugs')).toContain('"gethugs_id" TEXT NOT NULL');
        expect(table('hugs')).toContain('"gethugs_workspace_id" TEXT NOT NULL');
    });

    it('does nothing on a non-Postgres store', async () => {
        const { sq, sql } = fake('sqlite');
        await migrate_hugs_before_sync(sq);
        expect(sql).toEqual([]);
    });
});
