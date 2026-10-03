/**
 * Builds the configured {@link EmailSender} from the environment:
 *
 *   SMTP_USER set   → SMTP (images embedded in the message; shows everywhere).
 *                     Password from SMTP_PASS, or a Brevo SMTP key (xsmtpsib-…)
 *                     left in BREVO_API_KEY. Server: SMTP_HOST:SMTP_PORT,
 *                     default Brevo's relay smtp-relay.brevo.com:587.
 *   BREVO_API_KEY   → Brevo's API (xkeysib-… key; images as data URIs).
 *   neither         → no-op: nothing is sent and callers return links.
 */

import { EMAIL_PATTERN, type EnvConfig } from '../../config/env.js';
import { BrevoEmailSender } from './brevo_email_sender.js';
import { NoopEmailSender } from './noop_email_sender.js';
import { SmtpEmailSender } from './smtp_email_sender.js';
import type { EmailSender } from './email_sender.js';

/** Sender display name when `EMAIL_FROM_NAME` is unset. */
const DEFAULT_FROM_NAME = 'CliqHub';
/** Brevo's SMTP relay. */
export const BREVO_SMTP_HOST = 'smtp-relay.brevo.com';

/**
 * The sender for this process.
 *
 * @param config - Email settings from {@link EnvConfig}.
 * @throws Error naming the variable to fix (never a key) when sending is half set up:
 *   no valid `EMAIL_FROM_ADDRESS`, an SMTP login without a password, or a Brevo SMTP key
 *   in `BREVO_API_KEY` without `SMTP_USER`.
 */
export function create_email_sender(
    config: Pick<EnvConfig, 'brevo_api_key' | 'email_from_address' | 'email_from_name' | 'smtp_user' | 'smtp_pass' | 'smtp_host' | 'smtp_port'>,
): EmailSender {
    const key = config.brevo_api_key?.trim();
    const user = config.smtp_user?.trim();
    const smtp_key_in_api_var = Boolean(key?.startsWith('xsmtpsib-'));
    if (!key && !user) return new NoopEmailSender();
    const from_address = config.email_from_address?.trim() ?? '';
    if (!EMAIL_PATTERN.test(from_address)) {
        throw new Error('EMAIL_FROM_ADDRESS must be set to a valid address when email sending is set up');
    }
    const from = { email: from_address, name: config.email_from_name?.trim() || DEFAULT_FROM_NAME };
    if (user) {
        const pass = config.smtp_pass?.trim() || (smtp_key_in_api_var ? key : undefined);
        if (!pass) throw new Error('SMTP_PASS must be set when SMTP_USER is set');
        return new SmtpEmailSender({ host: config.smtp_host?.trim() || BREVO_SMTP_HOST, port: config.smtp_port || 587, user, pass, from });
    }
    if (smtp_key_in_api_var) {
        throw new Error('BREVO_API_KEY holds a Brevo SMTP key (xsmtpsib-…): set SMTP_USER to your Brevo SMTP login to send over SMTP, or use an API key (xkeysib-…)');
    }
    return new BrevoEmailSender({ api_key: key!, from });
}
