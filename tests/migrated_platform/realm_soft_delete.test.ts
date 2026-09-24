import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { randomUUID } from 'node:crypto';

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import {
	Daemon,
	Realm,
	RealmDispatchQueue,
	RealmMember,
	Run,
} from '../../src/models/index.js';
import { HubEvent } from '../../src/events/event.model.js';
import { ApiError } from '../../src/lib/api_error.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ScopeService } from '../../src/services/control_scope_service.js';
import { TeamService } from '../../src/services/teams_install_service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';
import { TokenRepository } from '../../src/repositories/token_repository.js';
import { User } from '../../src/db/models/user.js';
import { ApiToken } from '../../src/db/models/index.js';

const has_postgres = await postgres_reachable();

const user_a = hub_legacy_uuid(1);
const user_b = hub_legacy_uuid(2);

let fixture_workspace_id = '';
let fixture_team_id = '';

async function cleanup_user(user_id: string): Promise<void> {
	const created = await Realm.findAll({ where: { created_by: user_id } });
	for (const row of created) {
		await RealmMember.destroy({ where: { realm_id: row.id } });
		await RealmDispatchQueue.destroy({ where: { realm_id: row.id } });
		await Run.destroy({ where: { realm_id: row.id } });
		await HubEvent.destroy({ where: { realm_id: row.id } });
		await Realm.destroy({ where: { id: row.id } });
	}
	await RealmMember.destroy({ where: { member_type: 'user', member_id: user_id } });
}

async function reset_default_realm_pointer(): Promise<void> {
	await User.update({ default_realm_id: null }, { where: { id: user_a } });
	await User.update({ default_realm_id: null }, { where: { id: user_b } });
}

async function create_blocking_run(realm_id: string, state: 'running' | 'awaiting_input') {
	return Run.create({
		run_id: randomUUID(),
		workspace_id: fixture_workspace_id,
		team_id: fixture_team_id,
		daemon_id: null,
		realm_id,
		parent_run_id: null,
		parent_phase: null,
		run_name: `blocking-${state}`,
		state,
		inputs: null,
		error: null,
		execution_type: 'local',
		current_pid: null,
		current_phase: null,
		external_id: null,
		context_labels: null,
		started_at: Date.now(),
		completed_at: null,
	});
}

beforeAll(async () => {
	if (!has_postgres) return;
	process.env.CLIQ_BFF_LOG_LEVEL = 'error';
	await open_test_control_plane_store();

	const scope = await ScopeService.add(`soft-del-scope-${Date.now()}`);
	const team = await TeamService.create(scope.id, `soft-del-team-${Date.now()}`, '1.0', null, '{}');
	fixture_team_id = team.get('id') as string;
	const { record } = await WorkspaceService.upsert_by_path(`/tmp/soft-del-ws-${Date.now()}`);
	fixture_workspace_id = record.id;
});

beforeEach(async () => {
	if (!has_postgres) return;
	await cleanup_user(user_a);
	await cleanup_user(user_b);
	await reset_default_realm_pointer();
});

