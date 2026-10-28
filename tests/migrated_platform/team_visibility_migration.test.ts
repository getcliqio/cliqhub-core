/**
 * `migrate_team_visibility` (PLAN-team-visibility §5.3): nobody loses a private team they read today
 * (plain org members are assigned to scopes holding private teams; owners and admins already count),
 * `org_teams` keeps only teams from other orgs' scopes, the scope columns are gone, and a scope with no
 * org stops the migration before it changes anything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { ensure_account_org, ensure_account_scope } from '../../src/services/account_org.js';
import { Org, OrgMember, OrgRole, OrgTeam, Scope, ScopeMember, Setting, Team, User } from '../../src/models/index.js';
import { TEAM_VISIBILITY_MIGRATION_KEY, migrate_team_visibility } from '../../src/models/migrations/migrate_team_visibility.js';
import { get_sequelize } from '../../src/db/sequelize.js';

const has_postgres = await postgres_reachable();
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!has_postgres)('team visibility migration', () => {
	const users: string[] = [];
	const orgs: string[] = [];
	const scopes: string[] = [];
	const teams: string[] = [];

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});
	afterAll(async () => {
		if (!has_postgres) return;
		await OrgTeam.destroy({ where: { org_id: orgs } });
		await Team.destroy({ where: { id: teams } });
		await Org.update({ default_scope_id: null }, { where: { id: orgs } });
		const ids = (await Scope.findAll({ where: { slug: scopes }, attributes: ['id'], raw: true })).map((s) => s.id);
		await ScopeMember.destroy({ where: { scope_id: ids } });
		await Scope.destroy({ where: { slug: scopes } });
		await OrgMember.destroy({ where: { org_id: orgs } });
		await Org.update({ deleted_at: new Date() } as never, { where: { id: orgs } });
		await User.update({ deleted_at: new Date() } as never, { where: { id: users } });
		// Leave the migration recorded, as every boot would.
		await migrate_team_visibility(get_sequelize());
		await close_test_control_plane_store();
	});

	async function person(): Promise<string> {
		const username = `tv${uid()}`.slice(0, 20);
		const user = await User.create({ username, email: `${username}@tv.test`, display_name: username, role: 'user', status: 'active', password_hash: null } as never);
		users.push(String(user.id));
		return String(user.id);
	}

	/** An account org with its scope (the owner holds the system role), and its scope's slug. */
	async function org(): Promise<{ org_id: string; slug: string; owner: string }> {
		const owner = await person();
		const username = (await User.findByPk(owner, { attributes: ['username'], raw: true }))!.username as string;
		scopes.push(username);
		const o = await Org.sequelize!.transaction(async (t) => {
			const made = await ensure_account_org(owner, username, t);
			await ensure_account_scope(owner, username, username, made.id, t);
			return made;
		});
		orgs.push(o.id);
		return { org_id: o.id, slug: username, owner };
	}

	async function join(org_id: string, user_id: string, role: string): Promise<void> {
		const r = await OrgRole.findOne({ where: { org_id, slug: role }, attributes: ['id'], raw: true });
		await OrgMember.create({ org_id, user_id, role, role_id: r!.id, status: 'active' } as never);
	}

	async function team(scope: string, visibility: 'public' | 'private'): Promise<string> {
		const id = randomUUID();
		await Team.create({ id, name: `tv${uid()}`, scope, visibility, listed: 1, author_id: null } as never);
		teams.push(id);
		return id;
	}

	const unmark = () => Setting.destroy({ where: { key: TEAM_VISIBILITY_MIGRATION_KEY } });
	const marked = async () => (await Setting.count({ where: { key: TEAM_VISIBILITY_MIGRATION_KEY } })) > 0;

	it("assigns plain members to scopes holding private teams; keeps only other orgs' teams in org_teams; once", async () => {
		const x = await org();
		const y = await org();
		const member = await person();
		const admin = await person();
		await join(x.org_id, member, 'member');
		await join(x.org_id, admin, 'admin');
		const priv = await team(x.slug, 'private');
		const theirs = await team(y.slug, 'public');
		await OrgTeam.bulkCreate([
			{ org_id: x.org_id, team_id: priv, added_by: null, added_at: new Date() },
			{ org_id: x.org_id, team_id: theirs, added_by: null, added_at: new Date() },
		] as never);
		const x_scope = (await Scope.findOne({ where: { slug: x.slug }, attributes: ['id'], raw: true }))!.id;

		// Other tests leave scopes with no org in the shared test database; lend them an org meanwhile.
		const lender = await org();
		const [lent] = await get_sequelize().query(
			`UPDATE cliq."scopes" SET "org_id" = :org WHERE "org_id" IS NULL AND "is_default" = 0 RETURNING "id"`,
			{ replacements: { org: lender.org_id } },
		) as [Array<{ id: string }>, unknown];
		await unmark();
		try {
			await migrate_team_visibility(get_sequelize());
		} finally {
			if (lent.length) await Scope.update({ org_id: null }, { where: { id: lent.map((r) => r.id) } });
		}

		expect(await marked()).toBe(true);
		expect(await ScopeMember.count({ where: { scope_id: x_scope, user_id: member } })).toBe(1);
		// Owners and admins are scope members without a row.
		expect(await ScopeMember.count({ where: { scope_id: x_scope, user_id: admin } })).toBe(0);
		expect((await OrgTeam.findAll({ where: { org_id: x.org_id }, raw: true })).map((r) => r.team_id)).toEqual([theirs]);
		const [cols] = await get_sequelize().query(
			`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'cliq'
			   AND ((table_name = 'scopes' AND column_name IN ('visibility', 'scope_type')) OR (table_name = 'teams' AND column_name = 'scope_type'))`,
		);
		expect(cols).toEqual([]);

		// Recorded: a later run changes nothing.
		const later = await person();
		await join(x.org_id, later, 'member');
		await migrate_team_visibility(get_sequelize());
		expect(await ScopeMember.count({ where: { scope_id: x_scope, user_id: later } })).toBe(0);
	});

	it('a scope with no org stops it before anything changes', async () => {
		const x = await org();
		const member = await person();
		await join(x.org_id, member, 'member');
		await team(x.slug, 'private');
		const orphan = `tvorph${uid()}`.slice(0, 20);
		scopes.push(orphan);
		await Scope.create({ slug: orphan, display_name: orphan, owner_id: null, org_id: null } as never);
		const x_scope = (await Scope.findOne({ where: { slug: x.slug }, attributes: ['id'], raw: true }))!.id;

		await unmark();
		await migrate_team_visibility(get_sequelize());

		expect(await marked()).toBe(false);
		expect(await ScopeMember.count({ where: { scope_id: x_scope, user_id: member } })).toBe(0);
		await Scope.destroy({ where: { slug: orphan } });
	});
});
