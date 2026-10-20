/**
 * PLAN-tokens-sessions step 1 — the one-time revoke of the `admin` account's tokens left by Core's test suite
 * running against prod: active `test…` and `jira-<13 digits>` tokens made Aug 15 – Sep 11, 2026. Nothing
 * else: the account's realm tokens, sessions, other names and later tokens stay; nothing is deleted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { ApiToken, Setting, User } from '../../src/models/index.js';
import { ADMIN_TEST_TOKENS_MIGRATION_KEY, revoke_admin_test_tokens } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('revoke the admin account\'s test tokens (once)', () => {
	const ids: string[] = [];
	let admin_id: string;
	let other_id: string;

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
		const admin = await User.findOne({ where: { username: 'admin' }, raw: true })
			?? await User.create({ username: 'admin', email: `admin-${randomUUID()}@tokens.test`, display_name: 'admin', role: 'admin', status: 'active', password_hash: null } as never);
		admin_id = String((admin as { id: string }).id);
		const other = await User.create({ username: `tk${Date.now().toString(36)}`, email: `${randomUUID()}@tokens.test`, display_name: 'o', role: 'user', status: 'active', password_hash: null } as never);
		other_id = String(other.id);
	});
	afterAll(async () => {
		if (!has_postgres) return;
		await ApiToken.destroy({ where: { id: ids } });
		await User.update({ deleted_at: new Date() } as never, { where: { id: other_id } });
		await close_test_control_plane_store();
	});

	async function token(user_id: string, type: 'user' | 'realm', name: string, created_at: string, revoked = false): Promise<string> {
		const id = `t-${randomUUID()}`;
		await ApiToken.create({ id, type, user_id, token_hash: `h-${id}`, name, created_at: new Date(created_at), revoked_at: revoked ? new Date() : null } as never);
		ids.push(id);
		return id;
	}

	it('revokes only admin\'s test… and jira-<timestamp> tokens from the window; the rest stay', async () => {
		const gone = [
			await token(admin_id, 'user', 'test20260901abcd', '2026-09-01T10:00:00Z'),
			await token(admin_id, 'user', 'jira-1788840565970', '2026-09-08T10:00:00Z'),
		];
		const kept = [
			await token(admin_id, 'user', 'jira-prod-integration', '2026-09-08T10:00:00Z'),
			await token(admin_id, 'user', 'test-later', '2026-10-01T10:00:00Z'),
			await token(admin_id, 'realm', 'default', '2026-09-02T10:00:00Z'),
			await token(admin_id, 'user', 'session:2026-09-05', '2026-09-05T10:00:00Z'),
			await token(other_id, 'user', 'test20260901abcd', '2026-09-01T10:00:00Z'),
		];

		await Setting.destroy({ where: { key: ADMIN_TEST_TOKENS_MIGRATION_KEY } });
		await revoke_admin_test_tokens(ApiToken.sequelize!);
		await revoke_admin_test_tokens(ApiToken.sequelize!); // once

		const state = async (id: string) => (await ApiToken.findByPk(id, { raw: true }))?.revoked_at ?? null;
		for (const id of gone) expect(await state(id)).not.toBeNull();
		for (const id of kept) expect(await state(id)).toBeNull();
		expect(await ApiToken.count({ where: { id: [...gone, ...kept] } })).toBe(7);
		expect(await Setting.findByPk(ADMIN_TEST_TOKENS_MIGRATION_KEY)).toBeTruthy();
	});
});
