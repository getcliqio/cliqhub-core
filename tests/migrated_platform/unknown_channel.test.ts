/**
 * PLAN-notifications-v2 B2 — a channel named for an event that doesn't exist raises
 * `notification.unknown_channel` (once per run per name); the channels that exist still deliver; the
 * notice reaches the realm's All realm members through its fixed rule.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { EventSubmitService } from '../../src/services/events_service.js';
import { unknown_channel_message } from '../../src/notifications/unknown_channel.js';
import { realm_members_channel_id } from '../../src/notifications/defaults.js';
import { ChannelDestination, HubEvent, InAppNotification, NotificationChannel, NotificationRule, Realm, RealmMember } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('B2 — unknown channel names', () => {
	const realms: string[] = [];
	const channels: string[] = [];
	let fetch_mock: ReturnType<typeof vi.fn>;

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});
	afterEach(() => { vi.unstubAllGlobals(); });
	afterAll(async () => {
		if (!has_postgres) return;
		const all = [...channels, ...realms.map(realm_members_channel_id)];
		await HubEvent.destroy({ where: { realm_id: realms } });
		await InAppNotification.destroy({ where: { realm_id: realms } });
		await NotificationRule.destroy({ where: { realm_id: realms } });
		await ChannelDestination.destroy({ where: { channel_id: all } });
		await NotificationChannel.destroy({ where: { id: all } });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await close_test_control_plane_store();
	});

	async function setup() {
		fetch_mock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetch_mock);
		const realm = await RealmService.create(OWNER, `uc-${uid()}`.slice(0, 40), 'Unknown channels');
		realms.push(realm.id);
		const name = `ops-${uid()}`.slice(0, 30);
		const ch = await NotificationService.create_channel({ realm_id: realm.id, name, destinations: [{ type: 'webhook', url: 'https://example.com/ops' }] });
		channels.push(ch.id);
		return { realm_id: realm.id, name };
	}
	const failed = (realm_id: string, run_id: string, names: string[]) => EventSubmitService.submit({
		type: 'run.failed', realm_id, run_id, daemon_id: 'd-1', message: 'boom',
		payload: { notify: { channels: names } } as never,
	});
	const notices = (run_id: string) => HubEvent.findAll({ where: { type: 'notification.unknown_channel', run_id }, raw: true });

	it('the channels that exist still deliver; each missing name raises Unknown channel', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		const ev = await failed(s.realm_id, run_id, [s.name, 'nobody-here']);
		expect(ev.notifications).toBe('dispatched');
		expect(fetch_mock).toHaveBeenCalled();
		const raised = await notices(run_id);
		expect(raised.map((e) => e.message)).toEqual([unknown_channel_message('nobody-here')]);
	});

	it('once per run per name — the run\'s next events don\'t repeat it; another run raises its own', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		await failed(s.realm_id, run_id, ['nobody-here']);
		await EventSubmitService.submit({ type: 'run.crashed', realm_id: s.realm_id, run_id, daemon_id: 'd-1', payload: { notify: { channels: ['nobody-here'] } } as never });
		expect(await notices(run_id)).toHaveLength(1);
		const other = `run-${uid()}`;
		await failed(s.realm_id, other, ['nobody-here']);
		expect(await notices(other)).toHaveLength(1);
	});

	it('all names missing: nothing delivered (failed), Unknown channel for each', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		const ev = await failed(s.realm_id, run_id, ['nobody-a', 'nobody-b']);
		expect(ev.notifications).toBe('failed');
		expect((await notices(run_id)).map((e) => e.message).sort()).toEqual([unknown_channel_message('nobody-a'), unknown_channel_message('nobody-b')].sort());
	});

	it('every name exists: no notice', async () => {
		const s = await setup();
		const run_id = `run-${uid()}`;
		await failed(s.realm_id, run_id, [s.name]);
		expect(await notices(run_id)).toHaveLength(0);
	});

	it('the notice goes nowhere by default; a rule sends it on — in-app through All realm members', async () => {
		const s = await setup();
		const inbox = () => InAppNotification.findAll({ where: { realm_id: s.realm_id, event: 'notification.unknown_channel' }, raw: true });
		await failed(s.realm_id, `run-${uid()}`, ['nobody-here']);
		expect(await inbox()).toHaveLength(0);

		await NotificationService.set_rule({ realm_id: s.realm_id, event: 'notification.unknown_channel', channel_id: realm_members_channel_id(s.realm_id) });
		await failed(s.realm_id, `run-${uid()}`, ['nobody-here']);
		const rows = await inbox();
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].message).toBe(unknown_channel_message('nobody-here'));
	});
});
