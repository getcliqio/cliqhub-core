import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { CliqHubDeliverer } from '../../src/notifications/deliverers/cliqhub_deliverer.js';
import { InAppNotificationService } from '../../src/services/in_app_notification.service.js';
import { EventSubmitService } from '../../src/events/submit.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import {
	ChannelDestination,
	HubEvent,
	InAppNotification,
	NotificationChannel,
	NotificationRule,
	Realm,
	RealmMember,
} from '../../src/models/index.js';

/** Seeded user in open_test_control_plane_store — required for Realm.org_id. */
const test_user_id = hub_legacy_uuid(1);

const has_postgres = await postgres_reachable();
const uid = () => `cliqhub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
	if (!has_postgres) return;
	await open_test_control_plane_store();
});

beforeEach(async () => {
	if (!has_postgres) return;
	await InAppNotification.destroy({ where: {} });
	await NotificationRule.destroy({ where: {} });
	await ChannelDestination.destroy({ where: {} });
	await NotificationChannel.destroy({ where: {} });
	await HubEvent.destroy({ where: {} });
	await RealmMember.destroy({ where: {} });
	await Realm.destroy({ where: {} });
});

afterAll(async () => {
	if (!has_postgres) return;
	await InAppNotification.destroy({ where: {} });
	await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('CliqHubDeliverer — persist in-app notification', () => {
	it('create_from_payload stores top-level fields and extra payload', async () => {
		const row = await InAppNotificationService.create_from_payload({
			event: 'run.failed',
			title: 'Failed',
			message: 'boom',
			realm_id: 'realm-1',
			team_slug: '@acme/demo',
			run_id: 'run-1',
			phase_name: 'build',
			severity: 'error',
			review_id: 'rev-1',
			review_url: 'https://hug.example/r/1',
		});

		expect(row.id).toBeTruthy();
		expect(row.event).toBe('run.failed');
		expect(row.title).toBe('Failed');
		expect(row.message).toBe('boom');
		expect(row.realm_id).toBe('realm-1');
		expect(row.team).toBe('@acme/demo');
		expect(row.run_id).toBe('run-1');
		expect(row.phase).toBe('build');
		expect(row.severity).toBe('error');
		expect(row.payload.review_id).toBe('rev-1');
		expect(row.payload.review_url).toBe('https://hug.example/r/1');

		const deliverer = new CliqHubDeliverer();
		await deliverer.deliver({}, {
			event: 'hug.review_requested',
			message: 'please review',
			realm_id: 'realm-2',
			run_id: 'run-2',
		});
		const count = await InAppNotification.count();
		expect(count).toBe(2);
	});

	it('submit run.failed with realm rule creates a row', async () => {
		const realm = await RealmService.create(test_user_id, `c-${uid()}`.slice(0, 40), 'CliqHub');
		const channel = await NotificationService.ensure_realm_cliqhub_channel(realm.id);
		await NotificationService.set_rule({
			realm_id: realm.id,
			event: 'run.failed',
			channel_id: channel.id,
		});

		const event = await EventSubmitService.submit({
			type: 'run.failed',
			realm_id: realm.id,
			run_id: 'run-cliqhub-1',
			daemon_id: 'daemon-cliqhub-1',
			message: 'failed in test',
		});

		expect(event.notifications).toBe('dispatched');
		const rows = await InAppNotification.findAll();
		expect(rows).toHaveLength(1);
		expect(rows[0].event).toBe('run.failed');
		expect(rows[0].realm_id).toBe(realm.id);
		expect(rows[0].run_id).toBe('run-cliqhub-1');
		expect(rows[0].message).toBe('failed in test');
	});

	it('submit run.failed without rules falls back to realm:all_users in-app', async () => {
		const realm = await RealmService.create(test_user_id, `c-${uid()}`.slice(0, 40), 'Empty');
		await NotificationRule.destroy({ where: { realm_id: realm.id } });
		const event = await EventSubmitService.submit({
			type: 'run.failed',
			realm_id: realm.id,
			run_id: 'run-cliqhub-2',
			daemon_id: 'daemon-cliqhub-2',
		});
		/** Yamazaki default-notify: absent rules → realm:all_users (cliqhub dest). */
		expect(event.notifications).toBe('dispatched');
		expect(await InAppNotification.count()).toBe(1);
	});

	it('submit team.published with global rule creates row without realm', async () => {
		const channel = await NotificationService.create_channel({
			realm_id: null,
			org_id: hub_legacy_uuid(1),
			name: `cliqhub-account-${uid()}`,
			destinations: [{ type: 'cliqhub' }],
		});
		await NotificationService.set_rule({
			event: 'team.*',
			channel_id: channel.id,
		});

		const event = await EventSubmitService.submit({
			type: 'team.published',
			team: '@acme/demo',
			message: 'shipped',
		});

		expect(event.notifications).toBe('dispatched');
		const rows = await InAppNotification.findAll();
		expect(rows).toHaveLength(1);
		expect(rows[0].event).toBe('team.published');
		expect(rows[0].realm_id).toBeNull();
		expect(rows[0].team).toBe('@acme/demo');
	});
});
