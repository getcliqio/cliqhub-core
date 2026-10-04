/**
 * Org, owner and realm invites, `orgs/new` and the invite sweep over HTTP on
 * live Postgres (production app, route policy enforced):
 *
 *   - orgs/new for a person with no account and for an existing user, then
 *     the owner accepts (new person / signed in);
 *   - invite, send again (same link, new expiry), list, get, revoke, decline,
 *     accept as a new person and as an existing account, wrong email,
 *     expired links, already a member, deleted invitee, realm invites;
 *   - the sweep with a fake clock: reminders at 3 days and 1 day, expiry,
 *     an abandoned org, and the advisory lock.
 *
 * No email provider is configured, so invite emails are not sent and the
 * responses carry `invite_url`. Reactivation (`reactivate: true`) restores a
 * deleted org or invitee for real and the owner / invitee accepts.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op, QueryTypes } from 'sequelize';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { TEST_PUBLIC_APP_URL, use_test_link_env } from '../helpers/link_env.js';
import { accept_invite_url, token_from_invite_url } from '../helpers/invite_links.js';
import {
    AccountInvite, ChannelDestination, EmailDelivery, HubEvent, NotificationChannel, NotificationRule, Org, OrgMember,
    OrgRole, Realm, RealmInvite, RealmMember, Scope, User,
} from '../../src/models/index.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { INVITE_SWEEP_LOCK_KEY, run_invite_sweep } from '../../src/services/invite_sweep.service.js';

const has_postgres = await postgres_reachable();
const password = 'password123';
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe.skipIf(!has_postgres)('invitations, orgs/new and the invite sweep', () => {
    let app: Express;
    let s: Seed;
    let restore_env: () => void;
    const orgs: string[] = [];
    const emails: string[] = [];
    const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;

    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const uniq = (label: string) => `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const new_email = (label: string) => { const e = `${uniq(label)}@inv.test`; emails.push(e); return e; };
    const new_username = (label: string) => { const u = uniq(`iv${label}`).slice(0, 30); s.track(u); return u; };
    const role_id = async (org_id: string, slug: string) =>
        String((await OrgRole.findOne({ where: { org_id, slug }, attributes: ['id'], raw: true }))!.id);
    const events_of = async (invite_id: string) =>
        (await HubEvent.findAll({ where: { payload_json: { [Op.like]: `%${invite_id}%` } }, order: [['created_at', 'ASC']], raw: true }));
    const event_types = async (invite_id: string) => (await events_of(invite_id)).map((e) => e.type);
    const membership = (org_id: string, user_id: string) => OrgMember.findOne({ where: { org_id, user_id }, raw: true });
    const user_by_email = (email: string) => User.findOne({ where: { email }, raw: true });

    /** orgs/new as the site admin; records the org for cleanup. */
    async function new_org(body: Record<string, unknown>) {
        const res = await post('/v1/orgs/new', s.token.sam, body);
        if (res.status === 200) orgs.push(String(res.body.data.org.id));
        return res;
    }

    /** invitations/create as `token`. */
    const invite = (token: string, body: Record<string, unknown>) => post('/v1/invitations/create', token, body);

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
            await HubEvent.destroy({ where: { org_id: { [Op.in]: [...orgs, s.acme, s.beta] }, type: { [Op.like]: 'invite.%' } } });
            await HubEvent.destroy({ where: { org_id: { [Op.in]: orgs } } });
            const channels = (await NotificationChannel.findAll({ where: { org_id: { [Op.in]: orgs } }, attributes: ['id'], raw: true })).map((c) => c.id);
            await ChannelDestination.destroy({ where: { channel_id: { [Op.in]: channels } } });
            await NotificationRule.destroy({ where: { org_id: { [Op.in]: orgs } } });
            await NotificationChannel.destroy({ where: { org_id: { [Op.in]: orgs } } });
            const realms = (await Realm.findAll({ where: { org_id: { [Op.in]: orgs } }, attributes: ['id'], raw: true })).map((r) => r.id);
            await RealmMember.destroy({ where: { realm_id: { [Op.in]: realms } } });
            await Realm.destroy({ where: { id: { [Op.in]: realms } } });
            await Org.update({ default_scope_id: null } as never, { where: { id: { [Op.in]: orgs } } });
            await Scope.destroy({ where: { org_id: { [Op.in]: orgs } } });
            await Org.destroy({ where: { id: { [Op.in]: orgs } } });
            const invited = (await User.findAll({ where: { email: { [Op.in]: emails }, username: null }, attributes: ['id'], raw: true })).map((u) => u.id);
            await OrgMember.destroy({ where: { user_id: { [Op.in]: invited } } });
            await User.destroy({ where: { id: { [Op.in]: invited } } });
            await s.cleanup();
        }
        await close_live_hub_app();
        restore_env();
    }, 300_000);

    afterEach(() => { vi.restoreAllMocks(); });

    // ── orgs/new ──────────────────────────────────────────────────────

    describe('orgs/new', () => {
        it('a person with no account: invited user, waiting org, pending owner membership, owner invite; they accept as a new person', async () => {
            const spy = vi.spyOn(email_deliverer, 'deliver_message');
            const slug = uniq('ownnew');
            const email = new_email('owner');
            const before = Date.now();
            const res = await new_org({ slug, display_name: 'Owner New', owner: { email: email.toUpperCase(), display_name: 'Pat Owner' } });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const { org, owner_invite } = res.body.data;
            expect(org).toMatchObject({ slug, display_name: 'Owner New', status: 'waiting_for_owner', owner: { email, status: 'invited' }, reactivated: false });
            expect(owner_invite).toMatchObject({ role: 'owner', status: 'pending', email_sent: false });
            expect(owner_invite.invite_url).toMatch(new RegExp(`^${TEST_PUBLIC_APP_URL}/invite/`));
            expect(Object.keys(res.body.data.org)).not.toContain('admin_username');
            const expires = new Date(owner_invite.expires_at).getTime();
            expect(expires).toBeGreaterThanOrEqual(before + 14 * DAY - MINUTE);
            expect(expires).toBeLessThanOrEqual(Date.now() + 14 * DAY + MINUTE);
            const token = token_from_invite_url(owner_invite.invite_url);

            const invited = (await user_by_email(email))!;
            expect(invited).toMatchObject({ status: 'invited', username: null, password_hash: null, display_name: 'Pat Owner', id: org.owner.user_id });
            expect(await Org.findByPk(org.id, { raw: true })).toMatchObject({ status: 'waiting_for_owner', activated_at: null, owner_id: invited.id });
            expect(await membership(org.id, invited.id)).toMatchObject({ status: 'pending', role_id: await role_id(org.id, 'owner'), joined_at: null });
            expect(await NotificationRule.count({ where: { org_id: org.id, system_key: { [Op.ne]: null } } })).toBeGreaterThan(0);
            expect(await Realm.count({ where: { org_id: org.id } })).toBe(0);

            // The sent event: stored without the token; the invitee's email carries the link.
            const sent = await events_of(owner_invite.invite_id);
            expect(sent.map((e) => e.type)).toEqual(['invite.owner.sent']);
            expect(sent[0].payload_json).not.toContain(token);
            expect(JSON.parse(sent[0].payload_json)).toMatchObject({
                actor: { user_id: s.user.sam },
                data: { invite_id: owner_invite.invite_id, kind: 'owner', role: 'owner', invitee_email: email, org: { slug, display_name: 'Owner New' }, realm: null, send_count: 1 },
            });
            const to_invitee = spy.mock.calls.map((c) => c[0]).find((i) => i.event === 'invite.owner.sent' && i.to.email === email);
            expect(to_invitee?.links).toEqual({ accept_url: owner_invite.invite_url });

            // The org page: status, future owner, the open owner invite, the pending member.
            const page = await post('/v1/orgs/get_by_id', s.token.sam, { org_id: org.id });
            expect(page.body.data).toMatchObject({
                status: 'waiting_for_owner', deleted_at: null,
                owner: { user_id: invited.id, username: null, status: 'invited' },
                pending_owner_invite: { invite_id: owner_invite.invite_id, email, expires_at: owner_invite.expires_at },
            });
            expect(page.body.data.members).toEqual([expect.objectContaining({ user_id: invited.id, status: 'pending', joined_at: null, deleted_at: null })]);
            expect(page.body.data.members[0].invited_at).toBeTruthy();
            const waiting = await post('/v1/orgs/get', s.token.sam, { status: 'waiting_for_owner', query: slug });
            expect(waiting.body.data.orgs.map((o: { id: string }) => o.id)).toContain(org.id);
            const active = await post('/v1/orgs/get', s.token.sam, { status: 'active', query: slug });
            expect(active.body.data.orgs.map((o: { id: string }) => o.id)).not.toContain(org.id);

            // The invite page.
            const preview = await post('/v1/invitations/get_by_token', null, { token });
            expect(preview.status).toBe(200);
            expect(preview.body.data).toEqual({
                invite_id: owner_invite.invite_id, kind: 'owner', status: 'pending',
                org: { slug, display_name: 'Owner New' }, realm: null, role: 'owner',
                inviter: { display_name: expect.any(String) }, invitee_email: email, account_exists: false,
                expires_at: owner_invite.expires_at,
            });

            // Accept as a new person.
            const username = new_username('own');
            const accepted = await post('/v1/invitations/accept', null, { token, decision: 'accept', username, password, display_name: 'Pat O.' });
            expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
            expect(accepted.body.data).toMatchObject({
                decision: 'accept',
                user: { id: invited.id, username, status: 'active', created: true },
                org: { id: org.id, slug }, realm: null,
                membership: { role: 'owner', status: 'active' },
            });
            const session = accepted.body.data.token as string;
            expect(session).toBeTruthy();

            expect(await user_by_email(email)).toMatchObject({ id: invited.id, username, status: 'active', display_name: 'Pat O.' });
            const now_org = (await Org.findByPk(org.id, { raw: true }))!;
            expect(now_org).toMatchObject({ status: 'active', owner_id: invited.id });
            expect(now_org.activated_at).toBeTruthy();
            expect(await membership(org.id, invited.id)).toMatchObject({ status: 'active', role_id: await role_id(org.id, 'owner') });
            // Their own account org (seeded) and the org's default realm.
            const account_org = (await Org.findOne({ where: { slug: username }, raw: true }))!;
            expect(account_org).toBeTruthy();
            // Email + In-app twin.
            expect(await NotificationRule.count({ where: { org_id: account_org.id, system_key: 'user.password_reset.user' } })).toBe(2);
            expect(await Realm.count({ where: { org_id: org.id, slug: 'default', deleted: false } })).toBe(1);

            // Signed in with the returned token, they run their org.
            expect((await post('/v1/orgs/get_by_id', session, { org_id: org.id })).status).toBe(200);
            const after = await post('/v1/orgs/get_by_id', s.token.sam, { org_id: org.id });
            expect(after.body.data).toMatchObject({ status: 'active', pending_owner_invite: null, owner: { user_id: invited.id, username, status: 'active' } });

            expect(await event_types(owner_invite.invite_id)).toEqual(['invite.owner.sent', 'invite.owner.accepted']);
            const accepted_event = (await events_of(owner_invite.invite_id))[1];
            expect(JSON.parse(accepted_event.payload_json).data).toMatchObject({ decision: 'accept', accepted_user: { id: invited.id, username } });

            // A used link explains itself.
            expect((await post('/v1/invitations/get_by_token', null, { token })).body.data.status).toBe('accepted');
            const again = await post('/v1/invitations/accept', null, { token, decision: 'accept', username: `${username}x`, password });
            expect(again.status).toBe(409);
            expect(again.body).toMatchObject({ code: 'not_pending', details: { status: 'accepted' } });
        });

        it('an existing user: no rights until they accept, and only signed in as the invited email', async () => {
            const u = await s.signup('ownex');
            const slug = uniq('ownex');
            const res = await new_org({ slug, owner: { user_id: u.id } });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.data.org).toMatchObject({ status: 'waiting_for_owner', owner: { user_id: u.id, email: u.email, status: 'active' } });
            const org_id = res.body.data.org.id as string;
            const token = token_from_invite_url(res.body.data.owner_invite.invite_url);

            expect((await post('/v1/orgs/get_by_id', u.token, { org_id })).status).toBe(404);
            expect((await post('/v1/invitations/get_by_token', null, { token })).body.data).toMatchObject({ account_exists: true, invitee_email: u.email });

            const anon = await post('/v1/invitations/accept', null, { token, decision: 'accept', username: uniq('x'), password });
            expect(anon.status).toBe(401);
            expect(anon.body).toMatchObject({ code: 'sign_in_required', details: { invitee_email: u.email } });
            const other = await post('/v1/invitations/accept', s.token.nora, { token, decision: 'accept' });
            expect(other.status).toBe(403);
            expect(other.body).toMatchObject({ code: 'email_mismatch', details: { invitee_email: u.email } });

            const ok = await post('/v1/invitations/accept', u.token, { token, decision: 'accept' });
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
            expect(ok.body.data).toMatchObject({ user: { id: u.id, username: u.username, created: false }, membership: { role: 'owner', status: 'active' } });
            expect(ok.body.data.token).toBeUndefined();
            expect((await post('/v1/orgs/get_by_id', u.token, { org_id })).status).toBe(200);
            expect(await Org.findByPk(org_id, { raw: true })).toMatchObject({ status: 'active', owner_id: u.id });
        });

        it('refuses non site admins (403), taken slugs (409 conflict) and the removed admin_* fields (422)', async () => {
            expect((await post('/v1/orgs/new', s.token.olivia, { slug: uniq('no'), owner: { user_id: s.user.olivia } })).status).toBe(403);
            const acme = (await Org.findByPk(s.acme, { raw: true }))!;
            const taken = await post('/v1/orgs/new', s.token.sam, { slug: acme.slug, owner: { user_id: s.user.olivia } });
            expect(taken.status).toBe(409);
            expect(taken.body).toMatchObject({ code: 'conflict', details: { field: 'slug', holder: { id: s.acme, slug: acme.slug } } });
            const old = await post('/v1/orgs/new', s.token.sam, { slug: uniq('old'), admin_username: 'x', admin_email: 'x@inv.test', admin_password: password });
            expect(old.status).toBe(422);
            expect((await post('/v1/orgs/new', s.token.sam, { slug: uniq('bad'), owner: { email: 'not-an-email' } })).status).toBe(422);
            expect((await post('/v1/orgs/new', s.token.sam, { slug: uniq('gh'), owner: { user_id: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
        });

        it('a deleted org name: 409 deleted; reactivate restores the same org with a new owner invite; the owner accepts', async () => {
            const slug = uniq('react');
            const first = await new_org({ slug, owner: { user_id: s.user.ben } });
            const org_id = first.body.data.org.id as string;
            await accept_invite_url(app, s.token.ben, first.body.data.owner_invite.invite_url);
            expect((await post('/internal/orgs/delete', s.token.sam, { org_id })).status).toBe(200);

            const refused = await post('/v1/orgs/new', s.token.sam, { slug, owner: { user_id: s.user.ben } });
            expect(refused.status).toBe(409);
            expect(refused.body).toMatchObject({ code: 'deleted', details: { kind: 'org', id: org_id, was_active: true } });

            const res = await post('/v1/orgs/new', s.token.sam, { slug, owner: { user_id: s.user.ben }, reactivate: true });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.data.org).toMatchObject({ id: org_id, slug, status: 'waiting_for_owner', owner: { user_id: s.user.ben }, reactivated: true });
            const owner_invite = res.body.data.owner_invite;
            expect(owner_invite.invite_id).not.toBe(first.body.data.owner_invite.invite_id);
            expect(await event_types(owner_invite.invite_id)).toEqual(['invite.owner.sent']);
            expect(await Org.findByPk(org_id, { raw: true })).toMatchObject({ deleted_at: null, status: 'waiting_for_owner', owner_id: s.user.ben });
            // The former owner membership comes back pending: no access until the invite is accepted.
            expect(await membership(org_id, s.user.ben)).toMatchObject({ status: 'pending', deleted_at: null });
            expect([403, 404]).toContain((await post('/v1/orgs/get_by_id', s.token.ben, { org_id })).status);
            const detail = await post('/v1/orgs/get_by_id', s.token.sam, { org_id });
            expect(detail.body.data).toMatchObject({ status: 'waiting_for_owner', pending_owner_invite: { invite_id: owner_invite.invite_id } });

            await accept_invite_url(app, s.token.ben, owner_invite.invite_url);
            const after = await post('/v1/orgs/get_by_id', s.token.ben, { org_id });
            expect(after.status, JSON.stringify(after.body)).toBe(200);
            expect(after.body.data).toMatchObject({ status: 'active', owner: { user_id: s.user.ben, status: 'active' }, deleted_at: null, pending_owner_invite: null });
        });
    });

    // ── invitations ───────────────────────────────────────────────────

    describe('invitations', () => {
        it('invite a new person; send again keeps the link, resets the expiry and counts; list and get show it', async () => {
            const email = new_email('again');
            const first = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email, role: 'admin' });
            expect(first.status, JSON.stringify(first.body)).toBe(200);
            expect(Object.keys(first.body.data).sort()).toEqual(['email', 'email_sent', 'expires_at', 'invite_id', 'invite_url', 'resent', 'role', 'status']);
            expect(first.body.data).toMatchObject({ status: 'pending', email, role: 'admin', resent: false, email_sent: false });
            const invite_id = first.body.data.invite_id as string;
            const token = token_from_invite_url(first.body.data.invite_url);

            const invited = (await user_by_email(email))!;
            expect(invited).toMatchObject({ status: 'invited', username: null });
            expect(await membership(s.acme, invited.id)).toMatchObject({ status: 'pending', role_id: await role_id(s.acme, 'admin') });
            expect(await AccountInvite.findByPk(invite_id, { raw: true })).toMatchObject({ send_count: 1, reminders_sent: 0, status: 'pending' });

            // Pretend a reminder went out and the invite is about to expire.
            await AccountInvite.update({ reminders_sent: 1, expires_at: new Date(Date.now() + DAY) } as never, { where: { id: invite_id } });
            const second = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: email.toUpperCase(), role: 'admin' });
            expect(second.status).toBe(200);
            expect(second.body.data).toMatchObject({ invite_id, resent: true, status: 'pending' });
            expect(token_from_invite_url(second.body.data.invite_url)).toBe(token);
            expect(new Date(second.body.data.expires_at).getTime()).toBeGreaterThan(Date.now() + 13 * DAY);
            expect(await AccountInvite.findByPk(invite_id, { raw: true })).toMatchObject({ send_count: 2, reminders_sent: 0 });
            const sent = await events_of(invite_id);
            expect(sent.map((e) => e.type)).toEqual(['invite.org.sent', 'invite.org.sent']);
            expect(JSON.parse(sent[1].payload_json)).toMatchObject({ actor: { user_id: s.user.adam }, data: { send_count: 2 } });
            expect(sent.every((e) => !e.payload_json.includes(token))).toBe(true);

            // A recorded email shows up as a delivery.
            await EmailDelivery.create({ subject_type: 'invite', subject_id: invite_id, event: 'invite.org.sent', to: email, ok: true, provider_message_id: '<m1@relay.test>', sent_at: new Date() } as never);

            const listed = await post('/v1/invitations/get', s.token.adam, { org_id: s.acme, status: 'pending', sort: '-created_at', page: 1, page_size: 50 });
            expect(listed.status, JSON.stringify(listed.body)).toBe(200);
            expect(listed.body.data).toMatchObject({ target_type: 'org', org_id: s.acme });
            const item = (listed.body.data.invites as Array<Record<string, unknown>>).find((i) => i.invite_id === invite_id)!;
            expect(item).toMatchObject({
                invite_id, email, role: 'admin', kind: 'org', status: 'pending',
                inviter: { id: s.user.adam, display_name: expect.any(String) }, send_count: 2,
            });
            expect(item.deliveries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'sent', email_sent: true, provider_message_id: '<m1@relay.test>' })]));
            expect(JSON.stringify(listed.body)).not.toContain(token);
            expect(JSON.stringify(listed.body)).not.toContain('token_hash');

            const by_id = await post('/v1/invitations/get_by_id', s.token.adam, { invite_id });
            expect(by_id.status).toBe(200);
            expect(by_id.body.data).toMatchObject({ target_type: 'org', org_id: s.acme, invite: { invite_id, send_count: 2 } });

            const accepted_only = await post('/v1/invitations/get', s.token.adam, { org_id: s.acme, status: 'accepted' });
            expect((accepted_only.body.data.invites as Array<{ invite_id: string }>).some((i) => i.invite_id === invite_id)).toBe(false);
            expect((await post('/v1/invitations/get', s.token.adam, { org_id: s.acme, sort: 'token_hash' })).status).toBe(422);
            const paged = await post('/v1/invitations/get', s.token.adam, { org_id: s.acme, page_size: 1 });
            expect(paged.body.data.invites).toHaveLength(1);
            expect(paged.body.data.total).toBeGreaterThanOrEqual(1);
            expect((await post('/v1/invitations/get', s.token.mia, { org_id: s.acme })).status).toBe(403);
        });

        it('revoke by invite_id alone removes the pending membership; the link then explains itself', async () => {
            const email = new_email('rev');
            const created = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const invite_id = created.body.data.invite_id as string;
            const token = token_from_invite_url(created.body.data.invite_url);
            const invited = (await user_by_email(email))!;

            expect((await post('/v1/invitations/revoke', s.token.mia, { invite_id })).status).toBe(403);
            const res = await post('/v1/invitations/revoke', s.token.adam, { invite_id });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ invite_id, status: 'revoked' });
            expect((await membership(s.acme, invited.id))!.deleted_at).toBeTruthy();
            const page = await post('/v1/orgs/get_by_id', s.token.adam, { org_id: s.acme });
            expect((page.body.data.members as Array<{ user_id: string }>).some((m) => m.user_id === invited.id)).toBe(false);

            expect((await post('/v1/invitations/get_by_token', null, { token })).body.data.status).toBe('revoked');
            const accept = await post('/v1/invitations/accept', null, { token, decision: 'accept', username: uniq('r'), password });
            expect(accept.status).toBe(409);
            expect(accept.body).toMatchObject({ code: 'not_pending', details: { status: 'revoked' } });
            const twice = await post('/v1/invitations/revoke', s.token.adam, { invite_id });
            expect(twice.status).toBe(409);
            expect(twice.body).toMatchObject({ code: 'not_pending', details: { status: 'revoked' } });
            expect(await event_types(invite_id)).toEqual(['invite.org.sent', 'invite.org.revoked']);
        });

        it('decline removes the pending membership and raises declined', async () => {
            const email = new_email('dec');
            const created = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const invite_id = created.body.data.invite_id as string;
            const token = token_from_invite_url(created.body.data.invite_url);
            const invited = (await user_by_email(email))!;

            const res = await post('/v1/invitations/accept', null, { token, decision: 'decline' });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ decision: 'decline' });
            const row = (await AccountInvite.findByPk(invite_id, { raw: true }))!;
            expect(row).toMatchObject({ status: 'declined', decision: 'decline' });
            expect(row.decided_at).toBeTruthy();
            expect((await membership(s.acme, invited.id))!.deleted_at).toBeTruthy();
            const events = await events_of(invite_id);
            expect(events.map((e) => e.type)).toEqual(['invite.org.sent', 'invite.org.declined']);
            expect(JSON.parse(events[1].payload_json)).toMatchObject({ actor: { user_id: invited.id }, data: { decision: 'decline' } });
            expect((await post('/v1/invitations/accept', null, { token, decision: 'decline' })).status).toBe(409);
            expect((await post('/v1/invitations/accept', null, { token })).status).toBe(422);
        });

        it('an existing account: no access while pending; accepts signed in; inviting an active member is 409', async () => {
            const u = await s.signup('invex');
            const created = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: u.email });
            expect(created.status).toBe(200);
            const invite_id = created.body.data.invite_id as string;
            const token = token_from_invite_url(created.body.data.invite_url);
            expect(await membership(s.acme, u.id)).toMatchObject({ status: 'pending' });
            expect((await post('/v1/orgs/list_roles', u.token, { org_id: s.acme })).status).toBe(404);

            expect((await post('/v1/invitations/accept', null, { token, decision: 'accept', username: uniq('z'), password })).status).toBe(401);
            expect((await post('/v1/invitations/accept', s.token.nora, { token, decision: 'accept' })).status).toBe(403);
            const ok = await post('/v1/invitations/accept', u.token, { token, decision: 'accept' });
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
            expect(ok.body.data).toMatchObject({ user: { id: u.id, created: false }, org: { id: s.acme }, membership: { role: 'member', status: 'active' } });
            expect(ok.body.data.token).toBeUndefined();
            expect(await membership(s.acme, u.id)).toMatchObject({ status: 'active', role_id: await role_id(s.acme, 'member') });
            expect((await post('/v1/orgs/list_roles', u.token, { org_id: s.acme })).status).toBe(200);
            expect(await event_types(invite_id)).toEqual(['invite.org.sent', 'invite.org.accepted']);

            const dup = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: u.email });
            expect(dup.status).toBe(409);
            expect(dup.body).toMatchObject({ code: 'already_member', details: { user_id: u.id } });
        });

        it('expired links: the preview says expired; accept and decline are 410 with expired_at; revoke is 409', async () => {
            const email = new_email('exp');
            const created = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const invite_id = created.body.data.invite_id as string;
            const token = token_from_invite_url(created.body.data.invite_url);
            const expired_at = new Date(Date.now() - MINUTE);
            await AccountInvite.update({ expires_at: expired_at } as never, { where: { id: invite_id } });

            expect((await post('/v1/invitations/get_by_token', null, { token })).body.data.status).toBe('expired');
            const accept = await post('/v1/invitations/accept', null, { token, decision: 'accept', username: uniq('e'), password });
            expect(accept.status).toBe(410);
            expect(accept.body).toMatchObject({ code: 'expired', details: { expired_at: expired_at.toISOString() } });
            expect((await post('/v1/invitations/accept', null, { token, decision: 'decline' })).status).toBe(410);
            const revoke = await post('/v1/invitations/revoke', s.token.adam, { invite_id });
            expect(revoke.body).toMatchObject({ code: 'not_pending', details: { status: 'expired' } });
            const listed = await post('/v1/invitations/get', s.token.adam, { org_id: s.acme, status: 'expired' });
            expect((listed.body.data.invites as Array<{ invite_id: string; status: string }>).find((i) => i.invite_id === invite_id)?.status).toBe('expired');
            expect((await post('/v1/invitations/get_by_token', null, { token: 'not-a-real-token' })).status).toBe(404);
            expect((await post('/v1/invitations/accept', null, { token: 'not-a-real-token', decision: 'accept' })).status).toBe(404);
        });

        it('roles: owner only by an org owner or site admin and never on a realm; operator never on an org', async () => {
            const by_admin = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: new_email('own1'), role: 'owner' });
            expect(by_admin.status).toBe(403);
            const by_owner = await invite(s.token.olivia, { target_type: 'org', org_id: s.acme, email: new_email('own2'), role: 'owner' });
            expect(by_owner.status, JSON.stringify(by_owner.body)).toBe(200);
            expect(await event_types(by_owner.body.data.invite_id)).toEqual(['invite.owner.sent']);
            expect((await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A1, email: new_email('own3'), role: 'owner' })).status).toBe(422);
            expect((await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: new_email('op'), role: 'operator' })).status).toBe(422);
            expect((await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: 'not-an-email' })).status).toBe(422);
        });

        it('a deleted invitee: 409 deleted; a site admin reactivates them; they accept with their own username and can sign in', async () => {
            const gone = await s.signup('gone');
            emails.push(gone.email);
            expect((await post('/internal/users/delete', s.token.sam, { user_id: gone.id })).status).toBe(200);
            const refused = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: gone.email });
            expect(refused.status).toBe(409);
            expect(refused.body).toMatchObject({ code: 'deleted', details: { kind: 'user', id: gone.id, was_active: true } });
            expect((await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email: gone.email, reactivate: true })).status).toBe(403);

            const ok = await invite(s.token.sam, { target_type: 'org', org_id: s.acme, email: gone.email, reactivate: true });
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
            expect(await User.findByPk(gone.id, { raw: true })).toMatchObject({ deleted_at: null, status: 'invited', username: gone.username });
            expect(await membership(s.acme, gone.id)).toMatchObject({ status: 'pending' });
            const preview = await post('/v1/invitations/get_by_token', null, { token: token_from_invite_url(ok.body.data.invite_url) });
            expect(preview.body.data).toMatchObject({ account_exists: false, invitee_email: gone.email });

            const accepted = await post('/v1/invitations/accept', null, {
                token: token_from_invite_url(ok.body.data.invite_url), decision: 'accept', username: uniq('ignored'), password: 'back-again-pass',
            });
            expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
            expect(accepted.body.data).toMatchObject({ user: { id: gone.id, username: gone.username, status: 'active' }, membership: { status: 'active' } });
            // Joining the org gives the member their in-app channel there.
            expect(await NotificationChannel.count({ where: { user_id: gone.id, org_id: s.acme } })).toBe(1);
            expect(typeof accepted.body.data.token).toBe('string');
            expect((await post('/v1/orgs/get', accepted.body.data.token)).status).toBe(200);
            const signed_in = await post('/internal/auth/authenticate_user', null, { username: gone.username, password: 'back-again-pass' });
            expect(signed_in.status, JSON.stringify(signed_in.body)).toBe(200);
        });

        it('realm invites: a new person gets an account, the realm role and org membership; an existing user joins only on accept', async () => {
            const email = new_email('realm');
            const created = await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A1, email, role: 'operator' });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const invite_id = created.body.data.invite_id as string;
            const token = token_from_invite_url(created.body.data.invite_url);
            const invited = (await user_by_email(email))!;
            expect(await RealmMember.count({ where: { realm_id: s.A1, member_id: invited.id } })).toBe(0);
            const realm = (await Realm.findByPk(s.A1, { raw: true }))!;
            expect((await post('/v1/invitations/get_by_token', null, { token })).body.data).toMatchObject({
                kind: 'realm', role: 'operator', realm: { slug: realm.slug, display_name: realm.name }, invitee_email: email,
            });
            expect(await event_types(invite_id)).toEqual(['invite.realm.sent']);

            const listed = await post('/v1/invitations/get', s.token.olivia, { realm_id: s.A1 });
            expect(listed.body.data).toMatchObject({ target_type: 'realm', realm_id: s.A1 });
            expect((listed.body.data.invites as Array<{ invite_id: string; kind: string }>).find((i) => i.invite_id === invite_id)?.kind).toBe('realm');
            expect((await post('/v1/invitations/get_by_id', s.token.olivia, { invite_id })).body.data).toMatchObject({ target_type: 'realm', realm_id: s.A1 });

            const username = new_username('rlm');
            const accepted = await post('/v1/invitations/accept', null, { token, decision: 'accept', username, password });
            expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
            expect(accepted.body.data).toMatchObject({
                user: { id: invited.id, username, created: true }, org: { id: s.acme }, realm: { id: s.A1, slug: realm.slug },
                membership: { role: 'operator', status: 'active' },
            });
            expect(await RealmMember.findOne({ where: { realm_id: s.A1, member_id: invited.id }, raw: true })).toMatchObject({ role: 'operator', status: 'active' });
            expect(await membership(s.acme, invited.id)).toMatchObject({ status: 'active', role_id: await role_id(s.acme, 'member') });
            const session = accepted.body.data.token as string;
            expect((await post('/v1/realms/get_by_id', session, { realm_id: s.A1 })).status).toBe(200);
            expect((await post('/v1/realms/get_by_id', session, { realm_id: s.A2 })).status).toBe(404);

            const u = await s.signup('rlmex');
            const second = await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A1, email: u.email, role: 'member' });
            expect(second.status).toBe(200);
            expect((await post('/v1/realms/get_by_id', u.token, { realm_id: s.A1 })).status).toBe(404);
            const joined = await post('/v1/invitations/accept', u.token, { token: token_from_invite_url(second.body.data.invite_url), decision: 'accept' });
            expect(joined.status).toBe(200);
            expect((await post('/v1/realms/get_by_id', u.token, { realm_id: s.A1 })).status).toBe(200);
            expect((await invite(s.token.olivia, { target_type: 'realm', realm_id: s.A1, email: u.email })).body).toMatchObject({ code: 'already_member' });
        });

        it('when the Email channel sends the invite there is no invite_url', async () => {
            const spy = vi.spyOn(email_deliverer, 'deliver_message').mockResolvedValue({ sent: true, provider_message_id: '<m2@relay.test>', error: null });
            const email = new_email('mail');
            const res = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ email_sent: true, invite_url: null });
            const to_invitee = spy.mock.calls.map((c) => c[0]).find((i) => i.to.email === email)!;
            expect(to_invitee).toMatchObject({ event: 'invite.org.sent', subject: { type: 'invite', id: res.body.data.invite_id } });
            expect(to_invitee.links.accept_url).toMatch(new RegExp(`^${TEST_PUBLIC_APP_URL}/invite/`));
        });
    });

    // ── sweep ─────────────────────────────────────────────────────────

    describe('invite sweep (fake clock)', () => {
        const reminders_of = async (invite_id: string) => (await event_types(invite_id)).filter((t) => t.endsWith('.reminder')).length;

        it('reminds 3 days and 1 day before expiry, once each; expiry removes the pending membership', async () => {
            const email = new_email('sweep');
            const created = await invite(s.token.adam, { target_type: 'org', org_id: s.acme, email });
            const invite_id = created.body.data.invite_id as string;
            const expires = new Date(created.body.data.expires_at).getTime();
            const invited = (await user_by_email(email))!;
            const at = (offset: number) => new Date(expires + offset);

            expect((await run_invite_sweep(at(-3 * DAY - MINUTE))).ran).toBe(true);
            expect(await reminders_of(invite_id)).toBe(0);

            await run_invite_sweep(at(-3 * DAY + MINUTE));
            expect(await reminders_of(invite_id)).toBe(1);
            expect(await AccountInvite.findByPk(invite_id, { raw: true })).toMatchObject({ reminders_sent: 1, status: 'pending' });
            await run_invite_sweep(at(-3 * DAY + 2 * MINUTE));
            expect(await reminders_of(invite_id)).toBe(1);

            await run_invite_sweep(at(-DAY + MINUTE));
            expect(await reminders_of(invite_id)).toBe(2);
            const reminder = (await events_of(invite_id)).find((e) => e.type === 'invite.org.reminder')!;
            expect(JSON.parse(reminder.payload_json)).toMatchObject({ actor: { system: 'sweep' }, data: { invite_id, invitee_email: email } });
            expect(reminder.actor_id).toBeNull();
            await run_invite_sweep(at(-DAY + 2 * MINUTE));
            expect(await reminders_of(invite_id)).toBe(2);

            await run_invite_sweep(at(MINUTE));
            expect(await AccountInvite.findByPk(invite_id, { raw: true })).toMatchObject({ status: 'expired' });
            expect(await event_types(invite_id)).toEqual(['invite.org.sent', 'invite.org.reminder', 'invite.org.reminder', 'invite.org.expired']);
            expect((await membership(s.acme, invited.id))!.deleted_at).toBeTruthy();
            await run_invite_sweep(at(2 * MINUTE));
            expect((await event_types(invite_id)).filter((t) => t.endsWith('.expired'))).toHaveLength(1);
        });

        it('an expired owner invite abandons an org nobody joined, with its never-activated owner', async () => {
            const slug = uniq('aband');
            const email = new_email('aband');
            const created = await new_org({ slug, owner: { email } });
            const { org, owner_invite } = created.body.data;
            await run_invite_sweep(new Date(new Date(owner_invite.expires_at).getTime() + MINUTE));

            expect(await AccountInvite.findByPk(owner_invite.invite_id, { raw: true })).toMatchObject({ status: 'expired' });
            const gone = (await Org.findByPk(org.id, { raw: true }))!;
            expect(gone.status).toBe('deleted');
            expect(gone.deleted_at).toBeTruthy();
            expect((await user_by_email(email))!.deleted_at).toBeTruthy();
            const abandoned = (await HubEvent.findAll({ where: { type: 'org.abandoned', org_id: org.id }, raw: true }));
            expect(abandoned).toHaveLength(1);
            expect(JSON.parse(abandoned[0].payload_json)).toMatchObject({
                actor: { system: 'sweep' },
                data: { org: { id: org.id, slug }, invite_id: owner_invite.invite_id, invitee_email: email, inviter: { id: s.user.sam }, expired_at: owner_invite.expires_at },
            });
            expect(await event_types(owner_invite.invite_id)).toEqual(['invite.owner.sent', 'invite.owner.expired', 'org.abandoned']);
            // The name stays taken.
            const again = await post('/v1/orgs/new', s.token.sam, { slug, owner: { email: new_email('aband2') } });
            expect(again.body).toMatchObject({ code: 'deleted', details: { kind: 'org', id: org.id, was_active: false } });
        });

        it('an expired owner invite leaves an org with an active member alone', async () => {
            const created = await new_org({ slug: uniq('kept'), owner: { email: new_email('kept') } });
            const { org, owner_invite } = created.body.data;
            const u = await s.signup('keptm');
            const member = await invite(s.token.sam, { target_type: 'org', org_id: org.id, email: u.email });
            expect(member.status, JSON.stringify(member.body)).toBe(200);
            expect((await post('/v1/invitations/accept', u.token, { token: token_from_invite_url(member.body.data.invite_url), decision: 'accept' })).status).toBe(200);

            await run_invite_sweep(new Date(new Date(owner_invite.expires_at).getTime() + MINUTE));
            expect(await AccountInvite.findByPk(owner_invite.invite_id, { raw: true })).toMatchObject({ status: 'expired' });
            expect(await Org.findByPk(org.id, { raw: true })).toMatchObject({ status: 'waiting_for_owner', deleted_at: null });
            expect(await HubEvent.count({ where: { type: 'org.abandoned', org_id: org.id } })).toBe(0);
        });

        it('one instance at a time: a run skips while another holds the advisory lock', async () => {
            const result = await get_sequelize().transaction(async (t) => {
                await get_sequelize().query('SELECT pg_advisory_xact_lock(:key)', { replacements: { key: INVITE_SWEEP_LOCK_KEY }, type: QueryTypes.SELECT, transaction: t });
                return run_invite_sweep(new Date());
            });
            expect(result).toEqual({ ran: false, reminders: 0, expired: 0, abandoned: 0 });
            expect((await run_invite_sweep(new Date())).ran).toBe(true);
        });
    });
});
