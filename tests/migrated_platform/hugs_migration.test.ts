/**
 * migrate_hugs (PLAN-hug-requests) — the one-time switch from reviews to Hugs: the review tables
 * are dropped, notification rules and people's settings move to the renamed events (rules on
 * events with no equivalent are deleted), role permissions are renamed and `teams.inputs` dropped,
 * and the key is recorded so it runs once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { HUGS_MIGRATION_KEY, migrate_hugs } from '../../src/models/migrations/control_plane_schema_migrations.js';
import { NotificationPersonSetting, NotificationRule, OrgRole, Setting } from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('migrate_hugs', () => {
	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});
	afterAll(async () => {
		if (!has_postgres) return;
		await close_test_control_plane_store();
	});

	it('drops the review tables, renames events and permissions, and runs once', async () => {
		const sq = get_sequelize();
		const scalar = async (sql: string) => ((await sq.query<{ v: unknown }>(sql, { type: QueryTypes.SELECT }))[0]?.v ?? null);

		// The world before Hugs.
		await sq.query(`CREATE TABLE IF NOT EXISTS cliq."reviews" ("id" TEXT PRIMARY KEY)`);
		await sq.query(`CREATE TABLE IF NOT EXISTS cliq."review_notifications" ("id" TEXT PRIMARY KEY, "review_id" TEXT REFERENCES cliq."reviews"("id"))`);
		await sq.query(`CREATE TABLE IF NOT EXISTS cliq."review_chat_messages" ("id" TEXT PRIMARY KEY)`);
		const realm = await RealmService.create(hub_legacy_uuid(1), `mh-${uid()}`.slice(0, 40), 'Migrate');
		const now = Date.now();
		const rule = (event: string) => NotificationRule.create({
			id: randomUUID(), realm_id: realm.id, org_id: null, team_slug: null, event, channel_id: `ch-${uid()}`, priority: 0,
			created_at: now, updated_at: now, recipients: null, system_key: null, locked: false, lock_reason: null, enabled: true,
		} as never);
		const renamed = await rule('hug.review_responded');
		const resumed = await rule('phase.inputs_supplied');
		const routing = await rule('hug.routing_requested');
		const person = hub_legacy_uuid(77_001);
		const setting = (event: string) => NotificationPersonSetting.create({ id: randomUUID(), user_id: person, scope: 'my_runs', event, state: 'on', created_at: now, updated_at: now });
		await setting('phase.input_required');
		await setting('phase.inputs_supplied');
		const role = await OrgRole.create({
			id: randomUUID(), org_id: hub_legacy_uuid(1), slug: `r-${uid()}`.slice(0, 40), name: 'Custom',
			permissions: ['reviews.view', 'reviews.verdict', 'teams.inputs', 'runs.view'], is_system: false, is_default: false, created_at: new Date(),
		} as never);
		await Setting.destroy({ where: { key: HUGS_MIGRATION_KEY } });

		await migrate_hugs(sq);

		expect(await scalar(`SELECT to_regclass('cliq.reviews')::text AS v`)).toBeNull();
		expect(await scalar(`SELECT to_regclass('cliq.review_notifications')::text AS v`)).toBeNull();
		expect(await scalar(`SELECT to_regclass('cliq.review_chat_messages')::text AS v`)).toBeNull();
		expect((await NotificationRule.findByPk(renamed.id, { raw: true }))!.event).toBe('hug.responded');
		expect((await NotificationRule.findByPk(resumed.id, { raw: true }))!.event).toBe('phase.resumed');
		expect(await NotificationRule.findByPk(routing.id)).toBeNull();
		const events = (await NotificationPersonSetting.findAll({ where: { user_id: person }, raw: true })).map((r) => r.event).sort();
		expect(events).toEqual(['phase.resumed']);
		expect((await OrgRole.findByPk(role.id, { raw: true }))!.permissions.sort()).toEqual(['runs.view']);
		expect(await Setting.findByPk(HUGS_MIGRATION_KEY)).not.toBeNull();
		expect(await scalar(`SELECT 1 AS v FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'stored_artifacts' AND column_name = 'hug_requested_input'`)).toBe(1);
		expect(await scalar(`SELECT 1 AS v FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'command_outbox' AND column_name = 'deliver_until'`)).toBe(1);

		// Once recorded, it does nothing more.
		const again = await rule('hug.review_responded');
		await migrate_hugs(sq);
		expect((await NotificationRule.findByPk(again.id, { raw: true }))!.event).toBe('hug.review_responded');

		await NotificationRule.destroy({ where: { realm_id: realm.id } });
		await NotificationPersonSetting.destroy({ where: { user_id: person } });
		await OrgRole.destroy({ where: { id: role.id } });
	});
});
