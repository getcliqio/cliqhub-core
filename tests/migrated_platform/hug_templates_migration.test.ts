/**
 * `migrate_hug_templates` (PLAN-hug-templates §8): a database with the pre-template `hugs` columns is
 * converted once — open Hugs cancelled (with an event for catch-up), every Hug `form@1` with its old
 * fields in `params`, a response's `comment` moved into its values, the old columns dropped. A
 * converted database is left alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { migrate_hug_templates, migrate_hug_widgets } from '../../src/models/migrations/control_plane_schema_migrations.js';
import { get_sequelize } from '../../src/db/sequelize.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('Hug templates migration', () => {
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

    /** Put the pre-template columns back, as an older database has them. */
    async function old_schema(): Promise<void> {
        await q(`ALTER TABLE cliq."hugs" ADD COLUMN IF NOT EXISTS "prompt" TEXT, ADD COLUMN IF NOT EXISTS "context" JSONB NOT NULL DEFAULT '[]'::jsonb,
                 ADD COLUMN IF NOT EXISTS "requested_inputs" JSONB, ADD COLUMN IF NOT EXISTS "ui" JSONB`);
        await q(`ALTER TABLE cliq."hugs" ADD COLUMN IF NOT EXISTS "template" TEXT, ADD COLUMN IF NOT EXISTS "template_version" INTEGER`);
        await q(`ALTER TABLE cliq."hug_responses" ADD COLUMN IF NOT EXISTS "comment" TEXT`);
    }

    async function old_hug(status: string): Promise<string> {
        const id = randomUUID();
        ids.push(id);
        await q(`INSERT INTO cliq."hugs" ("id", "run_id", "phase", "daemon_id", "realm_id", "org_id", "title", "prompt", "context",
                 "requested_inputs", "channels", "status", "expires_at", "last_seq", "template", "template_version", "params", "created_at")
                 VALUES (:id, 'run-mig', 'review', 'd-1', 'r-1', :org, 'Ship?', 'Approve the release', '[{"type":"markdown","text":"notes"}]'::jsonb,
                 '[{"name":"decision","type":"enum","choices":[{"value":"approve"}]}]'::jsonb, ARRAY['ops'], :status,
                 NOW() + interval '1 hour', 1, NULL, NULL, '{}'::jsonb, NOW())`, { id, org: randomUUID(), status });
        return id;
    }

    it('converts an old database once: open Hugs cancelled, form@1 with the old fields in params, comments into values', async () => {
        await old_schema();
        const open = await old_hug('open');
        const closed = await old_hug('closed');
        await q(`INSERT INTO cliq."hug_responses" ("id", "hug_id", "responder_user_id", "via_channels", "values", "comment", "seq", "created_at", "updated_at")
                 VALUES (:id, :hug, :user, ARRAY['ops'], '{"decision":"approve"}'::jsonb, 'LGTM', 1, NOW(), NOW())`, { id: randomUUID(), hug: closed, user: randomUUID() });

        await migrate_hug_templates(get_sequelize());

        const [hugs] = await q(`SELECT "id", "status", "template", "template_version", "params", "last_seq" FROM cliq."hugs" WHERE "id" IN (:ids) ORDER BY "id"`, { ids: [open, closed] }) as [Array<Record<string, unknown>>, unknown];
        const by = new Map(hugs.map((h) => [h['id'], h]));
        expect(by.get(open)).toMatchObject({ status: 'cancelled', template: 'form', template_version: 1, last_seq: 2 });
        expect(by.get(closed)).toMatchObject({
            status: 'closed', template: 'form', template_version: 1,
            params: { prompt: 'Approve the release', context: [{ type: 'markdown', text: 'notes' }], inputs: [{ name: 'decision', type: 'enum', choices: [{ value: 'approve' }] }] },
        });
        const [events] = await q(`SELECT "seq", "type" FROM cliq."hug_events" WHERE "hug_id" = :id`, { id: open }) as [Array<Record<string, unknown>>, unknown];
        expect(events).toEqual([{ seq: 2, type: 'cancelled' }]);
        const [responses] = await q(`SELECT "values" FROM cliq."hug_responses" WHERE "hug_id" = :id`, { id: closed }) as [Array<{ values: unknown }>, unknown];
        expect(responses[0]!.values).toEqual({ decision: 'approve', comment: 'LGTM' });

        const [cols] = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'cliq'
            AND ((table_name = 'hugs' AND column_name IN ('prompt', 'context', 'requested_inputs', 'ui')) OR (table_name = 'hug_responses' AND column_name = 'comment'))`);
        expect(cols).toEqual([]);
        const [nullable] = await q(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'hugs'
            AND column_name IN ('template', 'template_version') ORDER BY column_name`);
        expect(nullable).toEqual([{ column_name: 'template', is_nullable: 'NO' }, { column_name: 'template_version', is_nullable: 'NO' }]);

        // Converted: a second run changes nothing.
        await migrate_hug_templates(get_sequelize());
        const [again] = await q(`SELECT "last_seq" FROM cliq."hugs" WHERE "id" = :id`, { id: open }) as [Array<{ last_seq: number }>, unknown];
        expect(again[0]!.last_seq).toBe(2);

        // Then the switch to hugs (PLAN-hug-widgets §11.3): the envelope's columns, and the template columns gone.
        await migrate_hug_widgets(get_sequelize());
        const [after] = await q(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'hugs'
            AND column_name IN ('template', 'template_version', 'hug_name', 'hug_sha256', 'summary', 'files', 'attachments') ORDER BY column_name`);
        expect(after).toEqual([
            { column_name: 'attachments', is_nullable: 'NO' }, { column_name: 'files', is_nullable: 'NO' }, { column_name: 'hug_name', is_nullable: 'YES' },
            { column_name: 'hug_sha256', is_nullable: 'YES' }, { column_name: 'summary', is_nullable: 'YES' },
        ]);
    });
});
