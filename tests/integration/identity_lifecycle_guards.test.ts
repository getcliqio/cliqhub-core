/**
 * Identity lifecycle guards over HTTP on live Postgres (production app, route
 * policy enforced): races, visibility and data-handling rules of the invite,
 * org, user and password flows.
 *
 *   - the invite sweep against "send again" (expiry and reminders), and an
 *     org with another open owner invite;
 *   - realm invites hold a pending realm membership; realm memberships are
 *     soft-deleted with an org or user and come back on reactivation;
 *   - who sees pending / former members and emails on orgs/get_by_id, and
 *     the lifecycle fields of the member org list;
 *   - concurrent creates, accepts and revokes answer 200 / 409, never 500;
 *   - users/new reactivation with a different email, username or role;
 *   - rule recipients from outside the org, account orgs of new people,
 *     password length limits, the boot backfill run twice at once;
 *   - no token or link in any log line or event row.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { use_test_link_env } from '../helpers/link_env.js';
import { accept_invite_url, token_from_invite_url } from '../helpers/invite_links.js';
import {
    AccountInvite, HubEvent, NotificationChannel, NotificationRule, Org, OrgMember, OrgRole, PasswordReset,
    Realm, RealmInvite, RealmMember, User,
} from '../../src/models/index.js';
import { run_invite_sweep } from '../../src/services/invite_sweep.service.js';
import { OrgSeedService } from '../../src/services/org_seed.service.js';
import { resolve_primary_org_id_for_user } from '../../src/models/migrations/migrate_ensure_user_orgs.js';
import { configure_hub_logging } from '../../src/lib/log.js';
import { settle_background } from '../../src/lib/background.js';

const has_postgres = await postgres_reachable();
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const password = 'password123';

describe.skipIf(!has_postgres)('identity lifecycle guards', () => {
    let app: Express;
    let s: Seed;
    let restore_env: () => void;
    const emails: string[] = [];
    const orgs: string[] = [];

    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    /** Error code and details from either envelope. */
    const err = (res: request.Response) => {
        const e = res.body.error;
        return typeof e === 'object' && e !== null
            ? { code: e.code, message: e.message, details: e.details }
            : { code: res.body.code, message: e, details: res.body.details };
    };
    const uniq = (label: string) => `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const new_email = (label: string) => { const e = `${uniq(label)}@guard.test`; emails.push(e); return e; };
    const invite = (token: string, body: Record<string, unknown>) => post('/v1/invitations/create', token, body);
    const new_org = async (body: Record<string, unknown>) => {
        const res = await post('/v1/orgs/new', s.token.sam, body);
        if (res.status === 200) orgs.push(String(res.body.data.org.id));
        return res;
    };
    const event_types = async (invite_id: string) =>
        (await HubEvent.findAll({ where: { payload_json: { [Op.like]: `%${invite_id}%` } }, order: [['created_at', 'ASC']], raw: true })).map((e) => e.type);
    const realm_row = (realm_id: string, user_id: string) =>
        RealmMember.unscoped().findOne({ where: { realm_id, member_type: 'user', member_id: user_id }, raw: true });

    beforeAll(async () => {
        restore_env = use_test_link_env();
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        if (s) {
            await AccountInvite.destroy({ where: { email: { [Op.in]: emails } } });
            await RealmInvite.destroy({ where: { email: { [Op.in]: emails } } });
            const invited = (await User.findAll({ where: { email: { [Op.in]: emails }, username: null }, attributes: ['id'], raw: true })).map((u) => u.id);
            await OrgMember.destroy({ where: { user_id: { [Op.in]: invited } } });
            await RealmMember.unscoped().destroy({ where: { member_type: 'user', member_id: { [Op.in]: invited } } });
            await User.destroy({ where: { id: { [Op.in]: invited } } });
            await User.update({ deleted_at: null, status: 'active' } as never, { where: { username: { [Op.like]: `%${s.stamp}%` } } });
            await s.cleanup();
        }
        await close_live_hub_app();
        restore_env();
    }, 300_000);

    afterEach(() => { vi.restoreAllMocks(); });

    // ── the sweep against "send again" ────────────────────────────────

    describe('invite sweep', () => {
        /** Makes the next sweep read `stale` rows for the step whose `where` matches `step`. */
        function serve_stale(step: 'reminders' | 'expiry', stale: object[]) {
            const real = AccountInvite.findAll.bind(AccountInvite);
            vi.spyOn(AccountInvite, 'findAll').mockImplementation((async (options: { where?: Record<string, unknown> }) => {
                const where = options?.where ?? {};
                const is_reminders = 'reminders_sent' in where;
                const is_expiry = where.status === 'pending' && !is_reminders && options && (options as { attributes?: unknown }).attributes !== undefined;
                if ((step === 'reminders' && is_reminders) || (step === 'expiry' && is_expiry)) return stale;
                return real(options as never);
            }) as never);
        }

        it('an invite sent again after the sweep read it as expired stays pending with its membership', async () => {
            const email = new_email('race');
            const sent = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const invite_id = sent.body.data.invite_id as string;
            await AccountInvite.update({ expires_at: new Date(Date.now() - MINUTE) }, { where: { id: invite_id } });
            // The sweep read the expired row; then the inviter sends it again.
            serve_stale('expiry', [{ id: invite_id }]);
            expect((await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email })).body.data.resent).toBe(true);

            const result = await run_invite_sweep(new Date());
            expect(result.ran).toBe(true);
            const row = (await AccountInvite.findByPk(invite_id, { raw: true }))!;
            expect(row.status).toBe('pending');
            expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 13 * DAY);
            const user = (await User.findOne({ where: { email }, raw: true }))!;
            expect(await OrgMember.findOne({ where: { org_id: s.acme, user_id: user.id }, raw: true })).toMatchObject({ status: 'pending', deleted_at: null });
            expect(await event_types(invite_id)).not.toContain('invite.org.expired');
        });

        it('a reminder claimed from a stale read is not written over a resend; the resend restarts the reminders', async () => {
            const email = new_email('remind');
            const sent = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const invite_id = sent.body.data.invite_id as string;
            await AccountInvite.update({ expires_at: new Date(Date.now() + 3 * DAY - MINUTE) }, { where: { id: invite_id } });
            const stale = (await AccountInvite.findByPk(invite_id, { raw: true }))!;
            await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            serve_stale('reminders', [stale]);

            await run_invite_sweep(new Date());
            vi.restoreAllMocks();
            const fresh = (await AccountInvite.findByPk(invite_id, { raw: true }))!;
            expect(fresh.reminders_sent).toBe(0);
            expect(await event_types(invite_id)).not.toContain('invite.org.reminder');

            // The new expiry gets its own 3-day reminder.
            await run_invite_sweep(new Date(fresh.expires_at.getTime() - 3 * DAY + MINUTE));
            expect((await AccountInvite.findByPk(invite_id, { raw: true }))!.reminders_sent).toBe(1);
            expect((await event_types(invite_id)).filter((t) => t === 'invite.org.reminder')).toHaveLength(1);
        });

        it('an expired owner invite does not abandon an org that has another open owner invite', async () => {
            const created = await new_org({ slug: uniq('twoown'), owner: { email: new_email('own1') } });
            const org_id = created.body.data.org.id as string;
            const second = await invite(s.token.sam, { target_type: 'org', org_id, email: new_email('own2'), role: 'owner' });
            expect(second.status, JSON.stringify(second.body)).toBe(200);
            await AccountInvite.update({ expires_at: new Date(Date.now() - MINUTE) }, { where: { id: created.body.data.owner_invite.invite_id } });

            await run_invite_sweep(new Date());
            expect(await AccountInvite.findByPk(created.body.data.owner_invite.invite_id, { raw: true })).toMatchObject({ status: 'expired' });
            expect(await Org.findByPk(org_id, { raw: true })).toMatchObject({ status: 'waiting_for_owner', deleted_at: null });
            expect(await AccountInvite.findByPk(second.body.data.invite_id, { raw: true })).toMatchObject({ status: 'pending' });
            expect(await HubEvent.count({ where: { type: 'org.abandoned', org_id } })).toBe(0);
        });
    });

    // ── realm memberships ─────────────────────────────────────────────

    describe('realm memberships', () => {
        it('a realm invite holds a pending realm membership (no access) until it is accepted', async () => {
            const email = new_email('rpend');
            const sent = await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A1, email, role: 'operator' });
            expect(sent.status, JSON.stringify(sent.body)).toBe(200);
            const user = (await User.findOne({ where: { email }, raw: true }))!;
            expect(await realm_row(s.A1, user.id)).toMatchObject({ status: 'pending', deleted_at: null, role: 'operator' });
            expect(await RealmMember.count({ where: { realm_id: s.A1, member_id: user.id } })).toBe(0);

            const accepted = await post('/v1/invitations/accept', null, {
                token: token_from_invite_url(sent.body.data.invite_url), decision: 'accept', username: uniq('rp').slice(0, 20), password,
            });
            expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
            s.track(accepted.body.data.user.username);
            expect(await realm_row(s.A1, user.id)).toMatchObject({ status: 'active', deleted_at: null });
            expect(await RealmMember.count({ where: { realm_id: s.A1, member_id: user.id } })).toBe(1);
        });

        it('revoke, decline and expiry of a realm invite remove the pending realm membership and leave the org membership alone', async () => {
            // Nora is an active member of Acme with no realm.
            const nora = (await User.findByPk(s.user.nora, { raw: true }))!;
            const org_before = await OrgMember.findOne({ where: { org_id: s.acme, user_id: nora.id }, raw: true });

            const revoked = await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A2, email: nora.email, role: 'member' });
            expect((await post('/v1/invitations/revoke', s.token.olivia, { invite_id: revoked.body.data.invite_id })).status).toBe(200);
            expect((await realm_row(s.A2, nora.id))!.deleted_at).toBeTruthy();

            const declined = await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A2, email: nora.email, role: 'member' });
            expect((await realm_row(s.A2, nora.id))).toMatchObject({ status: 'pending', deleted_at: null });
            expect((await post('/v1/invitations/accept', s.token.nora, { token: token_from_invite_url(declined.body.data.invite_url), decision: 'decline' })).status).toBe(200);
            expect((await realm_row(s.A2, nora.id))!.deleted_at).toBeTruthy();

            const expired = await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A2, email: nora.email, role: 'member' });
            await RealmInvite.update({ expires_at: new Date(Date.now() - MINUTE) }, { where: { id: expired.body.data.invite_id } });
            await run_invite_sweep(new Date());
            expect(await RealmInvite.findByPk(expired.body.data.invite_id, { raw: true })).toMatchObject({ status: 'expired' });
            expect((await realm_row(s.A2, nora.id))!.deleted_at).toBeTruthy();

            expect(await OrgMember.findOne({ where: { org_id: s.acme, user_id: nora.id }, raw: true })).toEqual(org_before);
        });

        it('users/delete soft-deletes realm memberships; reactivating the user brings back those of their account org', async () => {
            const u = await s.signup('rmdel');
            const account_realms = (await Realm.findAll({ where: { org_id: u.org_id, deleted: false }, attributes: ['id'], raw: true })).map((r) => r.id);
            expect(await RealmMember.count({ where: { realm_id: { [Op.in]: account_realms }, member_id: u.id } })).toBeGreaterThan(0);
            await RealmMember.create({ id: randomUUID(), realm_id: s.A2, member_type: 'user', member_id: u.id, role: 'member', created_at: Date.now() } as never);

            expect((await post('/internal/users/delete', s.token.sam, { user_id: u.id })).status).toBe(200);
            const rows = await RealmMember.unscoped().findAll({ where: { member_type: 'user', member_id: u.id }, raw: true });
            expect(rows.length).toBeGreaterThan(1);
            expect(rows.every((r) => r.deleted_at)).toBe(true);

            const back = await post('/internal/users/new', s.token.sam, { username: u.username, email: u.email, reactivate: true });
            expect(back.status, JSON.stringify(back.body)).toBe(200);
            expect(await RealmMember.count({ where: { realm_id: { [Op.in]: account_realms }, member_id: u.id } })).toBeGreaterThan(0);
            // A realm of another org stays left, like the org membership.
            expect(await RealmMember.count({ where: { realm_id: s.A2, member_id: u.id } })).toBe(0);
        });

        it('reactivating an org brings back its group memberships; a former member gets their realm access again only by accepting', async () => {
            const created = await new_org({ slug: uniq('rmorg'), owner: { user_id: s.user.ben } });
            const org_id = created.body.data.org.id as string;
            await accept_invite_url(app, s.token.ben, created.body.data.owner_invite.invite_url);
            const realm = (await Realm.findOne({ where: { org_id, deleted: false }, raw: true }))!;
            // A group membership (a daemon would block the delete).
            const group_id = `gg${s.stamp}${Math.random().toString(36).slice(2, 6)}`;
            await RealmMember.create({ id: randomUUID(), realm_id: realm.id, member_type: 'group', member_id: group_id, role: 'member', created_at: Date.now() } as never);
            expect(await RealmMember.count({ where: { realm_id: realm.id, member_id: s.user.ben } })).toBe(1);

            expect((await post('/internal/orgs/delete', s.token.sam, { org_id })).status).toBe(200);
            expect(await RealmMember.count({ where: { realm_id: realm.id } })).toBe(0);

            const slug = created.body.data.org.slug as string;
            const back = await post('/v1/orgs/new', s.token.sam, { slug, owner: { user_id: s.user.ben }, reactivate: true });
            expect(back.status, JSON.stringify(back.body)).toBe(200);
            expect(await RealmMember.count({ where: { realm_id: realm.id, member_type: 'group', member_id: group_id } })).toBe(1);
            expect(await RealmMember.count({ where: { realm_id: realm.id, member_id: s.user.ben } })).toBe(0);

            await accept_invite_url(app, s.token.ben, back.body.data.owner_invite.invite_url);
            expect(await RealmMember.count({ where: { realm_id: realm.id, member_id: s.user.ben } })).toBe(1);
        });

        it('an unlocked default rule the owners removed stays removed when the org is reactivated', async () => {
            const created = await new_org({ slug: uniq('rmrule'), owner: { user_id: s.user.ben } });
            const org_id = created.body.data.org.id as string;
            const rule = (await NotificationRule.findOne({ where: { org_id, locked: false }, raw: true }))!;
            await NotificationRule.destroy({ where: { id: rule.id } });
            expect((await post('/internal/orgs/delete', s.token.sam, { org_id })).status).toBe(200);
            const back = await post('/v1/orgs/new', s.token.sam, { slug: created.body.data.org.slug, owner: { user_id: s.user.ben }, reactivate: true });
            expect(back.status, JSON.stringify(back.body)).toBe(200);
            expect(await NotificationRule.count({ where: { org_id, system_key: rule.system_key, event: rule.event, channel_id: rule.channel_id } })).toBe(0);
        });
    });

    // ── who sees what ─────────────────────────────────────────────────

    describe('org reads', () => {
        it('orgs/get_by_id: pending and former members and emails only for members managers and site admins', async () => {
            const email = new_email('vis');
            expect((await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email })).status).toBe(200);

            const plain = await post('/v1/orgs/get_by_id', s.token.mia, { org_id: s.acme });
            expect(plain.status).toBe(200);
            const plain_members = plain.body.data.members as Array<Record<string, unknown>>;
            expect(plain_members.length).toBeGreaterThan(0);
            expect(plain_members.every((m) => m.status === 'active' && !('email' in m))).toBe(true);

            for (const token of [s.token.adam, s.token.sam]) {
                const full = await post('/v1/orgs/get_by_id', token, { org_id: s.acme });
                const members = full.body.data.members as Array<Record<string, unknown>>;
                expect(members.some((m) => m.status === 'pending' && m.email === email)).toBe(true);
            }
        });

        it('orgs/get member list rows carry status, owner and deleted_at', async () => {
            const res = await post('/v1/orgs/get', s.token.nora, { mine: true });
            expect(res.status).toBe(200);
            const acme = (res.body.data.orgs as Array<Record<string, unknown>>).find((o) => o.id === s.acme)!;
            const olivia = (await User.findByPk(s.user.olivia, { raw: true }))!;
            expect(acme).toMatchObject({ status: 'active', deleted_at: null, owner: { username: olivia.username, status: 'active' } });
        });

        it('a pending membership is never picked as a primary org', async () => {
            const email = new_email('prim');
            await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const user = (await User.findOne({ where: { email }, raw: true }))!;
            expect(await resolve_primary_org_id_for_user(user.id)).toBeNull();
        });
    });

    // ── concurrency ───────────────────────────────────────────────────

    describe('concurrent requests', () => {
        it('two invites to the same email at once: one creates, the other sends again', async () => {
            const email = new_email('par');
            const [a, b] = await Promise.all([
                invite(s.token.adam, { target_type: 'org', org_id: s.acme, email }),
                invite(s.token.adam, { target_type: 'org', org_id: s.acme, email }),
            ]);
            expect([a.status, b.status]).toEqual([200, 200]);
            expect([a.body.data.resent, b.body.data.resent].sort()).toEqual([false, true]);
            expect(await AccountInvite.count({ where: { org_id: s.acme, email, status: 'pending' } })).toBe(1);
            expect((await AccountInvite.findOne({ where: { org_id: s.acme, email }, raw: true }))!.send_count).toBe(2);
            expect(await User.count({ where: { email } })).toBe(1);
        });

        it('accept twice at once: one 200, one 409 not_pending; the new person gets an account org like a signup', async () => {
            const email = new_email('acc2');
            const sent = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const token = token_from_invite_url(sent.body.data.invite_url);
            const username = uniq('acc').slice(0, 20);
            s.track(username);
            const body = { token, decision: 'accept', username, password };
            const answers = await Promise.all([post('/v1/invitations/accept', null, body), post('/v1/invitations/accept', null, body)]);
            expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
            expect(err(answers.find((r) => r.status === 409)!).code).toBe('not_pending');

            const user = (await User.findOne({ where: { email }, raw: true }))!;
            const account = (await Org.findOne({ where: { slug: username }, raw: true }))!;
            expect(account).toMatchObject({ owner_id: user.id, status: 'active' });
            const owner_role = (await OrgRole.findOne({ where: { org_id: account.id, slug: 'owner' }, raw: true }))!;
            expect(await OrgMember.findOne({ where: { org_id: account.id, user_id: user.id }, raw: true })).toMatchObject({ role_id: owner_role.id, status: 'active' });
            expect(await NotificationRule.count({ where: { org_id: account.id, system_key: 'user.password_changed.user' } })).toBeGreaterThan(0);
        });

        it('accept and revoke at once: exactly one wins', async () => {
            const email = new_email('accrev');
            const sent = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const username = uniq('ar').slice(0, 20);
            s.track(username);
            const [accepted, revoked] = await Promise.all([
                post('/v1/invitations/accept', null, { token: token_from_invite_url(sent.body.data.invite_url), decision: 'accept', username, password }),
                post('/v1/invitations/revoke', s.token.adam, { invite_id: sent.body.data.invite_id }),
            ]);
            expect([accepted.status, revoked.status].sort()).toEqual([200, 409]);
            const row = (await AccountInvite.findByPk(sent.body.data.invite_id, { raw: true }))!;
            expect(row.status).toBe(accepted.status === 200 ? 'accepted' : 'revoked');
        });

        it('two orgs/new with the same slug at once: one 200, one 409 conflict', async () => {
            const slug = uniq('dup');
            const answers = await Promise.all([
                new_org({ slug, owner: { email: new_email('dup1') } }),
                new_org({ slug, owner: { email: new_email('dup2') } }),
            ]);
            expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
            expect(err(answers.find((r) => r.status === 409)!).code).toBe('conflict');
        });
    });

    // ── users/new reactivation ────────────────────────────────────────

    describe('users/new with reactivate', () => {
        it('applies the requested email, display name and role to the restored user before the setup link', async () => {
            const gone = await s.signup('rnew');
            expect((await post('/internal/users/delete', s.token.sam, { user_id: gone.id })).status).toBe(200);
            const email = new_email('rnewmail');
            const res = await post('/internal/users/new', s.token.sam, { username: gone.username, email, display_name: 'Back Again', role: 'admin', reactivate: true });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.data.user).toEqual({ id: gone.id, username: gone.username, email, status: 'invited' });
            expect(await User.findByPk(gone.id, { raw: true })).toMatchObject({ email, display_name: 'Back Again', role: 'admin', deleted_at: null });
            const [event] = await HubEvent.findAll({ where: { type: 'user.setup.sent', org_id: gone.org_id }, raw: true });
            expect(JSON.parse(event.payload_json).data.user.email).toBe(email);
            await User.update({ role: 'user' }, { where: { id: gone.id } });
        });

        it('refuses a different username for a user found by email, and a new email a live user holds', async () => {
            const gone = await s.signup('rname');
            expect((await post('/internal/users/delete', s.token.sam, { user_id: gone.id })).status).toBe(200);
            const other = await post('/internal/users/new', s.token.sam, { username: uniq('other').slice(0, 20), email: gone.email, reactivate: true });
            expect(other.status).toBe(422);
            expect(err(other).details).toMatchObject({ field: 'username' });

            const nora = (await User.findByPk(s.user.nora, { raw: true }))!;
            const taken = await post('/internal/users/new', s.token.sam, { username: gone.username, email: nora.email, reactivate: true });
            expect(taken.status).toBe(409);
            expect(err(taken).code).toBe('conflict');
            expect((await User.findByPk(gone.id, { raw: true }))!.deleted_at).not.toBeNull();
        });
    });

    // ── other guards ──────────────────────────────────────────────────

    describe('other guards', () => {
        it('a rule may name only active members of its org as recipients', async () => {
            const open = (await NotificationRule.findOne({ where: { org_id: s.acme, system_key: 'invite.accepted.notify', locked: false }, raw: true }))!;
            const body = { org_id: s.acme, event: open.event, channel_id: open.channel_id };
            const outsider = await post('/v1/orgs/set_notification_rules', s.token.olivia, { ...body, recipients: ['org_owners', s.user.ben] });
            expect(outsider.status).toBe(422);
            expect(err(outsider)).toMatchObject({ code: 'invalid_params', details: { field: 'recipients', not_members: [s.user.ben] } });
            const member = await post('/v1/orgs/set_notification_rules', s.token.olivia, { ...body, recipients: ['org_owners', s.user.adam] });
            expect(member.status, JSON.stringify(member.body)).toBe(200);
            await post('/v1/orgs/set_notification_rules', s.token.olivia, { ...body, recipients: open.recipients });
        });

        it('passwords longer than the maximum are refused on signup, accept and the reset link', async () => {
            const long = 'x'.repeat(129);
            const signup = await post('/internal/auth/signup', null, { username: uniq('lng').slice(0, 20), email: new_email('lng'), password: long });
            expect(signup.status).toBe(422);
            const sent = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: new_email('lngacc') });
            const accept = await post('/v1/invitations/accept', null, { token: token_from_invite_url(sent.body.data.invite_url), decision: 'accept', username: uniq('lg').slice(0, 20), password: long });
            expect(accept.status).toBe(422);
            expect(err(accept).details).toMatchObject({ field: 'password' });
            const reset = await post('/internal/users/change_password', null, { reset_token: 'unknown-token', new_password: long });
            expect(reset.status).toBe(422);
        });

        it('a signed-in password change does not create or use a deleted account org', async () => {
            const u = await s.signup('pwnoorg');
            await Org.update({ deleted_at: new Date(), status: 'deleted' } as never, { where: { id: u.org_id } });
            const res = await post('/internal/users/change_password', u.token, { current_password: password, new_password: 'another-password' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(await Org.count({ where: { slug: u.username } })).toBe(1);
            expect(await HubEvent.count({ where: { type: 'user.password.changed', org_id: u.org_id } })).toBe(0);
            await Org.update({ deleted_at: null, status: 'active' } as never, { where: { id: u.org_id } });
        });

        it('orgs/new refuses a suspended owner; signup with an invited email points to the invite', async () => {
            const susp = await s.signup('ownsusp');
            await post('/internal/users/suspend', s.token.sam, { user_id: susp.id });
            const res = await post('/v1/orgs/new', s.token.sam, { slug: uniq('susp'), owner: { user_id: susp.id } });
            expect(res.status).toBe(409);
            expect(err(res)).toMatchObject({ code: 'not_active', details: { status: 'suspended' } });

            const email = new_email('invsign');
            await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const signup = await post('/internal/auth/signup', null, { username: uniq('is').slice(0, 20), email, password });
            expect(signup.status).toBe(409);
            expect(err(signup).message).toMatch(/invite/i);
        });

        it('a decline by someone without an account is attributed to the invited email', async () => {
            const email = new_email('declnone');
            const sent = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const placeholder = (await User.findOne({ where: { email }, raw: true }))!;
            await OrgMember.destroy({ where: { user_id: placeholder.id } });
            await User.destroy({ where: { id: placeholder.id } });
            expect((await post('/v1/invitations/accept', null, { token: token_from_invite_url(sent.body.data.invite_url), decision: 'decline' })).status).toBe(200);
            const declined = (await HubEvent.findOne({ where: { type: 'invite.org.declined', payload_json: { [Op.like]: `%${sent.body.data.invite_id}%` } }, raw: true }))!;
            expect(JSON.parse(declined.payload_json).actor).toEqual({ invitee_email: email });
            expect(declined.actor_id).toBeNull();
        });

        it('org and owner invites never store the realm role operator', async () => {
            await expect(AccountInvite.create({
                org_id: s.acme, email: new_email('op'), invited_by: s.user.olivia, token_hash: `op${randomUUID()}`, role: 'operator', status: 'pending',
                expires_at: new Date(Date.now() + DAY),
            } as never)).rejects.toThrow();
        });

        it('the boot backfill run by two instances at once seeds an org once', async () => {
            const org = await Org.create({ slug: uniq('seed'), display_name: 'Seed', activated_at: new Date() } as never);
            orgs.push(org.id);
            const [a, b] = await Promise.all([OrgSeedService.backfill(), OrgSeedService.backfill()]);
            expect(a.orgs_seeded + b.orgs_seeded).toBeGreaterThanOrEqual(1);
            expect(await NotificationChannel.count({ where: { org_id: org.id, system_key: 'org.email' } })).toBe(1);
            expect((await Org.findByPk(org.id, { raw: true }))!.notifications_seeded_at).not.toBeNull();
            await NotificationRule.destroy({ where: { org_id: org.id } });
            await NotificationChannel.destroy({ where: { org_id: org.id } });
            await Org.destroy({ where: { id: org.id } });
        });
    });

    // ── secrets ───────────────────────────────────────────────────────

    describe('tokens and links', () => {
        it('no log line of the invite, users/new, reset or forgot flows carries a token or a link', async () => {
            const lines: string[] = [];
            for (const level of ['info', 'warn', 'error', 'debug'] as const) {
                vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
            }
            configure_hub_logging('debug');
            const secrets: string[] = [];
            try {
                const email = new_email('logs');
                const sent = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
                secrets.push(token_from_invite_url(sent.body.data.invite_url));
                const username = uniq('lg').slice(0, 20);
                s.track(username);
                await post('/v1/invitations/accept', null, { token: secrets[0], decision: 'accept', username, password });

                const new_user = uniq('lgu').slice(0, 20);
                s.track(new_user);
                const created = await post('/internal/users/new', s.token.sam, { username: new_user, email: new_email('lgu') });
                const setup_url = created.body.data.setup.setup_url as string;
                secrets.push(setup_url.slice(setup_url.lastIndexOf('/') + 1));

                const reset = await post('/internal/users/reset_password', s.token.sam, { user_id: created.body.data.user.id });
                const reset_url = reset.body.data.reset_url as string;
                secrets.push(reset_url.slice(reset_url.lastIndexOf('/') + 1));
                await post('/internal/users/change_password', null, { reset_token: secrets[2], new_password: 'brand-new-password' });

                const u = await s.signup('lgf');
                await post('/internal/users/reset_password', null, { email: u.email });
                await settle_background();
                const link = (await PasswordReset.findOne({ where: { user_id: u.id }, raw: true }))!;
                expect(link).toBeTruthy();
            } finally {
                configure_hub_logging();
            }
            expect(lines.length).toBeGreaterThan(0);
            for (const line of lines) {
                for (const secret of secrets) expect(line).not.toContain(secret);
                expect(line).not.toMatch(/\/(invite|reset)\/[A-Za-z0-9_-]{20,}/);
            }
        });

        it('password-link event rows hold no token and no link', async () => {
            const username = uniq('evt').slice(0, 20);
            s.track(username);
            const created = await post('/internal/users/new', s.token.sam, { username, email: new_email('evt') });
            const setup_token = (created.body.data.setup.setup_url as string).split('/').pop()!;
            const reset = await post('/internal/users/reset_password', s.token.sam, { user_id: created.body.data.user.id });
            const reset_token = (reset.body.data.reset_url as string).split('/').pop()!;
            const org = (await Org.findOne({ where: { slug: username }, raw: true }))!;
            const rows = await HubEvent.findAll({ where: { org_id: org.id, type: { [Op.in]: ['user.setup.sent', 'user.password_reset.sent'] } }, raw: true });
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                const text = JSON.stringify(row);
                expect(text).not.toContain(setup_token);
                expect(text).not.toContain(reset_token);
                expect(text).not.toMatch(/\/reset\//);
            }
        });
    });
});
