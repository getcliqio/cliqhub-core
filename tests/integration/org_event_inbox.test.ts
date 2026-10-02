/**
 * Org events in the in-app inbox over HTTP on live Postgres (production app,
 * route policy enforced): who sees an accepted invite and a "You're invited"
 * notice through `notifications/get { org_id }`, that nobody else does, the
 * versioned default rules added once to orgs seeded before, and the boot
 * backfill of the org of older inbox rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { use_test_link_env } from '../helpers/link_env.js';
import { token_from_invite_url } from '../helpers/invite_links.js';
import {
    AccountInvite, ChannelDestination, InAppNotification, NotificationChannel, NotificationRule, Org, OrgMember, User,
} from '../../src/models/index.js';
import { DEFAULTS_VERSION, OrgSeedService } from '../../src/services/org_seed.service.js';
import { migrate_identity_lifecycle } from '../../src/models/migrations/migrate_identity_lifecycle.js';
import { get_sequelize } from '../../src/db/sequelize.js';

const has_postgres = await postgres_reachable();
const password = 'password123';

describe.skipIf(!has_postgres)('org events in the inbox', () => {
    let app: Express;
    let s: Seed;
    let restore_env: () => void;
    const emails: string[] = [];

    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const uniq = (label: string) => `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const new_email = (label: string) => { const e = `${uniq(label)}@inbox.test`; emails.push(e); return e; };
    /** The caller's inbox items for `org_id` of `event`. */
    const inbox = async (token: string, org_id: string, event: string) => {
        const res = await post('/v1/notifications/get', token, { org_id, types: [event], limit: 100 });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.data.items as Array<{ id: string; event: string; title: string; message: string; payload: { data?: { invite_id?: string } } }>;
    };
    const for_invite = (items: Awaited<ReturnType<typeof inbox>>, invite_id: string) => items.filter((n) => n.payload.data?.invite_id === invite_id);

    beforeAll(async () => {
        restore_env = use_test_link_env();
        app = (await open_live_hub_app()).app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        if (s) {
            await AccountInvite.destroy({ where: { email: { [Op.in]: emails } } });
            const invited = (await User.findAll({ where: { email: { [Op.in]: emails }, username: null }, attributes: ['id'], raw: true })).map((u) => u.id);
            await OrgMember.destroy({ where: { user_id: { [Op.in]: invited } } });
            await User.destroy({ where: { id: { [Op.in]: invited } } });
            await s.cleanup();
        }
        await close_live_hub_app();
        restore_env();
    }, 300_000);

    it('an accepted invite reaches the owners and the inviter through notifications/get { org_id }, and nobody else', async () => {
        const sent = await post('/v1/invitations/create', s.token.adam, { target_type: 'org', org_id: s.acme, email: new_email('acc') });
        const invite_id = sent.body.data.invite_id as string;
        const username = uniq('inb').slice(0, 20);
        s.track(username);
        const accepted = await post('/v1/invitations/accept', null, {
            token: token_from_invite_url(sent.body.data.invite_url), decision: 'accept', username, password, display_name: 'Sapan Shah',
        });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        const acme = (await Org.findByPk(s.acme, { raw: true }))!;

        for (const token of [s.token.olivia, s.token.adam]) {
            const mine = for_invite(await inbox(token, s.acme, 'invite.org.accepted'), invite_id);
            expect(mine).toHaveLength(1);
            expect(mine[0].title).toBe(`Sapan Shah joined ${acme.display_name}`);
            expect(mine[0].message).toBe(`Sapan Shah accepted the invite to ${acme.display_name} as member.`);
        }
        for (const token of [s.token.mia, s.token.nora, accepted.body.data.token as string]) {
            expect(for_invite(await inbox(token, s.acme, 'invite.org.accepted'), invite_id)).toHaveLength(0);
        }
        const rows = await InAppNotification.findAll({ where: { event: 'invite.org.accepted', payload_json: { [Op.like]: `%${invite_id}%` } }, raw: true });
        expect(rows.every((r) => r.org_id === s.acme && r.user_id)).toBe(true);
    });

    it("an invitee with an account gets \"You're invited\" in their own inbox; an invitee without one gets nothing in-app", async () => {
        const u = await s.signup('invitee');
        const sent = await post('/v1/invitations/create', s.token.adam, { target_type: 'org', org_id: s.acme, email: u.email });
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        const invite_id = sent.body.data.invite_id as string;
        const acme = (await Org.findByPk(s.acme, { raw: true }))!;

        const theirs = for_invite(await inbox(u.token, u.org_id, 'invite.org.sent'), invite_id);
        expect(theirs).toHaveLength(1);
        expect(theirs[0].title).toBe(`You're invited to join ${acme.display_name}`);
        expect(theirs[0].message).toMatch(/invited you to join .* as member/);
        for (const token of [s.token.olivia, s.token.adam, s.token.mia]) {
            expect(for_invite(await inbox(token, s.acme, 'invite.org.sent'), invite_id)).toHaveLength(0);
        }

        const email = new_email('noacct');
        const no_account = await post('/v1/invitations/create', s.token.adam, { target_type: 'org', org_id: s.acme, email });
        const placeholder = (await User.findOne({ where: { email }, raw: true }))!;
        expect(await InAppNotification.count({ where: { user_id: placeholder.id } })).toBe(0);
        expect(await InAppNotification.count({ where: { payload_json: { [Op.like]: `%${no_account.body.data.invite_id}%` } } })).toBe(0);
    });

    it('a password change shows in the account holder\'s inbox', async () => {
        const u = await s.signup('pwinbox');
        expect((await post('/internal/users/change_password', u.token, { current_password: password, new_password: 'another-password' })).status).toBe(200);
        const items = await inbox(u.token, u.org_id, 'user.password.changed');
        expect(items).toHaveLength(1);
        expect(items[0].title).toBe('Your password was changed');
    });

    it('orgs seeded before get the new default rules once at boot; a removed editable default stays removed', async () => {
        const org = await Org.create({ slug: uniq('seedv'), display_name: 'Seed v', activated_at: new Date() } as never);
        await OrgSeedService.seed_org(org.id, { account: false });
        // As seeded by the first version: no in-app copies yet, no version recorded.
        const email_channel = (await NotificationChannel.findOne({ where: { org_id: org.id, system_key: 'org.email' }, raw: true }))!;
        const in_app = (await NotificationChannel.findOne({ where: { org_id: org.id, system_key: 'org.in_app' }, raw: true }))!;
        await NotificationRule.destroy({ where: { org_id: org.id, channel_id: in_app.id, system_key: { [Op.in]: ['invite.sent.invitee', 'invite.reminder.invitee'] } } });
        await Org.update({ notifications_seed_version: null } as never, { where: { id: org.id } });
        // The owners removed an editable default of the first version.
        await NotificationRule.destroy({ where: { org_id: org.id, channel_id: in_app.id, system_key: 'invite.declined.notify', event: 'invite.org.declined' } });

        await OrgSeedService.upgrade_defaults();
        await OrgSeedService.upgrade_defaults();

        const added = await NotificationRule.findAll({ where: { org_id: org.id, channel_id: in_app.id, system_key: 'invite.sent.invitee' }, raw: true });
        expect(added.map((r) => r.event).sort()).toEqual(['invite.org.sent', 'invite.owner.sent', 'invite.realm.sent']);
        expect(added.every((r) => !r.locked && JSON.stringify(r.recipients) === '["invitee"]')).toBe(true);
        expect(await NotificationRule.count({ where: { org_id: org.id, channel_id: in_app.id, system_key: 'invite.reminder.invitee' } })).toBe(3);
        expect(await NotificationRule.count({ where: { org_id: org.id, channel_id: in_app.id, system_key: 'invite.declined.notify', event: 'invite.org.declined' } })).toBe(0);
        expect(await NotificationRule.count({ where: { org_id: org.id, channel_id: email_channel.id, system_key: 'invite.sent.invitee' } })).toBe(3);
        expect((await Org.findByPk(org.id, { raw: true }))!.notifications_seed_version).toBe(DEFAULTS_VERSION);

        const channels = (await NotificationChannel.findAll({ where: { org_id: org.id }, attributes: ['id'], raw: true })).map((c) => c.id);
        await NotificationRule.destroy({ where: { org_id: org.id } });
        await ChannelDestination.destroy({ where: { channel_id: { [Op.in]: channels } } });
        await NotificationChannel.destroy({ where: { org_id: org.id } });
        await Org.destroy({ where: { id: org.id } });
    });

    it('new orgs get in-app copies of every default email rule except the set-password email', async () => {
        const u = await s.signup('defaults');
        const in_app = (await NotificationChannel.findOne({ where: { org_id: u.org_id, system_key: 'org.in_app' }, raw: true }))!;
        const keys = (await NotificationRule.findAll({ where: { org_id: u.org_id, channel_id: in_app.id }, raw: true })).map((r) => r.system_key);
        expect(keys).toEqual(expect.arrayContaining(['invite.sent.invitee', 'invite.reminder.invitee', 'user.password_reset.user', 'user.password_changed.user']));
        expect(keys).not.toContain('user.setup.user');
        expect((await Org.findByPk(u.org_id, { raw: true }))!.notifications_seed_version).toBe(DEFAULTS_VERSION);
    });

    it('boot gives older org-event inbox rows the org named in their event, and leaves rows it cannot place', async () => {
        const acme = (await Org.findByPk(s.acme, { raw: true }))!;
        const placed = randomUUID();
        const unplaced = randomUUID();
        const base = { event: 'invite.org.accepted', realm_id: null, org_id: null, user_id: s.user.olivia, created_at: Date.now() };
        await InAppNotification.create({ ...base, id: placed, payload_json: JSON.stringify({ data: { org: { slug: acme.slug, display_name: acme.display_name } } }) } as never);
        await InAppNotification.create({ ...base, id: unplaced, payload_json: 'not json' } as never);

        await migrate_identity_lifecycle(get_sequelize());
        expect((await InAppNotification.findByPk(placed, { raw: true }))!.org_id).toBe(s.acme);
        expect((await InAppNotification.findByPk(unplaced, { raw: true }))!.org_id).toBeNull();
        await InAppNotification.destroy({ where: { id: { [Op.in]: [placed, unplaced] } } });
    });
});
