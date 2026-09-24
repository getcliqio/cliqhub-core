import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Realm, RealmMember } from '../../src/models/index.js';
import { ApiError } from '../../src/lib/api_error.js';
import { RealmService } from '../../src/services/realm.service.js';

const has_postgres = await postgres_reachable();

const user_a = hub_legacy_uuid(1);
const user_b = hub_legacy_uuid(2);

async function cleanup_user(user_id: string): Promise<void> {
	const created = await Realm.findAll({ where: { created_by: user_id } });
	for (const row of created) {
		await RealmMember.destroy({ where: { realm_id: row.id } });
		await Realm.destroy({ where: { id: row.id } });
	}
	await RealmMember.destroy({ where: { member_type: 'user', member_id: user_id } });
}

beforeAll(async () => {
    if (!has_postgres) return;
	process.env.CLIQ_BFF_LOG_LEVEL = 'error';
	await open_test_control_plane_store();
});

beforeEach(async () => {
    if (!has_postgres) return;
	await cleanup_user(user_a);
	await cleanup_user(user_b);
});

afterAll(async () => {
    if (!has_postgres) return;
	await cleanup_user(user_a);
	await cleanup_user(user_b);
	await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('RealmService.create / members / tokens', () => {
	it('creates realm with creator as owner and admin', async () => {
		const realm = await RealmService.create(user_a, 'workers-a', 'Workers A');
		expect(realm.slug).toBe('workers-a');
		expect(realm.owner_user_id).toBe(user_a);
		expect(realm.created_by).toBe(user_a);
		const list = await RealmService.list_for_user(user_a);
		expect(list.realms.some((r) => r.id === realm.id)).toBe(true);
	});

	it('list_for_user is empty when user has no realm memberships', async () => {
		const list = await RealmService.list_for_user(user_a);
		expect(list).toEqual({ realms: [], total: 0 });
	});

	it('list_for_user only returns realms the caller belongs to', async () => {
		const owned = await RealmService.create(user_a, 'owned-only', 'Owned Only');
		await RealmService.create(user_b, 'other-user', 'Other User');
		const list = await RealmService.list_for_user(user_a);
		expect(list.realms.map((r) => r.id)).toEqual([owned.id]);
		expect(list.total).toBe(1);
		expect(list.realms.every((r) => r.slug !== 'other-user')).toBe(true);
	});

	it('list_for_user filters by query on slug or name', async () => {
		await RealmService.create(user_a, 'alpha-west', 'Alpha West');
		await RealmService.create(user_a, 'beta-east', 'Beta East');
		const by_slug = await RealmService.list_for_user(user_a, { query: 'alpha' });
		expect(by_slug.realms.map((r) => r.slug)).toEqual(['alpha-west']);
		const by_name = await RealmService.list_for_user(user_a, { query: 'east' });
		expect(by_name.realms.map((r) => r.slug)).toEqual(['beta-east']);
	});

	it('list_for_user supports owned=me, sort, and pagination', async () => {
		await RealmService.create(user_a, 'zeta-realm', 'Zeta');
		await RealmService.create(user_a, 'alpha-realm', 'Alpha');
		const shared = await RealmService.create(user_b, 'shared-sort', 'Shared Sort');
		await RealmService.add_member(shared.id, user_b, {
			member_type: 'user',
			member_id: user_a,
			role: 'member',
		});

		const owned = await RealmService.list_for_user(user_a, { owned: 'me', sort_by: 'slug', sort_dir: 'asc' });
		expect(owned.realms.map((r) => r.slug)).toEqual(['alpha-realm', 'zeta-realm']);
		expect(owned.total).toBe(2);

		const page = await RealmService.list_for_user(user_a, {
			sort_by: 'slug',
			sort_dir: 'asc',
			limit: 1,
			offset: 0,
		});
		expect(page.realms).toHaveLength(1);
		expect(page.realms[0]?.slug).toBe('alpha-realm');
		expect(page.total).toBe(3);
	});

	it('rejects invalid slug', async () => {
		await expect(RealmService.create(user_a, 'Bad Slug!', 'x')).rejects.toBeInstanceOf(ApiError);
	});

	it('rejects duplicate slug', async () => {
		await RealmService.create(user_a, 'dup-slug', 'One');
		await expect(RealmService.create(user_a, 'dup-slug', 'Two')).rejects.toBeInstanceOf(ApiError);
	});

	it('admin can add member; member can mint realm token', async () => {
		const realm = await RealmService.create(user_a, 'shared-realm', 'Shared');
		await RealmService.add_member(realm.id, user_a, {
			member_type: 'user',
			member_id: user_b,
			role: 'operator',
		});
		const created_by_member = await RealmService.create_token(realm.id, user_b, 'pod');
		expect(created_by_member.token.startsWith('cliq_dt_')).toBe(true);

		const created = await RealmService.create_token(realm.id, user_a, 'pod-admin');
		expect(created.token.startsWith('cliq_dt_')).toBe(true);
		expect(created.token_hash).toBeUndefined();

		const resolved = await RealmService.resolve_token(created.token);
		expect(resolved.realm_id).toBe(realm.id);

		await RealmService.revoke_token(realm.id, user_a, created.id);
		await expect(RealmService.resolve_token(created.token)).rejects.toBeInstanceOf(ApiError);
	});

	it('admin can soft-delete a created realm', async () => {
		const realm = await RealmService.create(user_a, 'temp-realm', 'Temp');
		await RealmService.remove(realm.id, user_a);
		await expect(RealmService.get(realm.id, user_a)).rejects.toBeInstanceOf(ApiError);
		const row = await Realm.findByPk(realm.id);
		expect(row?.deleted).toBe(true);
	});

	it('forbids non-member get', async () => {
		const realm = await RealmService.create(user_a, 'private-a', 'Private');
		await expect(RealmService.get(realm.id, user_b)).rejects.toBeInstanceOf(ApiError);
	});
});

