/**
 * PLAN-channels S0 — baseline: how a review reaches people today (no behaviour change).
 *
 * Reviews only go to channels. A reviewer name resolves to an org channel; a person's
 * personal channel (named after their username, made by `ensure_per_user_channel`) delivers to
 * their in-app inbox (and, since S3, their account email — see personal_channel_email.test.ts).
 * A name with no channel reaches nobody.
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
import { HugReviewsService } from '../../src/services/hug_reviews.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ensure_per_user_channel } from '../../src/services/per_user_channel.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import {
	ChannelDestination,
	InAppNotification,
	NotificationChannel,
	Realm,
	RealmMember,
	Review,
	ReviewNotification,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const ORG = hub_legacy_uuid(1);
const ELAN = hub_legacy_uuid(7);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Poll until `fn` returns a truthy value (delivery runs after the review is stored). */
async function eventually<T>(fn: () => Promise<T>, ms = 3000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v || Date.now() > end) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.skipIf(!has_postgres)('PLAN-channels S0 baseline: reviews reach people through channels', () => {
	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});

	beforeEach(async () => {
		if (!has_postgres) return;
		await InAppNotification.destroy({ where: {} });
		await ReviewNotification.destroy({ where: {} });
		await Review.destroy({ where: {} });
		await ChannelDestination.destroy({ where: {} });
		await NotificationChannel.destroy({ where: {} });
		await RealmMember.destroy({ where: {} });
		await Realm.destroy({ where: {} });
	});

	afterAll(async () => {
		if (!has_postgres) return;
		await close_test_control_plane_store();
	});

	it('a personal channel is named after the username and has in-app and account email (S3)', async () => {
		const id = await ensure_per_user_channel(ELAN, ORG, 'elan');
		const ch = await NotificationChannel.findByPk(id, { raw: true });
		expect(ch).toMatchObject({ name: 'elan', user_id: ELAN, org_id: ORG, enabled: 1 });
		const dests = (await ChannelDestination.findAll({ where: { channel_id: id }, raw: true })).map((d) => [d.type, d.config]);
		expect(dests.sort()).toEqual([['cliqhub', {}], ['email', { account: true }]]);
		// Idempotent: a second call reuses the channel.
		expect(await ensure_per_user_channel(ELAN, ORG, 'elan')).toBe(id);
	});

	it('a review to "elan" is recorded against Elan and lands in his in-app inbox', async () => {
		await ensure_per_user_channel(ELAN, ORG, 'elan');
		const realm = await RealmService.create(ORG, `r-${uid()}`.slice(0, 40), 'Reviews');
		const created = await HugReviewsService.create({
			run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: realm.id, org_id: ORG,
			payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: ORG,
			reviewers: [{ policy: 'any', channels: ['elan'] }],
		});
		const rows = await ReviewNotification.findAll({ where: { review_id: created.review_id }, raw: true });
		expect(rows.map((r) => [r.channel_target, r.user_id])).toEqual([['elan', ELAN]]);
		const inbox = await eventually(() => InAppNotification.findOne({ where: { user_id: ELAN, review_id: created.review_id }, raw: true }));
		expect(inbox).toBeTruthy();
	});

	it('a review to a channel with an email destination emails that address', async () => {
		const { DELIVERER_BY_PROVIDER } = await import('../../src/notifications/deliverers/index.js');
		const sent = vi.spyOn(DELIVERER_BY_PROVIDER.email, 'deliver').mockResolvedValue(undefined);
		try {
			// Created the way the API does (`notification_channels/create`).
			await NotificationService.create_channel({ org_id: ORG, name: 'qa-mail', destinations: [{ type: 'email', address: 'qa@cliq.local' }] });
			const realm = await RealmService.create(ORG, `r-${uid()}`.slice(0, 40), 'Reviews');
			await HugReviewsService.create({
				run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: realm.id, org_id: ORG,
				payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: ORG,
				reviewers: [{ policy: 'any', channels: ['qa-mail'] }],
			});
			await eventually(async () => sent.mock.calls.length > 0);
			expect(sent).toHaveBeenCalledTimes(1);
			expect(sent.mock.calls[0][0]).toMatchObject({ to: 'qa@cliq.local' });
		} finally {
			sent.mockRestore();
		}
	});

	it('a reviewer name with no channel reaches nobody (no direct notification)', async () => {
		const realm = await RealmService.create(ORG, `r-${uid()}`.slice(0, 40), 'Reviews');
		const created = await HugReviewsService.create({
			run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: realm.id, org_id: ORG,
			payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: ORG,
			reviewers: [{ policy: 'any', channels: ['nobody-here'] }],
		}).catch((err: Error) => ({ review_id: null as string | null, error: err.message }));
		if (created.review_id) {
			expect(await ReviewNotification.count({ where: { review_id: created.review_id } })).toBe(0);
		}
		await new Promise((r) => setTimeout(r, 300));
		expect(await InAppNotification.count()).toBe(0);
	});
});
