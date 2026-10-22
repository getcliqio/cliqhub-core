/**
 * PLAN-notification-layers C + D — on a real Postgres:
 *  - Runs record who started them, kept on re-register; a one-time fill from the Hub queue.
 *  - The person layer wins over realm and org, for that person: off stops it (delivery and their inbox), on brings it
 *    even when nothing sends it; "Runs I start" reaches the person who started the run, even if they switched the
 *    event off in general; seeded with the trouble events on (new people and, once, existing ones).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { use_test_link_env } from '../helpers/link_env.js';

vi.mock('../../src/auth/password.js', () => ({
	hash_password: vi.fn().mockResolvedValue('hash'),
	verify_password: vi.fn().mockResolvedValue(true),
}));

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RunService } from '../../src/services/run.service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { InAppNotificationService } from '../../src/services/in_app_notification.service.js';
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { MY_RUNS_SEEDED_ON, PersonSettingsService, reaches_me } from '../../src/services/person_settings.service.js';
import { NotificationFanOutService } from '../../src/notifications/fan_out.service.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import { NoopEmailSender } from '../../src/lib/email/noop_email_sender.js';
import type { EmailMessage, EmailSender } from '../../src/lib/email/email_sender.js';
import { realm_members_channel_id } from '../../src/notifications/defaults.js';
import { InAppNotification, NotificationChannel, NotificationPersonSetting, NotificationRule, Realm, RealmDispatchQueue, RealmMember, Run, Setting, User } from '../../src/models/index.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import {
	PERSON_SETTINGS_SEED_MIGRATION_KEY, RUN_STARTED_BY_MIGRATION_KEY, migrate_person_settings_seed, migrate_run_started_by,
} from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

class StubSender implements EmailSender {
	readonly configured = true;
	readonly name = 'stub';
	readonly sent: EmailMessage[] = [];
	async send(message: EmailMessage) { this.sent.push(message); return { message_id: `<s-${this.sent.length}@t>` }; }
}
const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;

describe.skipIf(!has_postgres)('the person layer; who started a run', () => {
	let stub: StubSender;
	let restore_env: () => void = () => {};
	const users: string[] = [];
	const realms: string[] = [];
	const runs: string[] = [];
	let workspace_id = '';

	async function person() {
		const id = randomUUID();
		const name = `pl${uid()}`.replace(/[^a-z0-9]/g, '').slice(0, 20);
		await User.create({ id, username: name, email: `${name}@cliq.test`, status: 'active', role: 'user', password_hash: 'x' } as never);
		users.push(id);
		await ensure_personal_channel(id, name);
		return { id, name, email: `${name}@cliq.test` };
	}
	async function realm_with(members: Array<{ id: string }>) {
		const realm = await RealmService.create(OWNER, `pl-${uid()}`.slice(0, 40), 'Person layer');
		realms.push(realm.id);
		for (const m of members) await RealmMember.create({ id: `${realm.id}:${m.id}`, realm_id: realm.id, member_type: 'user', member_id: m.id, role: 'member', created_at: Date.now() } as never);
		return realm.id;
	}
	let owner_email = '';
	const emailed = () => stub.sent.flatMap((m) => [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map((a) => a.email)).filter((e) => e !== owner_email).sort();
	const event = (realm_id: string, type: string, run_id?: string) => NotificationFanOutService.notify_realm({ type, realm_id, run_id, title: type, message: 'x', payload: {} } as never);
	async function run_by(realm_id: string, started_by: string | null) {
		const run_id = `run-${uid()}`;
		runs.push(run_id);
		await RunService.create(workspace_id, `team-${uid()}`, { run_id, realm_id, started_by });
		return run_id;
	}

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		restore_env = use_test_link_env();
		await open_test_control_plane_store();
		owner_email = String((await User.findByPk(OWNER, { attributes: ['email'], raw: true }))?.email ?? '');
		workspace_id = String((await WorkspaceService.upsert_by_path(`/tmp/person-layer-ws-${uid()}`)).record.id);
	});
	beforeEach(() => { stub = new StubSender(); email_deliverer.use_sender(stub); });
	afterEach(() => { email_deliverer.use_sender(new NoopEmailSender()); });
	afterAll(async () => {
		if (!has_postgres) return;
		await InAppNotification.destroy({ where: { realm_id: realms } });
		await InAppNotification.destroy({ where: { user_id: users } as never });
		await NotificationRule.destroy({ where: { realm_id: realms } });
		await NotificationPersonSetting.destroy({ where: { user_id: users } });
		await NotificationChannel.destroy({ where: { user_id: users } as never });
		await Run.destroy({ where: { run_id: runs } as never });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await User.destroy({ where: { id: users }, force: true } as never);
		await close_test_control_plane_store();
		restore_env();
	});

	it('a new person gets "Runs I start" seeded: the trouble events on, once', async () => {
		const amy = await person();
		const seeded = (await PersonSettingsService.list(amy.id)).filter((s) => s.scope === 'my_runs');
		expect(seeded.map((s) => s.event).sort()).toEqual([...MY_RUNS_SEEDED_ON].sort());
		expect(seeded.every((s) => s.state === 'on')).toBe(true);
		expect(await PersonSettingsService.ensure_seeded(amy.id)).toBe(0);
	});

	it('a run records who started it, and a re-register keeps it', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		const run_id = await run_by(realm_id, amy.id);
		await RunService.create(workspace_id, `team-${uid()}`, { run_id, realm_id, started_by: null });
		expect((await Run.findByPk(run_id, { raw: true }))?.started_by).toBe(amy.id);
	});

	it('Runs I start: the person who started a failed run gets it their way — with no rule, and even if they switched it off in general', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		const run_id = await run_by(realm_id, amy.id);
		await event(realm_id, 'run.failed', run_id);
		expect(emailed()).toEqual([amy.email]);

		stub.sent.length = 0;
		await PersonSettingsService.set(amy.id, 'all', 'run.failed', 'off');
		await event(realm_id, 'run.failed', run_id);
		expect(emailed()).toEqual([amy.email]);

		// Switched off in Runs I start → not about their runs.
		stub.sent.length = 0;
		await PersonSettingsService.set(amy.id, 'my_runs', 'run.failed', 'off');
		await event(realm_id, 'run.failed', run_id);
		expect(emailed()).toEqual([]);
	});

	it('off for me wins over the realm: All realm members sends it, Amy switched it off — not to her (email or inbox); Bo still gets it', async () => {
		const amy = await person();
		const bo = await person();
		const realm_id = await realm_with([amy, bo]);
		await NotificationService.set_rule({ realm_id, event: 'phase.failed', channel_id: realm_members_channel_id(realm_id) });
		await PersonSettingsService.set(amy.id, 'all', 'phase.failed', 'off');

		await event(realm_id, 'phase.failed');
		expect(emailed()).toEqual([bo.email]);
		const seen = async (user_id: string) => (await InAppNotificationService.list_for_user({ user_id, realm_id })).notifications.filter((n) => n.event === 'phase.failed').length;
		expect(await seen(amy.id)).toBe(0);
		expect(await seen(bo.id)).toBe(1);
	});

	it('on for me wins over the realm: nothing sends Phase idle, Amy switched it on — she gets it, Bo doesn\'t', async () => {
		const amy = await person();
		const bo = await person();
		const realm_id = await realm_with([amy, bo]);
		await PersonSettingsService.set(amy.id, 'all', 'phase.idle', 'on');
		await event(realm_id, 'phase.idle');
		expect(emailed()).toEqual([amy.email]);
		expect(await InAppNotification.count({ where: { user_id: amy.id, event: 'phase.idle' } as never })).toBe(1);
		// Back to following the realm: nothing.
		stub.sent.length = 0;
		await PersonSettingsService.set(amy.id, 'all', 'phase.idle', null);
		await event(realm_id, 'phase.idle');
		expect(emailed()).toEqual([]);
	});

	it('what reaches me: the rules that take a person in, by name — never addresses', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		await NotificationService.set_rule({ realm_id, event: 'run.completed', channel_id: realm_members_channel_id(realm_id) });
		const ch = await NotificationService.create_channel({ realm_id, name: `names-${uid()}`.replace(/[^a-z0-9-]/g, '').slice(0, 30), destinations: [{ type: 'channel_ref', name: amy.name }] });
		await NotificationService.set_rule({ realm_id, event: 'phase.idle', channel_id: ch.id });
		const got = await reaches_me(amy.id, amy.name);
		expect(got).toEqual(expect.arrayContaining([
			{ event: 'run.completed', via: ['All realm members'] },
			{ event: 'phase.idle', via: [`${ch.name} names you`] },
		]));
		expect(JSON.stringify(got)).not.toContain('@');
		await NotificationChannel.destroy({ where: { id: ch.id } });
	});

	it('one-time: Hub runs get who started them from the queue; people without "Runs I start" get it seeded — once', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		const run_id = await run_by(realm_id, null);
		await RealmDispatchQueue.create({ id: randomUUID(), realm_id, kind: 'run', payload: {}, priority: 0, status: 'done', run_id, submitted_by: amy.id, submitted_at: Date.now(), created_at: Date.now(), updated_at: Date.now() } as never);
		await NotificationPersonSetting.destroy({ where: { user_id: amy.id } });

		await Setting.destroy({ where: { key: [RUN_STARTED_BY_MIGRATION_KEY, PERSON_SETTINGS_SEED_MIGRATION_KEY] } });
		await migrate_run_started_by(get_sequelize());
		await migrate_person_settings_seed(get_sequelize());
		expect((await Run.findByPk(run_id, { raw: true }))?.started_by).toBe(amy.id);
		expect(await NotificationPersonSetting.count({ where: { user_id: amy.id, scope: 'my_runs', state: 'on' } })).toBe(MY_RUNS_SEEDED_ON.length);

		await migrate_person_settings_seed(get_sequelize()); // once
		expect(await NotificationPersonSetting.count({ where: { user_id: amy.id } })).toBe(MY_RUNS_SEEDED_ON.length);
		await RealmDispatchQueue.destroy({ where: { run_id } as never });
	});
});
