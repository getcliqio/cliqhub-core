/**
 * The sender used when no email transport is configured (`BREVO_API_KEY` unset).
 */

import { EmailSendError, type EmailMessage, type EmailSender, type SentEmail } from './email_sender.js';

/** Sends nothing; `configured` is false so callers return links instead. */
export class NoopEmailSender implements EmailSender {
    readonly configured = false;
    readonly name = 'noop';

    /**
     * Refuses every message.
     *
     * @throws EmailSendError `not_configured`, always.
     */
    async send(_message: EmailMessage): Promise<SentEmail> {
        throw new EmailSendError('not_configured', 'email sending is not configured');
    }
}
