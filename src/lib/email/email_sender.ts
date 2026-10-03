/**
 * Outgoing email: the {@link EmailSender} interface every transport
 * implements, the message shape and the typed send error.
 *
 * Transports: SmtpEmailSender (any SMTP relay, e.g. Brevo's) when
 * `SMTP_USER` is set; BrevoEmailSender (Brevo transactional API) when only
 * `BREVO_API_KEY` is; otherwise NoopEmailSender, which sends nothing and
 * reports `configured: false` so callers return the link instead of
 * claiming an email went out.
 */

import type { EmailImage } from './layout.js';

/** One address, with an optional display name. */
export interface EmailAddress {
    email: string;
    name?: string;
}

/** A message to send. HTML and text bodies are both required (text is the fallback). */
export interface EmailMessage {
    to: EmailAddress[];
    cc?: EmailAddress[];
    bcc?: EmailAddress[];
    subject: string;
    html: string;
    text: string;
    /** Provider tags (Brevo `tags`), e.g. `['invite.org.sent']`. */
    tags?: string[];
    /** Images the HTML refers to as `cid:<cid>`; the transport puts them inside the message. */
    images?: EmailImage[];
}

/** What a successful send returns. */
export interface SentEmail {
    /** The provider's message id (null when the provider returned none). */
    message_id: string | null;
}

/** Why a send failed. */
export type EmailSendErrorKind = 'not_configured' | 'timeout' | 'network' | 'rejected' | 'unauthorized' | 'rate_limited' | 'provider_error';

/** A failed send. Carries the HTTP status when the provider answered; never the key or the message body. */
export class EmailSendError extends Error {
    /**
     * @param kind - Failure class.
     * @param message - Short description (no key, link or body).
     * @param status - Provider HTTP status, when it answered.
     * @param provider_code - Provider error code (Brevo `code`), when it sent one.
     */
    constructor(
        readonly kind: EmailSendErrorKind,
        message: string,
        readonly status?: number,
        readonly provider_code?: string,
    ) {
        super(message);
        this.name = 'EmailSendError';
    }
}

/** An email transport. */
export interface EmailSender {
    /** False when no transport is set up: nothing is sent and callers return links instead. */
    readonly configured: boolean;
    /** Transport name for logs (`smtp`, `brevo`, `noop`). */
    readonly name: string;
    /**
     * Sends one message.
     *
     * @throws EmailSendError when the transport fails or is not configured.
     */
    send(message: EmailMessage): Promise<SentEmail>;
}

/** `priya@measureone.com` → `p***@measureone.com`, for log lines. */
export function mask_email(email: string): string {
    const at = email.lastIndexOf('@');
    if (at <= 0) return '***';
    return `${email.charAt(0)}***${email.slice(at)}`;
}
