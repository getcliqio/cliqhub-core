/**
 * PLAN-notifications-v2 A4 — a built-in channel's email (`members: true`) goes to each of its members at
 * their own account address: one email per person, following membership at send time; suspended and
 * deleted accounts are left out; a failure for one person doesn't stop the rest. End to end: the fixed
 * Unknown channel rule reaches the realm in-app and by email.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { RealmService } from '../../src/services/realm.service.js';
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { EventSubmitService } from '../../src/services/events_service.js';
import { OrgSeedService } from '../../src/services/org_seed.service.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import { NoopEmailSender } from '../../src/lib/email/noop_email_sender.js';
import { EmailSendError, type EmailMessage, type EmailSender } from '../../src/lib/email/email_sender.js';
import { ORG_IN_APP_CHANNEL_KEY, realm_members_channel_id } from '../../src/notifications/defaults.js';
import { ChannelDestination, InAppNotification, NotificationChannel, NotificationRule, Org, OrgMember, Realm, RealmMember, User } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

class StubSender implements EmailSender {
	readonly configured = true;
	readonly name = 'stub';
	readonly sent: EmailMessage[] = [];
	/** Addresses whose send fails. */
	fail = new Set<string>();
	async send(message: EmailMessage) {
		if (message.to.some((a) => this.fail.has(a.email))) throw new EmailSendError('rejected', 'refused');
		this.sent.push(message);
		return { message_id: `<stub-${this.sent.length}@test>` };
	}
}

const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;
const payload = { event: 'run.failed', title: 'Run failed', message: 'boom' };

