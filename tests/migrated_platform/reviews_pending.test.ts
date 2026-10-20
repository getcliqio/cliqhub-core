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
import { REALM_MEMBERS_CHANNEL_NAME } from '../../src/notifications/defaults.js';
import { no_channel_message } from '../../src/notifications/unknown_channel.js';
import { ReviewPendingService } from '../../src/services/review_pending.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
	HubEvent,
	NotificationChannel,
	Org,
	NotificationRule,
	Realm,
	RealmMember,
	Review,
	ReviewNotification,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
/** Reviewers that reach every member of the realm (its built-in channel). */
const ALL_MEMBERS = [{ policy: 'any' as const, channels: [REALM_MEMBERS_CHANNEL_NAME] }];
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
		await NotificationRule.destroy({ where: {} });
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
			const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Question', { org_id: hub_legacy_uuid(1) });
			const ask = () => HugReviewsService.create({ reviewers: ALL_MEMBERS,
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
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Reviews', { org_id: hub_legacy_uuid(1) });

		/** Seed a named channel for the explicit reviewer. */
		const ch_name = `rev-${uid()}`.slice(0, 30);
		await NotificationChannel.create({
			id: `ch-${uid()}`,
			realm_id: null,
			org_id: hub_legacy_uuid(1),
			user_id: null,
			name: ch_name,
			enabled: 1,
			created_at: Date.now(),
			updated_at: Date.now(),
		});

		const created = await HugReviewsService.create({
			run_id: 'run-1',
			daemon_id: 'daemon-1',
			realm_id: realm.id,
			payload: { phase: 'human-review' },
			timeout_minutes: 60,
			actor_id: hub_legacy_uuid(1),
			reviewers: [{ policy: 'any', channels: [ch_name] }],
		});

		const notif = (await ReviewNotification.findOne({
			where: { review_id: created.review_id },
		}))!;

		const open = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(open.reviews).toHaveLength(1);
		expect(open.reviews[0].review_id).toBe(created.review_id);
		expect(open.reviews[0].run_id).toBe('run-1');
		expect(open.reviews[0].review_url).toContain(`/reviews/${created.review_id}`);

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
			notification_id: notif.id,
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
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Expire', { org_id: hub_legacy_uuid(1) });
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
		await HugReviewsService.create({ reviewers: ALL_MEMBERS,
			run_id: 'run-2',
			daemon_id: 'd-2',
			realm_id: realm.id,
			payload: {},
			timeout_minutes: 60,
		});
		const pending = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(pending.reviews).toHaveLength(0);
	});

	it('a review to the realm\'s All realm members channel: every member can answer it, an outsider can\'t', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Default reviewers', { org_id: hub_legacy_uuid(1) });
		await RealmMember.create({
			id: `rm-${uid()}`, realm_id: realm.id, member_type: 'user', member_id: hub_legacy_uuid(2), role: 'operator', created_at: Date.now(),
		});
		const created = await HugReviewsService.create({
			run_id: 'run-default', daemon_id: 'd-default', realm_id: realm.id, payload: { phase: 'human-review' }, timeout_minutes: 60,
			reviewers: ALL_MEMBERS,
		});
		const rows = await ReviewNotification.findAll({ where: { review_id: created.review_id } });
		expect(rows.map((r) => ({ channel_id: r.channel_id, user_id: r.user_id }))).toEqual([{ channel_id: `cliqhub-${realm.id}`, user_id: null }]);

		for (const member of [hub_legacy_uuid(1), hub_legacy_uuid(2)]) {
			const listed = await ReviewPendingService.list_for_user({ user_id: member });
			expect(listed.reviews.map((r) => r.review_id)).toContain(created.review_id);
			await expect(HugReviewsService.authorize_verdict_via_notification(rows[0].id, created.review_id, member)).resolves.toBeUndefined();
		}
		const outsider = hub_legacy_uuid(3);
		expect((await ReviewPendingService.list_for_user({ user_id: outsider })).reviews).toHaveLength(0);
		await expect(HugReviewsService.authorize_verdict_via_notification(rows[0].id, created.review_id, outsider)).rejects.toMatchObject({ status_code: 403 });
	});

	it('a review that names no channel is refused and raises Unknown channel — nobody is worked out instead (B4.3)', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Nobody', { org_id: hub_legacy_uuid(1) });
		await expect(HugReviewsService.create({
			run_id: 'run-nobody', daemon_id: 'd-nobody', realm_id: realm.id, payload: { phase: 'human-review' }, timeout_minutes: 60,
		})).rejects.toMatchObject({ status_code: 422, message: no_channel_message('human-review') });
		expect(await Review.count({ where: { run_id: 'run-nobody' } })).toBe(0);
		const notices = await HubEvent.findAll({ where: { type: 'notification.unknown_channel', run_id: 'run-nobody' }, raw: true });
		expect(notices.map((e) => e.message)).toEqual([no_channel_message('human-review')]);
	});

	it('an input Hug to another shared channel of the realm: its members see and answer it there', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Leads', { org_id: hub_legacy_uuid(1) });
		const leads = `ch-${uid()}`;
		const leads_name = `leads-${uid()}`.slice(0, 30);
		await NotificationChannel.create({
			id: leads, realm_id: realm.id, org_id: null, user_id: null, name: leads_name, enabled: 1, created_at: Date.now(), updated_at: Date.now(),
		});

		const created = await HugReviewsService.create({
			run_id: 'run-leads', daemon_id: 'd-leads', realm_id: realm.id, mode: 'input_pause', payload: { phase: 'implement', summary: 'Which DB?' }, timeout_minutes: 60,
			reviewers: [{ policy: 'any', channels: [leads_name] }],
		} as never);
		const rows = await ReviewNotification.findAll({ where: { review_id: created.review_id } });
		expect(rows.map((r) => r.channel_id)).toEqual([leads]);
		const listed = await ReviewPendingService.list_for_user({ user_id: hub_legacy_uuid(1) });
		expect(listed.reviews.find((r) => r.review_id === created.review_id)?.notification_id).toBe(rows[0].id);
	});

	it('a REJECT decides at once: first response under `any`; one reject under `all` (no waiting for approvals)', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Verdicts', { org_id: hub_legacy_uuid(1) });
		const channel = async () => {
			const name = `rv-${uid()}`.slice(0, 30);
			await NotificationChannel.create({ id: `ch-${uid()}`, realm_id: null, org_id: hub_legacy_uuid(1), user_id: null, name, enabled: 1, created_at: Date.now(), updated_at: Date.now() });
			return name;
		};
		const review_for = async (policy: 'any' | 'all') => {
			const created = await HugReviewsService.create({
				run_id: `run-${policy}-${uid()}`, daemon_id: 'd-verdict', realm_id: realm.id,
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
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Explicit', { org_id: hub_legacy_uuid(1) });
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
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Expire', { org_id: hub_legacy_uuid(1) });
		const created = await HugReviewsService.create({ reviewers: ALL_MEMBERS,
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
		const realm_1 = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'One', { org_id: hub_legacy_uuid(1) });
		const realm_2 = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Two', { org_id: hub_legacy_uuid(1) });
		const org_x = hub_legacy_uuid(901);
		const org_y = hub_legacy_uuid(902);
		// A Hug's org is its realm's: put each realm in its own org.
		for (const [id, slug] of [[org_x, 'filt-x'], [org_y, 'filt-y']]) {
			await Org.findOrCreate({ where: { id }, defaults: { id, slug: `${slug}-${uid()}`.slice(0, 40), display_name: slug, activated_at: new Date() } as never });
		}
		await Realm.update({ org_id: org_x }, { where: { id: realm_1.id } });
		await Realm.update({ org_id: org_y }, { where: { id: realm_2.id } });
		const make = (realm_id: string, phase: string) => HugReviewsService.create({ reviewers: ALL_MEMBERS,
			run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id,
			payload: { phase, mode: 'input_pause' }, timeout_minutes: 60,
			mode: 'input_pause', actor_id: hub_legacy_uuid(1),
		});
		const a = await make(realm_1.id, 'a');
		const b = await make(realm_2.id, 'b');
		const c = await make(realm_2.id, 'c');
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
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Ended', { org_id: hub_legacy_uuid(1) });
		const run_id = `run-ended-${uid()}`;
		const pending = await HugReviewsService.create({ reviewers: ALL_MEMBERS,
			run_id, daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p1', mode: 'input_pause' }, timeout_minutes: 60,
			mode: 'input_pause', actor_id: hub_legacy_uuid(1),
		});
		const decided = await HugReviewsService.create({ reviewers: ALL_MEMBERS,
			run_id, daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p2', mode: 'input_pause' }, timeout_minutes: 60,
			mode: 'input_pause', actor_id: hub_legacy_uuid(1),
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
		const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'Badge', { org_id: hub_legacy_uuid(1) });
		const pending = await HugReviewsService.create({ reviewers: ALL_MEMBERS,
			run_id: 'run-badge-pending', daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p1', mode: 'input_pause' }, timeout_minutes: 60,
			mode: 'input_pause', actor_id: hub_legacy_uuid(1),
		});
		const decided = await HugReviewsService.create({ reviewers: ALL_MEMBERS,
			run_id: 'run-badge-decided', daemon_id: 'daemon-1', realm_id: realm.id,
			payload: { phase: 'p2', mode: 'input_pause' }, timeout_minutes: 60,
			mode: 'input_pause', actor_id: hub_legacy_uuid(1),
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
