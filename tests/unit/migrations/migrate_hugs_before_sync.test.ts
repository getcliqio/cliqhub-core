/**
 * migrate_hugs_before_sync — the Hug schema startup needs before `sequelize.sync()`: an older
 * database's `in_app_notifications.review_id` is renamed (sync would otherwise index a missing
 * `hug_id` and boot would fail), and the Hug tables are created from their SQL, with their cascading
 * foreign keys and the one-response-per-person rule, before sync could create them from the models.
 */
import { describe, expect, it } from 'vitest';
import type { Sequelize } from 'sequelize';

import { migrate_hugs_before_sync } from '../../../src/models/migrations/control_plane_schema_migrations.js';

/** A fake connection recording its statements; `columns` is what in_app_notifications has. */
function fake(columns: string[], dialect = 'postgres') {
    const sql: string[] = [];
    const sq = {
        getDialect: () => dialect,
        query: async (q: string) => {
            sql.push(q.replace(/\s+/g, ' ').trim());
            return q.includes('information_schema.columns') ? [columns.map((column_name) => ({ column_name })), null] : [[], null];
        },
    } as unknown as Sequelize;
    return { sq, sql };
}

describe('migrate_hugs_before_sync', () => {
    it('an older database: review_id becomes hug_id (its old indexes go), then the Hug tables are created', async () => {
        const { sq, sql } = fake(['review_id']);
        await migrate_hugs_before_sync(sq);
        const rename = sql.findIndex((q) => q.includes('RENAME COLUMN "review_id" TO "hug_id"'));
        const tables = sql.findIndex((q) => q.includes('CREATE TABLE IF NOT EXISTS cliq."hugs"'));
        expect(rename).toBeGreaterThan(-1);
        expect(tables).toBeGreaterThan(rename);
        expect(sql).toContain('DROP INDEX IF EXISTS cliq."in_app_notifications_review_id"');
    });

    it('an up-to-date database: nothing is renamed; the tables are only ensured', async () => {
        const { sq, sql } = fake(['hug_id']);
        await migrate_hugs_before_sync(sq);
        expect(sql.some((q) => q.includes('RENAME COLUMN'))).toBe(false);
        expect(sql.filter((q) => q.startsWith('CREATE TABLE IF NOT EXISTS cliq."hug'))).toHaveLength(4);
    });

    it('the Hug tables carry their constraints (sync from the models would not)', async () => {
        const { sq, sql } = fake([]);
        await migrate_hugs_before_sync(sq);
        const table = (name: string) => sql.find((q) => q.startsWith(`CREATE TABLE IF NOT EXISTS cliq."${name}"`)) ?? '';
        for (const child of ['hug_deliveries', 'hug_responses', 'hug_events']) {
            expect(table(child)).toContain('REFERENCES cliq."hugs"("id") ON DELETE CASCADE');
        }
        expect(table('hug_responses')).toContain('UNIQUE ("hug_id", "responder_user_id")');
        expect(table('hug_events')).toContain('PRIMARY KEY ("hug_id", "seq")');
    });

    it('does nothing on a non-Postgres store', async () => {
        const { sq, sql } = fake([], 'sqlite');
        await migrate_hugs_before_sync(sq);
        expect(sql).toEqual([]);
    });
});
