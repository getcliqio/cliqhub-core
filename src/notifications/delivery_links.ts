/**
 * Builds the links an email carries (accept, set-password, reset) at
 * delivery time from the encrypted token stored on the invite or password
 * link row. Links are never stored, logged or put in an event row; callers
 * may return one as the `*_url` fallback when email could not be sent.
 */

import { public_app_url } from '../config/env.js';
import { decrypt_token } from '../lib/secure_token.js';
import { AccountInvite, PasswordReset, RealmInvite } from '../models/index.js';
import type { DeliveryLinkRef, DeliveryLinks } from './org_events.js';

/** `${PUBLIC_APP_URL}/invite/<token>` */
function accept_url_for(token: string): string {
    return `${public_app_url()}/invite/${encodeURIComponent(token)}`;
}

/** `${PUBLIC_APP_URL}/reset/<token>` (set-password and reset share the page). */
function password_url_for(token: string): string {
    return `${public_app_url()}/reset/${encodeURIComponent(token)}`;
}

/**
 * Rebuilds the links for a stored token.
 *
 * @param ref - Which invite or password link row holds the token.
 * @returns `{ accept_url }` for invites, `{ setup_url }` or `{ reset_url }` for password links.
 * @throws Error when the row is gone, has no stored token, or
 *   `TOKEN_ENCRYPTION_KEY` / `PUBLIC_APP_URL` are not configured.
 */
export async function resolve_delivery_links(ref: DeliveryLinkRef): Promise<DeliveryLinks> {
    if (ref.kind === 'invite') {
        const model = ref.table === 'account_invites' ? AccountInvite : RealmInvite;
        const row = await (model as typeof AccountInvite).findByPk(ref.invite_id, { attributes: ['id', 'token_enc'], raw: true });
        if (!row?.token_enc) throw new Error(`Invite ${ref.invite_id} has no stored link`);
        return { accept_url: accept_url_for(decrypt_token(row.token_enc)) };
    }
    const row = await PasswordReset.findByPk(ref.reset_id, { attributes: ['id', 'purpose', 'token_enc'], raw: true });
    if (!row) throw new Error(`Password link ${ref.reset_id} not found`);
    const url = password_url_for(decrypt_token(row.token_enc));
    return row.purpose === 'setup' ? { setup_url: url } : { reset_url: url };
}
