/**
 * PLAN-notifications-v2 A1/A2 — what a new org and a new realm start with comes from one place
 * (src/notifications/defaults.ts), seeding twice adds nothing, and the two built-in channels
 * (All org members, All realm members) are locked, in-app + email to their members; the one-time
 * migration brings existing orgs and realms in line.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { Op } from 'sequelize';
import {
	ORG_BUILTIN_CHANNELS,
	ORG_IN_APP_CHANNEL_KEY,
	ORG_MEMBERS_CHANNEL_NAME,
	REALM_MEMBERS_CHANNEL_KEY,
	REALM_DEFAULT_RULE_EVENTS,
	REALM_MEMBERS_CHANNEL,
	realm_default_rule_key,
	realm_members_channel_id,
} from '../../src/notifications/defaults.js';
import { OrgSeedService } from '../../src/services/org_seed.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { ChannelDestination, NotificationChannel, NotificationRule, Org, Realm, RealmMember, Setting } from '../../src/models/index.js';
import { BUILTIN_CHANNELS_MIGRATION_KEY, migrate_builtin_channels } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** The org's channels (not its realms' or people's): system_key → destination types. */
async function org_channels(org_id: string): Promise<Record<string, string[]>> {
	const rows = await NotificationChannel.findAll({ where: { org_id, realm_id: null, user_id: null }, raw: true });
	const out: Record<string, string[]> = {};
	for (const c of rows) {
		const dests = await ChannelDestination.findAll({ where: { channel_id: c.id }, raw: true });
		out[String(c.system_key)] = dests.map((d) => d.type).sort();
	}
	return out;
}

