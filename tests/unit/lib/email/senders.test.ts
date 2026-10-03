/**
 * Email senders: Brevo request shape, headers, timeout and error mapping
 * (fetch mocked, no network), what Brevo logs, the no-op sender and the
 * sender factory.
 */

import { describe, it, expect, vi } from 'vitest';

// Capture every log line the email code writes.
const logged_lines = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../../src/lib/log.js', () => {
    const rec = (level: string) => (...args: unknown[]) => { logged_lines.push([level, ...args]); };
    return { get_logger: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), fatal: rec('fatal') }) };
});

import { BrevoEmailSender, BREVO_SEND_URL } from '../../../../src/lib/email/brevo_email_sender.js';
import { NoopEmailSender } from '../../../../src/lib/email/noop_email_sender.js';
import { EmailSendError, mask_email } from '../../../../src/lib/email/email_sender.js';
import { create_email_sender } from '../../../../src/lib/email/index.js';
import { SmtpEmailSender, smtp_failure_kind } from '../../../../src/lib/email/smtp_email_sender.js';
import { with_data_uris } from '../../../../src/lib/email/brevo_email_sender.js';
import { email_images_in } from '../../../../src/lib/email/layout.js';

const KEY = 'test-brevo-key-not-real';
const msg = { to: [{ email: 'a@x.test', name: 'A' }], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', tags: ['invite.org.sent'] };

function json_response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('BrevoEmailSender', () => {
    it('posts the transactional email with the api-key header and returns the message id', async () => {
        const fetch_impl = vi.fn().mockResolvedValue(json_response(201, { messageId: '<abc@smtp-relay.brevo.com>' }));
        const sender = new BrevoEmailSender({ api_key: KEY, from: { email: 'no-reply@x.test', name: 'CliqHub' }, fetch_impl });

        const res = await sender.send({ ...msg, cc: [{ email: 'c@x.test' }], bcc: [{ email: 'b@x.test' }] });

        expect(res).toEqual({ message_id: '<abc@smtp-relay.brevo.com>' });
        const [url, init] = fetch_impl.mock.calls[0];
        expect(url).toBe('https://api.brevo.com/v3/smtp/email');
        expect(url).toBe(BREVO_SEND_URL);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'api-key': KEY, 'content-type': 'application/json', accept: 'application/json' });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(init.body)).toEqual({
            sender: { email: 'no-reply@x.test', name: 'CliqHub' },
            to: [{ email: 'a@x.test', name: 'A' }],
            cc: [{ email: 'c@x.test' }],
            bcc: [{ email: 'b@x.test' }],
            subject: 'Hi',
            htmlContent: '<p>Hi</p>',
            textContent: 'Hi',
            tags: ['invite.org.sent'],
        });
        expect(sender.configured).toBe(true);
        expect(sender.name).toBe('brevo');
    });

    it('omits empty cc, bcc and tags; a missing messageId is null', async () => {
        const fetch_impl = vi.fn().mockResolvedValue(json_response(201, {}));
        const res = await new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl })
            .send({ to: [{ email: 'a@x.test' }], subject: 's', html: 'h', text: 't' });
        expect(res).toEqual({ message_id: null });
        expect(JSON.parse(fetch_impl.mock.calls[0][1].body)).toEqual({
            sender: { email: 'f@x.test' }, to: [{ email: 'a@x.test' }], subject: 's', htmlContent: 'h', textContent: 't',
        });
    });

    it.each([
        [400, 'rejected'], [401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [500, 'provider_error'], [502, 'provider_error'],
    ] as const)('maps HTTP %i to EmailSendError %s with Brevo’s code, without the key', async (status, kind) => {
        const fetch_impl = vi.fn().mockResolvedValue(json_response(status, { code: 'invalid_parameter', message: 'sender is not valid' }));
        const err = await new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl }).send(msg).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EmailSendError);
        expect(err).toMatchObject({ kind, status, provider_code: 'invalid_parameter' });
        expect((err as Error).message).toContain(String(status));
        expect((err as Error).message).not.toContain(KEY);
    });

    it('the error keeps only Brevo’s status and code, never its message (which can quote the recipient)', async () => {
        const fetch_impl = vi.fn().mockResolvedValue(json_response(400, { code: 'invalid_parameter', message: 'email is not valid: a@x.test' }));
        const err = await new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl }).send(msg).catch((e: unknown) => e);
        expect((err as Error).message).toBe('Brevo refused the email (400 invalid_parameter)');
        expect((err as Error).message).not.toContain('a@x.test');
        const network = await new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl: vi.fn().mockRejectedValue(new TypeError('connect to a@x.test failed')) })
            .send(msg).catch((e: unknown) => e);
        expect((network as Error).message).toBe('could not reach Brevo');
    });

    it('an error answer without a JSON body still maps by status', async () => {
        const fetch_impl = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
        await expect(new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl }).send(msg))
            .rejects.toMatchObject({ kind: 'provider_error', status: 502, provider_code: undefined });
    });

    it('a network failure is EmailSendError network', async () => {
        const fetch_impl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        await expect(new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl }).send(msg))
            .rejects.toMatchObject({ name: 'EmailSendError', kind: 'network' });
    });

    it('aborts after the timeout (EmailSendError timeout)', async () => {
        const fetch_impl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
            init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const sender = new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl: fetch_impl as unknown as typeof fetch, timeout_ms: 20 });
        await expect(sender.send(msg)).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('defaults to a 10 s timeout', async () => {
        vi.useFakeTimers();
        try {
            const fetch_impl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
                init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            }));
            const pending = new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl: fetch_impl as unknown as typeof fetch })
                .send(msg).catch((e: unknown) => e);
            await vi.advanceTimersByTimeAsync(9_999);
            expect(fetch_impl.mock.calls[0][1].signal!.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await pending).toMatchObject({ kind: 'timeout', message: 'Brevo did not answer within 10000 ms' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses a message with no recipients without calling Brevo', async () => {
        const fetch_impl = vi.fn();
        await expect(new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl }).send({ ...msg, to: [] }))
            .rejects.toMatchObject({ kind: 'rejected' });
        expect(fetch_impl).not.toHaveBeenCalled();
    });

    it('never logs the key, the recipient addresses or the bodies', async () => {
        logged_lines.length = 0;
        const fetch_impl = vi.fn()
            .mockResolvedValueOnce(json_response(201, { messageId: 'm' }))
            .mockResolvedValueOnce(json_response(400, { code: 'bad', message: 'nope a@x.test' }))
            .mockRejectedValueOnce(new TypeError('fetch failed'));
        const sender = new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl });
        const secret = { ...msg, html: '<p>SECRET-BODY https://app/invite/tok</p>', text: 'SECRET-BODY' };
        await sender.send(secret);
        await sender.send(secret).catch(() => undefined);
        await sender.send(secret).catch(() => undefined);
        const logged = JSON.stringify(logged_lines);
        expect(logged).toContain('email_sent');
        expect(logged).toContain('email_send_failed');
        expect(logged).not.toContain(KEY);
        expect(logged).not.toContain('SECRET-BODY');
        expect(logged).not.toContain('/invite/');
        expect(logged).not.toContain('a@x.test');
    });
});

