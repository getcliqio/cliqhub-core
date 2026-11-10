/**
 * The switch to hugs (PLAN-hug-widgets §11.3, Step 10): on a database whose `hugs` still has `template`, open Hugs
 * opened before hugs (no `hug_name`) are cancelled — each with a `cancelled` event for its daemon's catch-up — and
 * `template` / `template_version` are dropped. Closed pre-hug Hugs and Hugs opened with a hug are left alone. Once:
 * a second run changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { HUG_CUTOVER_REASON, migrate_hug_widgets } from '../../src/models/migrations/control_plane_schema_migrations.js';
import { get_sequelize } from '../../src/db/sequelize.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('Hug cut-over (Step 10)', () => {
    const ids: string[] = [];
    const q = (sql: string, replacements?: Record<string, unknown>) => get_sequelize().query(sql, replacements ? { replacements } : {});

    beforeAll(async () => {
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    afterAll(async () => {
        if (!has_postgres) return;
        if (ids.length) await q(`DELETE FROM cliq."hugs" WHERE "id" IN (:ids)`, { ids });
        await close_test_control_plane_store();
    });

    /** A Hug row; `hug_name` null for one opened before hugs. */
    async function a_hug(status: string, hug_name: string | null, last_seq = 2): Promise<string> {
        const id = randomUUID();
        ids.push(id);
        await q(`INSERT INTO cliq."hugs" ("id", "run_id", "phase", "daemon_id", "realm_id", "org_id", "title", "hug_name", "hug_sha256", "params", "channels",
                 "status", "expires_at", "next_remind_at", "last_seq", "created_at")
                 VALUES (:id, 'run-cut', 'review', 'd-1', 'r-1', :org, 'Ship?', :hug_name, :sha, '{"prompt":"ok?"}'::jsonb, ARRAY['ops'], :status,
                 NOW() + interval '1 hour', NOW() + interval '5 minutes', :last_seq, NOW())`,
        { id, org: randomUUID(), hug_name, sha: hug_name ? 'a'.repeat(64) : null, status, last_seq });
        return id;
    }

    it('cancels open pre-hug Hugs with an event, leaves the rest, drops the template columns; once', async () => {
        await q(`ALTER TABLE cliq."hugs" ADD COLUMN IF NOT EXISTS "template" TEXT, ADD COLUMN IF NOT EXISTS "template_version" INTEGER`);
        const open_old = await a_hug('open', null, 3);
        const closed_old = await a_hug('closed', null);
        const open_new = await a_hug('open', 'review-batch');

        await migrate_hug_widgets(get_sequelize());

        const [rows] = await q(`SELECT "id", "status", "outcome", "closed_at", "next_remind_at", "last_seq" FROM cliq."hugs" WHERE "id" IN (:ids)`, { ids: [open_old, closed_old, open_new] }) as [Array<Record<string, unknown>>, unknown];
        const by = new Map(rows.map((r) => [r['id'], r]));
        expect(by.get(open_old)).toMatchObject({ status: 'cancelled', outcome: `cancelled: ${HUG_CUTOVER_REASON}`, next_remind_at: null, last_seq: 4 });
        expect(by.get(open_old)!['closed_at']).not.toBeNull();
        expect(by.get(closed_old)).toMatchObject({ status: 'closed', outcome: null, last_seq: 2 });
        expect(by.get(open_new)).toMatchObject({ status: 'open', last_seq: 2 });
        const [events] = await q(`SELECT "hug_id", "seq", "type", "payload" FROM cliq."hug_events" WHERE "hug_id" IN (:ids) ORDER BY "hug_id"`, { ids: [open_old, closed_old, open_new] });
        expect(events).toEqual([{ hug_id: open_old, seq: 4, type: 'cancelled', payload: { reason: HUG_CUTOVER_REASON } }]);
        const [cols] = await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'hugs' AND column_name IN ('template', 'template_version')`);
        expect(cols).toEqual([]);

        // Once: a pre-hug-looking open Hug after the switch is not touched again.
        const later = await a_hug('open', null);
        await migrate_hug_widgets(get_sequelize());
        const [again] = await q(`SELECT "status" FROM cliq."hugs" WHERE "id" = :id`, { id: later }) as [Array<{ status: string }>, unknown];
        expect(again[0]!.status).toBe('open');
        await q(`DELETE FROM cliq."hug_events" WHERE "hug_id" IN (:ids)`, { ids });
    });
});
