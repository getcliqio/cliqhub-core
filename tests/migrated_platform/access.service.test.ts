import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, Realm, RealmMember } from '../../src/models/index.js';
import { AccessService } from '../../src/services/access.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ApiError } from '../../src/lib/api_error.js';

const has_postgres = await postgres_reachable();

const uid = () => `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('AccessService', () => {
	/** Seeded numeric users in open_test_control_plane_store — required for
	 *  RealmService.create to resolve/create the caller's personal org
	 *  (Realm.org_id is NOT NULL). Non-numeric strings won't resolve. */
	const alice = hub_legacy_uuid(1);
	const bob = hub_legacy_uuid(2);
	const charlie = hub_legacy_uuid(3);
	let realm_id: string;
	let daemon_id: string;

	beforeAll(async () => {
    if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();

		const realm = await RealmService.create(alice, `acc-${uid()}`.slice(0, 40), 'Access Realm');
		realm_id = realm.id;
		await RealmService.upsert_user_member(realm_id, bob, 'operator');

		daemon_id = uid();
		await Daemon.create({
			id: daemon_id,
			api_key_hash: 'h',
			user_id: null,
			user_email: null,
			hostname: 'd',
			ip: '127.0.0.1',
			port: 4900,
			public_url: 'http://127.0.0.1:4900',
			status: 'online',
			last_heartbeat: Date.now(),
			capacity: 5,
			created_at: Date.now(),
			last_registered_at: Date.now(),
		});
		await RealmService.upsert_daemon_member(realm_id, daemon_id);
	});

	afterAll(async () => {
    if (!has_postgres) return;
		await RealmMember.destroy({ where: { realm_id } });
		await Realm.destroy({ where: { id: realm_id } });
		await Daemon.destroy({ where: { id: daemon_id } });
		await close_test_control_plane_store();
	});

	it('list_daemon_ids_for_user returns intersection', async () => {
		const alice_ids = await AccessService.list_daemon_ids_for_user(alice);
		const bob_ids = await AccessService.list_daemon_ids_for_user(bob);
		const charlie_ids = await AccessService.list_daemon_ids_for_user(charlie);
		expect(alice_ids).toContain(daemon_id);
		expect(bob_ids).toContain(daemon_id);
		expect(charlie_ids).not.toContain(daemon_id);
	});

	it('assert_realm_access allows members and forbids others', async () => {
		await expect(AccessService.assert_realm_access(alice, daemon_id)).resolves.toBeUndefined();
		await expect(AccessService.assert_realm_access(charlie, daemon_id)).rejects.toBeInstanceOf(ApiError);
	});

	it('assert_scope_access checks membership', () => {
		expect(() => AccessService.assert_scope_access(['s1'], 's1')).not.toThrow();
		expect(() => AccessService.assert_scope_access(['s1'], 's2')).toThrow(ApiError);
	});

	it('assert_can_run_team_on_daemon needs both scope and realm', async () => {
		await expect(AccessService.assert_can_run_team_on_daemon({
			user_id: bob,
			daemon_id,
			scope_id: 'scope-a',
			accessible_scope_ids: ['scope-a'],
		})).resolves.toBeUndefined();

		await expect(AccessService.assert_can_run_team_on_daemon({
			user_id: bob,
			daemon_id,
			scope_id: 'scope-a',
			accessible_scope_ids: [],
		})).rejects.toBeInstanceOf(ApiError);

		await expect(AccessService.assert_can_run_team_on_daemon({
			user_id: charlie,
			daemon_id,
			scope_id: 'scope-a',
			accessible_scope_ids: ['scope-a'],
		})).rejects.toBeInstanceOf(ApiError);
	});

	it('assert_can_observe_run is realm-only when daemon assigned', async () => {
		await expect(AccessService.assert_can_observe_run(bob, { daemon_id: null })).resolves.toBeUndefined();
		await expect(AccessService.assert_can_observe_run(bob, { daemon_id })).resolves.toBeUndefined();
		await expect(AccessService.assert_can_observe_run(charlie, { daemon_id })).rejects.toBeInstanceOf(ApiError);
	});
});

