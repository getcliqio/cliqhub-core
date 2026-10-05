import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { migrate_hub_schema } from '../../src/models/migrations/hub_schema_migrations.js';
import { run_core_api_schema_migrations } from '../../src/models/migrations/control_plane_schema_migrations.js';
import { RealmService } from '../../src/services/realm.service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';
import { InAppNotification, Org, Realm, Review, Run } from '../../src/models/index.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';

const has_postgres = await postgres_reachable();
const uid = () => `hsc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function scalar(sql: string): Promise<string | null> {
    const rows = await get_sequelize().query<{ v: string | null }>(sql, { type: QueryTypes.SELECT });
    return rows[0]?.v ?? null;
}

describe.skipIf(!has_postgres)('hub schema cleanup (boot)', () => {
    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });

    afterAll(async () => {
        await close_test_control_plane_store();
    });

    it('drops the obsolete public tables and the public schema; pgcrypto moves to cliq', async () => {
        const sq = get_sequelize();
        await sq.query('CREATE SCHEMA IF NOT EXISTS public');
        await sq.query('CREATE TABLE IF NOT EXISTS public._hub_uuid_remint_map (old_id UUID PRIMARY KEY, new_id UUID NOT NULL)');
        await sq.query('CREATE TABLE IF NOT EXISTS public.chat_messages (id UUID PRIMARY KEY)');

        await migrate_hub_schema(sq);

        expect(await scalar(`SELECT nspname AS v FROM pg_namespace WHERE nspname = 'public'`)).toBeNull();
        expect(await scalar(`SELECT n.nspname AS v FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto'`)).toBe('cliq');
        // Boot again on a cliq-only database is a no-op.
        await migrate_hub_schema(sq);
        expect(await scalar(`SELECT gen_random_uuid()::text AS v`)).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('control-plane boot migrations keep the cliq.scopes registry and its rows', async () => {
        const sq = get_sequelize();
        const slug = uid();
        await sq.query(
            `INSERT INTO cliq.scopes (id, slug, display_name, visibility, scope_type, created_at)
             VALUES (:id, :slug, :slug, 'public', 'user', NOW())`,
            { replacements: { id: randomUUID(), slug } },
        );
        // Production lost the inbound FKs; without them nothing blocks a DROP of the registry.
        const fks = await sq.query<{ tbl: string; con: string; def: string }>(
            `SELECT conrelid::regclass::text AS tbl, conname AS con, pg_get_constraintdef(oid) AS def
               FROM pg_constraint WHERE confrelid = 'cliq.scopes'::regclass`,
            { type: QueryTypes.SELECT },
        );
        for (const fk of fks) await sq.query(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT "${fk.con}"`);

        await run_core_api_schema_migrations(sq);
        await run_core_api_schema_migrations(sq);

        expect(await scalar(`SELECT table_schema AS v FROM information_schema.tables WHERE table_schema = 'cliq' AND table_name = 'scopes'`)).toBe('cliq');
        expect(await scalar(`SELECT count(*)::text AS v FROM cliq.scopes WHERE slug = '${slug}'`)).toBe('1');
        expect(await scalar(`SELECT is_default::text AS v FROM cliq.scopes WHERE slug = 'cliq'`)).toBe('1');
        await sq.query('DELETE FROM cliq.scopes WHERE slug = :slug', { replacements: { slug } });
        for (const fk of fks) await sq.query(`ALTER TABLE ${fk.tbl} ADD CONSTRAINT "${fk.con}" ${fk.def}`);
    });

    it('keeps a public table that still has rows', async () => {
        const sq = get_sequelize();
        await sq.query('CREATE SCHEMA IF NOT EXISTS public');
        await sq.query('CREATE TABLE public.chat_messages (id UUID PRIMARY KEY)');
        await sq.query(`INSERT INTO public.chat_messages (id) VALUES ('${randomUUID()}')`);

        await migrate_hub_schema(sq);

        expect(await scalar(`SELECT count(*)::text AS v FROM public.chat_messages`)).toBe('1');
        await sq.query('DROP TABLE public.chat_messages');
        await migrate_hub_schema(sq);
        expect(await scalar(`SELECT nspname AS v FROM pg_namespace WHERE nspname = 'public'`)).toBeNull();
    });

    it('aligns realm-scoped org_id with the realm and closes decided reviews of ended runs', async () => {
        const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Moved');
        const stale_org = await Org.create({ slug: uid(), display_name: 'Old org' } as never);
        const stale_org_id = stale_org.get('id') as string;
        const { record: ws } = await WorkspaceService.upsert_by_path(`/tmp/${uid()}`);

        const ended_run = uid();
        const live_run = uid();
        for (const [run_id, state] of [[ended_run, 'failed'], [live_run, 'running']] as const) {
            await Run.create({ run_id, workspace_id: ws.id, team_id: 't', state, started_at: Date.now(), realm_id: realm.id, org_id: stale_org_id } as never);
        }
        const review = (run_id: string) => Review.create({
            id: randomUUID(), run_id, realm_id: realm.id, org_id: stale_org_id, status: 'decided',
            payload: {}, timeout_at: new Date(Date.now() + 3_600_000),
        } as never);
        const closed = await review(ended_run);
        const open = await review(live_run);
        const notif = await InAppNotification.create({
            id: randomUUID(), event: 'run.failed', realm_id: realm.id, org_id: stale_org_id, created_at: Date.now(),
        } as never);

        await migrate_hub_schema(get_sequelize());

        const realm_org = (await Realm.findByPk(realm.id, { raw: true }) as { org_id: string }).org_id;
        expect(realm_org).not.toBe(stale_org_id);
        expect((await Run.findByPk(ended_run, { raw: true }) as { org_id: string }).org_id).toBe(realm_org);
        expect((await InAppNotification.findByPk(notif.get('id') as string, { raw: true }) as { org_id: string }).org_id).toBe(realm_org);
        const closed_row = await Review.findByPk(closed.get('id') as string, { raw: true }) as { org_id: string; status: string; completed_at: Date | null };
        expect(closed_row).toMatchObject({ org_id: realm_org, status: 'completed' });
        expect(closed_row.completed_at).toBeTruthy();
        expect((await Review.findByPk(open.get('id') as string, { raw: true }) as { status: string }).status).toBe('decided');
    });
});
