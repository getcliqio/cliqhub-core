/**
 * PLAN-channels S3 + S4 — a personal channel emails its owner.
 *
 * S3: a new personal channel has in-app and an email destination with `account: true`, which
 * sends to the owner's *current* account email (read when sending). Only a personal channel can
 * use `account: true`. S4: a one-time boot backfill gives every existing personal channel without
 * an email destination one, tagged `added_by: 'backfill-2026-10'`; it never runs twice, so an
 * email destination removed later stays removed.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { use_test_link_env } from '../helpers/link_env.js';

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
import { NotificationService } from '../../src/services/notification.service.js';
import { ensure_per_user_channel } from '../../src/services/per_user_channel.service.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import { NoopEmailSender } from '../../src/lib/email/noop_email_sender.js';
import type { EmailMessage, EmailSender } from '../../src/lib/email/email_sender.js';
import { destination_schema } from '../../src/notifications/channel_config.js';
import {
	backfill_personal_channel_email,
	PERSONAL_EMAIL_BACKFILL_KEY,
} from '../../src/models/migrations/control_plane_schema_migrations.js';
import {
	ChannelDestination,
	InAppNotification,
	NotificationChannel,
	NotificationRule,
	Realm,
	RealmMember,
	Review,
	ReviewNotification,
	Setting,
	User,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const ORG = hub_legacy_uuid(1);
const KAI = hub_legacy_uuid(71);
const KAI_NAME = 's3kai';
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Records what would have been sent. */
class StubSender implements EmailSender {
	readonly configured = true;
	readonly name = 'stub';
	readonly sent: EmailMessage[] = [];
	async send(message: EmailMessage) {
		this.sent.push(message);
		return { message_id: `<stub-${this.sent.length}@test>` };
	}
}

/** Poll until `fn` returns a truthy value (delivery runs after the review is stored). */
async function eventually<T>(fn: () => Promise<T> | T, ms = 3000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v || Date.now() > end) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function review_to(channel: string): Promise<string> {
	const realm = await RealmService.create(ORG, `r-${uid()}`.slice(0, 40), 'Reviews');
	// Only the named reviewer channel: the realm's own review default (All realm members, which emails its
	// members) would add emails these tests aren't about.
	await NotificationRule.destroy({ where: { realm_id: realm.id, event: 'hug.review_requested' } });
	const created = await HugReviewsService.create({
		run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: realm.id, org_id: ORG,
		payload: { phase: 'human-review' }, timeout_minutes: 60, actor_id: ORG,
		reviewers: [{ policy: 'any', channels: [channel] }],
	});
	return created.review_id;
}

const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;
const recipients = (m: EmailMessage) => m.to.map((a) => a.email);

