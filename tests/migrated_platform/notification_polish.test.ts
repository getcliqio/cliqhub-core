/**
 * Walkthrough fixes (Oct 12): one notification per run end (Core's own end-of-run report and the
 * daemon's merge), readable titles, the run's error as the message, and destinations in a stable
 * order.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
	hash_password: vi.fn().mockResolvedValue('hash'),
	verify_password: vi.fn().mockResolvedValue(true),
}));

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { RealmService } from '../../src/services/realm.service.js';
import { EventSubmitService } from '../../src/services/events_service.js';
import { NotificationService, sort_destination_rows } from '../../src/services/notification.service.js';
import { event_title } from '../../src/notifications/types.js';
import { ChannelDestination, HubEvent, InAppNotification, NotificationChannel, NotificationRule, Realm, RealmMember, Setting } from '../../src/models/index.js';
import { migrate_built_in_messages, BUILT_IN_MESSAGES_MIGRATION_KEY } from '../../src/models/migrations/control_plane_schema_migrations.js';
import { randomUUID } from 'node:crypto';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('event titles and destination order (pure)', () => {
	it('readable titles: known names, else worded from the type', () => {
		expect(event_title('run.failed')).toBe('Run failed');
		expect(event_title('phase.timed_out')).toBe('Phase timed out');
		expect(event_title('phase.input_required')).toBe('Input needed');
		expect(event_title('hug.review_expired')).toBe('Review expired');
	});

	it('destinations sort in-app, email, then the rest (stable within a type)', () => {
		const rows = [
			{ id: 'b', type: 'email', created_at: 2 }, { id: 'c', type: 'slack', created_at: 1 },
			{ id: 'a', type: 'cliqhub', created_at: 3 }, { id: 'd', type: 'email', created_at: 1 },
		];
		expect(sort_destination_rows(rows).map((r) => r.id)).toEqual(['a', 'd', 'b', 'c']);
	});
});

describe.skipIf(!has_postgres)('one notification per run end', () => {
	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});
	beforeEach(async () => {
		if (!has_postgres) return;
		await InAppNotification.destroy({ where: {} });
		await RealmMember.destroy({ where: {} });
		await Realm.destroy({ where: {} });
	});
	afterAll(async () => {
		if (!has_postgres) return;
		await close_test_control_plane_store();
	});

	/** A realm whose failed runs go to its members (a realm of no org has no org default). */
	async function realm_sending_failures() {
		const realm = await RealmService.create(OWNER, `p-${uid()}`.slice(0, 40), 'Polish');
		await NotificationService.set_rule({ realm_id: realm.id, event: 'run.failed', channel_id: `cliqhub-${realm.id}` });
		return realm;
	}

	it('Core’s report then the daemon’s → one event (actor and message filled in), one inbox row, readable title', async () => {
		const realm = await realm_sending_failures();
		const run_id = `run-${uid()}`;
		// Core's own end-of-run report: no actor, the error in the payload.
		const first = await EventSubmitService.submit({ type: 'run.failed', realm_id: realm.id, run_id, daemon_id: 'd1', payload: { error: 'Phase boom failed: exit 1' } });
		expect(first.notifications).toBe('dispatched');
		// The daemon's report of the same end.
		const second = await EventSubmitService.submit({ type: 'run.failed', realm_id: realm.id, run_id, daemon_id: 'd1', message: 'Phase boom failed (daemon)', actor_id: OWNER });
		expect(second.notifications).toBe('skipped');
		const events = await HubEvent.findAll({ where: { run_id, type: 'run.failed' }, raw: true });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ actor_id: OWNER, message: 'Phase boom failed (daemon)' });
		const rows = await InAppNotification.findAll({ where: { run_id }, raw: true });
		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBe('Run failed');
		expect(rows[0].message).toBe('Phase boom failed: exit 1');
	});

	it('a run that started again in between ends again: that end is kept', async () => {
		const realm = await realm_sending_failures();
		const run_id = `run-${uid()}`;
		await EventSubmitService.submit({ type: 'run.failed', realm_id: realm.id, run_id, daemon_id: 'd1' });
		await EventSubmitService.submit({ type: 'run.started', realm_id: realm.id, run_id, daemon_id: 'd1' });
		const again = await EventSubmitService.submit({ type: 'run.failed', realm_id: realm.id, run_id, daemon_id: 'd1' });
		expect(again.notifications).toBe('dispatched');
		expect(await HubEvent.count({ where: { run_id, type: 'run.failed' } })).toBe(2);
	});

	it('channel destinations come back in-app first, then email', async () => {
		const ch = await NotificationService.create_channel({
			org_id: OWNER, name: `order-${uid()}`,
			destinations: [{ type: 'email', address: 'x@cliq.test' }, { type: 'slack', webhook_url: 'https://hooks.slack.com/x' }, { type: 'cliqhub' }],
		});
		const got = await NotificationService.get_channel(ch.id);
		expect(got.destinations.map((d) => d.type)).toEqual(['cliqhub', 'email', 'slack']);
	});
});

