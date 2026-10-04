/**
 * Identity lifecycle foundation on live Postgres: schema, org seeding, the
 * recipient resolver, org events raised after commit with delivery-time
 * links, deleted-name conflicts over HTTP, and the owner-only permission
 * migration. Full production app, route policy enforced.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { Op, QueryTypes } from 'sequelize';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { TEST_PUBLIC_APP_URL, use_test_link_env } from '../helpers/link_env.js';
import {
    AccountInvite, ChannelDestination, HubEvent, InAppNotification, NotificationChannel, NotificationRule,
    Org, OrgRole, PasswordReset, User,
} from '../../src/models/index.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { migrate_hub_schema } from '../../src/models/migrations/hub_schema_migrations.js';
import { migrate_identity_lifecycle } from '../../src/models/migrations/migrate_identity_lifecycle.js';
import { run_core_api_schema_migrations } from '../../src/models/migrations/control_plane_schema_migrations.js';
import { strip_owner_only_permissions } from '../../src/models/migrations/migrate_org_roles.js';
import { OrgSeedService, default_rule_specs } from '../../src/services/org_seed.service.js';
import { OrgEventService } from '../../src/services/org_event.service.js';
import { resolve_recipients } from '../../src/notifications/recipients.js';
import { resolve_delivery_links } from '../../src/notifications/delivery_links.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import { issue_token } from '../../src/lib/secure_token.js';
import type { InviteEventData } from '../../src/notifications/org_events.js';

const has_postgres = await postgres_reachable();
const password = 'password123';

describe.skipIf(!has_postgres)('identity lifecycle foundation', () => {
    let app: Express;
    let s: Seed;
    let restore_env: () => void;
    const extra_orgs: string[] = [];
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;

    beforeAll(async () => {
        restore_env = use_test_link_env();
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        for (const id of extra_orgs) {
            const channels = (await NotificationChannel.findAll({ where: { org_id: id }, attributes: ['id'], raw: true })).map((c) => c.id);
            await ChannelDestination.destroy({ where: { channel_id: { [Op.in]: channels } } });
            await NotificationRule.destroy({ where: { org_id: id } });
            await NotificationChannel.destroy({ where: { org_id: id } });
            await Org.destroy({ where: { id } });
        }
        await User.update({ deleted_at: null } as never, { where: { username: { [Op.like]: `%${s?.stamp}%` } } });
        await Org.update({ deleted_at: null, status: 'active' } as never, { where: { slug: { [Op.like]: `%${s?.stamp}%` }, id: { [Op.notIn]: extra_orgs } } });
        await s?.cleanup();
        await close_live_hub_app();
        restore_env();
    }, 300_000);

    afterEach(() => { vi.restoreAllMocks(); });

    // ── schema ────────────────────────────────────────────────────────

    describe('schema', () => {
        const columns = async (table: string) => (await get_sequelize().query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = :table`,
            { replacements: { table }, type: QueryTypes.SELECT },
        )).map((r) => r.column_name);

        it('has every column and table the lanes need', async () => {
            expect(await columns('users')).toEqual(expect.arrayContaining(['status', 'deleted_at']));
            expect(await columns('orgs')).toEqual(expect.arrayContaining(['status', 'deleted_at', 'owner_id', 'activated_at', 'notifications_seeded_at']));
            expect(await columns('org_members')).toEqual(expect.arrayContaining(['status', 'deleted_at', 'invited_at', 'joined_at']));
            expect(await columns('realm_members')).toEqual(expect.arrayContaining(['status', 'deleted_at']));
            for (const t of ['account_invites', 'realm_invites']) {
                expect(await columns(t)).toEqual(expect.arrayContaining(['token_hash', 'token_enc', 'send_count', 'last_sent_at', 'reminders_sent', 'decided_at', 'decision']));
            }
            expect(await columns('notification_channels')).toEqual(expect.arrayContaining(['system_key', 'locked', 'lock_reason']));
            expect(await columns('notification_rules')).toEqual(expect.arrayContaining(['system_key', 'locked', 'lock_reason', 'recipients']));
            expect(await columns('password_resets')).toEqual(expect.arrayContaining(['user_id', 'purpose', 'token_hash', 'token_enc', 'expires_at', 'used_at', 'send_count']));
            expect(await columns('password_reset_requests')).toEqual(expect.arrayContaining(['email', 'created_at']));
            expect(await columns('email_deliveries')).toEqual(expect.arrayContaining(['subject_type', 'subject_id', 'event', 'to', 'sent_at', 'ok', 'provider_message_id', 'error']));
        });

        it('re-running the migrations is a no-op', async () => {
            await migrate_hub_schema(get_sequelize());
            await migrate_hub_schema(get_sequelize());
        });

        it('checks statuses; invited users may have no username or password', async () => {
            const sq = get_sequelize();
            await expect(sq.query(`UPDATE users SET status = 'bogus' WHERE id = :id`, { replacements: { id: s.user.nora } })).rejects.toThrow();
            const email = `invited${s.stamp}@authz.test`;
            const invited = await User.create({ email, display_name: 'Invited', status: 'invited' } as never);
            expect(invited.username).toBeNull();
            expect(invited.password_hash).toBeNull();
            await User.destroy({ where: { id: invited.id } });
        });

        it('keeps users.status consistent with suspended_at, and backfills orgs.owner_id', async () => {
            await User.update({ suspended_at: new Date() } as never, { where: { id: s.user.mia } });
            await migrate_identity_lifecycle(get_sequelize());
            expect((await User.findByPk(s.user.mia, { raw: true }))!.status).toBe('suspended');
            await User.update({ suspended_at: null } as never, { where: { id: s.user.mia } });
            await migrate_identity_lifecycle(get_sequelize());
            expect((await User.findByPk(s.user.mia, { raw: true }))!.status).toBe('active');

            await Org.update({ owner_id: null } as never, { where: { id: s.acme } });
            await migrate_identity_lifecycle(get_sequelize());
            expect((await Org.findByPk(s.acme, { raw: true }))!.owner_id).toBe(s.user.olivia);
        });

        it('one open password link per user and purpose', async () => {
            const a = issue_token();
            const b = issue_token();
            const expires_at = new Date(Date.now() + 60_000);
            await PasswordReset.create({ user_id: s.user.nora, purpose: 'reset', token_hash: a.token_hash, token_enc: a.token_enc, expires_at } as never);
            await expect(PasswordReset.create({ user_id: s.user.nora, purpose: 'reset', token_hash: b.token_hash, token_enc: b.token_enc, expires_at } as never)).rejects.toThrow();
            await PasswordReset.destroy({ where: { user_id: s.user.nora } });
        });
    });

    // ── seeding ───────────────────────────────────────────────────────

    describe('org seeding', () => {
        it('signup seeds the account org: locked Email (Brevo), In-app, and every default rule', async () => {
            const channels = await NotificationChannel.findAll({ where: { org_id: s.acme, system_key: { [Op.ne]: null } }, raw: true });
            const email = channels.find((c) => c.system_key === 'org.email')!;
            const in_app = channels.find((c) => c.system_key === 'org.in_app')!;
            expect(email).toMatchObject({ name: 'Email', locked: true, enabled: 1 });
            expect(in_app).toMatchObject({ name: 'In-app', locked: false });
            const dest = await ChannelDestination.findOne({ where: { channel_id: email.id }, raw: true });
            expect(dest).toMatchObject({ type: 'email', config: { provider: 'brevo' } });

            const rules = await NotificationRule.findAll({ where: { org_id: s.acme, system_key: { [Op.ne]: null } }, raw: true });
            expect(rules).toHaveLength(default_rule_specs(true).length);
            const sent = rules.find((r) => r.event === 'invite.org.sent' && r.channel_id === email.id)!;
            expect(rules.find((r) => r.event === 'invite.org.sent' && r.channel_id === in_app.id)).toMatchObject({ system_key: 'invite.sent.invitee', locked: false });
            expect(sent).toMatchObject({ channel_id: email.id, recipients: ['invitee'], system_key: 'invite.sent.invitee', locked: true, lock_reason: 'Invites must reach the invited person.' });
            expect(rules.filter((r) => r.event === 'invite.owner.accepted').every((r) => !r.locked)).toBe(true);
            expect((await Org.findByPk(s.acme, { raw: true }))!.notifications_seeded_at).toBeTruthy();
        });

        it('seeding again creates nothing', async () => {
            expect(await OrgSeedService.seed_org(s.acme, { account: true })).toEqual({ channels_created: 0, rules_created: 0 });
        });

        it('backfill seeds unseeded orgs once; a removed editable default is not brought back', async () => {
            const org = await Org.create({ slug: `seedme${s.stamp}`, display_name: 'Seed me' } as never);
            extra_orgs.push(org.id);
            const first = await OrgSeedService.backfill();
            expect(first.orgs_seeded).toBeGreaterThanOrEqual(1);
            const rules = await NotificationRule.findAll({ where: { org_id: org.id }, raw: true });
            expect(rules).toHaveLength(default_rule_specs(false).length);

            const editable = rules.find((r) => !r.locked)!;
            await NotificationRule.destroy({ where: { id: editable.id } });
            expect((await OrgSeedService.backfill()).orgs_seeded).toBe(0);
            expect(await NotificationRule.count({ where: { org_id: org.id } })).toBe(rules.length - 1);
        });

        it('the boot migrations keep org and personal channels and drop only orphan realm-less ones', async () => {
            const seeded = await NotificationChannel.findAll({ where: { org_id: s.acme, system_key: { [Op.ne]: null } }, attributes: ['id'], raw: true });
            expect(seeded).toHaveLength(2);
            const personal = await NotificationChannel.findOne({ where: { org_id: s.acme, user_id: { [Op.ne]: null } }, attributes: ['id'], raw: true });
            expect(personal).toBeTruthy();
            const orphan_id = randomUUID();
            await NotificationChannel.create({
                id: orphan_id, realm_id: null, org_id: null, user_id: null, name: `orphan${s.stamp}`,
                secret: null, enabled: 1, created_at: Date.now(), updated_at: Date.now(),
            } as never);

            await run_core_api_schema_migrations(get_sequelize());

            const kept = await NotificationChannel.findAll({ where: { id: { [Op.in]: [...seeded.map((c) => c.id), personal!.id] } }, attributes: ['id'], raw: true });
            expect(kept).toHaveLength(3);
            expect(await NotificationChannel.findByPk(orphan_id)).toBeNull();
            const rule_channels = (await NotificationRule.findAll({ where: { org_id: s.acme, system_key: { [Op.ne]: null } }, attributes: ['channel_id'], raw: true })).map((r) => r.channel_id);
            expect(new Set(rule_channels)).toEqual(new Set(seeded.map((c) => c.id)));
        });

        it('orgs/new seeds the new org and records its future owner', async () => {
            const slug = `seeded${s.stamp}`.slice(0, 30);
            const res = await post('/v1/orgs/new', s.token.sam, { slug, display_name: 'Seeded', owner: { user_id: s.user.ben } });
            expect(res.status).toBe(200);
            const org_id = String(res.body.data.org.id);
            extra_orgs.push(org_id);
            const org = await Org.findByPk(org_id, { raw: true });
            expect(org).toMatchObject({ owner_id: s.user.ben, status: 'waiting_for_owner', activated_at: null });
            expect(await NotificationRule.count({ where: { org_id, system_key: { [Op.ne]: null } } })).toBe(default_rule_specs(false).length);
        });
    });

    // ── recipients ────────────────────────────────────────────────────

    describe('recipient resolver', () => {
        const data = (over: Partial<InviteEventData> = {}): InviteEventData => ({
            invite_id: randomUUID(), kind: 'org', role: 'member', invitee_email: 'nobody@authz.test',
            inviter: { id: s.user.adam, display_name: 'Adam' }, org: { slug: 'acme', display_name: 'Acme' }, realm: null,
            expires_at: new Date(Date.now() + 86_400_000).toISOString(), send_count: 1, ...over,
        });

        it('invitee: the address, with the account when there is one', async () => {
            const nora = (await User.findByPk(s.user.nora, { raw: true }))!;
            expect(await resolve_recipients(['invitee'], { org_id: s.acme, data: data({ invitee_email: nora.email.toUpperCase() }) }))
                .toEqual([expect.objectContaining({ email: nora.email, user_id: s.user.nora, selector: 'invitee' })]);
            expect(await resolve_recipients(['invitee'], { org_id: s.acme, data: data() }))
                .toEqual([{ email: 'nobody@authz.test', user_id: null, display_name: null, selector: 'invitee' }]);
        });

        it('org_owners, inviter and user ids; de-duplicated by email; deleted users never', async () => {
            const owners = await resolve_recipients(['org_owners'], { org_id: s.acme, data: data() });
            expect(owners.map((r) => r.user_id)).toEqual([s.user.olivia]);
            const both = await resolve_recipients(['org_owners', 'inviter', s.user.olivia, 'not-a-selector'], { org_id: s.acme, data: data() });
            expect(both.map((r) => r.user_id)).toEqual([s.user.olivia, s.user.adam]);

            await User.update({ deleted_at: new Date() } as never, { where: { id: s.user.adam } });
            try {
                expect(await resolve_recipients(['inviter'], { org_id: s.acme, data: data() })).toEqual([]);
            } finally {
                await User.update({ deleted_at: null } as never, { where: { id: s.user.adam } });
            }
            expect(await resolve_recipients(['user'], { org_id: s.acme, data: data() })).toEqual([]);
        });
    });

    // ── events ────────────────────────────────────────────────────────

    describe('org events', () => {
        async function pending_invite(email: string) {
            const issued = issue_token();
            const invite = await AccountInvite.create({
                org_id: s.acme, email, invited_by: s.user.adam, token_hash: issued.token_hash, token_enc: issued.token_enc,
                role: 'member', status: 'pending', expires_at: new Date(Date.now() + 86_400_000),
            } as never);
            return { invite, token: issued.token };
        }
        const data_for = (invite_id: string, email: string): InviteEventData => ({
            invite_id, kind: 'org', role: 'member', invitee_email: email,
            inviter: { id: s.user.adam, display_name: 'Adam' }, org: { slug: 'acme', display_name: 'Acme' }, realm: null,
            expires_at: new Date(Date.now() + 86_400_000).toISOString(), send_count: 1,
        });

        it('sent: raised after commit; only the invitee email carries the accept link; the stored event has no token', async () => {
            const email = `priya${s.stamp}@authz.test`;
            const { invite, token } = await pending_invite(email);
            const spy = vi.spyOn(email_deliverer, 'deliver_message');

            const data = data_for(invite.id, email);
            const pending = await get_sequelize().transaction(async (t) => OrgEventService.raise_after_commit(t, {
                event: 'invite.org.sent', org_id: s.acme, actor: { user_id: s.user.adam },
                data, link: { kind: 'invite', table: 'account_invites', invite_id: invite.id },
            }));
            const result = await pending.result;

            expect(result.event_id).toBeTruthy();
            expect(result.status).toBe('failed');
            expect(result.email_sent).toBe(false);
            expect(spy).toHaveBeenCalledTimes(1);
            const input = spy.mock.calls[0][0];
            expect(input).toMatchObject({
                event: 'invite.org.sent', org_id: s.acme, to: { email, selector: 'invitee' },
                links: { accept_url: `${TEST_PUBLIC_APP_URL}/invite/${token}` },
                subject: { type: 'invite', id: invite.id }, destination: { provider: 'brevo' },
            });

            const row = (await HubEvent.findByPk(result.event_id!, { raw: true }))!;
            expect(row).toMatchObject({ type: 'invite.org.sent', org_id: s.acme, actor_id: s.user.adam, title: 'Invite sent' });
            expect(row.payload_json).not.toContain(token);
            expect(row.payload_json).not.toContain('/invite/');
            expect(JSON.parse(row.payload_json)).toEqual({ actor: { user_id: s.user.adam }, data });
        });

        it('email_sent is true once the Email channel reports the linked email as sent', async () => {
            const email = `sent${s.stamp}@authz.test`;
            const { invite } = await pending_invite(email);
            vi.spyOn(email_deliverer, 'deliver_message').mockResolvedValue({ sent: true, provider_message_id: '<m@test>', error: null });
            const result = await OrgEventService.raise({
                event: 'invite.org.reminder', org_id: s.acme, actor: { system: 'sweep' },
                data: data_for(invite.id, email), link: { kind: 'invite', table: 'account_invites', invite_id: invite.id },
            });
            expect(result).toMatchObject({ status: 'dispatched', email_sent: true });
            expect((await HubEvent.findByPk(result.event_id!, { raw: true }))!.actor_id).toBeNull();
        });

        it('accepted: owners and inviter get email (no link) and an inbox row', async () => {
            const email = `acc${s.stamp}@authz.test`;
            const { invite } = await pending_invite(email);
            const spy = vi.spyOn(email_deliverer, 'deliver_message');
            const result = await OrgEventService.raise({
                event: 'invite.org.accepted', org_id: s.acme, actor: { user_id: s.user.nora },
                data: data_for(invite.id, email),
            });
            expect(spy.mock.calls.map((c) => c[0].to.user_id).sort()).toEqual([s.user.adam, s.user.olivia].sort());
            expect(spy.mock.calls.every((c) => Object.keys(c[0].links).length === 0)).toBe(true);
            const inbox = await InAppNotification.findAll({ where: { event: 'invite.org.accepted', user_id: { [Op.in]: [s.user.olivia, s.user.adam] } }, raw: true });
            expect(inbox.length).toBeGreaterThanOrEqual(2);
            expect(result.status).toBe('dispatched');
            expect(result.email_sent).toBe(false);
        });

        it('a rolled-back transaction raises nothing', async () => {
            const email = `rb${s.stamp}@authz.test`;
            const { invite } = await pending_invite(email);
            await expect(get_sequelize().transaction(async (t) => {
                OrgEventService.raise_after_commit(t, { event: 'invite.org.revoked', org_id: s.acme, actor: { user_id: s.user.adam }, data: data_for(invite.id, email) });
                throw new Error('boom');
            })).rejects.toThrow('boom');
            const rows = await HubEvent.findAll({ where: { type: 'invite.org.revoked', org_id: s.acme }, raw: true });
            expect(rows.some((r) => r.payload_json.includes(invite.id))).toBe(false);
        });

        it('password links: setup → setup_url, reset → reset_url', async () => {
            const issued = issue_token();
            const row = await PasswordReset.create({ user_id: s.user.mia, purpose: 'setup', token_hash: issued.token_hash, token_enc: issued.token_enc, expires_at: new Date(Date.now() + 60_000) } as never);
            expect(await resolve_delivery_links({ kind: 'password', reset_id: row.id })).toEqual({ setup_url: `${TEST_PUBLIC_APP_URL}/reset/${issued.token}` });
            await PasswordReset.update({ purpose: 'reset' } as never, { where: { id: row.id } });
            expect(await resolve_delivery_links({ kind: 'password', reset_id: row.id })).toEqual({ reset_url: `${TEST_PUBLIC_APP_URL}/reset/${issued.token}` });
            await PasswordReset.destroy({ where: { id: row.id } });
        });

        it('clients cannot submit invite events', async () => {
            const res = await post('/v1/events/submit', s.token.olivia, { type: 'invite.org.sent', org_id: s.acme, payload: {} });
            expect(res.status).toBe(400);
        });
    });

    // ── deleted names over HTTP ───────────────────────────────────────

    describe('deleted names', () => {
        it('internal users/new: a deleted username or email → 409 deleted; a live email → 409 conflict naming the holder', async () => {
            const gone = await s.signup('gone');
            const when = new Date('2026-09-01T00:00:00Z');
            // A deleted user's account org is deleted with them.
            await User.update({ deleted_at: when } as never, { where: { id: gone.id } });
            await Org.update({ deleted_at: when, status: 'deleted' } as never, { where: { id: gone.org_id } });

            const by_name = await post('/internal/users/new', s.token.sam, { username: gone.username, email: `fresh${s.stamp}@authz.test`, password });
            expect(by_name.status).toBe(409);
            expect(by_name.body.error).toMatchObject({ code: 'deleted', details: { kind: 'user', id: gone.id, deleted_at: when.toISOString(), was_active: true } });

            const by_email = await post('/internal/users/new', s.token.sam, { username: `fresh${s.stamp}`.slice(0, 30), email: gone.email, password });
            expect(by_email.status).toBe(409);
            expect(by_email.body.error).toMatchObject({ code: 'deleted', details: { kind: 'user', id: gone.id } });

            const nora = (await User.findByPk(s.user.nora, { raw: true }))!;
            const live = await post('/internal/users/new', s.token.sam, { username: `fresh${s.stamp}`.slice(0, 30), email: nora.email, password });
            expect(live.status).toBe(409);
            expect(live.body.error).toMatchObject({ code: 'conflict', details: { kind: 'user', field: 'email', holder: { id: s.user.nora, slug: nora.username } } });
        });

        it('signup: a deleted org slug → 409 deleted (kind org)', async () => {
            const slug = `delorg${s.stamp}`.slice(0, 30);
            const org = await Org.create({ slug, display_name: slug, status: 'deleted', deleted_at: new Date(), activated_at: new Date() } as never);
            extra_orgs.push(org.id);
            const res = await post('/internal/auth/signup', null, { username: slug, email: `${slug}@authz.test`, password });
            expect(res.status).toBe(409);
            expect(res.body.error).toMatchObject({ code: 'deleted', details: { kind: 'org', id: org.id, was_active: true } });
        });
    });

    // ── owner-only permissions ────────────────────────────────────────

    describe('owner-only permissions', () => {
        it('orgs/get_by_id reports the caller\'s org role: owner, admin, member, or site_admin', async () => {
            const role_of = async (token: string) => (await post('/v1/orgs/get_by_id', token, { org_id: s.acme })).body.data.my_role;
            expect(await role_of(s.token.olivia)).toBe('owner');
            expect(await role_of(s.token.adam)).toBe('admin');
            expect(await role_of(s.token.nora)).toBe('member');
            expect(await role_of(s.token.sam)).toBe('site_admin');
        });

        it('are removed from every role but the owner role', async () => {
            const role = await OrgRole.create({ org_id: s.acme, slug: `custom${s.stamp}`, name: 'Custom', permissions: ['runs.view', 'org.delete'] } as never);
            try {
                expect(await strip_owner_only_permissions()).toBeGreaterThanOrEqual(1);
                expect((await OrgRole.findByPk(role.id, { raw: true }))!.permissions).toEqual(['runs.view']);
                expect(await strip_owner_only_permissions()).toBe(0);
            } finally {
                await OrgRole.destroy({ where: { id: role.id } });
            }
        });
    });
});
