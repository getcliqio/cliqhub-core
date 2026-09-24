import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { NotificationChannel, Realm, RealmMember } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

const uid = () => `test-notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** Seeded user in open_test_control_plane_store — required for RealmService.create's org resolution. */
const user_id = hub_legacy_uuid(1);
let shared_realm_id: string | null = null;

function slack_destinations(webhook_url = 'https://hooks.slack.com/services/T/B/X') {
	return [{ type: 'slack', webhook_url }];
}

function email_destinations(to = 'ops@example.com') {
	return [{ type: 'email', to }];
}

beforeAll(async () => {
	if (!has_postgres) return;
	process.env.CLIQ_BFF_LOG_LEVEL = 'error';
	await open_test_control_plane_store();
});

beforeEach(async () => {
	if (!has_postgres) return;
	shared_realm_id = null;
	await NotificationChannel.destroy({ where: {} });
	await RealmMember.destroy({ where: {} });
	await Realm.destroy({ where: {} });
});

afterAll(async () => {
	if (!has_postgres) return;
	await NotificationChannel.destroy({ where: {} });
	await RealmMember.destroy({ where: {} });
	await Realm.destroy({ where: {} });
	await close_test_control_plane_store();
});

async function create_test_realm() {
	const slug = `n-${uid()}`.slice(0, 40);
	const realm = await RealmService.create(user_id, slug, 'Notif Realm');
	await NotificationChannel.destroy({ where: { realm_id: realm.id } });
	shared_realm_id = realm.id;
	return realm;
}

async function create_test_channel(name?: string) {
	if (!shared_realm_id) {
		const realm = await create_test_realm();
		shared_realm_id = realm.id;
	}
	return NotificationService.create_channel({
		realm_id: shared_realm_id,
		name: name ?? uid(),
		destinations: slack_destinations(),
	});
}

function parse_destinations(record: { destinations: string }): Array<Record<string, unknown>> {
	return JSON.parse(record.destinations) as Array<Record<string, unknown>>;
}

describe.skipIf(!has_postgres)('NotificationService — Channels', () => {
	describe.skipIf(!has_postgres)('list_channels', () => {
		it('returns empty array when no channels exist', async () => {
			const result = await NotificationService.list_channels();
			expect(result).toEqual([]);
		});

		it('returns channels ordered by name', async () => {
			const name_b = `b-${uid()}`;
			const name_a = `a-${uid()}`;
			await create_test_channel(name_b);
			await create_test_channel(name_a);

			const result = await NotificationService.list_channels();
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe(name_a);
		});
	});

	describe.skipIf(!has_postgres)('get_channel', () => {
		it('returns channel by id', async () => {
			const ch = await create_test_channel();
			const found = await NotificationService.get_channel(ch.id);
			expect(found.name).toBe(ch.name);
		});

		it('throws 404 for missing channel', async () => {
			await expect(NotificationService.get_channel('nonexistent'))
				.rejects.toThrow(/not found/);
		});
	});

	describe.skipIf(!has_postgres)('find_channel_by_name', () => {
		it('returns channel by name (realm-scoped)', async () => {
			const realm = await create_test_realm();
			const name = uid();
			await NotificationService.create_channel({
				realm_id: realm.id,
				name,
				destinations: slack_destinations(),
			});
			const found = await NotificationService.find_channel_by_name(name, realm.id);
			expect(found).not.toBeNull();
			expect(found!.name).toBe(name);
		});

		it('returns null for unknown name', async () => {
			const found = await NotificationService.find_channel_by_name('unknown');
			expect(found).toBeNull();
		});
	});

	describe.skipIf(!has_postgres)('create_channel', () => {
		it('creates channel with defaults (enabled=true) and expected destination type', async () => {
			const ch = await create_test_channel();
			expect(ch.enabled).toBe(1);
			const dests = parse_destinations(ch);
			expect(dests).toHaveLength(1);
			expect(dests[0].type).toBe('slack');
		});

		it('creates disabled email channel', async () => {
			const realm = await create_test_realm();
			const ch = await NotificationService.create_channel({
				realm_id: realm.id,
				name: uid(),
				destinations: email_destinations(),
				enabled: false,
			});
			expect(ch.enabled).toBe(0);
			expect(parse_destinations(ch)[0].type).toBe('email');
		});

		it('rejects missing destinations', async () => {
			const realm = await create_test_realm();
			await expect(NotificationService.create_channel({
				realm_id: realm.id,
				name: uid(),
				destinations: [],
			})).rejects.toThrow(/At least one destination/);
		});

		it('rejects duplicate name in same scope', async () => {
			const realm = await create_test_realm();
			const name = uid();
			await NotificationService.create_channel({
				realm_id: realm.id,
				name,
				destinations: slack_destinations(),
			});
			await expect(NotificationService.create_channel({
				realm_id: realm.id,
				name,
				destinations: slack_destinations(),
			})).rejects.toThrow(/already exists/);
		});
	});

	describe.skipIf(!has_postgres)('update_channel', () => {
		it('updates name and replaces destinations', async () => {
			const ch = await create_test_channel();
			const new_name = uid();

			const updated = await NotificationService.update_channel({
				id: ch.id,
				name: new_name,
				destinations: email_destinations('a@b.c'),
			});

			expect(updated.name).toBe(new_name);
			expect(parse_destinations(updated)[0].type).toBe('email');
		});

		it('updates destinations and enabled flag', async () => {
			const ch = await create_test_channel();
			const updated = await NotificationService.update_channel({
				id: ch.id,
				destinations: slack_destinations('https://hooks.slack.com/services/T/B/NEW'),
				enabled: false,
			});
			expect(updated.enabled).toBe(0);
			const dests = parse_destinations(updated);
			expect(String(dests[0].webhook_url)).toContain('hooks.slack.com');
		});

		it('throws 404 for missing channel', async () => {
			await expect(NotificationService.update_channel({ id: 'ghost', name: 'x' }))
				.rejects.toThrow(/not found/);
		});
	});

	describe.skipIf(!has_postgres)('remove_channel', () => {
		it('removes existing channel', async () => {
			const ch = await create_test_channel();
			const removed = await NotificationService.remove_channel(ch.id);
			expect(removed).toBe(true);
		});

		it('returns false for nonexistent channel', async () => {
			const removed = await NotificationService.remove_channel('ghost');
			expect(removed).toBe(false);
		});
	});

	describe.skipIf(!has_postgres)('find_enabled_channels', () => {
		it('returns empty for empty ids array', async () => {
			const result = await NotificationService.find_enabled_channels([]);
			expect(result).toEqual([]);
		});

		it('returns only enabled channels from given ids', async () => {
			const enabled_ch = await create_test_channel();
			const disabled_ch = await NotificationService.create_channel({
				realm_id: shared_realm_id!,
				name: uid(),
				destinations: slack_destinations('https://hooks.slack.com/services/T/B/Y'),
				enabled: false,
			});

			const result = await NotificationService.find_enabled_channels([
				enabled_ch.id, disabled_ch.id,
			]);
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(enabled_ch.id);
		});
	});
});