describe.skipIf(!has_postgres)('A4 — email to a built-in channel\'s members', () => {
	let stub: StubSender;
	let restore_env: () => void = () => {};
	const users: string[] = [];
	const realms: string[] = [];
	const orgs: string[] = [];

	async function person(status = 'active', deleted = false) {
		const id = randomUUID();
		const name = `m${uid()}`.replace(/[^a-z0-9]/g, '').slice(0, 20);
		await User.create({ id, username: name, email: `${name}@cliq.test`, status, role: 'user', password_hash: 'x', ...(deleted ? { deleted_at: new Date() } : {}) } as never);
		users.push(id);
		return { id, email: `${name}@cliq.test` };
	}
	async function realm_with(members: Array<{ id: string }>) {
		const realm = await RealmService.create(OWNER, `em-${uid()}`.slice(0, 40), 'Email members');
		realms.push(realm.id);
		for (const m of members) await RealmMember.create({ id: `${realm.id}:${m.id}`, realm_id: realm.id, member_type: 'user', member_id: m.id, role: 'member', created_at: Date.now() } as never);
		return realm.id;
	}
	const sent_to = () => stub.sent.map((m) => m.to.map((a) => a.email));

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		restore_env = use_test_link_env();
		await open_test_control_plane_store();
	});
	beforeEach(() => { stub = new StubSender(); email_deliverer.use_sender(stub); });
	afterEach(() => { email_deliverer.use_sender(new NoopEmailSender()); });
	afterAll(async () => {
		if (!has_postgres) return;
		const channels = [...realms.map(realm_members_channel_id), ...(await NotificationChannel.findAll({ where: { org_id: orgs }, attributes: ['id'], raw: true })).map((c) => c.id)];
		await InAppNotification.destroy({ where: { realm_id: realms } });
		await NotificationRule.destroy({ where: { realm_id: realms } });
		await ChannelDestination.destroy({ where: { channel_id: channels } });
		await NotificationChannel.destroy({ where: { id: channels } });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await OrgMember.destroy({ where: { org_id: orgs } });
		await Org.destroy({ where: { id: orgs } });
		await NotificationChannel.destroy({ where: { user_id: users } as never });
		await User.destroy({ where: { id: users }, force: true } as never);
		await close_test_control_plane_store();
		restore_env();
	});

	it('a realm channel: one email per member, each only to that person; suspended and deleted accounts left out', async () => {
		const amy = await person();
		const bo = await person();
		const sus = await person('suspended');
		const gone = await person('active', true);
		const realm_id = await realm_with([amy, bo, sus, gone]);

		await email_deliverer.deliver({ members: true }, payload, { channel_id: realm_members_channel_id(realm_id) });

		const to = sent_to();
		expect(to.every((list) => list.length === 1)).toBe(true);
		expect(to.flat()).toEqual(expect.arrayContaining([amy.email, bo.email]));
		expect(to.flat()).not.toContain(sus.email);
		expect(to.flat()).not.toContain(gone.email);
		expect(stub.sent.every((m) => !m.cc?.length && !m.bcc?.length)).toBe(true);
	});

	it('follows membership: someone who left gets nothing, someone who joined gets it', async () => {
		const amy = await person();
		const bo = await person();
		const realm_id = await realm_with([amy]);
		await RealmMember.destroy({ where: { realm_id, member_id: amy.id } });
		await RealmMember.create({ id: `${realm_id}:${bo.id}`, realm_id, member_type: 'user', member_id: bo.id, role: 'member', created_at: Date.now() } as never);

		await email_deliverer.deliver({ members: true }, payload, { channel_id: realm_members_channel_id(realm_id) });
		expect(sent_to().flat()).toContain(bo.email);
		expect(sent_to().flat()).not.toContain(amy.email);
	});

	it('an org channel reaches the org\'s active members only', async () => {
		const org = await Org.create({ id: randomUUID(), slug: `emo-${uid()}`.slice(0, 40), display_name: 'Email org', activated_at: new Date() } as never);
		orgs.push(org.id);
		await OrgSeedService.seed_org(org.id, { account: false });
		const amy = await person();
		const pending = await person();
		const outsider = await person();
		await OrgMember.create({ org_id: org.id, user_id: amy.id, role: 'member', status: 'active' } as never);
		await OrgMember.create({ org_id: org.id, user_id: pending.id, role: 'member', status: 'pending' } as never);
		const channel = (await NotificationChannel.findOne({ where: { org_id: org.id, system_key: ORG_IN_APP_CHANNEL_KEY }, raw: true }))!;

		await email_deliverer.deliver({ members: true }, payload, { channel_id: channel.id });
		expect(sent_to().flat()).toContain(amy.email);
		expect(sent_to().flat()).not.toContain(pending.email);
		expect(sent_to().flat()).not.toContain(outsider.email);
	});

	it('one failed send doesn\'t stop the rest; only when every send fails does delivery fail', async () => {
		const amy = await person();
		const bo = await person();
		const realm_id = await realm_with([amy, bo]);
		const channel_id = realm_members_channel_id(realm_id);

		stub.fail = new Set([amy.email]);
		await expect(email_deliverer.deliver({ members: true }, payload, { channel_id })).resolves.toBeUndefined();
		expect(sent_to().flat()).toContain(bo.email);

		const everyone = (await RealmMember.findAll({ where: { realm_id, member_type: 'user' }, raw: true })).map((m) => String(m.member_id));
		const emails = (await User.findAll({ where: { id: everyone }, raw: true })).map((u) => String(u.email));
		stub.fail = new Set(emails);
		await expect(email_deliverer.deliver({ members: true }, payload, { channel_id })).rejects.toThrow(/email delivery failed/);
	});

	it('end to end: Unknown channel, sent to the realm\'s members by a rule, reaches them in-app and by email their way', async () => {
		const amy = await person();
		// Members are reached their way: through their personal channel (account email by default).
		await ensure_personal_channel(amy.id, amy.email.split('@')[0]);
		const realm_id = await realm_with([amy]);
		// Nothing goes there by default any more; the realm sends it.
		const { NotificationService } = await import('../../src/services/notification.service.js');
		await NotificationService.set_rule({ realm_id, event: 'notification.unknown_channel', channel_id: realm_members_channel_id(realm_id) });

		const ev = await EventSubmitService.submit({
			type: 'notification.unknown_channel', realm_id, run_id: `run-${uid()}`,
			title: 'Unknown channel', message: "No channel named 'nobody-here' in this realm",
			payload: { name: 'nobody-here' } as never,
		}, { system: true });
		expect(ev.notifications).toBe('dispatched');
		expect(await InAppNotification.count({ where: { realm_id } })).toBeGreaterThan(0);
		expect(sent_to().flat()).toContain(amy.email);
	});
});
