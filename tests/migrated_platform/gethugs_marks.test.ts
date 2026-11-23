/**
 * PLAN-gethugs-step2-provisioning.md sub-step 2: every write to what getHugs mirrors marks its org for the reconcile.
 * Marks are written after commit — a rolled-back write marks nothing — and marking twice only moves `marked_at`.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { test_config } from '../helpers/test_container.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { Org, OrgMember, OrgRole, User } from '../../src/models/index.js';
import { migrate_hub_schema } from '../../src/models/migrations/hub_schema_migrations.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { AuditRepository } from '../../src/repositories/audit_repository.js';
import { OrgMemberRepository } from '../../src/repositories/org_member_repository.js';
import { OrgRepository } from '../../src/repositories/org_repository.js';
import { ScopeMemberRepository } from '../../src/repositories/scope_member_repository.js';
import { ScopeRepository } from '../../src/repositories/scope_repository.js';
import { TeamRepository } from '../../src/repositories/team_repository.js';
import { TokenRepository } from '../../src/repositories/token_repository.js';
import { UserRepository } from '../../src/repositories/user_repository.js';
import type { AuthContext } from '../../src/schemas/auth_types.js';
import { ensure_account_org } from '../../src/services/account_org.js';
import { gethugs_mark, gethugs_mark_realm, gethugs_mark_user } from '../../src/services/gethugs_sync.js';
import { InvitationsService } from '../../src/services/invitations_service.js';
import { activate_org_membership, set_pending_org_membership } from '../../src/services/invite_records.js';
import { soft_delete_org, soft_delete_user } from '../../src/services/namespace_removal.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { OrgRoleService } from '../../src/services/org_role_service.js';
import { OrgsService } from '../../src/services/orgs_service.js';
import { PasswordLinkService } from '../../src/services/password_link.service.js';
import { ReactivationService } from '../../src/services/reactivation.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { UsersService } from '../../src/services/users_service.js';

const has_postgres = await postgres_reachable();
const ADMIN = hub_legacy_uuid(1);
const uid = () => `gm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const admin = { user: { id: ADMIN, role: 'admin', username: 'admin' }, org_ids: [], org_slugs: [], member_scopes: [], publish_orgs: [] } as unknown as AuthContext;

describe.skipIf(!has_postgres)('getHugs marks', () => {
    const orgs: string[] = [];
    const users: string[] = [];
    let orgs_service: OrgsService;
    let users_service: UsersService;

    /** When the org was last marked (null: never). */
    async function marked(org_id: string): Promise<Date | null> {
        const [rows] = await get_sequelize().query('SELECT marked_at FROM cliq.gethugs_sync WHERE org_id = :org_id', { replacements: { org_id } });
        return (rows as Array<{ marked_at: Date }>)[0]?.marked_at ?? null;
    }
    async function clear(...ids: string[]): Promise<void> {
        await get_sequelize().query('DELETE FROM cliq.gethugs_sync WHERE org_id = ANY(ARRAY[:ids]::uuid[])', { replacements: { ids } });
    }
    async function org(): Promise<string> {
        const slug = uid();
        const row = await Org.create({ slug, display_name: slug, status: 'active', owner_id: ADMIN } as never);
        orgs.push(row.id);
        await seed_default_roles_for_org(row.id);
        return row.id;
    }
    async function person(): Promise<string> {
        const name = uid();
        const id = randomUUID();
        await User.create({ id, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
        users.push(id);
        return id;
    }
    async function member(org_id: string, user_id: string, slug = 'member'): Promise<void> {
        const role = await OrgRole.findOne({ where: { org_id, slug }, attributes: ['id'], raw: true });
        await OrgMember.create({ org_id, user_id, role: slug === 'member' ? 'member' : 'admin', role_id: role?.id ?? null, status: 'active', joined_at: new Date() } as never);
    }
    /** Runs `fn` in a transaction that rolls back. */
    async function rolled_back(fn: (t: Transaction) => Promise<void>): Promise<void> {
        await expect(get_sequelize().transaction(async (t) => { await fn(t); throw new Error('roll back'); })).rejects.toThrow('roll back');
    }

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        const user_repo = new UserRepository();
        const org_repo = new OrgRepository();
        const scope_repo = new ScopeRepository();
        const org_member_repo = new OrgMemberRepository();
        const reactivation = new ReactivationService();
        const invitations = new InvitationsService(org_repo, scope_repo, user_repo, reactivation, async () => 'pat');
        orgs_service = new OrgsService(
            org_repo, org_member_repo, scope_repo, new ScopeMemberRepository(), user_repo, new TeamRepository(), new AuditRepository(), invitations, reactivation,
        );
        users_service = new UsersService(user_repo, scope_repo, new TokenRepository(), new AuditRepository(), org_member_repo, test_config(), reactivation, new PasswordLinkService());
    });

    afterAll(async () => {
        if (orgs.length) {
            await get_sequelize().query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[]))', { replacements: { ids: orgs } });
            await get_sequelize().query('DELETE FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[])', { replacements: { ids: orgs } });
            await Org.destroy({ where: { id: orgs } });
        }
        await close_test_control_plane_store();
    });

    describe('the mark', () => {
        let a: string;
        beforeEach(async () => { a = await org(); });

        it('marks an org; marking again moves marked_at; unknown and empty ids are ignored', async () => {
            expect(await marked(a)).toBeNull();
            await gethugs_mark([a, null, '', undefined, '00000000-0000-4000-8000-00000000dead']);
            const first = await marked(a);
            expect(first).not.toBeNull();
            await gethugs_mark(a);
            expect((await marked(a))!.getTime()).toBeGreaterThan(first!.getTime());
        });

        it('inside a transaction: written after commit; a rollback marks nothing', async () => {
            await rolled_back(async (t) => { await gethugs_mark(a, t); });
            expect(await marked(a)).toBeNull();
            await get_sequelize().transaction(async (t) => {
                await gethugs_mark(a, t);
                expect(await marked(a)).toBeNull();
            });
            expect(await marked(a)).not.toBeNull();
        });

        it('a person marks every org they are in; a realm marks its org', async () => {
            const b = await org();
            const p = await person();
            await member(a, p);
            await member(b, p);
            await gethugs_mark_user(p);
            expect([await marked(a), await marked(b)].every(Boolean)).toBe(true);

            const realm = await RealmService.create(ADMIN, uid(), 'R', { org_id: b });
            await clear(b);
            await gethugs_mark_realm(realm.id);
            expect(await marked(b)).not.toBeNull();
        });

        it('running the schema steps again keeps the tables and the marks', async () => {
            await gethugs_mark(a);
            await migrate_hub_schema(get_sequelize());
            expect(await marked(a)).not.toBeNull();
        });
    });

    describe('write paths mark their org', () => {
        let a: string;
        let p: string;
        beforeEach(async () => {
            a = await org();
            p = await person();
            await member(a, p);
            await clear(a);
        });

        it('orgs: rename, remove a member', async () => {
            await orgs_service.update(admin, { org_id: a, display_name: 'Renamed' });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            const q = await person();
            await member(a, q);
            await orgs_service.remove_member(admin, { org_id: a, user_id: q });
            expect(await marked(a)).not.toBeNull();
        });

        it('people: profile, suspend, unsuspend, org role; custom role permissions', async () => {
            await users_service.update(admin, { user_id: p, display_name: 'New name' });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await users_service.suspend(admin, { user_id: p });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await users_service.unsuspend(admin, { user_id: p });
            expect(await marked(a)).not.toBeNull();

            await clear(a);
            const role = await OrgRoleService.create(a, ADMIN, { slug: 'reviewer', name: 'Reviewer', permissions: ['runs.view'] });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await users_service.update_role(admin, { user_id: p, org_id: a, role_id: role.id });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await OrgRoleService.update(a, ADMIN, role.id, { permissions: [] });
            expect(await marked(a)).not.toBeNull();
        });

        it('realms: create, rename, members added, changed and removed, delete', async () => {
            const realm = await RealmService.create(ADMIN, uid(), 'R', { org_id: a });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await RealmService.update(realm.id, ADMIN, { name: 'R2' });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await RealmService.add_member(realm.id, ADMIN, { member_type: 'user', member_id: p, role: 'member' });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await RealmService.add_member(realm.id, ADMIN, { member_type: 'user', member_id: p, role: 'operator' });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            // Nothing changes, nothing is marked.
            await RealmService.add_member(realm.id, ADMIN, { member_type: 'user', member_id: p, role: 'operator' });
            expect(await marked(a)).toBeNull();
            await RealmService.remove_member(realm.id, ADMIN, 'user', p);
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await RealmService.remove(realm.id, ADMIN);
            expect(await marked(a)).not.toBeNull();
        });

        it('channels: org and realm channels mark; a personal channel does not', async () => {
            const realm = await RealmService.create(ADMIN, uid(), 'R', { org_id: a });
            await clear(a);
            const dest = [{ type: 'email', config: { to: 'ops@cliq.test' } }];
            const org_channel = await NotificationService.create_channel({ org_id: a, name: `c-${uid()}`, destinations: dest });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            const realm_channel = await NotificationService.create_channel({ realm_id: realm.id, name: `c-${uid()}`, destinations: dest });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await NotificationService.update_channel({ id: org_channel.id, destinations: [{ type: 'email', config: { to: 'oncall@cliq.test' } }] } as never);
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await NotificationService.remove_channel(realm_channel.id);
            expect(await marked(a)).not.toBeNull();
        });

        it('memberships from invites, account orgs and removals mark — and nothing when rolled back', async () => {
            const q = await person();
            await rolled_back(async (t) => { await set_pending_org_membership(a, q, 'member', new Date(), t); });
            expect(await marked(a)).toBeNull();
            await get_sequelize().transaction(async (t) => { await set_pending_org_membership(a, q, 'member', new Date(), t); });
            expect(await marked(a)).not.toBeNull();
            await clear(a);
            await get_sequelize().transaction(async (t) => { await activate_org_membership(a, q, 'member', new Date(), t); });
            expect(await marked(a)).not.toBeNull();

            const name = uid();
            const r = await person();
            await User.update({ username: name } as never, { where: { id: r } });
            const account = await get_sequelize().transaction((t) => ensure_account_org(r, name, t));
            orgs.push(account.id);
            expect(await marked(account.id)).not.toBeNull();

            await clear(a, account.id);
            await rolled_back(async (t) => { await soft_delete_user({ id: r, username: name }, t); });
            expect(await marked(account.id)).toBeNull();
            await get_sequelize().transaction(async (t) => { await soft_delete_user({ id: r, username: name }, t); });
            expect(await marked(account.id)).not.toBeNull();

            await rolled_back(async (t) => { await soft_delete_org({ id: a }, t); });
            expect(await marked(a)).toBeNull();
            await get_sequelize().transaction(async (t) => { await soft_delete_org({ id: a }, t); });
            expect(await marked(a)).not.toBeNull();
        });
    });
});
