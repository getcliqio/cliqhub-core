/**
 * Email over SMTP (Brevo's relay `smtp-relay.brevo.com:587`, or any other).
 * Images the HTML refers to as `cid:<name>` travel inside the message as
 * inline parts, so every client (Gmail included) shows them without fetching
 * anything. Brevo tags go in the `X-Mailin-Tag` header.
 *
 * The password, the recipient addresses and the message bodies are never
 * logged: log lines carry the recipient count, tags and the failure class.
 */

import nodemailer, { type Transporter } from 'nodemailer';

import { get_logger } from '../log.js';
import { EmailSendError, type EmailAddress, type EmailMessage, type EmailSendErrorKind, type EmailSender, type SentEmail } from './email_sender.js';
import { EMAIL_SEND_TIMEOUT_MS } from '../../config/identity_lifecycle.js';

const log = get_logger('lib.email.smtp');

/** Settings for {@link SmtpEmailSender}. */
export interface SmtpEmailSenderOptions {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: EmailAddress;
    /** Give up after this many ms (default `EMAIL_SEND_TIMEOUT_MS`). */
    timeout_ms?: number;
    /** Injected for tests; defaults to a nodemailer SMTP transport. */
    transport?: Pick<Transporter, 'sendMail'>;
}

const fmt = (a: EmailAddress) => (a.name ? { name: a.name, address: a.email } : a.email);

/** nodemailer error → failure class. */
export function smtp_failure_kind(err: unknown): EmailSendErrorKind {
    const e = err as { code?: string; responseCode?: number };
    if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) return 'unauthorized';
    if (e.code === 'ETIMEDOUT') return 'timeout';
    if (e.code === 'ECONNECTION' || e.code === 'ESOCKET' || e.code === 'EDNS') return 'network';
    if (e.code === 'EENVELOPE') return 'rejected';
    if (e.responseCode === 421 || e.responseCode === 450 || e.responseCode === 451 || e.responseCode === 452) return 'rate_limited';
    if (typeof e.responseCode === 'number' && e.responseCode >= 500) return 'rejected';
    return 'provider_error';
}

/** {@link EmailSender} over SMTP. */
export class SmtpEmailSender implements EmailSender {
    readonly configured = true;
    readonly name = 'smtp';
    private readonly _transport: Pick<Transporter, 'sendMail'>;

    /** @param _opts - Server, login, sender address, timeout and an optional transport for tests. */
    constructor(private readonly _opts: SmtpEmailSenderOptions) {
        const timeout = _opts.timeout_ms ?? EMAIL_SEND_TIMEOUT_MS;
        this._transport = _opts.transport ?? nodemailer.createTransport({
            host: _opts.host, port: _opts.port, secure: _opts.port === 465,
            auth: { user: _opts.user, pass: _opts.pass },
            connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout,
        });
    }

    /**
     * Sends one message, with its images embedded.
     *
     * @returns The message id the server gave.
     * @throws EmailSendError `rejected`, `unauthorized`, `rate_limited`, `timeout`, `network` or `provider_error`.
     */
    async send(message: EmailMessage): Promise<SentEmail> {
        if (message.to.length === 0) throw new EmailSendError('rejected', 'no recipients');
        const ctx = { recipients: message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0), tags: message.tags ?? [] };
        try {
            const info = await this._transport.sendMail({
                from: fmt(this._opts.from),
                to: message.to.map(fmt),
                ...(message.cc?.length ? { cc: message.cc.map(fmt) } : {}),
                ...(message.bcc?.length ? { bcc: message.bcc.map(fmt) } : {}),
                subject: message.subject,
                html: message.html,
                text: message.text,
                attachments: (message.images ?? []).map((i) => ({
                    filename: i.filename, content: Buffer.from(i.base64, 'base64'), contentType: i.content_type, cid: i.cid, contentDisposition: 'inline' as const,
                })),
                ...(message.tags?.length ? { headers: { 'X-Mailin-Tag': message.tags.join(',') } } : {}),
            });
            log.info('email_sent', { ...ctx, provider: 'smtp' });
            return { message_id: typeof info.messageId === 'string' ? info.messageId : null };
        } catch (err) {
            const kind = smtp_failure_kind(err);
            const status = (err as { responseCode?: number }).responseCode;
            log.warn('email_send_failed', { ...ctx, provider: 'smtp', kind, ...(status ? { status } : {}) });
            throw new EmailSendError(kind, `the SMTP server refused or failed the email (${kind}${status ? ` ${status}` : ''})`, status);
        }
    }
}
