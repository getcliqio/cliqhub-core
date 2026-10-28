/**
 * Every account org has its scope, the way signup makes it (Oct 2026): named after the username, public,
 * owned by the user, linked to the account org, the user a member, the org's default scope.
 * `migrate_account_scopes` fixes accounts made before that (no scope) or through an invite / by an admin
 * (a scope not linked to the org); a scope of that name someone else owns is left alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { ensure_account_org, ensure_account_scope } from '../../src/services/account_org.js';
import { Org, Scope, ScopeMember, Setting, User } from '../../src/models/index.js';
import { ACCOUNT_SCOPES_MIGRATION_KEY, migrate_account_scopes } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!has_postgres)('account scopes', () => {
	const users: string[] = [];
	const orgs: string[] = [];
	const names: string[] = [];

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});
	afterAll(async () => {
		if (!has_postgres) return;
		await Org.update({ default_scope_id: null }, { where: { id: orgs } });
		const scopes = await Scope.findAll({ where: { slug: names }, attributes: ['id'], raw: true });
		await ScopeMember.destroy({ where: { scope_id: scopes.map((s) => s.id) } });
		await Scope.destroy({ where: { slug: names } });
		await Org.update({ deleted_at: new Date() } as never, { where: { id: orgs } });
		await User.update({ deleted_at: new Date() } as never, { where: { id: users } });
		await close_test_control_plane_store();
	});

	/** A person and their account org, with no scope (as accounts made before signup created one). */
	async function account(): Promise<{ user_id: string; username: string; org_id: string }> {
		const username = `as${uid()}`.slice(0, 20);
		names.push(username);
		const user = await User.create({ username, email: `${username}@scopes.test`, display_name: username, role: 'user', status: 'active', password_hash: null } as never);
		users.push(String(user.id));
		const org = await Org.sequelize!.transaction((t) => ensure_account_org(String(user.id), username, t));
		orgs.push(org.id);
		return { user_id: String(user.id), username, org_id: org.id };
	}
	const state = async (a: { user_id: string; username: string; org_id: string }) => {
		const scope = await Scope.findOne({ where: { slug: a.username }, raw: true });
		return {
			scope: scope ? { owner_id: scope.owner_id, org_id: scope.org_id } : null,
			member: scope ? await ScopeMember.count({ where: { scope_id: scope.id, user_id: a.user_id } }) : 0,
			is_default: scope ? (await Org.findByPk(a.org_id, { raw: true }))!.default_scope_id === scope.id : false,
		};
	};

	it('the migration gives a scope-less account its scope and links an unlinked one; once', async () => {
		const missing = await account();
		const unlinked = await account();
		await Scope.create({ slug: unlinked.username, display_name: unlinked.username, owner_id: unlinked.user_id } as never);

		await Setting.destroy({ where: { key: ACCOUNT_SCOPES_MIGRATION_KEY } });
		await migrate_account_scopes(Org.sequelize!);
		await migrate_account_scopes(Org.sequelize!); // once

		for (const a of [missing, unlinked]) {
			expect(await state(a)).toEqual({ scope: { owner_id: a.user_id, org_id: a.org_id }, member: 1, is_default: true });
		}
		expect(await Scope.count({ where: { slug: [missing.username, unlinked.username] } })).toBe(2);
		expect(await Setting.findByPk(ACCOUNT_SCOPES_MIGRATION_KEY)).toBeTruthy();
	});

	it('a scope of that name someone else owns is left alone', async () => {
		const a = await account();
		const other = await account();
		await Scope.create({ slug: a.username, display_name: 'theirs', owner_id: other.user_id } as never);

		await expect(Org.sequelize!.transaction((t) => ensure_account_scope(a.user_id, a.username, a.username, a.org_id, t))).resolves.toBeNull();
		await Setting.destroy({ where: { key: ACCOUNT_SCOPES_MIGRATION_KEY } });
		await migrate_account_scopes(Org.sequelize!);

		expect(await state(a)).toEqual({ scope: { owner_id: other.user_id, org_id: null }, member: 0, is_default: false });
	});
});