afterAll(async () => {
	if (!has_postgres) return;
	await cleanup_user(user_a);
	await cleanup_user(user_b);
	await reset_default_realm_pointer();
	await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('RealmService.remove soft-delete', () => {
	it('soft-deletes: sets deleted flag, frees slug, hides from list/get', async () => {
		const realm = await RealmService.create(user_a, 'soft-del-a', 'Soft Del A');
		await RealmService.remove(realm.id, user_a);

		const row = await Realm.findByPk(realm.id);
		expect(row).not.toBeNull();
		expect(row!.deleted).toBe(true);
		expect(row!.deleted_at).toBeTruthy();
		expect(row!.slug).not.toBe('soft-del-a');
		expect(row!.slug).toContain('soft-del-a.deleted.');

		await expect(RealmService.get(realm.id, user_a)).rejects.toBeInstanceOf(ApiError);
		await expect(RealmService.get_by_slug('soft-del-a', user_a)).rejects.toBeInstanceOf(ApiError);

		const list = await RealmService.list_for_user(user_a);
		expect(list.realms.some((r) => r.id === realm.id)).toBe(false);
	});

	it('allows recreating the same slug after soft-delete', async () => {
		const first = await RealmService.create(user_a, 'reuse-slug', 'Reuse 1');
		await RealmService.remove(first.id, user_a);

		const second = await RealmService.create(user_a, 'reuse-slug', 'Reuse 2');
		expect(second.slug).toBe('reuse-slug');
		expect(second.id).not.toBe(first.id);
		expect(second.name).toBe('Reuse 2');
	});

	it('removes all members and marks enrolled daemons offline', async () => {
		const realm = await RealmService.create(user_a, 'soft-members', 'Soft Members');
		await RealmService.add_member(realm.id, user_a, {
			member_type: 'user',
			member_id: user_b,
			role: 'operator',
		});

		const daemon_id = randomUUID();
		await Daemon.create({
			id: daemon_id,
			api_key_hash: 'soft-del-daemon',
			user_id: user_a,
			user_email: 'platform@test.local',
			hostname: 'soft-del-host',
			ip: null,
			port: null,
			public_url: null,
			status: 'online',
			last_heartbeat: Date.now(),
			capacity: 2,
			created_at: Date.now(),
			last_registered_at: Date.now(),
		});
		await RealmService.add_member(realm.id, user_a, {
			member_type: 'daemon',
			member_id: daemon_id,
			role: 'member',
		});

		await RealmService.remove(realm.id, user_a);

		const members = await RealmMember.findAll({ where: { realm_id: realm.id } });
		expect(members).toHaveLength(0);

		const daemon = await Daemon.findByPk(daemon_id);
		expect(daemon?.status).toBe('offline');

		await expect(
			RealmService.assert_daemon_in_realm(realm.id, daemon_id),
		).rejects.toBeInstanceOf(ApiError);

		await Daemon.destroy({ where: { id: daemon_id } });
	});

	it('revokes realm enroll tokens so resolve_token fails', async () => {
		const realm = await RealmService.create(user_a, 'soft-tokens', 'Soft Tokens');
		const created = await RealmService.create_token(realm.id, user_a, 'enroll');
		const resolved = await RealmService.resolve_token(created.token);
		expect(resolved.realm_id).toBe(realm.id);

		await RealmService.remove(realm.id, user_a);

		await expect(RealmService.resolve_token(created.token)).rejects.toBeInstanceOf(ApiError);

		const listed = await new TokenRepository().list_daemon_tokens_for_realm(realm.id);
		expect(listed).toHaveLength(0);
	});

	it('also revokes auto-enrolled type=daemon tokens for the realm', async () => {
		const realm = await RealmService.create(user_a, 'soft-daemon-tok', 'Soft Daemon Tok');
		const plaintext_hash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
		const token = await ApiToken.create({
			id: randomUUID(),
			type: 'daemon',
			user_id: user_a,
			name: `auto-enroll-${randomUUID().slice(0, 8)}`,
			token_hash: plaintext_hash,
			token_prefix: plaintext_hash.slice(0, 16),
			permissions: {
				domains: { realms: [realm.id] },
				access: {},
				auto_enrolled: true,
			},
			revoked_at: null,
		});

		const before = await new TokenRepository().list_daemon_tokens_for_realm(realm.id);
		expect(before.some((t) => t.id === token.id)).toBe(true);

		await RealmService.remove(realm.id, user_a);

		const after = await ApiToken.findByPk(token.id);
		expect(after?.revoked_at).toBeTruthy();
	});

	it('fires realm.member_removed for each member and realm.deleted', async () => {
		const realm = await RealmService.create(user_a, 'soft-events', 'Soft Events');
		await RealmService.add_member(realm.id, user_a, {
			member_type: 'user',
			member_id: user_b,
			role: 'member',
		});

		await HubEvent.destroy({ where: { realm_id: realm.id } });
		await RealmService.remove(realm.id, user_a);

		const events = await HubEvent.findAll({
			where: { realm_id: realm.id },
			order: [['created_at', 'ASC']],
		});
		const types = events.map((e) => e.type);
		expect(types.filter((t) => t === 'realm.member_removed').length).toBeGreaterThanOrEqual(2);
		expect(types).toContain('realm.deleted');

		const deleted = events.find((e) => e.type === 'realm.deleted');
		expect(deleted?.payload_json).toContain('soft-events');
		expect(deleted?.payload_json).toContain('soft_delete');
	});

	it('blocks delete while a run is running', async () => {
		const realm = await RealmService.create(user_a, 'soft-active-run', 'Active Run');
		const run = await create_blocking_run(realm.id, 'running');

		await expect(RealmService.remove(realm.id, user_a)).rejects.toMatchObject({
			status_code: 409,
		});

		const still = await Realm.findByPk(realm.id);
		expect(still?.deleted).toBe(false);

		await Run.update(
			{ state: 'completed', completed_at: Date.now() },
			{ where: { run_id: run.run_id } },
		);
		await RealmService.remove(realm.id, user_a);
		const gone = await Realm.findByPk(realm.id);
		expect(gone?.deleted).toBe(true);
	});

	it('blocks delete while awaiting_input', async () => {
		const realm = await RealmService.create(user_a, 'soft-await', 'Await');
		await create_blocking_run(realm.id, 'awaiting_input');

		const err = await RealmService.remove(realm.id, user_a).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status_code).toBe(409);
		const still = await Realm.findByPk(realm.id);
		expect(still?.deleted).toBe(false);
	});

	it('blocks delete while dispatch queue has active jobs', async () => {
		const realm = await RealmService.create(user_a, 'soft-dispatch', 'Dispatch');
		const now = Date.now();
		await RealmDispatchQueue.create({
			id: randomUUID(),
			realm_id: realm.id,
			kind: 'run',
			payload: {},
			priority: 0,
			status: 'queued',
			claimed_by: null,
			claimed_at: null,
			run_id: null,
			results: null,
			submitted_by: user_a,
			submitted_at: now,
			error: null,
			created_at: now,
			updated_at: now,
		});

		const err = await RealmService.remove(realm.id, user_a).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status_code).toBe(409);
	});

	it('blocks deleting the personal default realm', async () => {
		const realm = await RealmService.create(user_a, 'soft-default', 'Default Candidate');
		await User.update(
			{ default_realm_id: realm.id },
			{ where: { id: user_a } },
		);

		const err = await RealmService.remove(realm.id, user_a).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status_code).toBe(409);
		expect(String((err as ApiError).message)).toMatch(/default realm/i);

		const still = await Realm.findByPk(realm.id);
		expect(still?.deleted).toBe(false);
	});

	it('fires realm.member_removed on manual member remove', async () => {
		const realm = await RealmService.create(user_a, 'soft-manual-rm', 'Manual RM');
		await RealmService.add_member(realm.id, user_a, {
			member_type: 'user',
			member_id: user_b,
			role: 'member',
		});
		await HubEvent.destroy({ where: { realm_id: realm.id } });

		await RealmService.remove_member(realm.id, user_a, 'user', user_b);

		const events = await HubEvent.findAll({
			where: { realm_id: realm.id, type: 'realm.member_removed' },
		});
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[0]?.payload_json).toContain('"reason":"manual"');
	});

	it('forbids non-admin from deleting', async () => {
		const realm = await RealmService.create(user_a, 'soft-noadmin', 'No Admin');
		await RealmService.add_member(realm.id, user_a, {
			member_type: 'user',
			member_id: user_b,
			role: 'operator',
		});
		await expect(RealmService.remove(realm.id, user_b)).rejects.toBeInstanceOf(ApiError);
	});

	it('second delete fails after membership was cleared', async () => {
		const realm = await RealmService.create(user_a, 'soft-twice', 'Twice');
		await RealmService.remove(realm.id, user_a);
		// Members are detached on soft-delete, so require_admin rejects before the
		// deleted-row 404 path — both mean "cannot delete again."
		const err = await RealmService.remove(realm.id, user_a).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect([403, 404]).toContain((err as ApiError).status_code);
	});

	it('allows delete when only completed runs exist', async () => {
		const realm = await RealmService.create(user_a, 'soft-done-run', 'Done Run');
		await Run.create({
			run_id: randomUUID(),
			workspace_id: fixture_workspace_id,
			team_id: fixture_team_id,
			daemon_id: null,
			realm_id: realm.id,
			parent_run_id: null,
			parent_phase: null,
			run_name: 'already-done',
			state: 'completed',
			inputs: null,
			error: null,
			execution_type: 'local',
			current_pid: null,
			current_phase: null,
			external_id: null,
			context_labels: null,
			started_at: Date.now() - 1000,
			completed_at: Date.now(),
		});

		await RealmService.remove(realm.id, user_a);
		const row = await Realm.findByPk(realm.id);
		expect(row?.deleted).toBe(true);
	});

	it('clears default_realm_id pointers for other users', async () => {
		const realm = await RealmService.create(user_a, 'soft-pointer', 'Pointer');
		await RealmService.add_member(realm.id, user_a, {
			member_type: 'user',
			member_id: user_b,
			role: 'member',
		});
		await User.update(
			{ default_realm_id: realm.id },
			{ where: { id: user_b } },
		);

		await RealmService.remove(realm.id, user_a);

		const user = await User.findByPk(user_b);
		expect(user?.default_realm_id).toBeNull();
	});
});
