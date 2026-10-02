/**
 * Soft delete, reactivation, sign-in refusals, locked notification rules and
 * channels, and owner-only org rules — over HTTP on live Postgres (full
 * production app, route policy enforced).
 *
 *   1. orgs/delete keeps the rows (`{ id, deleted_at }`), hides the org from
 *      reads (site admins see it with include_deleted), keeps the slug taken
 *      (`409 deleted`), and a site admin restores the same id with its realms,
 *      scopes, channels and rules; former members stay former members.
 *   2. users/delete keeps the user and soft-deletes their account org; the
 *      username and email stay taken; their tokens stop working; users/get
 *      rows carry status and deleted_at; restore brings back the same id as
 *      an invited user with their account org.
 *   3. users/delete refuses with `409 owns_orgs` while the user owns another
 *      org or their account org has another owner.
 *   4. Sign-in refuses deleted users (`403 account_deleted`) and invited ones
 *      (`409 not_active`) before any password check.
 *   5. Locked rules and channels answer `409 locked`; rule and channel reads
 *      carry recipients / system_key / locked / lock_reason.
 *   6. `rules.manage` is owner-only: org admins can read rules but not change them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import {
    AccountInvite, ApiToken, NotificationChannel, NotificationRule, Org, OrgMember, OrgRole,
    Realm, Scope, ScopeMember, User,
} from '../../src/models/index.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { OrgSeedService } from '../../src/services/org_seed.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ReactivationService } from '../../src/services/reactivation.service.js';
import { remove_org_rows } from '../helpers/remove_org_rows.js';
import { ADMIN_PERMISSIONS, OWNER_ONLY_PERMISSIONS } from '../../src/auth/permissions.js';
import type { AuthContext } from '../../src/schemas/auth_types.js';

const has_postgres = await postgres_reachable();
const password = 'password123';

describe.skipIf(!has_postgres)('soft delete, reactivation and locks', () => {
    let app: Express;
    let s: Seed;
    const made_orgs: string[] = [];
    const reactivation = new ReactivationService();

    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const as_auth = (id: string, role: 'admin' | 'user'): AuthContext => ({
        user: { id, username: `u${id.slice(0, 6)}`, display_name: '', email: '', role, suspended_at: null, suspended_reason: '', created_at: new Date().toISOString() },
        org_slugs: [], org_ids: [], scopes: [],
    });
    const sam_auth = () => as_auth(s.user.sam, 'admin');
    /** Error code and details from either envelope (`/v1` routers put them beside the message). */
    const err = (res: request.Response) => {
        const e = res.body.error;
        return typeof e === 'object' && e !== null
            ? { code: e.code, message: e.message, details: e.details }
            : { code: res.body.code, message: e, details: res.body.details };
    };

    /** An org (not an account org) owned by `owner`, with roles, scope, default channels/rules and its default realm. */
    async function make_org(label: string, owner: { id: string }) {
        const slug = `sd${label}${s.stamp}`.slice(0, 40).toLowerCase();
        const org = await Org.create({ slug, display_name: `Org ${label}`, owner_id: owner.id, activated_at: new Date() } as never);
        made_orgs.push(org.id);
        await seed_default_roles_for_org(org.id);
        const owner_role = await OrgRole.findOne({ where: { org_id: org.id, slug: 'owner' }, attributes: ['id'], raw: true });
        await OrgMember.create({ org_id: org.id, user_id: owner.id, role: 'admin', role_id: owner_role!.id } as never);
        const scope = await Scope.create({ slug, display_name: slug, owner_id: owner.id, visibility: 'public', scope_type: 'org', org_id: org.id } as never);
        await ScopeMember.create({ scope_id: scope.id, user_id: owner.id } as never);
        await Org.update({ default_scope_id: scope.id } as never, { where: { id: org.id } });
        await OrgSeedService.seed_org(org.id, { account: false });
        const realm = await RealmService.ensure_org_default_realm(slug, owner.id);
        return { id: org.id, slug, realm_id: String(realm.id), scope_id: scope.id };
    }

    async function add_member(org_id: string, user_id: string, role: 'admin' | 'member' | 'owner') {
        const r = await OrgRole.findOne({ where: { org_id, slug: role }, attributes: ['id'], raw: true });
        await OrgMember.create({ org_id, user_id, role: role === 'owner' ? 'admin' : role, role_id: r!.id } as never);
    }

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        await User.update({ deleted_at: null, status: 'active' } as never, { where: { username: { [Op.like]: `%${s?.stamp}%` } } });
        for (const id of made_orgs) {
            try {
                await get_sequelize().transaction(async (t) => {
                    const org = await Org.findByPk(id, { transaction: t });
                    if (org) await remove_org_rows({ id }, t);
                });
            } catch { /* best effort */ }
        }
        await Org.update({ deleted_at: null, status: 'active' } as never, { where: { slug: { [Op.like]: `%${s?.stamp}%` } } });
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    // ── 1. orgs ───────────────────────────────────────────────────────

    describe('orgs/delete and restore_org', () => {
        it('soft-deletes: rows stay, reads hide it, the slug stays taken, and restore brings the same org back', async () => {
            const owner = await s.signup('orgown');
            const member = await s.signup('orgmem');
            const org = await make_org('del', owner);
            await add_member(org.id, member.id, 'member');
            const invite_id = randomUUID();
            await AccountInvite.create({ id: invite_id, org_id: org.id, email: `p${s.stamp}@sd.test`, invited_by: owner.id, token_hash: `sd${s.stamp}`, role: 'member', status: 'pending', expires_at: new Date(Date.now() + 86_400_000) } as never);
            const channels_before = await NotificationChannel.count({ where: { org_id: org.id } });
            const rules_before = await NotificationRule.count({ where: { org_id: org.id } });
            expect(channels_before).toBeGreaterThan(0);

            const del = await post('/v1/orgs/delete', owner.token, { org_id: org.id });
            expect(del.status, JSON.stringify(del.body)).toBe(200);
            expect(del.body.data.id).toBe(org.id);
            expect(new Date(del.body.data.deleted_at).toString()).not.toBe('Invalid Date');

            // Rows kept; members former; invite revoked; realm soft-deleted with its slug; channels and rules kept.
            const row = (await Org.findByPk(org.id, { raw: true }))!;
            expect(row.status).toBe('deleted');
            expect(row.deleted_at).not.toBeNull();
            expect(await OrgMember.count({ where: { org_id: org.id, deleted_at: null } })).toBe(0);
            expect(await OrgMember.count({ where: { org_id: org.id } })).toBe(2);
            expect((await AccountInvite.findByPk(invite_id, { raw: true }))!.status).toBe('revoked');
            const realm = (await Realm.findByPk(org.realm_id, { raw: true }))!;
            expect(realm.deleted).toBe(true);
            expect(realm.slug).toBe('default');
            expect(await NotificationChannel.count({ where: { org_id: org.id } })).toBe(channels_before);
            expect(await NotificationRule.count({ where: { org_id: org.id } })).toBe(rules_before);
            expect(await Scope.count({ where: { id: org.scope_id } })).toBe(1);

            // Reads: gone for members; listed for site admins only with include_deleted / status deleted.
            const mine = await post('/v1/orgs/get', member.token, { mine: true });
            expect(mine.body.data.orgs.map((o: { id: string }) => o.id)).not.toContain(org.id);
            expect([403, 404]).toContain((await post('/v1/orgs/get_by_id', member.token, { org_id: org.id })).status);
            const live_list = await post('/v1/orgs/get', s.token.sam, { query: org.slug });
            expect(live_list.body.data.orgs.map((o: { id: string }) => o.id)).not.toContain(org.id);
            const with_deleted = await post('/v1/orgs/get', s.token.sam, { query: org.slug, include_deleted: true });
            const listed = with_deleted.body.data.orgs.find((o: { id: string }) => o.id === org.id);
            expect(listed).toMatchObject({ status: 'deleted', owner: { username: owner.username, status: 'active' } });
            expect(listed.deleted_at).toBeTruthy();
            const only_deleted = await post('/v1/orgs/get', s.token.sam, { query: org.slug, status: 'deleted' });
            expect(only_deleted.body.data.orgs.map((o: { id: string }) => o.id)).toEqual([org.id]);
            const detail = await post('/v1/orgs/get_by_id', s.token.sam, { org_id: org.id });
            expect(detail.status).toBe(200);
            expect(detail.body.data).toMatchObject({ id: org.id, status: 'deleted', owner: { user_id: owner.id, username: owner.username } });
            expect(detail.body.data.members.map((m: { status: string }) => m.status)).toEqual(['deleted', 'deleted']);
            expect(detail.body.data.members[0].deleted_at).toBeTruthy();

            // The slug stays taken: 409 deleted (not conflict).
            const taken = await post('/internal/auth/signup', null, { username: org.slug, email: `n${s.stamp}@sd.test`, password });
            expect(taken.status).toBe(409);
            expect(err(taken).code).toBe('deleted');
            expect(err(taken).details).toMatchObject({ kind: 'org', id: org.id, was_active: true });

            // Restore: site admin only; same id; realm, channels, rules, scope back; members stay former.
            await expect(get_sequelize().transaction((t) => reactivation.restore_org(as_auth(owner.id, 'user'), org.id, t)))
                .rejects.toMatchObject({ status: 403 });
            const restored = await get_sequelize().transaction((t) => reactivation.restore_org(sam_auth(), org.id, t));
            expect(restored).toMatchObject({ id: org.id, slug: org.slug, status: 'waiting_for_owner', realm_ids: [org.realm_id] });
            const back = (await Org.findByPk(org.id, { raw: true }))!;
            expect(back).toMatchObject({ deleted_at: null, status: 'waiting_for_owner', owner_id: null });
            expect((await Realm.findByPk(org.realm_id, { raw: true }))!.deleted).toBe(false);
            expect(await NotificationChannel.count({ where: { org_id: org.id } })).toBe(channels_before);
            expect(await NotificationRule.count({ where: { org_id: org.id } })).toBe(rules_before);
            expect(await OrgMember.count({ where: { org_id: org.id, deleted_at: null } })).toBe(0);
            const after = await post('/v1/orgs/get_by_id', s.token.sam, { org_id: org.id });
            expect(after.body.data).toMatchObject({ status: 'waiting_for_owner', owner: null, deleted_at: null, pending_owner_invite: null });

            // Restoring a live org is refused.
            await expect(get_sequelize().transaction((t) => reactivation.restore_org(sam_auth(), org.id, t)))
                .rejects.toMatchObject({ status: 409 });
        });

        it("restore_org refuses a user's account org (restore the user instead)", async () => {
            const u = await s.signup('acctorg');
            await Org.update({ deleted_at: new Date(), status: 'deleted' } as never, { where: { id: u.org_id } });
            await expect(get_sequelize().transaction((t) => reactivation.restore_org(sam_auth(), u.org_id, t)))
                .rejects.toMatchObject({ status: 409, code: 'conflict', details: { kind: 'user', id: u.id } });
            await Org.update({ deleted_at: null, status: 'active' } as never, { where: { id: u.org_id } });
        });

        it('get_by_id shows the pending owner invite and member status fields', async () => {
            const owner = await s.signup('pendown');
            const org = await make_org('pend', owner);
            const invite_id = randomUUID();
            const expires_at = new Date(Date.now() + 86_400_000);
            await AccountInvite.create({ id: invite_id, org_id: org.id, email: `o${s.stamp}@sd.test`, invited_by: s.user.sam, token_hash: `own${s.stamp}`, role: 'owner', status: 'pending', expires_at } as never);
            const res = await post('/v1/orgs/get_by_id', owner.token, { org_id: org.id });
            expect(res.status).toBe(200);
            expect(res.body.data.pending_owner_invite).toEqual({ invite_id, email: `o${s.stamp}@sd.test`, expires_at: expires_at.toISOString() });
            expect(res.body.data.status).toBe('active');
            expect(res.body.data.members[0]).toMatchObject({ user_id: owner.id, status: 'active', deleted_at: null });
            expect(res.body.data.members[0]).toHaveProperty('invited_at');
            expect(res.body.data.members[0]).toHaveProperty('joined_at');
        });

        it('removing a member keeps them as a former member; adding them again revives the row', async () => {
            const owner = await s.signup('remown');
            const member = await s.signup('remmem');
            const org = await make_org('rem', owner);
            await add_member(org.id, member.id, 'member');
            const removed = await post('/v1/orgs/remove_member', owner.token, { org_id: org.id, user_id: member.id });
            expect(removed.status, JSON.stringify(removed.body)).toBe(200);
            const list = await post('/v1/orgs/get_by_id', owner.token, { org_id: org.id });
            expect(list.body.data.members.find((m: { user_id: string }) => m.user_id === member.id).status).toBe('deleted');
            expect([403, 404]).toContain((await post('/v1/orgs/get_by_id', member.token, { org_id: org.id })).status);

            const { OrgMemberRepository } = await import('../../src/repositories/org_member_repository.js');
            await new OrgMemberRepository().create(org.id, member.id, 'member');
            const row = (await OrgMember.findOne({ where: { org_id: org.id, user_id: member.id }, raw: true }))!;
            expect(row.deleted_at).toBeNull();
        });
    });

    // ── 2. users ──────────────────────────────────────────────────────

    describe('users/delete and restore_user', () => {
        it('soft-deletes the user and their account org; names stay taken; tokens stop working; restore brings them back invited', async () => {
            const u = await s.signup('udel');
            const host = await s.signup('uhost');
            const host_org = await make_org('uhost', host);
            await add_member(host_org.id, u.id, 'member');
            const pat = u.token;
            expect((await post('/v1/orgs/get', pat, { mine: true })).status).toBe(200);

            const del = await post('/internal/users/delete', s.token.sam, { user_id: u.id });
            expect(del.status, JSON.stringify(del.body)).toBe(200);

            const row = (await User.findByPk(u.id, { raw: true }))!;
            expect(row.deleted_at).not.toBeNull();
            expect(row.username).toBe(u.username);
            const account = (await Org.findByPk(u.org_id, { raw: true }))!;
            expect(account.status).toBe('deleted');
            expect(account.deleted_at!.getTime()).toBe(row.deleted_at!.getTime());
            expect(await ApiToken.count({ where: { user_id: u.id, revoked_at: null } })).toBe(0);
            expect((await post('/v1/orgs/get', pat, { mine: true })).status).toBe(401);

            // The host org lists them as a former member.
            const members = await post('/v1/orgs/get_by_id', host.token, { org_id: host_org.id });
            expect(members.body.data.members.find((m: { user_id: string }) => m.user_id === u.id).status).toBe('deleted');

            // Username and email stay taken: 409 deleted naming the user.
            const same_name = await post('/internal/auth/signup', null, { username: u.username, email: `z${s.stamp}@sd.test`, password });
            expect(same_name.status).toBe(409);
            expect(err(same_name)).toMatchObject({ code: 'deleted', details: { kind: 'user', id: u.id, was_active: true } });
            const same_email = await post('/internal/auth/signup', null, { username: `zz${s.stamp}`, email: u.email, password });
            expect(same_email.status).toBe(409);
            expect(err(same_email)).toMatchObject({ code: 'deleted', details: { kind: 'user', id: u.id } });

            // users/get: hidden by default; with include_deleted the row says deleted.
            const hidden = await post('/v1/users/get', s.token.sam, { query: u.username });
            expect(hidden.body.data.users.map((x: { id: string }) => x.id)).not.toContain(u.id);
            const shown = await post('/v1/users/get', s.token.sam, { query: u.username, include_deleted: true });
            const listed = shown.body.data.users.find((x: { id: string }) => x.id === u.id);
            expect(listed.status).toBe('deleted');
            expect(listed.deleted_at).toBeTruthy();
            const live = await post('/v1/users/get', s.token.sam, { query: host.username });
            expect(live.body.data.users[0]).toMatchObject({ id: host.id, status: 'active', deleted_at: null });
            expect((await post('/v1/users/get_by_id', s.token.sam, { user_id: u.id })).body.data.status).toBe('deleted');

            // Deleting again: not found.
            expect((await post('/internal/users/delete', s.token.sam, { user_id: u.id })).status).toBe(404);

            // Restore: same id, invited without a password, account org active and owned again.
            const restored = await get_sequelize().transaction((t) => reactivation.restore_user(sam_auth(), u.id, t));
            expect(restored).toMatchObject({ id: u.id, username: u.username, email: u.email, status: 'invited', account_org_id: u.org_id });
            const back = (await User.findByPk(u.id, { raw: true }))!;
            expect(back).toMatchObject({ deleted_at: null, status: 'invited', password_hash: null });
            expect((await Org.findByPk(u.org_id, { raw: true }))!).toMatchObject({ deleted_at: null, status: 'active', owner_id: u.id });
            expect(await OrgMember.count({ where: { org_id: u.org_id, user_id: u.id, deleted_at: null } })).toBe(1);
            expect(await OrgMember.count({ where: { org_id: host_org.id, user_id: u.id, deleted_at: null } })).toBe(0);
            expect(await Realm.count({ where: { org_id: u.org_id, deleted: false } })).toBeGreaterThan(0);

            // A restored user has no password until they set one: sign-in is the plain 401.
            const sign_in = await post('/internal/auth/authenticate_user', null, { username: u.username, password });
            expect(sign_in.status).toBe(401);
            expect(err(sign_in).code).not.toBe('not_active');
            await expect(get_sequelize().transaction((t) => reactivation.restore_user(sam_auth(), u.id, t)))
                .rejects.toMatchObject({ status: 409 });
        });

        it('refuses with 409 owns_orgs while the user owns another org, and changes nothing', async () => {
            const u = await s.signup('owns');
            const org = await make_org('owned', u);
            const res = await post('/internal/users/delete', s.token.sam, { user_id: u.id });
            expect(res.status).toBe(409);
            expect(err(res)).toMatchObject({ code: 'owns_orgs', message: 'Transfer or delete these orgs first.', details: { orgs: [{ slug: org.slug }] } });
            expect((await User.findByPk(u.id, { raw: true }))!.deleted_at).toBeNull();
            expect((await Org.findByPk(u.org_id, { raw: true }))!.deleted_at).toBeNull();
        });

        it('refuses with 409 owns_orgs when their account org has another owner', async () => {
            const u = await s.signup('coown');
            const other = await s.signup('coother');
            await add_member(u.org_id, other.id, 'owner');
            const res = await post('/internal/users/delete', s.token.sam, { user_id: u.id });
            expect(res.status).toBe(409);
            expect(err(res)).toMatchObject({ code: 'owns_orgs', details: { orgs: [{ slug: u.username }] } });
            expect((await User.findByPk(u.id, { raw: true }))!.deleted_at).toBeNull();
        });
    });

    // ── 4. sign-in refusals ───────────────────────────────────────────

    describe('sign-in refusals', () => {
        it('a deleted user: the right password gets 403 account_deleted, a wrong one the plain 401 (sign-in); act-as is 403', async () => {
            const u = await s.signup('signdel');
            expect((await post('/internal/users/delete', s.token.sam, { user_id: u.id })).status).toBe(200);
            const wrong = await post('/internal/auth/authenticate_user', null, { username: u.username, password: 'wrong-password' });
            expect(wrong.status).toBe(401);
            expect(err(wrong).code).toBe('unauthorized');
            const unknown = await post('/internal/auth/authenticate_user', null, { username: `nobody${s.stamp}`, password: 'wrong-password' });
            expect(err(unknown)).toEqual(err(wrong));
            const res = await post('/internal/auth/authenticate_user', null, { username: u.username, password });
            expect(res.status).toBe(403);
            expect(err(res).code).toBe('account_deleted');
            expect(err(res).details).toBeUndefined();
            const act_as = await post('/internal/auth/issue_session_token', s.token.sam, { user_id: u.id });
            expect(act_as.status).toBe(403);
            expect(err(act_as).code).toBe('account_deleted');
        });

        it('an invited user (no password yet) gets the plain 401 on sign-in, so sign-in tells nothing; act-as is 409 not_active', async () => {
            const username = `inv${s.stamp}`;
            s.track(username);
            const invited = await User.create({ username, email: `${username}@sd.test`, display_name: 'Invited', status: 'invited' } as never);
            const res = await post('/internal/auth/authenticate_user', null, { username, password });
            expect(res.status).toBe(401);
            expect(err(res).code).toBe('unauthorized');
            const act_as = await post('/internal/auth/issue_session_token', s.token.sam, { user_id: invited.id });
            expect(act_as.status).toBe(409);
            expect(err(act_as).code).toBe('not_active');

            const nameless = await User.create({ email: `nameless${s.stamp}@sd.test`, display_name: 'No name', status: 'invited' } as never);
            const act_as_nameless = await post('/internal/auth/issue_session_token', s.token.sam, { user_id: nameless.id });
            expect(act_as_nameless.status).toBe(409);
            await User.destroy({ where: { id: nameless.id } });
        });
    });

    // ── 5. locks ──────────────────────────────────────────────────────

    describe('locked rules and channels', () => {
        it('rule and channel reads carry recipients, system_key, locked and lock_reason', async () => {
            const rules = await post('/v1/orgs/get_notification_rules', s.token.olivia, { org_id: s.acme });
            expect(rules.status).toBe(200);
            const locked = rules.body.data.find((r: { system_key: string | null; event: string }) => r.system_key === 'invite.sent.invitee' && r.event === 'invite.org.sent');
            expect(locked).toMatchObject({ locked: true, recipients: ['invitee'] });
            expect(locked.lock_reason).toEqual(expect.any(String));
            const custom = rules.body.data.find((r: { id: string }) => r.id === s.rule_acme);
            expect(custom).toMatchObject({ locked: false, system_key: null, recipients: null, lock_reason: null });

            const channels = await post('/v1/notification_channels/get', s.token.olivia, { org_id: s.acme, account: true });
            const email = channels.body.data.find((c: { system_key: string | null }) => c.system_key === 'org.email');
            expect(email).toMatchObject({ locked: true, enabled: 1 });
            const in_app = channels.body.data.find((c: { system_key: string | null }) => c.system_key === 'org.in_app');
            expect(in_app).toMatchObject({ locked: false });
        });

        it('changing or removing a locked rule answers 409 locked; unlocked defaults can be edited', async () => {
            const locked = (await NotificationRule.findOne({ where: { org_id: s.acme, system_key: 'invite.sent.invitee', event: 'invite.org.sent' }, raw: true }))!;
            const set = await post('/v1/orgs/set_notification_rules', s.token.olivia, { org_id: s.acme, event: locked.event, channel_id: locked.channel_id, priority: 5 });
            expect(set.status).toBe(409);
            expect(err(set)).toMatchObject({ code: 'locked', details: { system_key: 'invite.sent.invitee' } });
            for (const path of ['/v1/orgs/remove_notification_rules', '/v1/realms/remove_notification_rules']) {
                const rm = await post(path, s.token.olivia, { id: locked.id });
                expect(rm.status, path).toBe(409);
                expect(err(rm).code).toBe('locked');
            }
            expect(await NotificationRule.count({ where: { id: locked.id } })).toBe(1);
            expect((await NotificationRule.findByPk(locked.id, { raw: true }))!.priority).toBe(locked.priority);

            const open = (await NotificationRule.findOne({ where: { org_id: s.acme, system_key: 'invite.accepted.notify', event: 'invite.org.accepted', locked: false }, raw: true }))!;
            const edit = await post('/v1/orgs/set_notification_rules', s.token.olivia, { org_id: s.acme, event: open.event, channel_id: open.channel_id, recipients: ['org_owners'] });
            expect(edit.status, JSON.stringify(edit.body)).toBe(200);
            expect(edit.body.data).toMatchObject({ id: open.id, recipients: ['org_owners'], locked: false });
            const bad = await post('/v1/orgs/set_notification_rules', s.token.olivia, { org_id: s.acme, event: open.event, channel_id: open.channel_id, recipients: ['everyone'] });
            expect(bad.status).toBe(422);
        });

        it('updating or removing a locked channel answers 409 locked', async () => {
            const email = (await NotificationChannel.findOne({ where: { org_id: s.acme, system_key: 'org.email' }, raw: true }))!;
            const upd = await post('/v1/notification_channels/update', s.token.olivia, { id: email.id, enabled: false });
            expect(upd.status).toBe(409);
            expect(err(upd)).toMatchObject({ code: 'locked', details: { system_key: 'org.email' } });
            const rm = await post('/v1/notification_channels/remove', s.token.olivia, { id: email.id });
            expect(rm.status).toBe(409);
            expect((await NotificationChannel.findByPk(email.id, { raw: true }))!.enabled).toBe(1);

            const in_app = (await NotificationChannel.findOne({ where: { org_id: s.acme, system_key: 'org.in_app' }, raw: true }))!;
            const ok = await post('/v1/notification_channels/update', s.token.olivia, { id: in_app.id, name: in_app.name });
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        });
    });

    // ── 6. owner-only rules ──────────────────────────────────────────

    describe('owner-only org rules', () => {
        it('rules.manage is owner-only and no admin role holds it', async () => {
            expect(OWNER_ONLY_PERMISSIONS).toContain('rules.manage');
            expect(ADMIN_PERMISSIONS).not.toContain('rules.manage');
            const admin_role = (await OrgRole.findOne({ where: { org_id: s.acme, slug: 'admin' }, raw: true }))!;
            expect(admin_role.permissions).not.toContain('rules.manage');
            expect(admin_role.permissions).toContain('rules.manage.realm');
        });

        it('an org admin can read the rules but not change them; the owner can', async () => {
            const read = await post('/v1/orgs/get_notification_rules', s.token.adam, { org_id: s.acme });
            expect(read.status).toBe(200);
            const channel = s.channel_acme;
            const as_admin = await post('/v1/orgs/set_notification_rules', s.token.adam, { org_id: s.acme, event: 'run.failed', channel_id: channel });
            expect(as_admin.status).toBe(403);
            const rm_admin = await post('/v1/orgs/remove_notification_rules', s.token.adam, { id: s.rule_acme });
            expect(rm_admin.status).toBe(403);
            const as_owner = await post('/v1/orgs/set_notification_rules', s.token.olivia, { org_id: s.acme, event: 'run.failed', channel_id: channel });
            expect(as_owner.status, JSON.stringify(as_owner.body)).toBe(200);
            await NotificationRule.destroy({ where: { id: as_owner.body.data.id } });
        });
    });
});
