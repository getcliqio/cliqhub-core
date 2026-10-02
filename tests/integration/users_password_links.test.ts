/**
 * Password links on live Postgres over HTTP (full production app, route
 * policy enforced): users/new with a "Set your password" link, the site-admin
 * reset email, the public "Forgot password" form with its per-email limit, and
 * users/change_password with a reset token or signed in (session revocation,
 * invited-user activation, used / expired / unknown links).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { TEST_PUBLIC_APP_URL, use_test_link_env } from '../helpers/link_env.js';
import {
    ChannelDestination, HubEvent, NotificationChannel, NotificationRule, Org, OrgMember, OrgRole,
    PasswordReset, PasswordResetRequest, User,
} from '../../src/models/index.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import type { ReactivationService } from '../../src/services/reactivation.service.js';
import { ApiError } from '../../src/errors/api_error.js';
import { hash_token } from '../../src/lib/secure_token.js';
import { settle_background } from '../../src/lib/background.js';

const has_postgres = await postgres_reachable();
const password = 'password123';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe.skipIf(!has_postgres)('password links (users/new, reset_password, change_password)', () => {
    let app: Express;
    let s: Seed;
    let reactivation: ReactivationService;
    let restore_env: () => void;
    const created_users: string[] = [];
    const used_emails: string[] = [];
    const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;

    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        let r = request(app).post(path);
        if (token) r = r.set('Authorization', `Bearer ${token}`);
        return r.send(body);
    };
    let n = 0;
    const fresh = (label: string) => {
        n += 1;
        const username = `pw${label}${n}${s.stamp}`.slice(0, 32).toLowerCase();
        created_users.push(username);
        s.track(username);
        const email = `${username}@authz.test`;
        used_emails.push(email);
        return { username, email };
    };
    const token_of = (url: string) => decodeURIComponent(url.slice(`${TEST_PUBLIC_APP_URL}/reset/`.length));
    const sign_in = (username: string, pw: string) => post('/internal/auth/authenticate_user', null, { username, password: pw });
    const events = (type: string, org_id: string) => HubEvent.findAll({ where: { type, org_id }, order: [['created_at', 'ASC']], raw: true });
    const account_org = async (username: string) => (await Org.findOne({ where: { slug: username }, raw: true }))!;
    const create_user = async (label: string) => {
        const { username, email } = fresh(label);
        const res = await post('/internal/users/new', s.token.sam, { username, email, display_name: `User ${label}` });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return { username, email, id: res.body.data.user.id as string, setup_url: res.body.data.setup.setup_url as string };
    };
    const signup = async (label: string) => {
        const u = await s.signup(label);
        used_emails.push(u.email);
        return u;
    };
    const admin_reset = (user_id: string) => post('/internal/users/reset_password', s.token.sam, { user_id });

    beforeAll(async () => {
        restore_env = use_test_link_env();
        const live = await open_live_hub_app();
        app = live.app;
        reactivation = live.container.reactivation_service;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        const users = await User.findAll({ where: { username: { [Op.in]: created_users } }, attributes: ['id', 'username'], raw: true });
        const orgs = await Org.findAll({ where: { slug: { [Op.in]: users.map((u) => u.username) } }, attributes: ['id'], raw: true });
        const org_ids = orgs.map((o) => o.id);
        const channels = (await NotificationChannel.findAll({ where: { org_id: { [Op.in]: org_ids } }, attributes: ['id'], raw: true })).map((c) => c.id);
        await ChannelDestination.destroy({ where: { channel_id: { [Op.in]: channels } } });
        await NotificationRule.destroy({ where: { org_id: { [Op.in]: org_ids } } });
        await NotificationChannel.destroy({ where: { org_id: { [Op.in]: org_ids } } });
        await OrgMember.destroy({ where: { org_id: { [Op.in]: org_ids } } });
        await OrgRole.destroy({ where: { org_id: { [Op.in]: org_ids } } });
        await PasswordResetRequest.destroy({ where: { email: { [Op.in]: used_emails } } });
        await User.update({ deleted_at: null, status: 'active' } as never, { where: { username: { [Op.like]: `%${s?.stamp}%` } } });
        await s?.cleanup();
        await Org.destroy({ where: { id: { [Op.in]: org_ids } } }).catch(() => undefined);
        await close_live_hub_app();
        restore_env();
    }, 300_000);

    beforeEach(() => {
        // Email "cannot send" unless a test says otherwise: the link comes back as the *_url fallback.
        vi.spyOn(email_deliverer, 'deliver_message').mockResolvedValue({ sent: false, provider_message_id: null, error: 'not configured' });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    // ── users/new ─────────────────────────────────────────────────────

    describe('users/new', () => {
        it('creates an invited user with a seeded account org and a 7-day setup link; raises user.setup.sent', async () => {
            const { username, email } = fresh('new');
            const before = Date.now();
            const res = await post('/internal/users/new', s.token.sam, { username, email, display_name: 'Priya N', role: 'user' });

            expect(res.status).toBe(200);
            const { user, setup } = res.body.data;
            expect(user).toEqual({ id: expect.any(String), username, email, status: 'invited' });
            expect(setup.email_sent).toBe(false);
            expect(setup.setup_url).toMatch(new RegExp(`^${TEST_PUBLIC_APP_URL}/reset/`));
            const expires = new Date(setup.expires_at).getTime();
            expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY - 5_000);
            expect(expires).toBeLessThanOrEqual(Date.now() + 7 * DAY + 5_000);

            const row = (await User.findByPk(user.id, { raw: true }))!;
            expect(row).toMatchObject({ status: 'invited', password_hash: null, display_name: 'Priya N', role: 'user' });

            const org = await account_org(username);
            expect(org).toMatchObject({ owner_id: user.id, status: 'active' });
            const owner = await OrgMember.findOne({ where: { org_id: org.id, user_id: user.id }, raw: true });
            const owner_role = await OrgRole.findOne({ where: { org_id: org.id, slug: 'owner' }, raw: true });
            expect(owner?.role_id).toBe(owner_role?.id);
            const rule_keys = (await NotificationRule.findAll({ where: { org_id: org.id }, raw: true })).map((r) => r.system_key);
            expect(rule_keys).toEqual(expect.arrayContaining(['user.setup.user', 'user.password_reset.user', 'user.password_changed.user']));

            const token = token_of(setup.setup_url);
            const link = (await PasswordReset.findOne({ where: { user_id: user.id }, raw: true }))!;
            expect(link).toMatchObject({ purpose: 'setup', send_count: 1, used_at: null, requested_by: s.user.sam, token_hash: hash_token(token) });
            expect(link.token_enc).not.toContain(token);

            const [event] = await events('user.setup.sent', org.id);
            expect(event).toMatchObject({ actor_id: s.user.sam });
            expect(JSON.parse(event.payload_json)).toEqual({
                actor: { user_id: s.user.sam },
                data: { user: { id: user.id, username, email, display_name: 'Priya N' }, reset_id: link.id, expires_at: setup.expires_at, send_count: 1 },
            });
            expect(event.payload_json).not.toContain(token);
            expect(event.payload_json).not.toContain('/reset/');
        });

        it('when the email carried the link: email_sent true, no setup_url; only the user gets the link', async () => {
            const spy = vi.spyOn(email_deliverer, 'deliver_message').mockResolvedValue({ sent: true, provider_message_id: '<m@test>', error: null });
            const { username, email } = fresh('sent');
            const res = await post('/internal/users/new', s.token.sam, { username, email });
            expect(res.status).toBe(200);
            expect(res.body.data.setup).toMatchObject({ email_sent: true, setup_url: null });
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0][0]).toMatchObject({
                event: 'user.setup.sent', to: { email, selector: 'user' },
                links: { setup_url: expect.stringMatching(new RegExp(`^${TEST_PUBLIC_APP_URL}/reset/`)) },
            });
        });

        it('site admin only; no password is taken', async () => {
            const { username, email } = fresh('deny');
            expect((await post('/internal/users/new', s.token.adam, { username, email })).status).toBe(403);
            expect((await post('/internal/users/new', null, { username, email })).status).toBe(401);
            const res = await post('/internal/users/new', s.token.sam, { username, email, password: 'ignored-pass' });
            expect(res.status).toBe(200);
            expect((await User.findByPk(res.body.data.user.id, { raw: true }))!.password_hash).toBeNull();
        });

        it('reactivate: restores the deleted user (same id, invited) with a new setup link; setting the password activates them', async () => {
            const gone = await signup('gonepw');
            expect((await post('/internal/users/delete', s.token.sam, { user_id: gone.id })).status).toBe(200);

            const refused = await post('/internal/users/new', s.token.sam, { username: gone.username, email: gone.email });
            expect(refused.status).toBe(409);
            expect(refused.body.error).toMatchObject({ code: 'deleted', details: { kind: 'user', id: gone.id, was_active: true } });
            expect((await post('/internal/users/new', s.token.adam, { username: gone.username, email: gone.email, reactivate: true })).status).toBe(403);

            const res = await post('/internal/users/new', s.token.sam, { username: gone.username, email: gone.email, reactivate: true });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.data.user).toEqual({ id: gone.id, username: gone.username, email: gone.email, status: 'invited' });
            expect(await User.findByPk(gone.id, { raw: true })).toMatchObject({ deleted_at: null, status: 'invited', password_hash: null });
            expect(await account_org(gone.username)).toMatchObject({ id: gone.org_id, deleted_at: null, status: 'active' });
            expect(await PasswordReset.count({ where: { user_id: gone.id, purpose: 'setup' } })).toBe(1);
            expect(await events('user.setup.sent', gone.org_id)).toHaveLength(1);
            // The old session stays revoked; the person signs in once the password is set.
            expect((await post('/v1/orgs/get', gone.token)).status).toBe(401);
            expect((await sign_in(gone.username, password)).status).toBe(401);

            const set = await post('/internal/users/change_password', null, { reset_token: token_of(res.body.data.setup.setup_url), new_password: 'reactivated-pass' });
            expect(set.status, JSON.stringify(set.body)).toBe(200);
            expect(set.body.data.user).toEqual({ id: gone.id, username: gone.username, status: 'active' });
            expect((await sign_in(gone.username, 'reactivated-pass')).status).toBe(200);
        });

        it('reactivate: a failing restore rolls everything back (no link, no event)', async () => {
            const gone = await signup('gonefail');
            expect((await post('/internal/users/delete', s.token.sam, { user_id: gone.id })).status).toBe(200);
            vi.spyOn(reactivation, 'restore_user').mockRejectedValue(new ApiError('internal_error', 'restore failed', 500));

            const res = await post('/internal/users/new', s.token.sam, { username: gone.username, email: gone.email, reactivate: true });
            expect(res.status).toBe(500);
            expect(await PasswordReset.count({ where: { user_id: gone.id } })).toBe(0);
            expect(await events('user.setup.sent', gone.org_id)).toHaveLength(0);
            expect((await User.findByPk(gone.id, { raw: true }))!.deleted_at).not.toBeNull();
        });
    });

    // ── users/reset_password (site admin) ─────────────────────────────

    describe('users/reset_password as a site admin', () => {
        it('sends a 24-hour reset link; asking again reuses the link (new expiry, send_count + 1); sessions stay valid', async () => {
            const u = await signup('rst');
            const first = await admin_reset(u.id);
            expect(first.status).toBe(200);
            expect(first.body.data).toEqual({ reset_id: expect.any(String), expires_at: expect.any(String), email_sent: false, reset_url: expect.stringMatching(/\/reset\//) });
            expect(new Date(first.body.data.expires_at).getTime() - Date.now()).toBeGreaterThan(DAY - 60_000);
            expect(new Date(first.body.data.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(DAY);

            // Pretend time passed: the second ask restarts the expiry from now.
            await PasswordReset.update({ expires_at: new Date(Date.now() + HOUR) } as never, { where: { id: first.body.data.reset_id } });
            const again = await admin_reset(u.id);
            expect(again.body.data.reset_id).toBe(first.body.data.reset_id);
            expect(again.body.data.reset_url).toBe(first.body.data.reset_url);
            expect(new Date(again.body.data.expires_at).getTime() - Date.now()).toBeGreaterThan(DAY - 60_000);

            const link = (await PasswordReset.findByPk(first.body.data.reset_id, { raw: true }))!;
            expect(link).toMatchObject({ purpose: 'reset', send_count: 2, requested_by: s.user.sam, used_at: null });

            const raised = await events('user.password_reset.sent', u.org_id);
            expect(raised).toHaveLength(2);
            expect(JSON.parse(raised[1].payload_json).data).toMatchObject({ reset_id: link.id, send_count: 2, user: { id: u.id } });

            expect((await post('/v1/orgs/get', u.token)).status).toBe(200);
            expect((await sign_in(u.username, password)).status).toBe(200);
        });

        it('concurrent asks share one link', async () => {
            const u = await signup('rstpar');
            const all = await Promise.all([admin_reset(u.id), admin_reset(u.id), admin_reset(u.id)]);
            expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
            expect(new Set(all.map((r) => r.body.data.reset_id)).size).toBe(1);
            expect((await PasswordReset.findOne({ where: { user_id: u.id }, raw: true }))!.send_count).toBe(3);
        });

        it('deleted → 409 deleted; suspended → 409 not_active; unknown → 404; org admin → 403', async () => {
            const gone = await signup('rstgone');
            const when = new Date('2026-09-02T00:00:00Z');
            await User.update({ deleted_at: when } as never, { where: { id: gone.id } });
            const deleted = await admin_reset(gone.id);
            expect(deleted.status).toBe(409);
            expect(deleted.body.error).toMatchObject({ code: 'deleted', details: { kind: 'user', id: gone.id, deleted_at: when.toISOString(), was_active: true } });

            const susp = await signup('rstsusp');
            await post('/internal/users/suspend', s.token.sam, { user_id: susp.id });
            const suspended = await admin_reset(susp.id);
            expect(suspended.status).toBe(409);
            expect(suspended.body.error).toMatchObject({ code: 'not_active', details: { status: 'suspended' } });

            expect((await admin_reset('00000000-0000-4000-8000-000000000000')).status).toBe(404);
            expect((await post('/internal/users/reset_password', s.token.adam, { user_id: susp.id })).status).toBe(403);
            expect(await PasswordReset.count({ where: { user_id: { [Op.in]: [gone.id, susp.id] } } })).toBe(0);
        });
    });

    // ── users/reset_password (public "Forgot password") ───────────────

    describe('users/reset_password with { email } (public)', () => {
        const forgot = (email: string) => post('/internal/users/reset_password', null, { email });

        it('a live account gets a reset link in the background; the answer is always { requested: true }', async () => {
            const u = await signup('fgt');
            const res = await forgot(`  ${u.email.toUpperCase()} `);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ ok: true, data: { requested: true } });

            await vi.waitFor(async () => expect(await events('user.password_reset.sent', u.org_id)).toHaveLength(1), { timeout: 10_000 });
            const link = (await PasswordReset.findOne({ where: { user_id: u.id }, raw: true }))!;
            expect(link).toMatchObject({ purpose: 'reset', requested_by: null, send_count: 1 });
            const [event] = await events('user.password_reset.sent', u.org_id);
            expect(event.actor_id).toBe(u.id);
            expect(await PasswordResetRequest.count({ where: { email: u.email } })).toBe(1);
        });

        it('unknown, deleted and suspended emails get the same answer and nothing is sent', async () => {
            const gone = await signup('fgtgone');
            await User.update({ deleted_at: new Date() } as never, { where: { id: gone.id } });
            const susp = await signup('fgtsusp');
            await post('/internal/users/suspend', s.token.sam, { user_id: susp.id });
            const unknown = `nobody${s.stamp}@authz.test`;
            used_emails.push(unknown);

            for (const email of [unknown, gone.email, susp.email]) {
                const res = await forgot(email);
                expect(res.status).toBe(200);
                expect(res.body).toEqual({ ok: true, data: { requested: true } });
            }
            // A live account asked last: once its link exists, the earlier background checks have run.
            const live = await signup('fgtlive');
            await forgot(live.email);
            await settle_background();
            expect(await PasswordReset.count({ where: { user_id: live.id } })).toBe(1);
            expect(await PasswordReset.count({ where: { user_id: { [Op.in]: [gone.id, susp.id] } } })).toBe(0);
            expect(await PasswordResetRequest.count({ where: { email: unknown } })).toBe(1);
        });

        it('3 requests per email per hour, then 429 rate_limited (known or unknown email alike)', async () => {
            const u = await signup('fgtlim');
            const unknown = `nolimit${s.stamp}@authz.test`;
            used_emails.push(unknown);
            for (const email of [u.email, unknown]) {
                for (let i = 0; i < 3; i += 1) expect((await forgot(email)).status).toBe(200);
                const limited = await forgot(email);
                expect(limited.status).toBe(429);
                expect(limited.body.error.code).toBe('rate_limited');
            }
            // Same link each time: one row, sent three times.
            await vi.waitFor(async () => expect((await PasswordReset.findOne({ where: { user_id: u.id }, raw: true }))?.send_count).toBe(3), { timeout: 10_000 });
        });

        it('concurrent requests cannot go over the per-email limit; Core keeps no per-address limit', async () => {
            const email = `burst${s.stamp}@authz.test`;
            used_emails.push(email);
            const answers = await Promise.all(Array.from({ length: 8 }, () => forgot(email)));
            expect(answers.filter((r) => r.status === 200)).toHaveLength(3);
            expect(answers.filter((r) => r.status === 429)).toHaveLength(5);
            expect(await PasswordResetRequest.count({ where: { email } })).toBe(3);

            // Many emails from one caller: each is within its own limit.
            const many = await Promise.all(Array.from({ length: 14 }, (_, i) => {
                const one = `burstmany${i}x${s.stamp}@authz.test`;
                used_emails.push(one);
                return forgot(one);
            }));
            expect(many.every((r) => r.status === 200)).toBe(true);
        });

        it('an old request outside the hour no longer counts', async () => {
            const email = `window${s.stamp}@authz.test`;
            used_emails.push(email);
            for (let i = 0; i < 3; i += 1) await PasswordResetRequest.create({ email, created_at: new Date(Date.now() - HOUR - 60_000) });
            expect((await forgot(email)).status).toBe(200);
        });
    });

    // ── users/change_password with a reset token ──────────────────────

    describe('users/change_password with { reset_token } (public)', () => {
        const change = (reset_token: string, new_password: string) =>
            post('/internal/users/change_password', null, { reset_token, new_password });

        it('setup link: sets the password, activates the invited user, marks the link used, raises user.password.changed', async () => {
            const u = await create_user('act');
            const res = await change(token_of(u.setup_url), 'my-new-password');

            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.data).toEqual({ user: { id: u.id, username: u.username, status: 'active' }, sessions_revoked: 0 });
            expect((await User.findByPk(u.id, { raw: true }))!.status).toBe('active');
            expect((await PasswordReset.findOne({ where: { user_id: u.id }, raw: true }))!.used_at).not.toBeNull();
            expect((await sign_in(u.username, 'my-new-password')).status).toBe(200);

            const org = await account_org(u.username);
            const [event] = await events('user.password.changed', org.id);
            expect(JSON.parse(event.payload_json)).toEqual({
                actor: { user_id: u.id },
                data: { user: { id: u.id, username: u.username, email: u.email, display_name: 'User act' }, sessions_revoked: 0 },
            });
        });

        it('a used link → 409 not_pending { status: used }', async () => {
            const u = await create_user('reuse');
            const token = token_of(u.setup_url);
            expect((await change(token, 'first-password')).status).toBe(200);
            const again = await change(token, 'second-password');
            expect(again.status).toBe(409);
            expect(again.body.error).toMatchObject({ code: 'not_pending', details: { status: 'used' } });
            expect((await sign_in(u.username, 'first-password')).status).toBe(200);
        });

        it('an expired link → 410 expired { expired_at }; unknown → 404', async () => {
            const u = await signup('exp');
            const reset = await admin_reset(u.id);
            const expired_at = new Date(Date.now() - 1_000);
            await PasswordReset.update({ expires_at: expired_at } as never, { where: { id: reset.body.data.reset_id } });

            const res = await change(token_of(reset.body.data.reset_url), 'too-late-pass');
            expect(res.status).toBe(410);
            expect(res.body.error).toMatchObject({ code: 'expired', details: { expired_at: expired_at.toISOString() } });
            expect((await change('no-such-token', 'whatever-pass')).status).toBe(404);
            expect((await sign_in(u.username, password)).status).toBe(200);
        });

        it('a too-short password → 422 and the link stays usable', async () => {
            const u = await create_user('short');
            const token = token_of(u.setup_url);
            const res = await change(token, 'short');
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe('invalid_params');
            expect((await PasswordReset.findOne({ where: { user_id: u.id }, raw: true }))!.used_at).toBeNull();
            expect((await change(token, 'long-enough-now')).status).toBe(200);
        });

        it('signs out every session of the user; the reset link retires the older setup link', async () => {
            const u = await create_user('sess');
            expect((await change(token_of(u.setup_url), 'first-password')).status).toBe(200);
            const a = (await sign_in(u.username, 'first-password')).body.data.token as string;
            const b = (await sign_in(u.username, 'first-password')).body.data.token as string;
            expect((await post('/v1/orgs/get', a)).status).toBe(200);

            const reset = await admin_reset(u.id);
            const res = await change(token_of(reset.body.data.reset_url), 'second-password');
            expect(res.status).toBe(200);
            expect(res.body.data.sessions_revoked).toBe(2);
            expect((await post('/v1/orgs/get', a)).status).toBe(401);
            expect((await post('/v1/orgs/get', b)).status).toBe(401);
            expect((await sign_in(u.username, 'first-password')).status).toBe(401);
            expect((await sign_in(u.username, 'second-password')).status).toBe(200);
        });

        it('using a reset link retires every other open link of the user', async () => {
            const u = await create_user('retire');
            const reset = await admin_reset(u.id);
            expect((await change(token_of(reset.body.data.reset_url), 'via-reset-link')).status).toBe(200);
            const setup = await change(token_of(u.setup_url), 'via-setup-link');
            expect(setup.status).toBe(409);
            expect(setup.body.error.details).toEqual({ status: 'used' });
        });

        it('a user suspended after the link was sent → 409 not_active; the link stays open', async () => {
            const u = await signup('chgsusp');
            const reset = await admin_reset(u.id);
            await post('/internal/users/suspend', s.token.sam, { user_id: u.id });
            const res = await change(token_of(reset.body.data.reset_url), 'blocked-password');
            expect(res.status).toBe(409);
            expect(res.body.error).toMatchObject({ code: 'not_active', details: { status: 'suspended' } });
            expect((await PasswordReset.findByPk(reset.body.data.reset_id, { raw: true }))!.used_at).toBeNull();
        });
    });

    // ── users/change_password signed in ───────────────────────────────

    describe('users/change_password signed in', () => {
        it('keeps the calling session, signs out the others, raises user.password.changed', async () => {
            const u = await signup('self');
            const other = (await sign_in(u.username, password)).body.data.token as string;

            const res = await post('/internal/users/change_password', u.token, { current_password: password, new_password: 'changed-password' });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ user: { id: u.id, username: u.username, status: 'active' }, sessions_revoked: 1 });
            expect((await post('/v1/orgs/get', u.token)).status).toBe(200);
            expect((await post('/v1/orgs/get', other)).status).toBe(401);
            expect((await sign_in(u.username, 'changed-password')).status).toBe(200);

            const [event] = await events('user.password.changed', u.org_id);
            expect(JSON.parse(event.payload_json).data).toMatchObject({ user: { id: u.id }, sessions_revoked: 1 });
        });

        it('a wrong current password → 403, nothing changes', async () => {
            const u = await signup('selfbad');
            const res = await post('/internal/users/change_password', u.token, { current_password: 'not-it', new_password: 'changed-password' });
            expect(res.status).toBe(403);
            expect((await sign_in(u.username, password)).status).toBe(200);
            expect(await events('user.password.changed', u.org_id)).toHaveLength(0);
        });

        it('without a session or a token → 401', async () => {
            expect((await post('/internal/users/change_password', null, { current_password: password, new_password: 'changed-password' })).status).toBe(401);
        });
    });
});