describe.skipIf(!has_postgres)('notification defaults (A1)', () => {
	const orgs: string[] = [];
	const realms: string[] = [];

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});

	afterAll(async () => {
		if (!has_postgres) return;
		const channels = (await NotificationChannel.findAll({ where: { org_id: orgs }, attributes: ['id'], raw: true })).map((c) => c.id);
		await NotificationRule.destroy({ where: { realm_id: realms } });
		await ChannelDestination.destroy({ where: { channel_id: [...channels, ...realms.map(realm_members_channel_id)] } });
		await NotificationChannel.destroy({ where: { id: [...channels, ...realms.map(realm_members_channel_id)] } });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await Org.destroy({ where: { id: orgs } });
		await close_test_control_plane_store();
	});

	it('a new org gets exactly the built-in org channels, and seeding again adds nothing', async () => {
		const org = await Org.create({ id: randomUUID(), slug: `dflt-${uid()}`.slice(0, 40), display_name: 'Defaults', activated_at: new Date() } as never);
		orgs.push(org.id);

		const first = await OrgSeedService.seed_org(org.id, { account: false });
		const expected = Object.fromEntries(ORG_BUILTIN_CHANNELS.map((c) => [c.system_key, c.destinations.map((d) => d.type).sort()]));
		expect(first.channels_created).toBe(ORG_BUILTIN_CHANNELS.length);
		expect(await org_channels(org.id)).toEqual(expected);

		const again = await OrgSeedService.seed_org(org.id, { account: false });
		expect(again.channels_created).toBe(0);
		expect(await org_channels(org.id)).toEqual(expected);
	});

	it('a new realm gets its "All realm members" channel and exactly the default rules, and ensuring again adds nothing', async () => {
		const realm = await RealmService.create(OWNER, `dflt-${uid()}`.slice(0, 40), 'Defaults');
		realms.push(realm.id);
		const channel_id = realm_members_channel_id(realm.id);

		const channel = (await NotificationChannel.findByPk(channel_id, { raw: true }))!;
		expect(channel.name).toBe(REALM_MEMBERS_CHANNEL.name);
		expect((await ChannelDestination.findAll({ where: { channel_id }, raw: true })).map((d) => d.type).sort())
			.toEqual(REALM_MEMBERS_CHANNEL.destinations.map((d) => d.type).sort());
		const rules = async () => (await NotificationRule.findAll({ where: { realm_id: realm.id }, raw: true }))
			.map((r) => `${r.event}|${r.channel_id}|${r.system_key}|${r.locked}`).sort();
		const expected = REALM_DEFAULT_RULE_EVENTS.map((e) => `${e}|${channel_id}|${realm_default_rule_key(e)}|false`).sort();
		expect(await rules()).toEqual(expected);

		await NotificationService.ensure_realm_members_channel(realm.id);
		expect(await rules()).toEqual(expected);
		expect(await ChannelDestination.count({ where: { channel_id } })).toBe(REALM_MEMBERS_CHANNEL.destinations.length);
	});

	describe('A2 — built-in channels', () => {
		const dest_types = async (channel_id: string) => (await ChannelDestination.findAll({ where: { channel_id }, raw: true }))
			.map((d) => `${d.type}${(d.config as Record<string, unknown>)?.members ? ':members' : ''}`).sort();

		async function new_org() {
			const org = await Org.create({ id: randomUUID(), slug: `bi-${uid()}`.slice(0, 40), display_name: 'Built in', activated_at: new Date() } as never);
			orgs.push(org.id);
			await OrgSeedService.seed_org(org.id, { account: false });
			return org.id as string;
		}
		async function new_realm() {
			const realm = await RealmService.create(OWNER, `bi-${uid()}`.slice(0, 40), 'Built in');
			realms.push(realm.id);
			return realm.id;
		}

		it('All org members and All realm members: locked, in-app + email to members', async () => {
			const org_id = await new_org();
			const org_ch = (await NotificationChannel.findOne({ where: { org_id, system_key: ORG_IN_APP_CHANNEL_KEY }, raw: true }))!;
			expect(org_ch).toMatchObject({ name: ORG_MEMBERS_CHANNEL_NAME, locked: true, enabled: 1 });
			expect(await dest_types(org_ch.id)).toEqual(['cliqhub', 'email:members']);

			const realm_id = await new_realm();
			const realm_ch = (await NotificationChannel.findByPk(realm_members_channel_id(realm_id), { raw: true }))!;
			expect(realm_ch).toMatchObject({ system_key: REALM_MEMBERS_CHANNEL_KEY, locked: true, enabled: 1 });
			expect(await dest_types(realm_ch.id)).toEqual(['cliqhub', 'email:members']);
		});

		it('a built-in channel can\'t be renamed, switched off, re-pointed or removed (409 locked)', async () => {
			const org_id = await new_org();
			const realm_id = await new_realm();
			const ids = [
				(await NotificationChannel.findOne({ where: { org_id, system_key: ORG_IN_APP_CHANNEL_KEY }, raw: true }))!.id,
				realm_members_channel_id(realm_id),
			];
			for (const id of ids) {
				await expect(NotificationService.update_channel({ id, name: 'x' })).rejects.toMatchObject({ status: 409, code: 'locked' });
				await expect(NotificationService.update_channel({ id, enabled: false })).rejects.toMatchObject({ status: 409, code: 'locked' });
				await expect(NotificationService.update_channel({ id, destinations: [{ type: 'cliqhub' }] })).rejects.toMatchObject({ status: 409, code: 'locked' });
				await expect(NotificationService.remove_channel(id)).rejects.toMatchObject({ status: 409, code: 'locked' });
			}
		});

		it('people can\'t give a channel email-to-members (422) — it\'s only for built-in channels', async () => {
			const realm_id = await new_realm();
			await expect(NotificationService.create_channel({ realm_id, name: `m-${uid()}`.slice(0, 30), destinations: [{ type: 'email', members: true }] }))
				.rejects.toMatchObject({ status: 422 });
		});

		it('the one-time migration brings older orgs and realms in line, keeps an owner\'s own name, and runs once', async () => {
			// An org as seeded before: "In-app", unlocked, in-app only; one whose owners renamed it.
			const legacy_org = await new_org();
			const renamed_org = await new_org();
			for (const [org_id, name] of [[legacy_org, 'In-app'], [renamed_org, 'Alerts']] as const) {
				const ch = (await NotificationChannel.findOne({ where: { org_id, system_key: ORG_IN_APP_CHANNEL_KEY } }))!;
				await ch.update({ name, locked: false, lock_reason: null } as never);
				await ChannelDestination.destroy({ where: { channel_id: ch.id, type: 'email' } });
			}
			// A realm channel as before: legacy name, no key, unlocked, switched off, in-app only; a realm with none.
			const legacy_realm = await new_realm();
			const cid = realm_members_channel_id(legacy_realm);
			await NotificationChannel.update({ name: 'cliqhub', system_key: null, locked: false, lock_reason: null, enabled: 0 } as never, { where: { id: cid } });
			await ChannelDestination.destroy({ where: { channel_id: cid, type: 'email' } });
			const bare_realm = await new_realm();
			await NotificationRule.destroy({ where: { realm_id: bare_realm } });
			await ChannelDestination.destroy({ where: { channel_id: realm_members_channel_id(bare_realm) } });
			await NotificationChannel.destroy({ where: { id: realm_members_channel_id(bare_realm) } });

			await Setting.destroy({ where: { key: BUILTIN_CHANNELS_MIGRATION_KEY } });
			await migrate_builtin_channels(NotificationChannel.sequelize!);
			await migrate_builtin_channels(NotificationChannel.sequelize!); // once

			const org_ch = async (org_id: string) => (await NotificationChannel.findOne({ where: { org_id, system_key: ORG_IN_APP_CHANNEL_KEY }, raw: true }))!;
			expect(await org_ch(legacy_org)).toMatchObject({ name: ORG_MEMBERS_CHANNEL_NAME, locked: true, enabled: 1 });
			expect(await org_ch(renamed_org)).toMatchObject({ name: 'Alerts', locked: true });
			expect(await dest_types((await org_ch(legacy_org)).id)).toEqual(['cliqhub', 'email:members']);
			expect(await dest_types((await org_ch(renamed_org)).id)).toEqual(['cliqhub', 'email:members']);

			expect(await NotificationChannel.findByPk(cid, { raw: true })).toMatchObject({ name: 'All realm members', system_key: REALM_MEMBERS_CHANNEL_KEY, locked: true, enabled: 1 });
			expect(await dest_types(cid)).toEqual(['cliqhub', 'email:members']);
			// Its rules are left alone.
			expect(await NotificationRule.count({ where: { realm_id: legacy_realm } })).toBe(REALM_DEFAULT_RULE_EVENTS.length);

			const bare = (await NotificationChannel.findByPk(realm_members_channel_id(bare_realm), { raw: true }))!;
			expect(bare).toMatchObject({ system_key: REALM_MEMBERS_CHANNEL_KEY, locked: true });
			expect(await NotificationRule.count({ where: { realm_id: bare_realm, channel_id: { [Op.eq]: bare.id } } })).toBe(REALM_DEFAULT_RULE_EVENTS.length);
			expect(await Setting.findByPk(BUILTIN_CHANNELS_MIGRATION_KEY)).toBeTruthy();
		});
	});
});
