/**
 * PLAN-notifications-v2 A1 — what a new org and a new realm start with comes from one place
 * (src/notifications/defaults.ts), and seeding twice adds nothing.
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
import {
	ORG_BUILTIN_CHANNELS,
	REALM_DEFAULT_RULE_EVENTS,
	REALM_MEMBERS_CHANNEL,
	realm_default_rule_key,
	realm_members_channel_id,
} from '../../src/notifications/defaults.js';
import { OrgSeedService } from '../../src/services/org_seed.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { ChannelDestination, NotificationChannel, NotificationRule, Org, Realm, RealmMember } from '../../src/models/index.js';

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
});