describe('NoopEmailSender', () => {
    it('reports configured: false and refuses with not_configured', async () => {
        const s = new NoopEmailSender();
        expect(s.configured).toBe(false);
        expect(s.name).toBe('noop');
        await expect(s.send(msg)).rejects.toMatchObject({ name: 'EmailSendError', kind: 'not_configured', message: 'email sending is not configured' });
    });
});

describe('create_email_sender', () => {
    it('no key (or a blank one) → the no-op sender', () => {
        expect(create_email_sender({})).toBeInstanceOf(NoopEmailSender);
        expect(create_email_sender({ brevo_api_key: '  ', email_from_address: 'f@x.test' })).toBeInstanceOf(NoopEmailSender);
    });

    it('a key and a sender address → Brevo, named CliqHub unless EMAIL_FROM_NAME is set', async () => {
        const sender = create_email_sender({ brevo_api_key: KEY, email_from_address: 'no-reply@x.test' });
        expect(sender).toBeInstanceOf(BrevoEmailSender);
        expect(sender.configured).toBe(true);
        const fetch_spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json_response(201, { messageId: 'm' }));
        try {
            await sender.send(msg);
            await create_email_sender({ brevo_api_key: KEY, email_from_address: 'no-reply@x.test', email_from_name: 'Hub' }).send(msg);
            expect(JSON.parse(String(fetch_spy.mock.calls[0][1]!.body)).sender).toEqual({ email: 'no-reply@x.test', name: 'CliqHub' });
            expect(JSON.parse(String(fetch_spy.mock.calls[1][1]!.body)).sender).toEqual({ email: 'no-reply@x.test', name: 'Hub' });
        } finally {
            fetch_spy.mockRestore();
        }
    });

    it('a key without a valid sender address is an error naming the variable, not the key', () => {
        for (const email_from_address of [undefined, '', 'not-an-address']) {
            let err: Error | null = null;
            try { create_email_sender({ brevo_api_key: KEY, email_from_address }); } catch (e) { err = e as Error; }
            expect(err?.message).toContain('EMAIL_FROM_ADDRESS');
            expect(err?.message).not.toContain(KEY);
        }
    });
});

