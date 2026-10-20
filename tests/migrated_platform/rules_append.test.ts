/**
 * PLAN-notifications-v2 B1 — the org's rules and a realm's own rules both apply: a realm's rule adds to
 * the org's for that realm, never replaces it; a switched-off rule stops only itself; another org's
 * rules never apply. (Every realm here is the owner's, so they share one org: each case uses its own event.)
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
import { RealmService } from '../../src/services/realm.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { ChannelDestination, NotificationChannel, NotificationRule, Org, Realm, RealmMember } from '../../src/models/index.js';
import { realm_members_channel_id } from '../../src/notifications/defaults.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('B1 — org and realm rules both apply', () => {
	const realms: string[] = [];
	const channels: string[] = [];
	const orgs: string[] = [];

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});
	afterAll(async () => {
		if (!has_postgres) return;
		const all = [...channels, ...realms.map(realm_members_channel_id)];
		await NotificationRule.destroy({ where: { channel_id: all } });
		await ChannelDestination.destroy({ where: { channel_id: all } });
		await NotificationChannel.destroy({ where: { id: all } });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await Org.destroy({ where: { id: orgs } });
		await close_test_control_plane_store();
	});

	/** A realm, its org, an org channel and a realm channel (webhooks; nothing is sent here). */
	async function setup() {
		const realm = await RealmService.create(OWNER, `ap-${uid()}`.slice(0, 40), 'Append');
		realms.push(realm.id);
		const org_id = String((await Realm.findByPk(realm.id, { raw: true }))!.org_id);
		const org_ch = await NotificationService.create_channel({ org_id, name: `org-${uid()}`.slice(0, 30), destinations: [{ type: 'webhook', url: 'https://example.com/org' }] });
		const realm_ch = await NotificationService.create_channel({ realm_id: realm.id, name: `rl-${uid()}`.slice(0, 30), destinations: [{ type: 'webhook', url: 'https://example.com/realm' }] });
		channels.push(org_ch.id, realm_ch.id);
		// Only the rules each case sets: drop the realm's defaults.
		await NotificationRule.destroy({ where: { realm_id: realm.id } });
		return { realm_id: realm.id, org_id, org_ch: org_ch.id, realm_ch: realm_ch.id };
	}
	const resolve = (event: string, realm_id: string, org_id?: string) => NotificationService.resolve_rules({ event, realm_id, ...(org_id ? { org_id } : {}) });

	it('org only → the org\'s channel; realm only → the realm\'s; both → both', async () => {
		const s = await setup();
		await NotificationService.set_rule({ org_id: s.org_id, event: 'run.failed', channel_id: s.org_ch });
		expect(await resolve('run.failed', s.realm_id, s.org_id)).toEqual([s.org_ch]);

		await NotificationService.set_rule({ realm_id: s.realm_id, event: 'run.completed', channel_id: s.realm_ch });
		expect(await resolve('run.completed', s.realm_id, s.org_id)).toEqual([s.realm_ch]);

		await NotificationService.set_rule({ realm_id: s.realm_id, event: 'run.failed', channel_id: s.realm_ch });
		expect((await resolve('run.failed', s.realm_id, s.org_id)).sort()).toEqual([s.org_ch, s.realm_ch].sort());
	});

	it('a realm switching its own rule off stops only that rule — the org\'s still sends', async () => {
		const s = await setup();
		await NotificationService.set_rule({ org_id: s.org_id, event: 'run.crashed', channel_id: s.org_ch });
		await NotificationService.set_rule({ realm_id: s.realm_id, event: 'run.crashed', channel_id: s.realm_ch, enabled: false });
		expect(await resolve('run.crashed', s.realm_id, s.org_id)).toEqual([s.org_ch]);
	});

	it('the same channel in both is sent once; a family wildcard matches too', async () => {
		const s = await setup();
		await NotificationService.set_rule({ org_id: s.org_id, event: 'phase.*', channel_id: s.org_ch });
		await NotificationService.set_rule({ realm_id: s.realm_id, event: 'phase.timed_out', channel_id: s.org_ch });
		expect(await resolve('phase.timed_out', s.realm_id, s.org_id)).toEqual([s.org_ch]);
	});

	it('without an org id the realm\'s org is used — another org\'s rules never apply', async () => {
		const s = await setup();
		await NotificationService.set_rule({ org_id: s.org_id, event: 'daemon.offline', channel_id: s.org_ch });
		// Another org with a rule for the same event.
		const other = await Org.create({ id: randomUUID(), slug: `ot-${uid()}`.slice(0, 40), display_name: 'Other', activated_at: new Date() } as never);
		orgs.push(other.id);
		const other_ch = await NotificationService.create_channel({ org_id: other.id, name: `ot-${uid()}`.slice(0, 30), destinations: [{ type: 'webhook', url: 'https://example.com/other' }] });
		channels.push(other_ch.id);
		await NotificationService.set_rule({ org_id: other.id, event: 'daemon.offline', channel_id: other_ch.id });

		expect(await resolve('daemon.offline', s.realm_id)).toEqual([s.org_ch]);
	});

	it('a realm can add its own rule for an event the org has locked', async () => {
		const s = await setup();
		await NotificationRule.create({ realm_id: null, org_id: s.org_id, team_slug: null, event: 'run.cancelled', channel_id: s.org_ch, priority: 0, locked: true, lock_reason: 'test', system_key: `t.${uid()}`, created_at: Date.now(), updated_at: Date.now() } as never);
		await expect(NotificationService.set_rule({ realm_id: s.realm_id, event: 'run.cancelled', channel_id: s.realm_ch })).resolves.toBeTruthy();
		expect((await resolve('run.cancelled', s.realm_id, s.org_id)).sort()).toEqual([s.org_ch, s.realm_ch].sort());
	});
});
