/**
 * PLAN-channels E2 — explicit channels: who an in-app message reaches follows the channel's owner,
 * every realm has an "All realm members" channel with ordinary default rules (no hidden all-users
 * fallback), org-wide inbox rows stay inside their org, and the one-time migration cleans up dead
 * rules / empty channels and gives existing realms their channel and defaults.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Op } from 'sequelize';
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
import { REALM_DEFAULT_RULE_EVENTS, REALM_FIXED_RULES, REALM_MEMBERS_CHANNEL_NAME } from '../../src/notifications/defaults.js';
import { InAppNotificationService } from '../../src/services/in_app_notification.service.js';
import { EventSubmitService } from '../../src/services/events_service.js';
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { CliqHubDeliverer } from '../../src/notifications/deliverers/cliqhub_deliverer.js';
import {
	add_realm_review_rule,
	migrate_realm_members_channels,
	REALM_MEMBERS_MIGRATION_EVENTS,
	REALM_MEMBERS_MIGRATION_KEY,
	REALM_REVIEW_RULE_KEY,
} from '../../src/models/migrations/control_plane_schema_migrations.js';
import {
	ChannelDestination,
	InAppNotification,
	NotificationChannel,
	NotificationRule,
	OrgMember,
	Realm,
	RealmMember,
	Setting,
	User,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const AMY = hub_legacy_uuid(81);
const OUTSIDER = hub_legacy_uuid(82);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function new_realm(): Promise<{ id: string; org_id: string }> {
	const realm = await RealmService.create(OWNER, `rm-${uid()}`.slice(0, 40), 'Members');
	const row = await Realm.findByPk(realm.id, { attributes: ['org_id'], raw: true }) as { org_id: string };
	return { id: realm.id, org_id: String(row.org_id) };
}

/** Make `user_id` an active member of the org (and optionally the realm). */
async function join(user_id: string, org_id: string, realm_id?: string) {
	await OrgMember.findOrCreate({ where: { org_id, user_id }, defaults: { org_id, user_id, role: 'member', status: 'active' } as never });
	if (realm_id) await RealmMember.create({ id: `${realm_id}:${user_id}`, realm_id, member_type: 'user', member_id: user_id, role: 'member', created_at: Date.now() } as never);
}

const sees = async (user_id: string, message: string) =>
	(await InAppNotificationService.list_for_user({ user_id })).notifications.some((n) => n.message === message);

