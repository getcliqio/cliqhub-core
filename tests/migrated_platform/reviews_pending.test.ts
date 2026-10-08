import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));
import request from 'supertest';

import { create_migrated_test_app } from './helpers/test_app.js';
import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { make_hub_bearer, stub_hub_pat_auth } from './helpers/hub_jwt.js';
import { HugReviewsService } from '../../src/services/hug_reviews.service.js';
import { ReviewPendingService } from '../../src/services/review_pending.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
	NotificationChannel,
	Realm,
	RealmMember,
	Review,
	ReviewNotification,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const { app, repos } = create_migrated_test_app();
const uid = () => `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('POST /v1/reviews/get', () => {
	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
		stub_hub_pat_auth(repos);
		repos.user_repo.find_profile_by_id.mockResolvedValue({
			id: hub_legacy_uuid(1),
			username: 'migrated-platform-user',
			display_name: 'Migrated Platform User',
			email: 'platform@test.local',
			role: 'user',
			suspended_at: null,
			suspended_reason: '',
			created_at: new Date().toISOString(),
		});
	});

	beforeEach(async () => {
		if (!has_postgres) return;
		await ReviewNotification.destroy({ where: {} });
		await Review.destroy({ where: {} });
		await NotificationChannel.destroy({ where: {} });
		await RealmMember.destroy({ where: {} });
		await Realm.destroy({ where: {} });
	});

	afterAll(async () => {
		if (!has_postgres) return;
		await ReviewNotification.destroy({ where: {} });
		await Review.destroy({ where: {} });
		await NotificationChannel.destroy({ where: {} });
		await close_test_control_plane_store();
	});

	it('requires auth', async () => {
		const res = await request(app).post('/v1/reviews/get').send({});
		expect(res.status).toBe(401);
	});

	it('input pause (an agent question): PASS supplies the answer; REJECT cancels the run instead of parking it', async () => {
		const { DispatchService } = await import('../../src/services/dispatch.service.js');
		const supply = vi.spyOn(DispatchService, 'supply_inputs').mockResolvedValue(undefined as never);
		const cancel = vi.spyOn(DispatchService, 'cancel_run').mockResolvedValue({ cancelled: true, mode: 'queued' });
		try {
			const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Question');
			const ask = () => HugReviewsService.create({
				run_id: 'run-q', daemon_id: 'daemon-1', realm_id: realm.id, mode: 'input_pause',
				payload: { phase: 'implement', mode: 'input_pause', summary: 'Use Redis?' },
				timeout_minutes: 60, actor_id: hub_legacy_uuid(1),
			} as never);
			const notif = async (review_id: string) => (await ReviewNotification.findOne({ where: { review_id } }))!.id;

			const answered = await ask();
			await HugReviewsService.submit_verdict({
				review_id: answered.review_id, action: 'PASS', actor_id: hub_legacy_uuid(1), responded_by: hub_legacy_uuid(1),
				notification_id: await notif(answered.review_id), fields: { values: { answer: 'DB queue' } },
			} as never);
			expect(supply).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'run-q', inputs: { answer: 'DB queue' } }));
			expect(cancel).not.toHaveBeenCalled();

			const declined = await ask();
			await HugReviewsService.submit_verdict({
				review_id: declined.review_id, action: 'REJECT', actor_id: hub_legacy_uuid(1), responded_by: hub_legacy_uuid(1),
				notification_id: await notif(declined.review_id), fields: { comment: 'out of scope' },
			} as never);
			expect(cancel).toHaveBeenCalledWith('run-q', [], hub_legacy_uuid(1), 'Input request declined: out of scope');
		} finally {
			supply.mockRestore();
			cancel.mockRestore();
		}
	});

	it('pending review appears; verdict removes from pending list after completed', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Reviews');
		const created = await HugReviewsService.create({
			run_id: 'run-1',
			daemon_id: 'daemon-1',
			realm_id: realm.id,
			payload: { phase: 'human-review' },
			timeout_minutes: 60,
			actor_id: hub_legacy_uuid(1),
		});

		/** No explicit reviewers → per-member fan-out: one notification row
		 *  per realm user member (owner = user 1). */
		const broadcast_notif = (await ReviewNotification.findOne({
			where: { review_id: created.review_id },
		}))!;
		expect(broadcast_notif.user_id).toBe(hub_legacy_uuid(1));

		const open = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(open.reviews).toHaveLength(1);
		expect(open.reviews[0].review_id).toBe(created.review_id);
		expect(open.reviews[0].run_id).toBe('run-1');
		expect(open.reviews[0].review_url).toContain(`/reviews/${created.review_id}`);
		expect(open.reviews[0].notification_id).toBe(broadcast_notif.id);

		const res = await request(app)
			.post('/v1/reviews/get')
			.set('Authorization', make_hub_bearer())
			.send({ realm_id: realm.id });
		expect(res.status).toBe(200);
		expect(res.body.data?.items ?? res.body.reviews).toHaveLength(1);

		await HugReviewsService.submit_verdict({
			review_id: created.review_id,
			action: 'PASS',
			reviewer_name: 'Alice',
			actor_id: hub_legacy_uuid(1),
			notification_id: broadcast_notif.id,
			responded_by: hub_legacy_uuid(1),
		});
		/** Decided reviews are only listed when explicitly requested — the
		 *  default status filter is ['pending']. */
		const decided = await ReviewPendingService.list_for_user({
			user_id: hub_legacy_uuid(1),
			statuses: ['decided'],
		});
		expect(decided.reviews).toHaveLength(1);
		expect(decided.reviews[0].review_id).toBe(created.review_id);

		await HugReviewsService.ack(created.review_id, 'run-1');
		expect(
			(await ReviewPendingService.list_for_user({
				user_id: hub_legacy_uuid(1),
				statuses: ['pending', 'decided'],
			})).reviews,
		).toHaveLength(0);
	});

	it('expired pending is filtered out', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Expire');
		const id = `expired-${uid()}`;
		await Review.create({
			id,
			run_id: 'run-x',
			daemon_id: null,
			realm_id: realm.id,
			payload: {},
			verdict: null,
			status: 'pending',
			route_targets: null,
			created_at: new Date(Date.now() - 3600_000),
			timeout_at: new Date(Date.now() - 60_000),
			completed_at: null,
		});
		const pending = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(pending.reviews).toHaveLength(0);
	});

	it('non-member of realm does not see pending', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(2), `r-${uid()}`.slice(0, 40), 'Other');
		await HugReviewsService.create({
			run_id: 'run-2',
			daemon_id: 'd-2',
			realm_id: realm.id,
			payload: {},
			timeout_minutes: 60,
		});
		const pending = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(pending.reviews).toHaveLength(0);
	});

	it('realm-broadcast fallback: review with no reviewers is visible to every realm member', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Broadcast');
		/** User 1 is the realm owner (auto-added). Add user 2 as a plain member. */
		await RealmMember.create({
			id: `rm-${uid()}`,
			realm_id: realm.id,
			member_type: 'user',
			member_id: hub_legacy_uuid(2),
			role: 'operator',
			created_at: Date.now(),
		});

		const created = await HugReviewsService.create({
			run_id: 'run-broadcast',
			daemon_id: 'd-broadcast',
			realm_id: realm.id,
			payload: { phase: 'human-review', message: 'Broadcast fallback test' },
			timeout_minutes: 60,
		});

		/** One notification row per realm user member (user_id set). */
		const notif_rows = await ReviewNotification.findAll({
			where: { review_id: created.review_id },
			order: [['user_id', 'ASC']],
		});
		expect(notif_rows).toHaveLength(2);
		expect(notif_rows.map((r) => r.user_id).sort()).toEqual([hub_legacy_uuid(1), hub_legacy_uuid(2)].sort());
		expect(notif_rows.every((r) => r.user_id !== null)).toBe(true);

		const u1 = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(u1.reviews).toHaveLength(1);
		expect(u1.reviews[0].review_id).toBe(created.review_id);
		expect(u1.reviews[0].notification_id).toBe(
			notif_rows.find((r) => r.user_id === hub_legacy_uuid(1))!.id,
		);

		const u2 = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(2) });
		expect(u2.reviews).toHaveLength(1);
		expect(u2.reviews[0].review_id).toBe(created.review_id);
		expect(u2.reviews[0].notification_id).toBe(
			notif_rows.find((r) => r.user_id === hub_legacy_uuid(2))!.id,
		);
	});

	it('realm-broadcast fallback: non-member of the review realm still cannot see it', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(2), `r-${uid()}`.slice(0, 40), 'ScopedOut');
		await HugReviewsService.create({
			run_id: 'run-scoped',
			daemon_id: 'd-scoped',
			realm_id: realm.id,
			payload: { phase: 'human-review' },
			timeout_minutes: 60,
		});
		/** User 1 is not a member of the realm above (owned by org '2', user 1 is org 1). */
		const pending = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(pending.reviews).toHaveLength(0);
	});

	it('realm-broadcast verdict: realm member is authorized; outsider is forbidden', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'BroadcastAuth');
		const created = await HugReviewsService.create({
			run_id: 'run-auth',
			daemon_id: 'd-auth',
			realm_id: realm.id,
			payload: { phase: 'human-review' },
			timeout_minutes: 60,
		});
		const notif = (await ReviewNotification.findOne({
			where: { review_id: created.review_id },
		}))!;

		/** User 1 is a member (realm owner). */
		await expect(
			HugReviewsService.authorize_verdict_via_notification(
				notif.id, created.review_id, hub_legacy_uuid(1),
			),
		).resolves.toBeUndefined();

		/** User 99 is not a member — should be forbidden. */
		await expect(
			HugReviewsService.authorize_verdict_via_notification(
				notif.id, created.review_id, hub_legacy_uuid(99),
			),
		).rejects.toMatchObject({ status_code: 403 });
	});

	it('a REJECT decides at once: first response under `any`; one reject under `all` (no waiting for approvals)', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Verdicts');
		const channel = async () => {
			const name = `rv-${uid()}`.slice(0, 30);
			await NotificationChannel.create({ id: `ch-${uid()}`, realm_id: null, org_id: hub_legacy_uuid(1), user_id: null, name, enabled: 1, created_at: Date.now(), updated_at: Date.now() });
			return name;
		};
		const review_for = async (policy: 'any' | 'all') => {
			const created = await HugReviewsService.create({
				run_id: `run-${policy}-${uid()}`, daemon_id: 'd-verdict', realm_id: realm.id, org_id: hub_legacy_uuid(1),
				payload: { phase: 'hug-lld' }, timeout_minutes: 30,
				reviewers: [{ policy, channels: [await channel(), await channel()] }],
			});
			const notifs = await ReviewNotification.findAll({ where: { review_id: created.review_id }, order: [['channel_target', 'ASC']] });
			expect(notifs).toHaveLength(2);
			return { id: created.review_id, notifs };
		};
		const respond = (review_id: string, notification_id: string, action: string) => HugReviewsService.submit_verdict({
			review_id, action, notification_id, actor_id: hub_legacy_uuid(1), responded_by: hub_legacy_uuid(1), fields: { comment: 'not ready' },
		} as never);
		const status = async (id: string) => (await Review.findByPk(id))!;

		// `any`: one REJECT from one of two reviewers decides it (it used to wait for an approval, then time out).
		const any = await review_for('any');
		expect(await respond(any.id, any.notifs[0].id, 'REJECT')).toEqual({ status: 'decided' });
		expect((await status(any.id)).status).toBe('decided');
		expect((await status(any.id)).verdict).toMatchObject({ action: 'REJECT', comment: 'not ready' });

		// `all`: one approval of two waits; a REJECT from the other decides it straight away.
		const all = await review_for('all');
		expect(await respond(all.id, all.notifs[0].id, 'PASS')).toEqual({ status: 'pending' });
		expect(await respond(all.id, all.notifs[1].id, 'REJECT')).toEqual({ status: 'decided' });
		expect((await status(all.id)).verdict).toMatchObject({ action: 'REJECT' });

		// `all` still passes only when everyone approves; a send-back decides like a reject.
		const both = await review_for('all');
		expect(await respond(both.id, both.notifs[0].id, 'PASS')).toEqual({ status: 'pending' });
		expect(await respond(both.id, both.notifs[1].id, 'PASS')).toEqual({ status: 'decided' });
		const back = await review_for('any');
		expect(await respond(back.id, back.notifs[1].id, 'ROUTE:design')).toEqual({ status: 'decided' });
	});

	it('review with explicit reviewers does NOT get the broadcast fallback', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Explicit');
		/** Seed a named org-scoped channel so reviewer resolution succeeds
		 *  without needing DB-level user/org_member seeding. */
		const channel_name = `ops-${uid()}`.slice(0, 30);
		await NotificationChannel.create({
			id: `ch-${uid()}`,
			realm_id: null,
			org_id: hub_legacy_uuid(1),
			user_id: null,
			name: channel_name,
			enabled: 1,
			created_at: Date.now(),
			updated_at: Date.now(),
		});

		const created = await HugReviewsService.create({
			run_id: 'run-explicit',
			daemon_id: 'd-explicit',
			realm_id: realm.id,
			org_id: hub_legacy_uuid(1),
			payload: { phase: 'human-review' },
			timeout_minutes: 60,
			reviewers: [{ policy: 'any', channels: [channel_name] }],
		});

		const notif_rows = await ReviewNotification.findAll({
			where: { review_id: created.review_id },
		});
		expect(notif_rows).toHaveLength(1);
		/** Explicit channel target — NOT the realm-broadcast fallback. */
		expect(notif_rows[0].channel_target).toBe(channel_name);
		expect(notif_rows[0].channel_id).not.toBe(`cliqhub-${realm.id}`);
	});

	it('expire_pending_for_run removes input HUGs from pending list', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Expire');
		const created = await HugReviewsService.create({
			run_id: 'run-cancel-hug',
			daemon_id: 'daemon-1',
			realm_id: realm.id,
			payload: { phase: 'input', mode: 'input_pause', event: 'phase.input_required' },
			timeout_minutes: 60,
			mode: 'input_pause',
			actor_id: hub_legacy_uuid(1),
		});

		const before = await ReviewPendingService.count_pending_for_user({ user_id: hub_legacy_uuid(1) });
		expect(before).toBeGreaterThanOrEqual(1);

		const n = await HugReviewsService.expire_pending_for_run('run-cancel-hug');
		expect(n).toBeGreaterThanOrEqual(1);

		const row = await Review.findByPk(created.review_id);
		expect(row?.status).toBe('expired');

		const after = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(after.reviews.find((r) => r.review_id === created.review_id)).toBeUndefined();

		const remind = await HugReviewsService.remind(created.review_id);
		expect(remind.ok).toBe(false);
	});

	it('filters: realm_id, org_id and statuses narrow the caller’s own reviews; others see none', async () => {
		const realm_1 = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'One');
		const realm_2 = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Two');
		const org_x = hub_legacy_uuid(901);
		const org_y = hub_legacy_uuid(902);
		const make = (realm_id: string, org_id: string, phase: string) => HugReviewsService.create({
			run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id, org_id,
			payload: { phase }, timeout_minutes: 60, actor_id: hub_legacy_uuid(1),
		});
		const a = await make(realm_1.id, org_x, 'a');
		const b = await make(realm_2.id, org_y, 'b');
		const c = await make(realm_2.id, org_y, 'c');
		const c_notif = (await ReviewNotification.findOne({ where: { review_id: c.review_id } }))!;
		await HugReviewsService.submit_verdict({
			review_id: c.review_id, action: 'PASS', reviewer_name: 'Alice',
			actor_id: hub_legacy_uuid(1), notification_id: c_notif.id, responded_by: hub_legacy_uuid(1),
		});
		const ids = async (opts: Partial<Parameters<typeof ReviewPendingService.list_for_user>[0]>) =>
			(await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1), ...opts })).reviews.map((r) => r.review_id).sort();

		expect(await ids({})).toEqual([a.review_id, b.review_id].sort());
		expect(await ids({ realm_id: realm_1.id })).toEqual([a.review_id]);
		expect(await ids({ org_id: org_y })).toEqual([b.review_id]);
		expect(await ids({ statuses: ['decided'] })).toEqual([c.review_id]);
		expect(await ids({ org_id: org_y, statuses: ['pending', 'decided'] })).toEqual([b.review_id, c.review_id].sort());
		expect(await ids({ realm_id: realm_1.id, org_id: org_y })).toEqual([]);

		expect((await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(2) })).reviews).toHaveLength(0);
		expect(await ReviewPendingService.count_pending_for_user({ user_id: hub_legacy_uuid(2) })).toBe(0);
		expect(await ReviewPendingService.count_pending_for_user({ user_id: hub_legacy_uuid(1), org_id: org_y })).toBe(1);
	});

	it('an ended run closes its reviews: pending → expired, decided → completed', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Ended');
		const run_id = `run-ended-${uid()}`;
		const pending = await HugReviewsService.create({
			run_id, daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p1' }, timeout_minutes: 60, actor_id: hub_legacy_uuid(1),
		});
		const decided = await HugReviewsService.create({
			run_id, daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p2' }, timeout_minutes: 60, actor_id: hub_legacy_uuid(1),
		});
		const decided_notif = (await ReviewNotification.findOne({ where: { review_id: decided.review_id } }))!;
		await HugReviewsService.submit_verdict({
			review_id: decided.review_id, action: 'PASS', reviewer_name: 'Alice',
			actor_id: hub_legacy_uuid(1), notification_id: decided_notif.id, responded_by: hub_legacy_uuid(1),
		});

		expect(await HugReviewsService.close_reviews_for_ended_run(run_id)).toEqual({ expired: 1, completed: 1 });
		expect((await Review.findByPk(pending.review_id))?.status).toBe('expired');
		const closed = await Review.findByPk(decided.review_id);
		expect(closed?.status).toBe('completed');
		expect(closed?.completed_at).toBeTruthy();
		expect(await HugReviewsService.close_reviews_for_ended_run(run_id)).toEqual({ expired: 0, completed: 0 });
	});

	it('per-realm badge count matches the pending list (decided reviews are not counted)', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Badge');
		const pending = await HugReviewsService.create({
			run_id: 'run-badge-pending', daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p1' }, timeout_minutes: 60, actor_id: hub_legacy_uuid(1),
		});
		const decided = await HugReviewsService.create({
			run_id: 'run-badge-decided', daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p2' }, timeout_minutes: 60, actor_id: hub_legacy_uuid(1),
		});
		const decided_notif = (await ReviewNotification.findOne({ where: { review_id: decided.review_id } }))!;
		await HugReviewsService.submit_verdict({
			review_id: decided.review_id, action: 'PASS', reviewer_name: 'Alice',
			actor_id: hub_legacy_uuid(1), notification_id: decided_notif.id, responded_by: hub_legacy_uuid(1),
		});

		const by_realm = await ReviewPendingService.count_pending_by_realm_for_user({
			user_id: hub_legacy_uuid(1), realm_ids: [realm.id],
		});
		const list = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1), realm_id: realm.id });
		expect(by_realm.get(realm.id)).toBe(1);
		expect(list.total).toBe(1);
		expect(list.reviews[0].review_id).toBe(pending.review_id);

		const outsider = await ReviewPendingService.count_pending_by_realm_for_user({
			user_id: hub_legacy_uuid(2), realm_ids: [realm.id],
		});
		expect(outsider.get(realm.id) ?? 0).toBe(0);
	});
});
