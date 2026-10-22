/**
 * PLAN-personal-channel, Core B — on a real Postgres:
 *  - "All realm members" reaches each member their way: one shared in-app notice for the realm (no personal
 *    in-app copies), plus each member's personal channel's other destinations (account email, Slack…).
 *  - Once per event: the same email address, Slack URL or inbox gets the event once, however many channels
 *    reach it.
 *  - Suspended members aren't reached; the one-time cleanup drops the built-ins' own "email every member".
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { use_test_link_env } from '../helpers/link_env.js';

vi.mock('../../src/auth/password.js', () => ({
	hash_password: vi.fn().mockResolvedValue('hash'),
	verify_password: vi.fn().mockResolvedValue(true),
}));

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { RealmService } from '../../src/services/realm.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { NotificationFanOutService } from '../../src/notifications/fan_out.service.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import { NoopEmailSender } from '../../src/lib/email/noop_email_sender.js';
import type { EmailMessage, EmailSender } from '../../src/lib/email/email_sender.js';
import { realm_members_channel_id } from '../../src/notifications/defaults.js';
import { ChannelDestination, InAppNotification, NotificationChannel, Realm, RealmMember, Setting, User } from '../../src/models/index.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { BUILTIN_MEMBERS_THEIR_WAY_MIGRATION_KEY, migrate_builtin_members_their_way } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

class StubSender implements EmailSender {
	readonly configured = true;
	readonly name = 'stub';
	readonly sent: EmailMessage[] = [];
	async send(message: EmailMessage) { this.sent.push(message); return { message_id: `<s-${this.sent.length}@t>` }; }
}
const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;

describe.skipIf(!has_postgres)('members reached their way; once per event', () => {
	let stub: StubSender;
	let restore_env: () => void = () => {};
	let posts: string[];
	const users: string[] = [];
	const realms: string[] = [];
	const channels: string[] = [];

	async function person(status = 'active') {
		const id = randomUUID();
		const name = `w${uid()}`.replace(/[^a-z0-9]/g, '').slice(0, 20);
		await User.create({ id, username: name, email: `${name}@cliq.test`, status, role: 'user', password_hash: 'x' } as never);
		users.push(id);
		const channel_id = await ensure_personal_channel(id, name);
		return { id, email: `${name}@cliq.test`, channel_id };
	}
	async function realm_with(members: Array<{ id: string }>) {
		const realm = await RealmService.create(OWNER, `mw-${uid()}`.slice(0, 40), 'Their way');
		realms.push(realm.id);
		for (const m of members) await RealmMember.create({ id: `${realm.id}:${m.id}`, realm_id: realm.id, member_type: 'user', member_id: m.id, role: 'member', created_at: Date.now() } as never);
		return realm.id;
	}
	// The realm's creator is a member too (reached their way); these tests look at the people they add.
	let owner_email = '';
	const emailed = () => stub.sent.flatMap((m) => [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map((a) => a.email)).filter((e) => e !== owner_email).sort();
	const send = (realm_id: string, ids: string[]) => NotificationFanOutService.deliver_to_channels(ids, { type: 'run.failed', realm_id, title: 'Run failed', message: 'boom', payload: {} } as never);

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		restore_env = use_test_link_env();
		await open_test_control_plane_store();
		owner_email = String((await User.findByPk(OWNER, { attributes: ['email'], raw: true }))?.email ?? '');
	});
	beforeEach(() => {
		stub = new StubSender();
		email_deliverer.use_sender(stub);
		posts = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => { posts.push(String(url)); return new Response('ok', { status: 200 }); });
	});
	afterEach(() => { email_deliverer.use_sender(new NoopEmailSender()); vi.restoreAllMocks(); });
	afterAll(async () => {
		if (!has_postgres) return;
		await InAppNotification.destroy({ where: { realm_id: realms } });
		await InAppNotification.destroy({ where: { user_id: users } as never });
		await ChannelDestination.destroy({ where: { channel_id: channels } });
		await NotificationChannel.destroy({ where: { id: channels } });
		await NotificationChannel.destroy({ where: { user_id: users } as never });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await User.destroy({ where: { id: users }, force: true } as never);
		await close_test_control_plane_store();
		restore_env();
	});

	it('"All realm members": one shared in-app notice; each member by their own email and Slack; no personal in-app copies', async () => {
		const amy = await person();
		const bo = await person();
		await NotificationService.update_channel({ id: amy.channel_id, destinations: [{ type: 'cliqhub' }, { type: 'email', account: true }, { type: 'slack', webhook_url: 'https://hooks.slack.com/services/T/B/amy' }] });
		const realm_id = await realm_with([amy, bo]);

		await send(realm_id, [realm_members_channel_id(realm_id)]);
		expect(await InAppNotification.count({ where: { realm_id, user_id: null } as never })).toBe(1);
		expect(await InAppNotification.count({ where: { user_id: [amy.id, bo.id] } as never })).toBe(0);
		expect(emailed()).toEqual([amy.email, bo.email].sort());
		expect(posts).toEqual(['https://hooks.slack.com/services/T/B/amy']);
	});

	it('once per event: an address or Slack URL reached by two channels gets it once', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		const team = await NotificationService.create_channel({ realm_id, name: `team-${uid()}`.slice(0, 40), destinations: [{ type: 'email', address: `${amy.email}, lead@cliq.test` }, { type: 'slack', webhook_url: 'https://hooks.slack.com/services/T/B/team' }] });
		const also = await NotificationService.create_channel({ realm_id, name: `also-${uid()}`.slice(0, 40), destinations: [{ type: 'slack', webhook_url: 'https://hooks.slack.com/services/T/B/team' }] });
		channels.push(team.id, also.id);

		await send(realm_id, [realm_members_channel_id(realm_id), team.id, also.id]);
		expect(emailed()).toEqual([amy.email, 'lead@cliq.test'].sort());
		expect(posts).toEqual(['https://hooks.slack.com/services/T/B/team']);
	});

	it('a person reached directly and through the realm in the same event: one in-app notice (the shared one)', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		await send(realm_id, [amy.channel_id, realm_members_channel_id(realm_id)]);
		expect(await InAppNotification.count({ where: { realm_id, user_id: null } as never })).toBe(1);
		expect(await InAppNotification.count({ where: { user_id: amy.id } as never })).toBe(0);
		expect(emailed()).toEqual([amy.email]);
	});

	it('the org\'s "All realm members" reaches the realm the event comes from — its notice and its members their way', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		const org_channel = await NotificationChannel.create({
			id: randomUUID(), realm_id: null, org_id: null, user_id: null, name: `arm-${uid()}`.slice(0, 40), enabled: 1,
			system_key: 'org.realm_members', locked: true, lock_reason: 'Built in', created_at: Date.now(), updated_at: Date.now(),
		} as never);
		channels.push(org_channel.id);
		await ChannelDestination.create({ id: randomUUID(), channel_id: org_channel.id, type: 'cliqhub', config: {}, created_at: Date.now() } as never);

		await send(realm_id, [org_channel.id]);
		expect(await InAppNotification.count({ where: { realm_id, user_id: null } as never })).toBe(1);
		expect(emailed()).toEqual([amy.email]);
	});

	it('channels may loop (a → b → a); each address and person still gets it once', async () => {
		const amy = await person();
		const realm_id = await realm_with([amy]);
		const name_a = `loopa-${uid()}`.replace(/[^a-z0-9-]/g, '').slice(0, 30);
		const name_b = `loopb-${uid()}`.replace(/[^a-z0-9-]/g, '').slice(0, 30);
		const amy_name = amy.email.split('@')[0]!;
		const a = await NotificationService.create_channel({ realm_id, name: name_a, destinations: [{ type: 'email', address: 'shared@cliq.test' }, { type: 'channel_ref', name: name_b }] });
		const b = await NotificationService.create_channel({ realm_id, name: name_b, destinations: [{ type: 'email', address: 'shared@cliq.test' }, { type: 'channel_ref', name: name_a }, { type: 'channel_ref', name: amy_name }] });
		channels.push(a.id, b.id);

		await send(realm_id, [a.id, b.id]);
		expect(emailed()).toEqual([amy.email, 'shared@cliq.test'].sort());
		expect(await InAppNotification.count({ where: { user_id: amy.id } as never })).toBe(1);
	});

	it('a suspended member isn\'t reached their way', async () => {
		const amy = await person();
		const sus = await person('suspended');
		const realm_id = await realm_with([amy, sus]);
		await send(realm_id, [realm_members_channel_id(realm_id)]);
		expect(emailed()).toEqual([amy.email]);
	});

	it('cleanup: a built-in\'s own "email every member" is removed, once', async () => {
		const realm_id = await realm_with([]);
		const id = realm_members_channel_id(realm_id);
		await ChannelDestination.create({ id: randomUUID(), channel_id: id, type: 'email', config: { members: true }, created_at: Date.now() } as never);
		await Setting.destroy({ where: { key: BUILTIN_MEMBERS_THEIR_WAY_MIGRATION_KEY } });
		await migrate_builtin_members_their_way(get_sequelize());
		expect((await ChannelDestination.findAll({ where: { channel_id: id }, raw: true })).map((d) => d.type)).toEqual(['cliqhub']);
		expect((await NotificationChannel.findByPk(id, { raw: true }))?.lock_reason).toBe('Built in — everyone in the realm, each the way they chose.');
		expect(await Setting.findByPk(BUILTIN_MEMBERS_THEIR_WAY_MIGRATION_KEY)).toBeTruthy();
	});
});