describe.skipIf(!has_postgres)('PLAN-channels E2: explicit channels', () => {
	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
		for (const [id, name] of [[AMY, 'e2amy'], [OUTSIDER, 'e2outsider']]) {
			await User.findOrCreate({ where: { id }, defaults: { id, username: name, email: `${name}@cliq.test`, status: 'active', role: 'user', password_hash: 'x' } as never });
		}
	});

	beforeEach(async () => {
		if (!has_postgres) return;
		await InAppNotification.destroy({ where: {} });
		// Rules people made, and realm rules (incl. realm defaults); seeded org defaults stay.
		await NotificationRule.destroy({ where: { [Op.or]: [{ system_key: null }, { realm_id: { [Op.ne]: null } }] } });
		await RealmMember.destroy({ where: {} });
		await Realm.destroy({ where: {} });
		await OrgMember.destroy({ where: { user_id: [AMY, OUTSIDER] } });
		await Setting.destroy({ where: { key: REALM_MEMBERS_MIGRATION_KEY } });
	});

	afterAll(async () => {
		if (!has_postgres) return;
		await OrgMember.destroy({ where: { user_id: [AMY, OUTSIDER] } });
		await NotificationChannel.destroy({ where: { user_id: [AMY, OUTSIDER] } });
		await User.destroy({ where: { id: [AMY, OUTSIDER] }, force: true } as never);
		await Setting.destroy({ where: { key: REALM_MEMBERS_MIGRATION_KEY } });
		await close_test_control_plane_store();
	});

	it('a new realm gets "All realm members" (in-app + email to its members) and the default rules to it', async () => {
		const realm = await new_realm();
		const ch = await NotificationChannel.findOne({ where: { realm_id: realm.id, name: REALM_MEMBERS_CHANNEL_NAME }, raw: true });
		expect(ch).toBeTruthy();
		expect((await ChannelDestination.findAll({ where: { channel_id: ch!.id }, raw: true })).map((d) => d.type)).toEqual(['cliqhub', 'email']);
		const rules = await NotificationRule.findAll({ where: { realm_id: realm.id }, raw: true });
		expect(rules.map((r) => r.event).sort()).toEqual([...REALM_DEFAULT_RULE_EVENTS, ...REALM_FIXED_RULES.map((f) => f.event)].sort());
		expect(rules.every((r) => r.channel_id === ch!.id)).toBe(true);
		// The defaults are editable; the fixed rules are locked.
		expect(rules.filter((r) => r.locked).map((r) => r.event)).toEqual(REALM_FIXED_RULES.map((f) => f.event));
	});

	it('in-app to a realm channel reaches that realm’s members, as they join', async () => {
		const realm = await new_realm();
		const channel = await NotificationService.ensure_realm_members_channel(realm.id);
		await new CliqHubDeliverer().deliver({}, { event: 'run.failed', message: 'realm-msg', realm_id: realm.id }, { channel_id: channel.id });
		expect(await sees(AMY, 'realm-msg')).toBe(false);
		await join(AMY, realm.org_id, realm.id);
		expect(await sees(AMY, 'realm-msg')).toBe(true);
	});

	it('in-app to an org channel reaches every org member, and nobody outside the org', async () => {
		const realm = await new_realm();
		const org_channel = await NotificationService.create_channel({ org_id: realm.org_id, name: `org-inapp-${uid()}`, destinations: [{ type: 'cliqhub' }] });
		// Sent for an event in the realm, it still goes org-wide (In-app is org-wide).
		await new CliqHubDeliverer().deliver({}, { event: 'run.failed', message: 'org-msg', realm_id: realm.id }, { channel_id: org_channel.id });
		const row = await InAppNotification.findOne({ where: { message: 'org-msg' }, raw: true });
		expect(row).toMatchObject({ realm_id: null, user_id: null, org_id: realm.org_id });
		await join(AMY, realm.org_id);
		expect(await sees(AMY, 'org-msg')).toBe(true);
		expect(await sees(OUTSIDER, 'org-msg')).toBe(false);
	});

	it('in-app to a personal channel reaches only its owner', async () => {
		const realm = await new_realm();
		const personal = await ensure_personal_channel(AMY, 'amy');
		await join(AMY, realm.org_id, realm.id);
		await join(OUTSIDER, realm.org_id, realm.id);
		await new CliqHubDeliverer().deliver({}, { event: 'run.failed', message: 'just-amy', realm_id: realm.id }, { channel_id: personal });
		expect(await sees(AMY, 'just-amy')).toBe(true);
		expect(await sees(OUTSIDER, 'just-amy')).toBe(false);
	});

	it('an account-wide row (no org) is still visible to everyone', async () => {
		await InAppNotificationService.create_from_payload({ event: 'team.published', message: 'for-all' });
		expect(await sees(OUTSIDER, 'for-all')).toBe(true);
	});

	it('no rules → nothing is sent (no hidden all-users fallback)', async () => {
		const realm = await new_realm();
		await NotificationRule.destroy({ where: { realm_id: realm.id } });
		const ev = await EventSubmitService.submit({ type: 'run.failed', realm_id: realm.id, run_id: `r-${uid()}`, daemon_id: 'd1' });
		expect(ev.notifications).toBe('skipped');
		expect(await InAppNotification.count()).toBe(0);
	});

	describe('one-time migration', () => {
		/** A realm as prod has it: legacy `cliqhub` channel, no defaults, an empty channel + rule, an all_users channel. */
		async function legacy_realm() {
			const realm = await new_realm();
			const members = await NotificationChannel.findOne({ where: { realm_id: realm.id, name: REALM_MEMBERS_CHANNEL_NAME } });
			await members!.update({ name: 'cliqhub' });
			await NotificationRule.destroy({ where: { realm_id: realm.id } });
			const now = Date.now();
			const empty = await NotificationChannel.create({ id: `empty-${uid()}`, realm_id: realm.id, name: `old-${uid()}`, enabled: 1, created_at: now, updated_at: now } as never);
			await NotificationRule.create({ realm_id: realm.id, org_id: null, team_slug: null, event: 'hug.*', channel_id: empty.id, priority: 0, created_at: now, updated_at: now } as never);
			const all_users = await NotificationChannel.create({ id: `all_users-${realm.id}`, realm_id: realm.id, name: 'realm:all_users', enabled: 1, created_at: now, updated_at: now } as never);
			await ChannelDestination.create({ id: `d-${uid()}`, channel_id: all_users.id, type: 'cliqhub', config: {}, created_at: now } as never);
			return { realm, members_id: members!.id, empty_id: empty.id, all_users_id: all_users.id };
		}

		it('deletes dead rules, empty and all_users channels; renames the realm channel; adds the defaults', async () => {
			const l = await legacy_realm();
			await migrate_realm_members_channels(NotificationChannel.sequelize!);
			expect(await NotificationChannel.findByPk(l.empty_id)).toBeNull();
			expect(await NotificationRule.count({ where: { channel_id: l.empty_id } })).toBe(0);
			expect(await NotificationChannel.findByPk(l.all_users_id)).toBeNull();
			expect((await NotificationChannel.findByPk(l.members_id, { raw: true }))?.name).toBe(REALM_MEMBERS_CHANNEL_NAME);
			const rules = await NotificationRule.findAll({ where: { realm_id: l.realm.id }, raw: true });
			expect(rules.map((r) => r.event).sort()).toEqual([...REALM_MEMBERS_MIGRATION_EVENTS].sort());
			expect(await Setting.findByPk(REALM_MEMBERS_MIGRATION_KEY)).toBeTruthy();
		});

		it('runs once: a default rule removed afterwards is not put back', async () => {
			const l = await legacy_realm();
			await migrate_realm_members_channels(NotificationChannel.sequelize!);
			await NotificationRule.destroy({ where: { realm_id: l.realm.id, event: 'run.failed' } });
			await migrate_realm_members_channels(NotificationChannel.sequelize!);
			expect(await NotificationRule.count({ where: { realm_id: l.realm.id, event: 'run.failed' } })).toBe(0);
		});
	});

	describe('one-time review-request rule for existing realms', () => {
		beforeEach(async () => { await Setting.destroy({ where: { key: REALM_REVIEW_RULE_KEY } }); });

		it('adds review requests → "All realm members" to a realm without one, once; a realm\'s own choice and a switched-off channel are kept', async () => {
			const plain = await new_realm();
			await NotificationRule.destroy({ where: { realm_id: plain.id, event: 'hug.review_requested' } });
			const own = await new_realm();
			await NotificationRule.destroy({ where: { realm_id: own.id, event: 'hug.review_requested' } });
			await NotificationRule.create({ realm_id: own.id, org_id: null, team_slug: null, event: 'hug.*', channel_id: `cliqhub-${own.id}`, priority: 0, created_at: Date.now(), updated_at: Date.now() } as never);
			const off = await new_realm();
			await NotificationRule.destroy({ where: { realm_id: off.id, event: 'hug.review_requested' } });
			await NotificationChannel.update({ enabled: 0 }, { where: { id: `cliqhub-${off.id}` } });

			await add_realm_review_rule(NotificationChannel.sequelize!);
			expect(await NotificationRule.count({ where: { realm_id: plain.id, event: 'hug.review_requested', channel_id: `cliqhub-${plain.id}` } })).toBe(1);
			expect(await NotificationRule.count({ where: { realm_id: own.id, event: 'hug.review_requested' } })).toBe(0);
			expect(await NotificationRule.count({ where: { realm_id: off.id, event: 'hug.review_requested' } })).toBe(1);
			expect((await NotificationChannel.findByPk(`cliqhub-${off.id}`, { raw: true }))?.enabled).toBe(0);
			expect(await Setting.findByPk(REALM_REVIEW_RULE_KEY)).toBeTruthy();

			// Runs once: a rule removed afterwards stays removed.
			await NotificationRule.destroy({ where: { realm_id: plain.id, event: 'hug.review_requested' } });
			await add_realm_review_rule(NotificationChannel.sequelize!);
			expect(await NotificationRule.count({ where: { realm_id: plain.id, event: 'hug.review_requested' } })).toBe(0);
		});
	});
});
