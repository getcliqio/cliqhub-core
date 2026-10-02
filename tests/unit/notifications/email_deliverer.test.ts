/**
 * EmailDeliverer: renders, sends and records one `email_deliveries` row per
 * org-event email; reports failures instead of throwing; never logs links,
 * bodies or full addresses. Also the channel-addressed `deliver` path.
 * Models and the logger are mocked; the sender is a fake.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const logged_lines = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../src/lib/log.js', () => {
    const rec = (level: string) => (...args: unknown[]) => { logged_lines.push([level, ...args]); };
    return { get_logger: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), fatal: rec('fatal') }) };
});
vi.mock('../../../src/models/index.js', () => ({
    Org: { findByPk: vi.fn() },
    User: { findByPk: vi.fn() },
    NotificationChannel: { findByPk: vi.fn() },
}));
vi.mock('../../../src/models/email_delivery.model.js', () => ({ EmailDelivery: { create: vi.fn() } }));

import { NotificationChannel, Org, User } from '../../../src/models/index.js';
import { EmailDelivery } from '../../../src/models/email_delivery.model.js';
import { EmailDeliverer, type EmailMessageInput } from '../../../src/notifications/deliverers/email_deliverer.js';
import { EmailSendError, type EmailMessage, type EmailSender } from '../../../src/lib/email/email_sender.js';
import { NoopEmailSender } from '../../../src/lib/email/noop_email_sender.js';
import { use_test_link_env, TEST_PUBLIC_APP_URL } from '../../helpers/link_env.js';
import type { InviteEventData } from '../../../src/notifications/org_events.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const INVITE = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ACCEPT = `${TEST_PUBLIC_APP_URL}/invite/SECRET-TOKEN`;

const data: InviteEventData = {
    invite_id: INVITE, kind: 'owner', role: 'owner', invitee_email: 'priya@measureone.com',
    inviter: { id: ACTOR, display_name: 'Sapan Shah' }, org: { slug: 'measureone', display_name: 'MeasureOne' }, realm: null,
    expires_at: '2026-10-16T09:30:00.000Z', send_count: 1,
};

function input(over: Partial<EmailMessageInput> = {}): EmailMessageInput {
    return {
        event: 'invite.owner.sent', event_id: 'evt-1', org_id: ORG, realm_id: null, channel_id: 'ch-email',
        occurred_at: '2026-10-02T10:20:00.000Z', actor: { user_id: ACTOR }, data, links: { accept_url: ACCEPT },
        to: { email: 'priya@measureone.com', user_id: null, display_name: 'Priya', selector: 'invitee' },
        subject: { type: 'invite', id: INVITE }, destination: { provider: 'brevo' },
        ...over,
    };
}

class FakeSender implements EmailSender {
    readonly configured = true;
    readonly name = 'fake';
    readonly sent: EmailMessage[] = [];
    constructor(private readonly _outcome: () => Promise<{ message_id: string | null }>) {}
    async send(message: EmailMessage) {
        this.sent.push(message);
        return this._outcome();
    }
}

describe('EmailDeliverer.deliver_message', () => {
    let restore: () => void;
    beforeEach(() => {
        restore = use_test_link_env();
        logged_lines.length = 0;
        vi.mocked(Org.findByPk).mockResolvedValue({ id: ORG, display_name: 'MeasureOne', status: 'waiting_for_owner' } as never);
        vi.mocked(User.findByPk).mockResolvedValue({ id: ACTOR, display_name: 'Sapan Shah', username: 'sapan' } as never);
        vi.mocked(NotificationChannel.findByPk).mockResolvedValue({ id: 'ch-email', name: 'Email' } as never);
        vi.mocked(EmailDelivery.create).mockResolvedValue({} as never);
    });
    afterEach(() => { restore(); vi.clearAllMocks(); });

    it('sends the rendered template to the recipient and records one ok row with the message id', async () => {
        const sender = new FakeSender(async () => ({ message_id: '<m1@smtp-relay.brevo.com>' }));
        const d = new EmailDeliverer();
        d.use_sender(sender);

        const result = await d.deliver_message(input());

        expect(result).toEqual({ sent: true, provider_message_id: '<m1@smtp-relay.brevo.com>', error: null });
        expect(sender.sent).toHaveLength(1);
        const msg = sender.sent[0];
        expect(msg.to).toEqual([{ email: 'priya@measureone.com', name: 'Priya' }]);
        expect(msg.subject).toBe('Sapan Shah invited you to own MeasureOne on CliqHub');
        expect(msg.html).toContain('MeasureOne is waiting for you');
        expect(msg.html).toContain(ACCEPT);
        expect(msg.text).toContain(ACCEPT);
        expect(msg.tags).toEqual(['invite.owner.sent']);
        expect(vi.mocked(EmailDelivery.create)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(EmailDelivery.create).mock.calls[0][0]).toEqual(expect.objectContaining({
            subject_type: 'invite', subject_id: INVITE, event: 'invite.owner.sent', event_id: 'evt-1', org_id: ORG,
            channel_id: 'ch-email', to: 'priya@measureone.com', ok: true, provider_message_id: '<m1@smtp-relay.brevo.com>', error: null,
        }));
    });

    it('owner invite to an active org uses the join template', async () => {
        vi.mocked(Org.findByPk).mockResolvedValue({ id: ORG, display_name: 'MeasureOne', status: 'active' } as never);
        const sender = new FakeSender(async () => ({ message_id: 'm' }));
        const d = new EmailDeliverer();
        d.use_sender(sender);
        await d.deliver_message(input());
        expect(sender.sent[0].subject).toBe('Sapan Shah invited you to join MeasureOne on CliqHub');
    });

    it('a provider failure is reported and recorded, never thrown', async () => {
        const d = new EmailDeliverer();
        d.use_sender(new FakeSender(async () => { throw new EmailSendError('rejected', 'Brevo refused the email (400 invalid_parameter)', 400, 'invalid_parameter'); }));
        const result = await d.deliver_message(input());
        expect(result).toEqual({ sent: false, provider_message_id: null, error: 'rejected: Brevo refused the email (400 invalid_parameter)' });
        expect(vi.mocked(EmailDelivery.create).mock.calls[0][0]).toEqual(expect.objectContaining({ ok: false, provider_message_id: null, error: 'rejected: Brevo refused the email (400 invalid_parameter)' }));
    });

    it('the no-op sender records a not-sent row', async () => {
        const d = new EmailDeliverer();
        d.use_sender(new NoopEmailSender());
        expect(await d.deliver_message(input())).toEqual({ sent: false, provider_message_id: null, error: 'email sending is not configured' });
        expect(vi.mocked(EmailDelivery.create).mock.calls[0][0]).toEqual(expect.objectContaining({ ok: false, error: 'email sending is not configured' }));
    });

    it('a rendering failure (PUBLIC_APP_URL missing) is reported and recorded without sending', async () => {
        delete process.env.PUBLIC_APP_URL;
        const sender = new FakeSender(async () => ({ message_id: 'm' }));
        const d = new EmailDeliverer();
        d.use_sender(sender);
        const result = await d.deliver_message(input());
        expect(result.sent).toBe(false);
        expect(result.error).toContain('PUBLIC_APP_URL');
        expect(sender.sent).toHaveLength(0);
        expect(vi.mocked(EmailDelivery.create).mock.calls[0][0]).toEqual(expect.objectContaining({ ok: false }));
    });

    it('a failed lookup is reported, and a failed row insert still returns the send outcome', async () => {
        vi.mocked(Org.findByPk).mockRejectedValueOnce(new Error('db down'));
        const d = new EmailDeliverer();
        d.use_sender(new FakeSender(async () => ({ message_id: 'm' })));
        expect(await d.deliver_message(input())).toMatchObject({ sent: false, error: 'db down' });

        vi.mocked(EmailDelivery.create).mockRejectedValueOnce(new Error('insert failed'));
        expect(await d.deliver_message(input())).toEqual({ sent: true, provider_message_id: 'm', error: null });
        expect(JSON.stringify(logged_lines)).toContain('email_delivery_record_failed');
    });

    it('records password and account subjects as given', async () => {
        const d = new EmailDeliverer();
        d.use_sender(new FakeSender(async () => ({ message_id: 'm' })));
        const user = { id: ACTOR, username: 'priya', email: 'priya@measureone.com', display_name: 'Priya' };
        await d.deliver_message(input({
            event: 'user.password.changed', data: { user, sessions_revoked: 1 }, links: {}, subject: { type: 'user', id: ACTOR },
            to: { email: 'priya@measureone.com', user_id: ACTOR, display_name: null, selector: 'user' },
        }));
        expect(vi.mocked(EmailDelivery.create).mock.calls[0][0]).toEqual(expect.objectContaining({ subject_type: 'user', subject_id: ACTOR, event: 'user.password.changed' }));
    });

    it('never logs the link, the body or the full address', async () => {
        const d = new EmailDeliverer();
        d.use_sender(new FakeSender(async () => ({ message_id: 'm' })));
        await d.deliver_message(input());
        d.use_sender(new FakeSender(async () => { throw new EmailSendError('timeout', 'Brevo did not answer within 10000 ms'); }));
        await d.deliver_message(input());
        const logged = JSON.stringify(logged_lines);
        expect(logged).toContain('org_email_sent');
        expect(logged).toContain('org_email_not_sent');
        expect(logged).toContain('p***@measureone.com');
        expect(logged).not.toContain('SECRET-TOKEN');
        expect(logged).not.toContain('priya@measureone.com');
        expect(logged).not.toContain('waiting for you');
    });
});

describe('EmailDeliverer.deliver (channel addresses)', () => {
    let restore: () => void;
    beforeEach(() => { restore = use_test_link_env(); logged_lines.length = 0; });
    afterEach(() => { restore(); vi.clearAllMocks(); });

    it('sends to the destination addresses and records no delivery row', async () => {
        const sender = new FakeSender(async () => ({ message_id: 'm' }));
        const d = new EmailDeliverer();
        d.use_sender(sender);
        await d.deliver({ to: 'a@x.test, b@x.test', cc: 'c@x.test', bcc: '' }, { event: 'run.failed', title: 'Run failed', message: 'quiet-heron failed' });
        expect(sender.sent[0]).toMatchObject({ to: [{ email: 'a@x.test' }, { email: 'b@x.test' }], cc: [{ email: 'c@x.test' }], bcc: [], subject: '[CliqHub] Run failed' });
        expect(EmailDelivery.create).not.toHaveBeenCalled();
        expect(JSON.stringify(logged_lines)).not.toContain('a@x.test');
    });

    it('throws on a send failure so the channel counts as failed', async () => {
        const d = new EmailDeliverer();
        d.use_sender(new FakeSender(async () => { throw new EmailSendError('network', 'could not reach Brevo'); }));
        await expect(d.deliver({ to: 'a@x.test' }, { event: 'run.failed' })).rejects.toThrow('email delivery failed: network');
    });

    it('without a transport or an address it sends nothing', async () => {
        const d = new EmailDeliverer();
        await expect(d.deliver({ to: 'a@x.test' }, { event: 'run.failed' })).resolves.toBeUndefined();
        const sender = new FakeSender(async () => ({ message_id: 'm' }));
        d.use_sender(sender);
        await d.deliver({}, { event: 'run.failed' });
        expect(sender.sent).toHaveLength(0);
    });
});
