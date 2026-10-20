/**
 * PLAN-notifications-v2 B4.4 / B4.5 — a Hug is posted straight to the channels it names, with the same
 * message ("Review requested"), and to nobody else: it is not an event, so no rule can match it.
 * `phase.input_required` and `hug.review_requested` are no longer events; a one-time migration deletes the
 * rules on them. A run waiting for input raises no event either.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { NotificationService } from '../../src/services/notification.service.js';
import { HugReviewsService } from '../../src/services/hug_reviews.service.js';
import { realm_members_channel_id } from '../../src/notifications/defaults.js';
import {
	ChannelDestination, HubEvent, InAppNotification, NotificationChannel, NotificationRule, Realm, RealmMember, Review, ReviewNotification, Setting,
} from '../../src/models/index.js';
import { REMOVED_EVENT_RULES_MIGRATION_KEY, migrate_removed_event_rules } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('B4.4 / B4.5 — a Hug goes only to its own channels', () => {
	const realms: string[] = [];
	const channels: string[] = [];
	const reviews: string[] = [];

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});
	afterEach(() => { vi.unstubAllGlobals(); });
	afterAll(async () => {
		if (!has_postgres) return;
		const all = [...channels, ...realms.map(realm_members_channel_id)];
		await ReviewNotification.destroy({ where: { review_id: reviews } });
		await Review.destroy({ where: { id: reviews } });
		await HubEvent.destroy({ where: { realm_id: realms } });
		await InAppNotification.destroy({ where: { realm_id: realms } });
		await NotificationRule.destroy({ where: { realm_id: realms } });
		await ChannelDestination.destroy({ where: { channel_id: all } });
		await NotificationChannel.destroy({ where: { id: all } });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await close_test_control_plane_store();
	});

	it('only the named channel gets it — a hug.* rule to another channel does not; no event is stored', async () => {
		const fetch_mock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetch_mock);
		const realm = await RealmService.create(OWNER, `hd-${uid()}`.slice(0, 40), 'Direct');
		realms.push(realm.id);
		const named = await NotificationService.create_channel({ realm_id: realm.id, name: `named-${uid()}`.slice(0, 30), destinations: [{ type: 'webhook', url: 'https://example.com/named' }] });
		const other = await NotificationService.create_channel({ realm_id: realm.id, name: `other-${uid()}`.slice(0, 30), destinations: [{ type: 'webhook', url: 'https://example.com/other' }] });
		channels.push(named.id, other.id);
		await NotificationService.set_rule({ realm_id: realm.id, event: 'hug.*', channel_id: other.id });

		const run_id = `run-${uid()}`;
		const created = await HugReviewsService.create({
			run_id, daemon_id: 'd-1', realm_id: realm.id, payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: OWNER,
			reviewers: [{ policy: 'any', channels: [named.name] }],
		});
		reviews.push(created.review_id);

		await vi.waitFor(() => expect(fetch_mock.mock.calls.some((c) => String(c[0]).includes('/named'))).toBe(true));
		await new Promise((r) => setTimeout(r, 200));
		expect(fetch_mock.mock.calls.some((c) => String(c[0]).includes('/other'))).toBe(false);
		expect(await HubEvent.count({ where: { run_id, type: 'hug.review_requested' } })).toBe(0);
	});

	it('the same message in the inbox: labelled Review requested, linked to the Hug', async () => {
		const realm = await RealmService.create(OWNER, `hd-${uid()}`.slice(0, 40), 'Inbox');
		realms.push(realm.id);
		const run_id = `run-${uid()}`;
		const created = await HugReviewsService.create({
			run_id, daemon_id: 'd-1', realm_id: realm.id, payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: OWNER,
			reviewers: [{ policy: 'any', channels: ['All realm members'] }],
		});
		reviews.push(created.review_id);
		const row = await vi.waitFor(async () => {
			const r = await InAppNotification.findOne({ where: { review_id: created.review_id }, raw: true });
			expect(r).toBeTruthy();
			return r!;
		});
		expect(row).toMatchObject({ event: 'hug.review_requested', title: 'Review requested — human-review' });
	});

	it('the migration deletes every rule on the retired events, and only those', async () => {
		const realm = await RealmService.create(OWNER, `hd-${uid()}`.slice(0, 40), 'Retired');
		realms.push(realm.id);
		const ch = realm_members_channel_id(realm.id);
		const now = Date.now();
		for (const event of ['phase.input_required', 'hug.review_requested']) {
			await NotificationRule.create({ id: randomUUID(), realm_id: realm.id, org_id: null, team_slug: null, event, channel_id: ch, priority: 0, created_at: now, updated_at: now } as never);
		}
		const kept = await NotificationRule.count({ where: { realm_id: realm.id, event: ['run.failed', 'phase.idle'] } });

		await Setting.destroy({ where: { key: REMOVED_EVENT_RULES_MIGRATION_KEY } });
		await migrate_removed_event_rules(NotificationRule.sequelize!);

		expect(await NotificationRule.count({ where: { event: ['phase.input_required', 'hug.review_requested'] } })).toBe(0);
		expect(await NotificationRule.count({ where: { realm_id: realm.id, event: ['run.failed', 'phase.idle'] } })).toBe(kept);
		expect(await Setting.findByPk(REMOVED_EVENT_RULES_MIGRATION_KEY)).toBeTruthy();
	});

	it('a new realm\'s defaults no longer include the retired events', async () => {
		const realm = await RealmService.create(OWNER, `hd-${uid()}`.slice(0, 40), 'Fresh');
		realms.push(realm.id);
		expect(await NotificationRule.count({ where: { realm_id: realm.id, event: ['phase.input_required', 'hug.review_requested'] } })).toBe(0);
	});
});
