/**
 * Email channel on live Postgres: org events raised through
 * OrgEventService reach the EmailDeliverer, which writes one
 * `email_deliveries` row per send and reports `email_sent` back, with the
 * no-op sender (no BREVO_API_KEY) and with a stubbed transport.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Op } from 'sequelize';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { TEST_PUBLIC_APP_URL, use_test_link_env } from '../helpers/link_env.js';
import { AccountInvite, EmailDelivery, HubEvent, NotificationChannel } from '../../src/models/index.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { OrgEventService } from '../../src/services/org_event.service.js';
import { resolve_delivery_links } from '../../src/notifications/delivery_links.js';
import { DELIVERER_BY_PROVIDER } from '../../src/notifications/deliverers/index.js';
import type { EmailDeliverer } from '../../src/notifications/deliverers/email_deliverer.js';
import { ORG_EMAIL_CHANNEL_KEY } from '../../src/services/org_seed.service.js';
import { issue_token } from '../../src/lib/secure_token.js';
import type { EmailMessage, EmailSender } from '../../src/lib/email/email_sender.js';
import type { Container } from '../../src/container.js';
import type { InviteEventData } from '../../src/notifications/org_events.js';

const has_postgres = await postgres_reachable();

/** A transport that accepts every message and keeps it for inspection. */
class StubSender implements EmailSender {
    readonly configured = true;
    readonly name = 'stub';
    readonly sent: EmailMessage[] = [];
    async send(message: EmailMessage) {
        this.sent.push(message);
        return { message_id: `<stub-${this.sent.length}@test>` };
    }
}

describe.skipIf(!has_postgres)('Email channel delivery', () => {
    let s: Seed;
    let container: Container;
    let restore_env: () => void;
    let email_channel_id: string;
    const invite_ids: string[] = [];
    const email_deliverer = DELIVERER_BY_PROVIDER.email as EmailDeliverer;

    beforeAll(async () => {
        restore_env = use_test_link_env();
        const live = await open_live_hub_app();
        container = live.container;
        s = await seed_authz(live.app);
        const channel = await NotificationChannel.findOne({ where: { org_id: s.acme, system_key: ORG_EMAIL_CHANNEL_KEY }, raw: true });
        email_channel_id = channel!.id;
    }, 300_000);

    afterEach(() => { email_deliverer.use_sender(container.email_sender); });

    afterAll(async () => {
        await EmailDelivery.destroy({ where: { subject_id: { [Op.in]: invite_ids } } });
        await AccountInvite.destroy({ where: { id: { [Op.in]: invite_ids } } });
        await s?.cleanup();
        await close_live_hub_app();
        restore_env();
    }, 300_000);

    async function pending_invite(email: string) {
        const issued = issue_token();
        const invite = await AccountInvite.create({
            org_id: s.acme, email, invited_by: s.user.adam, token_hash: issued.token_hash, token_enc: issued.token_enc,
            role: 'member', status: 'pending', expires_at: new Date(Date.now() + 86_400_000),
        } as never);
        invite_ids.push(invite.id);
        return { invite, token: issued.token };
    }
    const data_for = (invite_id: string, email: string): InviteEventData => ({
        invite_id, kind: 'org', role: 'member', invitee_email: email,
        inviter: { id: s.user.adam, display_name: 'Adam' }, org: { slug: 'acme', display_name: 'Acme' }, realm: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(), send_count: 1,
    });
    const rows_for = (invite_id: string) => EmailDelivery.findAll({ where: { subject_type: 'invite', subject_id: invite_id }, order: [['sent_at', 'ASC']], raw: true });

    it('without BREVO_API_KEY: the container uses the no-op sender, a not-sent row is written and email_sent is false', async () => {
        expect(container.email_sender.configured).toBe(false);
        const email = `noop${s.stamp}@authz.test`;
        const { invite, token } = await pending_invite(email);

        const pending = await get_sequelize().transaction(async (t) => OrgEventService.raise_after_commit(t, {
            event: 'invite.org.sent', org_id: s.acme, actor: { user_id: s.user.adam },
            data: data_for(invite.id, email), link: { kind: 'invite', table: 'account_invites', invite_id: invite.id },
        }));
        const result = await pending.result;

        expect(result).toMatchObject({ status: 'failed', email_sent: false });
        const rows = await rows_for(invite.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            event: 'invite.org.sent', event_id: result.event_id, org_id: s.acme, channel_id: email_channel_id,
            to: email, ok: false, provider_message_id: null, error: 'email sending is not configured',
        });
        expect(JSON.stringify(rows[0])).not.toContain(token);
        // The route's fallback link is still available.
        expect((await resolve_delivery_links({ kind: 'invite', table: 'account_invites', invite_id: invite.id })).accept_url)
            .toBe(`${TEST_PUBLIC_APP_URL}/invite/${token}`);
    });

    it('with a transport: the invitee gets the accept link, the row is ok with the message id, email_sent is true', async () => {
        const stub = new StubSender();
        email_deliverer.use_sender(stub);
        const email = `stub${s.stamp}@authz.test`;
        const { invite, token } = await pending_invite(email);

        const result = await OrgEventService.raise({
            event: 'invite.org.reminder', org_id: s.acme, actor: { system: 'sweep' },
            data: data_for(invite.id, email), link: { kind: 'invite', table: 'account_invites', invite_id: invite.id },
        });

        expect(result).toMatchObject({ status: 'dispatched', email_sent: true });
        expect(stub.sent).toHaveLength(1);
        expect(stub.sent[0].to).toEqual([{ email }]);
        expect(stub.sent[0].subject).toBe('Reminder: Adam invited you to join Acme on CliqHub');
        expect(stub.sent[0].html).toContain(`${TEST_PUBLIC_APP_URL}/invite/${token}`);
        // No images to load: the logo is drawn in HTML.
        expect(stub.sent[0].html).not.toContain('<img');
        const rows = await rows_for(invite.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ event: 'invite.org.reminder', ok: true, provider_message_id: '<stub-1@test>', error: null, to: email });
        const event = (await HubEvent.findByPk(result.event_id!, { raw: true }))!;
        expect(event.payload_json).not.toContain(token);
    });

    it('accepted: owners and inviter each get a notify email without the link, one row each', async () => {
        const stub = new StubSender();
        email_deliverer.use_sender(stub);
        const email = `acc${s.stamp}@authz.test`;
        const { invite, token } = await pending_invite(email);

        const result = await OrgEventService.raise({
            event: 'invite.org.accepted', org_id: s.acme, actor: { user_id: s.user.nora }, data: data_for(invite.id, email),
        });

        expect(result.email_sent).toBe(true);
        expect(stub.sent.length).toBeGreaterThanOrEqual(2);
        expect(stub.sent.every((m) => m.subject === `[CliqHub] Invite accepted: ${email} · Acme`)).toBe(true);
        expect(stub.sent.every((m) => !m.html.includes(token) && !m.html.includes('/invite/'))).toBe(true);
        const rows = await rows_for(invite.id);
        expect(rows).toHaveLength(stub.sent.length);
        expect(rows.every((r) => r.ok && r.event === 'invite.org.accepted')).toBe(true);
    });
});