describe.skipIf(!has_postgres)('PLAN-channels S3/S4: a personal channel emails its owner', () => {
	let stub: StubSender;
	let restore_env: () => void = () => {};

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		// Emails carry a link to the web app.
		restore_env = use_test_link_env();
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
		await User.destroy({ where: { id: KAI }, force: true } as never);
		await User.create({ id: KAI, username: KAI_NAME, email: 'kai@cliq.test', status: 'active', role: 'user', password_hash: 'x' } as never);
		await Setting.destroy({ where: { key: PERSONAL_EMAIL_BACKFILL_KEY } });
		stub = new StubSender();
		email_deliverer.use_sender(stub);
	});

	afterEach(() => { email_deliverer.use_sender(new NoopEmailSender()); });

	afterAll(async () => {
		if (!has_postgres) return;
		await User.destroy({ where: { id: KAI }, force: true } as never);
		await Setting.destroy({ where: { key: PERSONAL_EMAIL_BACKFILL_KEY } });
		await close_test_control_plane_store();
		restore_env();
	});

	// ── S3 ──────────────────────────────────────────────────────────────

	it('a review to the personal channel arrives in-app and by email to the account address', async () => {
		await ensure_per_user_channel(KAI, ORG, KAI_NAME);
		const review_id = await review_to(KAI_NAME);
		expect(await eventually(() => InAppNotification.findOne({ where: { user_id: KAI, review_id }, raw: true }))).toBeTruthy();
		await eventually(() => stub.sent.length > 0);
		expect(stub.sent).toHaveLength(1);
		expect(recipients(stub.sent[0])).toEqual(['kai@cliq.test']);
	});

	it('the address is read when sending: changing the account email changes where the next one goes', async () => {
		await ensure_per_user_channel(KAI, ORG, KAI_NAME);
		await User.update({ email: 'kai.new@cliq.test' }, { where: { id: KAI } });
		await review_to(KAI_NAME);
		await eventually(() => stub.sent.length > 0);
		expect(recipients(stub.sent[0])).toEqual(['kai.new@cliq.test']);
	});

	it('a suspended account gets no email; in-app still arrives', async () => {
		await ensure_per_user_channel(KAI, ORG, KAI_NAME);
		await User.update({ status: 'suspended' }, { where: { id: KAI } });
		const review_id = await review_to(KAI_NAME);
		expect(await eventually(() => InAppNotification.findOne({ where: { user_id: KAI, review_id }, raw: true }))).toBeTruthy();
		await new Promise((r) => setTimeout(r, 300));
		expect(stub.sent).toHaveLength(0);
	});

	it('removing the email destination from the channel stops the email; in-app stays', async () => {
		const id = await ensure_per_user_channel(KAI, ORG, KAI_NAME);
		await NotificationService.update_channel({ id, destinations: [{ type: 'cliqhub' }] });
		const review_id = await review_to(KAI_NAME);
		expect(await eventually(() => InAppNotification.findOne({ where: { user_id: KAI, review_id }, raw: true }))).toBeTruthy();
		await new Promise((r) => setTimeout(r, 300));
		expect(stub.sent).toHaveLength(0);
		// …and an admin can put it back.
		await NotificationService.update_channel({ id, destinations: [{ type: 'cliqhub' }, { type: 'email', account: true }] });
		await review_to(KAI_NAME);
		await eventually(() => stub.sent.length > 0);
		expect(recipients(stub.sent[0])).toEqual(['kai@cliq.test']);
	});

	it('Send test on an email address destination sends to that address', async () => {
		const ch = await NotificationService.create_channel({ org_id: ORG, name: `test-mail-${uid()}`, destinations: [{ type: 'cliqhub' }, { type: 'email', address: 'ops@cliq.test' }] });
		const res = await NotificationService.test_channel(ch.id);
		expect(res).toEqual({ delivered: 2, errors: [] });
		expect(stub.sent).toHaveLength(1);
		expect(recipients(stub.sent[0])).toEqual(['ops@cliq.test']);
	});

	it('Send test on a personal channel’s account email sends to the owner', async () => {
		const id = await ensure_per_user_channel(KAI, ORG, KAI_NAME);
		const res = await NotificationService.test_channel(id);
		expect(res.errors).toEqual([]);
		expect(stub.sent).toHaveLength(1);
		expect(recipients(stub.sent[0])).toEqual(['kai@cliq.test']);
	});

	it('account: true is only for a personal channel; an email destination needs exactly one of address / account', async () => {
		await expect(NotificationService.create_channel({ org_id: ORG, name: 'shared-mail', destinations: [{ type: 'email', account: true }] }))
			.rejects.toMatchObject({ status: 400 });
		const shared = await NotificationService.create_channel({ org_id: ORG, name: 'shared-ok', destinations: [{ type: 'cliqhub' }] });
		await expect(NotificationService.update_channel({ id: shared.id, destinations: [{ type: 'email', account: true }] }))
			.rejects.toMatchObject({ status: 400 });
		expect(destination_schema.safeParse({ type: 'email', address: 'a@b.c' }).success).toBe(true);
		expect(destination_schema.safeParse({ type: 'email', account: true }).success).toBe(true);
		expect(destination_schema.safeParse({ type: 'email' }).success).toBe(false);
		expect(destination_schema.safeParse({ type: 'email', address: 'a@b.c', account: true }).success).toBe(false);
	});

	it('a shared channel with a fixed address still emails that address', async () => {
		await NotificationService.create_channel({ org_id: ORG, name: 'qa-fixed', destinations: [{ type: 'email', address: 'qa@cliq.test' }] });
		await review_to('qa-fixed');
		await eventually(() => stub.sent.length > 0);
		expect(recipients(stub.sent[0])).toEqual(['qa@cliq.test']);
	});

	// ── S4 ──────────────────────────────────────────────────────────────

	/** A personal channel as it is in prod today: in-app only. */
	async function legacy_personal_channel(): Promise<string> {
		const id = await ensure_per_user_channel(KAI, ORG, KAI_NAME);
		await ChannelDestination.destroy({ where: { channel_id: id, type: 'email' } });
		return id;
	}

	const email_rows = (channel_id: string) => ChannelDestination.findAll({ where: { channel_id, type: 'email' }, raw: true });

	it('backfill: an in-app-only personal channel gets a tagged account email; shared channels are untouched', async () => {
		const id = await legacy_personal_channel();
		const shared = await NotificationService.create_channel({ org_id: ORG, name: 'shared-inapp', destinations: [{ type: 'cliqhub' }] });
		await backfill_personal_channel_email(NotificationChannel.sequelize!);
		expect((await email_rows(id)).map((d) => d.config)).toEqual([{ account: true, added_by: 'backfill-2026-10' }]);
		expect(await email_rows(shared.id)).toHaveLength(0);
		expect(await Setting.findByPk(PERSONAL_EMAIL_BACKFILL_KEY)).toBeTruthy();
	});

	it('backfill runs once: a second run adds nothing, and an email removed afterwards stays removed', async () => {
		const id = await legacy_personal_channel();
		await backfill_personal_channel_email(NotificationChannel.sequelize!);
		await backfill_personal_channel_email(NotificationChannel.sequelize!);
		expect(await email_rows(id)).toHaveLength(1);
		await ChannelDestination.destroy({ where: { channel_id: id, type: 'email' } });
		await backfill_personal_channel_email(NotificationChannel.sequelize!);
		expect(await email_rows(id)).toHaveLength(0);
	});

	it('backfill leaves a channel that already has an email destination as it is', async () => {
		const id = await ensure_per_user_channel(KAI, ORG, KAI_NAME);
		await backfill_personal_channel_email(NotificationChannel.sequelize!);
		expect((await email_rows(id)).map((d) => d.config)).toEqual([{ account: true }]);
	});
});
