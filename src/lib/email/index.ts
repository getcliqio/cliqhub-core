/**
 * Builds the configured {@link EmailSender} from the environment: Brevo
 * when `BREVO_API_KEY` is set, otherwise the no-op sender.
 */

import { EMAIL_PATTERN, type EnvConfig } from '../../config/env.js';
import { BrevoEmailSender } from './brevo_email_sender.js';
import { NoopEmailSender } from './noop_email_sender.js';
import type { EmailSender } from './email_sender.js';

/** Sender display name when `EMAIL_FROM_NAME` is unset. */
const DEFAULT_FROM_NAME = 'CliqHub';

/**
 * The sender for this process.
 *
 * @param config - `brevo_api_key`, `email_from_address`, `email_from_name` from {@link EnvConfig}.
 * @throws Error when a key is set but `EMAIL_FROM_ADDRESS` is missing or not an address
 *   (the message names the variable, never the key).
 */
export function create_email_sender(
    config: Pick<EnvConfig, 'brevo_api_key' | 'email_from_address' | 'email_from_name'>,
): EmailSender {
    const key = config.brevo_api_key?.trim();
    if (!key) return new NoopEmailSender();
    const from = config.email_from_address?.trim() ?? '';
    if (!EMAIL_PATTERN.test(from)) {
        throw new Error('EMAIL_FROM_ADDRESS must be set to a valid address when BREVO_API_KEY is set');
    }
    return new BrevoEmailSender({ api_key: key, from: { email: from, name: config.email_from_name?.trim() || DEFAULT_FROM_NAME } });
}
