/**
 * PLAN-channels S0 — baseline: how a review reaches people today (no behaviour change).
 *
 * Reviews only go to channels. A reviewer name resolves to an org channel; a person's
 * personal channel (named after their username, made by `ensure_personal_channel`) delivers to
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
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import {
	ChannelDestination,
	InAppNotification,
	NotificationChannel,
	Org,
	OrgMember,
	Realm,
	RealmMember,
	Review,
	ReviewNotification,
	User,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const ORG = hub_legacy_uuid(1);
const ELAN = hub_legacy_uuid(7);
/** Elan's username (unique per run): a name reaches a real member of the org. */
const EL = `elan${Date.now().toString(36)}`;
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
		// "elan" reaches Elan from a realm of an org he's in.
		await User.destroy({ where: { id: ELAN }, force: true } as never);
		await User.create({ id: ELAN, username: EL, email: `${EL}@cliq.test`, status: 'active', role: 'user', password_hash: 'x' } as never);
		await OrgMember.destroy({ where: { org_id: ORG, user_id: ELAN } as never });
		await Org.findOrCreate({ where: { id: ORG } as never, defaults: { id: ORG, slug: 'legacy-org-one', display_name: 'Legacy org' } as never });
		await OrgMember.create({ org_id: ORG, user_id: ELAN, role: 'member', status: 'active' } as never);
	});

	afterAll(async () => {
		if (!has_postgres) return;
		await close_test_control_plane_store();
	});

	it('a personal channel is named after the username and has in-app and account email (S3)', async () => {
		const id = await ensure_personal_channel(ELAN, EL);
		const ch = await NotificationChannel.findByPk(id, { raw: true });
		// One for the whole account: no org, no realm.
		expect(ch).toMatchObject({ name: EL, user_id: ELAN, org_id: null, realm_id: null, enabled: 1 });
		const dests = (await ChannelDestination.findAll({ where: { channel_id: id }, raw: true })).map((d) => [d.type, d.config]);
		expect(dests.sort()).toEqual([['cliqhub', {}], ['email', { account: true }]]);
		// Idempotent: a second call reuses the channel.
		expect(await ensure_personal_channel(ELAN, EL)).toBe(id);
	});

	it('a review to "elan" is recorded against Elan and lands in his in-app inbox', async () => {
		await ensure_personal_channel(ELAN, EL);
		const realm = await RealmService.create(ORG, `r-${uid()}`.slice(0, 40), 'Reviews', { org_id: ORG });
		// A person's name reaches them from a realm they're a member of.
		await RealmMember.create({ id: `${realm.id}:${ELAN}`, realm_id: realm.id, member_type: 'user', member_id: ELAN, role: 'member', created_at: Date.now() } as never);
		const created = await HugReviewsService.create({
			run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: ORG,
			reviewers: [{ policy: 'any', channels: [EL] }],
		});
		const rows = await ReviewNotification.findAll({ where: { review_id: created.review_id }, raw: true });
		expect(rows.map((r) => [r.channel_target, r.user_id])).toEqual([[EL, ELAN]]);
		const inbox = await eventually(() => InAppNotification.findOne({ where: { user_id: ELAN, review_id: created.review_id }, raw: true }));
		expect(inbox).toBeTruthy();
	});

	it('a review to a channel with an email destination emails that address', async () => {
		const { DELIVERER_BY_PROVIDER } = await import('../../src/notifications/deliverers/index.js');
		const sent = vi.spyOn(DELIVERER_BY_PROVIDER.email, 'deliver').mockResolvedValue(undefined);
		try {
			// Created the way the API does (`notification_channels/create`).
			await NotificationService.create_channel({ org_id: ORG, name: 'qa-mail', destinations: [{ type: 'email', address: 'qa@cliq.local' }] });
			const realm = await RealmService.create(ORG, `r-${uid()}`.slice(0, 40), 'Reviews', { org_id: ORG });
			await HugReviewsService.create({
				run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: realm.id,
				payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: ORG,
				reviewers: [{ policy: 'any', channels: ['qa-mail'] }],
			});
			// Sends to that address (built-in channels' email-to-members may also be called).
			const to_qa = () => sent.mock.calls.filter((c) => (c[0] as { to?: unknown }).to === 'qa@cliq.local');
			await eventually(async () => to_qa().length > 0);
			expect(to_qa()).toHaveLength(1);
		} finally {
			sent.mockRestore();
		}
	});

	it('a reviewer name with no channel reaches nobody directly — it is refused and raises Unknown channel (B3)', async () => {
		const realm = await RealmService.create(ORG, `r-${uid()}`.slice(0, 40), 'Reviews', { org_id: ORG });
		await expect(HugReviewsService.create({
			run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: ORG,
			reviewers: [{ policy: 'any', channels: ['nobody-here'] }],
		})).rejects.toMatchObject({ status_code: 422 });
		expect(await Review.count()).toBe(0);
		await new Promise((r) => setTimeout(r, 300));
		const inbox = await InAppNotification.findAll({ raw: true });
		expect(inbox.every((n) => n.event === 'notification.unknown_channel' && !n.review_id)).toBe(true);
	});
});