describe.skipIf(!has_postgres)('one-time move to built-in invite/account messages', () => {
	beforeAll(async () => {
		if (!has_postgres) return;
		await open_test_control_plane_store();
		await Setting.destroy({ where: { key: BUILT_IN_MESSAGES_MIGRATION_KEY } });
	});
	afterAll(async () => {
		if (!has_postgres) return;
		await Setting.destroy({ where: { key: BUILT_IN_MESSAGES_MIGRATION_KEY } });
		await close_test_control_plane_store();
	});

	it('deletes seeded org rules and the system Email channel; keeps realm defaults and people’s rules; unlocks In-app; runs once', async () => {
		const now = Date.now();
		const org = OWNER;
		const mk_channel = async (system_key: string | null, locked = false) => {
			const id = randomUUID();
			await NotificationChannel.create({ id, realm_id: null, org_id: org, user_id: null, name: `c-${uid()}`, secret: null, enabled: 1, created_at: now, updated_at: now, system_key, locked, lock_reason: locked ? 'x' : null } as never);
			await ChannelDestination.create({ id: randomUUID(), channel_id: id, type: system_key === 'org.email' ? 'email' : 'cliqhub', config: {}, created_at: now } as never);
			return id;
		};
		await NotificationChannel.destroy({ where: { org_id: org, system_key: ['org.email', 'org.in_app'] } });
		const email = await mk_channel('org.email', true);
		const in_app = await mk_channel('org.in_app', true);
		const mine = await mk_channel(null);
		const rule = (over: Record<string, unknown>) => NotificationRule.create({ realm_id: null, org_id: org, team_slug: null, event: 'invite.org.sent', priority: 0, created_at: now, updated_at: now, ...over } as never);
		const seeded = await rule({ channel_id: email, system_key: 'invite.sent.invitee', recipients: ['invitee'], locked: true });
		const seeded_in_app = await rule({ channel_id: in_app, system_key: 'invite.sent.invitee', recipients: ['invitee'] });
		const people = await rule({ channel_id: mine, event: 'run.failed' });
		const realm = await RealmService.create(OWNER, `bi-${uid()}`.slice(0, 40), 'Built-in');
		const realm_defaults = await NotificationRule.count({ where: { realm_id: realm.id } });

		await migrate_built_in_messages(NotificationChannel.sequelize!);

		expect(await NotificationRule.findByPk(seeded.id)).toBeNull();
		expect(await NotificationRule.findByPk(seeded_in_app.id)).toBeNull();
		expect(await NotificationRule.findByPk(people.id)).toBeTruthy();
		expect(await NotificationChannel.findByPk(email)).toBeNull();
		expect(await NotificationChannel.findByPk(in_app, { raw: true })).toMatchObject({ locked: false, lock_reason: null });
		expect(await NotificationRule.count({ where: { realm_id: realm.id } })).toBe(realm_defaults);

		// Once: a later Email channel (not that we make one) would not be touched.
		const again = await mk_channel('org.email');
		await migrate_built_in_messages(NotificationChannel.sequelize!);
		expect(await NotificationChannel.findByPk(again)).toBeTruthy();
		await NotificationChannel.destroy({ where: { id: [again, mine] } });
	});
});
