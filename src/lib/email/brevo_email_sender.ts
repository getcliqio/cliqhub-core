/**
 * Brevo transactional email: `POST https://api.brevo.com/v3/smtp/email` with
 * the `api-key` header. Body `{ sender, to, cc?, bcc?, subject, htmlContent,
 * textContent, tags? }`; a 201 answers `{ messageId }`.
 *
 * Brevo's API can't attach images inline (no Content-ID), so images the HTML
 * refers to as `cid:<name>` are written into it as base64 `data:` URIs. Gmail
 * doesn't show `data:` images; the SMTP transport embeds them properly.
 *
 * The key, the recipient addresses and the message bodies are never logged:
 * log lines carry the recipient count, tags, HTTP status and Brevo's error
 * code only.
 */

import { get_logger } from '../log.js';
import {
    EmailSendError,
    type EmailAddress,
    type EmailMessage,
    type EmailSendErrorKind,
    type EmailSender,
    type SentEmail,
} from './email_sender.js';
import type { EmailImage } from './layout.js';
import { EMAIL_SEND_TIMEOUT_MS } from '../../config/identity_lifecycle.js';

const log = get_logger('lib.email.brevo');

/** Brevo's transactional email endpoint. */
export const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';


/** Settings for {@link BrevoEmailSender}. */
export interface BrevoEmailSenderOptions {
    api_key: string;
    from: EmailAddress;
    /** Abort the request after this many ms (default `EMAIL_SEND_TIMEOUT_MS`). */
    timeout_ms?: number;
    /** Injected for tests; defaults to the global `fetch`. */
    fetch_impl?: typeof fetch;
}

/** Replaces each `cid:<name>` image reference with the image as a base64 `data:` URI. */
export function with_data_uris(html: string, images: EmailImage[]): string {
    return images.reduce((out, i) => out.split(`src="cid:${i.cid}"`).join(`src="data:${i.content_type};base64,${i.base64}"`), html);
}

const address = (a: EmailAddress) => (a.name ? { email: a.email, name: a.name } : { email: a.email });

function kind_for_status(status: number): EmailSendErrorKind {
    if (status === 400) return 'rejected';
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate_limited';
    return 'provider_error';
}

/** {@link EmailSender} over Brevo's transactional API. */
export class BrevoEmailSender implements EmailSender {
    readonly configured = true;
    readonly name = 'brevo';
    private readonly _timeout_ms: number;
    private readonly _fetch: typeof fetch;

    /** @param _opts - API key, sender address, timeout and an optional fetch for tests. */
    constructor(private readonly _opts: BrevoEmailSenderOptions) {
        this._timeout_ms = _opts.timeout_ms ?? EMAIL_SEND_TIMEOUT_MS;
        this._fetch = _opts.fetch_impl ?? ((...args) => fetch(...args));
    }

    /**
     * Sends one message through Brevo.
     *
     * @returns Brevo's message id.
     * @throws EmailSendError `rejected` (400 or no recipients), `unauthorized` (401/403),
     *   `rate_limited` (429), `provider_error` (other non-2xx), `timeout` or `network`.
     */
    async send(message: EmailMessage): Promise<SentEmail> {
        if (message.to.length === 0) throw new EmailSendError('rejected', 'no recipients');
        const body = {
            sender: address(this._opts.from),
            to: message.to.map(address),
            ...(message.cc?.length ? { cc: message.cc.map(address) } : {}),
            ...(message.bcc?.length ? { bcc: message.bcc.map(address) } : {}),
            subject: message.subject,
            htmlContent: with_data_uris(message.html, message.images ?? []),
            textContent: message.text,
            ...(message.tags?.length ? { tags: message.tags } : {}),
        };
        const ctx = { recipients: message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0), tags: message.tags ?? [] };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeout_ms);
        let res: Response;
        try {
            res = await this._fetch(BREVO_SEND_URL, {
                method: 'POST',
                headers: { 'api-key': this._opts.api_key, 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (err) {
            const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
            log.warn('email_send_failed', { ...ctx, provider: 'brevo', kind: aborted ? 'timeout' : 'network' });
            throw aborted
                ? new EmailSendError('timeout', `Brevo did not answer within ${this._timeout_ms} ms`)
                : new EmailSendError('network', 'could not reach Brevo');
        } finally {
            clearTimeout(timer);
        }

        if (res.ok) {
            const data = await res.json().catch(() => ({})) as { messageId?: unknown };
            log.info('email_sent', { ...ctx, provider: 'brevo', status: res.status });
            return { message_id: typeof data.messageId === 'string' ? data.messageId : null };
        }

        // Brevo errors are `{ code, message }`. The message can quote the
        // recipient, so only the status and code are kept (logs and the delivery row).
        const err = await res.json().catch(() => ({})) as { code?: unknown };
        const code = typeof err.code === 'string' ? err.code : undefined;
        const kind = kind_for_status(res.status);
        log.warn('email_send_failed', { ...ctx, provider: 'brevo', kind, status: res.status, provider_code: code });
        throw new EmailSendError(kind, `Brevo refused the email (${res.status}${code ? ` ${code}` : ''})`, res.status, code);
    }
}