describe('embedded images per transport', () => {
    const logo = email_images_in('<img src="cid:logo">');
    const with_logo = { ...msg, html: '<img src="cid:logo"><p>Hi</p>', images: logo };

    it('SMTP puts the logo inside the message as an inline part and tags it for Brevo', async () => {
        const sendMail = vi.fn().mockResolvedValue({ messageId: '<m1@relay>' });
        const sender = new SmtpEmailSender({ host: 'h', port: 587, user: 'u', pass: 'p', from: { email: 'no-reply@x.test', name: 'CliqHub' }, transport: { sendMail } as never });
        expect(await sender.send(with_logo)).toEqual({ message_id: '<m1@relay>' });
        const mail = sendMail.mock.calls[0][0];
        expect(mail).toMatchObject({ from: { name: 'CliqHub', address: 'no-reply@x.test' }, to: [{ name: 'A', address: 'a@x.test' }], subject: 'Hi', html: with_logo.html, headers: { 'X-Mailin-Tag': 'invite.org.sent' } });
        expect(mail.attachments).toEqual([expect.objectContaining({ cid: 'logo', filename: 'logo.png', contentType: 'image/png', contentDisposition: 'inline' })]);
        expect(Buffer.isBuffer(mail.attachments[0].content)).toBe(true);
    });

    it('SMTP failures map to the send error kinds', async () => {
        expect(smtp_failure_kind({ code: 'EAUTH', responseCode: 535 })).toBe('unauthorized');
        expect(smtp_failure_kind({ code: 'ETIMEDOUT' })).toBe('timeout');
        expect(smtp_failure_kind({ code: 'ECONNECTION' })).toBe('network');
        expect(smtp_failure_kind({ responseCode: 421 })).toBe('rate_limited');
        expect(smtp_failure_kind({ responseCode: 550 })).toBe('rejected');
        const sender = new SmtpEmailSender({ host: 'h', port: 587, user: 'u', pass: 'secret-pass', from: { email: 'f@x.test' }, transport: { sendMail: vi.fn().mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 })) } as never });
        await expect(sender.send(msg)).rejects.toMatchObject({ kind: 'unauthorized', status: 535 });
    });

    it('the Brevo API, which cannot attach inline images, gets the logo as a base64 data URI', async () => {
        expect(with_data_uris(with_logo.html, logo)).toBe(`<img src="data:image/png;base64,${logo[0].base64}"><p>Hi</p>`);
        const fetch_impl = vi.fn().mockResolvedValue(json_response(201, { messageId: 'm' }));
        await new BrevoEmailSender({ api_key: KEY, from: { email: 'f@x.test' }, fetch_impl }).send(with_logo);
        expect(JSON.parse(String(fetch_impl.mock.calls[0][1].body)).htmlContent).toContain('src="data:image/png;base64,');
    });
});

describe('create_email_sender: SMTP', () => {
    const from = { email_from_address: 'no-reply@x.test' };
    it('SMTP_USER → SMTP; the password from SMTP_PASS or a Brevo SMTP key left in BREVO_API_KEY', () => {
        expect(create_email_sender({ ...from, smtp_user: 'me@smtp-brevo.com', smtp_pass: 'xsmtpsib-x' })).toBeInstanceOf(SmtpEmailSender);
        expect(create_email_sender({ ...from, smtp_user: 'me@smtp-brevo.com', brevo_api_key: 'xsmtpsib-x' })).toBeInstanceOf(SmtpEmailSender);
        expect(create_email_sender({ ...from, smtp_user: 'me@smtp-brevo.com', smtp_pass: 'p', brevo_api_key: KEY }).name).toBe('smtp');
    });
    it('a Brevo API key given as SMTP_PASS sends through the API instead of failing at SMTP login', () => {
        expect(create_email_sender({ ...from, smtp_user: 'me@smtp-brevo.com', smtp_pass: 'xkeysib-abc' })).toBeInstanceOf(BrevoEmailSender);
    });

    it('half set up is an error naming what to set, never the key', () => {
        expect(() => create_email_sender({ ...from, smtp_user: 'me@smtp-brevo.com' })).toThrow('SMTP_PASS');
        let err: Error | null = null;
        try { create_email_sender({ ...from, brevo_api_key: 'xsmtpsib-secret' }); } catch (e) { err = e as Error; }
        expect(err?.message).toContain('SMTP_USER');
        expect(err?.message).not.toContain('xsmtpsib-secret');
    });
});

describe('mask_email', () => {
    it('keeps the first character and the domain', () => {
        expect(mask_email('priya@measureone.com')).toBe('p***@measureone.com');
        expect(mask_email('nope')).toBe('***');
    });
});
