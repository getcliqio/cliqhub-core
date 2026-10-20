/**
 * PLAN-notifications-v2 B3 — a gate's reviewers are channels the realm can use (the realm's own and its
 * org's). Each reviewer name with no such channel raises Unknown channel; the names that exist still get
 * the review; a group left with nobody is refused (422) so the gate's phase fails. B2's notify channels
 * use the same set: an org channel named by a run delivers and raises nothing.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { EventSubmitService } from '../../src/services/events_service.js';
import { validate_run_start_options } from '../../src/services/run_start_options.js';
import { unknown_channel_message } from '../../src/notifications/unknown_channel.js';
import { realm_members_channel_id } from '../../src/notifications/defaults.js';
import {
	ChannelDestination, HubEvent, InAppNotification, NotificationChannel, NotificationRule, Realm, RealmMember, Review, ReviewNotification,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('B3 — gate reviewers are channels the realm can use', () => {
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

	/** A realm with one channel of its own and one org channel (webhooks). */
	async function setup() {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
		const realm = await RealmService.create(OWNER, `b3-${uid()}`.slice(0, 40), 'Gate reviewers');
		realms.push(realm.id);
		const org_id = String((await Realm.findByPk(realm.id, { raw: true }))!.org_id);
		const realm_name = `rl-${uid()}`.slice(0, 30);
		const org_name = `og-${uid()}`.slice(0, 30);
		const rc = await NotificationService.create_channel({ realm_id: realm.id, name: realm_name, destinations: [{ type: 'webhook', url: 'https://example.com/realm' }] });
		const oc = await NotificationService.create_channel({ org_id, name: org_name, destinations: [{ type: 'webhook', url: 'https://example.com/org' }] });
		channels.push(rc.id, oc.id);
		return { realm_id: realm.id, org_id, realm_name, org_name, realm_ch: rc.id, org_ch: oc.id };
	}
	const review = (s: { realm_id: string; org_id: string }, run_id: string, names: string[]) => HugReviewsService.create({
		run_id, daemon_id: 'd-1', realm_id: s.realm_id,
		payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: OWNER,
		reviewers: [{ policy: 'any', channels: names }],
	}).then((r) => { reviews.push(r.review_id); return r; });
	const notices = (run_id: string) => HubEvent.findAll({ where: { type: 'notification.unknown_channel', run_id }, raw: true });
	const targets = async (review_id: string) => (await ReviewNotification.findAll({ where: { review_id }, raw: true })).map((r) => r.channel_target).sort();

	it('a realm\'s own channel and an org channel are both reviewers', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		const r = await review(s, run_id, [s.realm_name, s.org_name]);
		expect(await targets(r.review_id)).toEqual([s.realm_name, s.org_name].sort());
		expect(await notices(run_id)).toHaveLength(0);
	});

	it('some names missing: the review goes to the rest; Unknown channel for each missing name', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		const r = await review(s, run_id, [s.realm_name, 'nobody-here']);
		expect(await targets(r.review_id)).toEqual([s.realm_name]);
		const raised = await notices(run_id);
		expect(raised.map((e) => e.message)).toEqual([unknown_channel_message('nobody-here')]);
		expect(JSON.parse(raised[0].payload_json).source).toBe('reviewers');
	});

	it('every name missing: refused with 422 (the phase fails); Unknown channel for each; no review', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		await expect(review(s, run_id, ['nobody-a', 'nobody-b']))
			.rejects.toMatchObject({ status_code: 422, message: expect.stringContaining("Review sent to unknown channel 'nobody-a', 'nobody-b'") });
		expect((await notices(run_id)).map((e) => e.message).sort()).toEqual([unknown_channel_message('nobody-a'), unknown_channel_message('nobody-b')].sort());
		expect(await Review.count({ where: { run_id } })).toBe(0);
	});

	it('another realm\'s channel is not one this realm can use', async () => {
		const s = await setup();
		const other = await setup();
		const run_id = `run-${uid()}`;
		await expect(review(s, run_id, [other.realm_name])).rejects.toMatchObject({ status_code: 422 });
	});

	it('notify channels (B2): an org channel named by a run delivers and raises nothing; run start accepts it', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		const ev = await EventSubmitService.submit({
			type: 'run.failed', realm_id: s.realm_id, run_id, daemon_id: 'd-1', message: 'boom',
			payload: { notify: { channels: [s.org_name] } } as never,
		});
		expect(ev.notifications).toBe('dispatched');
		expect(await notices(run_id)).toHaveLength(0);
		await expect(validate_run_start_options({ realm_id: s.realm_id, notify_channels: [s.org_name, s.realm_name] })).resolves.toBeUndefined();
		await expect(validate_run_start_options({ realm_id: s.realm_id, notify_channels: ['nobody-here'] })).rejects.toMatchObject({ status: 422 });
	});
	describe('B4.3a — an input Hug (a phase that lacks inputs) goes to the channels it names', () => {
		const input_hug = (s: { realm_id: string; org_id: string }, run_id: string, names: string[]) => HugReviewsService.create({
			run_id, daemon_id: 'd-1', realm_id: s.realm_id, mode: 'input_pause',
			payload: { phase: 'fix', fields: [{ name: 'ticket', type: 'text', required: true }] }, timeout_minutes: 60, actor_id: OWNER,
			reviewers: [{ policy: 'any', channels: names }],
		}).then((r) => { reviews.push(r.review_id); return r; });

		it('its channels get it (no longer dropped)', async () => {
			const s = await setup();
			const r = await input_hug(s, `run-${uid()}`, [s.realm_name, s.org_name]);
			expect(await targets(r.review_id)).toEqual([s.realm_name, s.org_name].sort());
		});

		it('a name with no channel — e.g. a person\'s name from an old daemon — raises Unknown channel; none left → 422', async () => {
			const s = await setup();
			const run_id = `run-${uid()}`;
			await expect(input_hug(s, run_id, ['some-username'])).rejects.toMatchObject({ status_code: 422 });
			expect((await notices(run_id)).map((e) => e.message)).toEqual([unknown_channel_message('some-username')]);
		});
	});
});
