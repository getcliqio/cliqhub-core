/**
 * Invite links in tests. With no email provider configured the invite email
 * is not sent, so `invitations/create` and `orgs/new` return `invite_url`
 * (tests call `use_test_link_env()` first); the token is its last segment.
 */

import request from 'supertest';
import type { Express } from 'express';

/** The link token inside an `invite_url` (`<PUBLIC_APP_URL>/invite/<token>`). */
export function token_from_invite_url(invite_url: string | null | undefined): string {
    const match = /\/invite\/([^/?#]+)$/.exec(invite_url ?? '');
    if (!match) throw new Error(`not an invite url: ${String(invite_url)}`);
    return decodeURIComponent(match[1]);
}

/**
 * Invites `email` to an org and accepts it as the signed-in account
 * `invitee_token` (the account's email must be `email`).
 *
 * @throws Error when either call fails.
 */
export async function invite_and_accept(
    app: Express,
    inviter_token: string,
    invitee_token: string,
    body: { org_id: string; email: string; role?: string },
): Promise<void> {
    const sent = await request(app).post('/v1/invitations/create').set('Authorization', `Bearer ${inviter_token}`)
        .send({ target_type: 'org', ...body });
    if (sent.status !== 200) throw new Error(`invite ${body.email}: ${sent.status} ${JSON.stringify(sent.body)}`);
    await accept_invite_url(app, invitee_token, sent.body.data.invite_url);
}

/**
 * Invites `email` to a realm and accepts it as the signed-in account
 * `invitee_token` (joins the realm and, as Member, the realm's org).
 *
 * @throws Error when either call fails.
 */
export async function invite_to_realm_and_accept(
    app: Express,
    inviter_token: string,
    invitee_token: string,
    body: { realm_id: string; email: string; role?: string },
): Promise<void> {
    const sent = await request(app).post('/v1/invitations/create').set('Authorization', `Bearer ${inviter_token}`)
        .send({ target_type: 'realm', ...body });
    if (sent.status !== 200) throw new Error(`realm invite ${body.email}: ${sent.status} ${JSON.stringify(sent.body)}`);
    await accept_invite_url(app, invitee_token, sent.body.data.invite_url);
}

/**
 * Accepts the invite behind `invite_url` as the signed-in account `invitee_token`.
 *
 * @throws Error when the accept fails.
 */
export async function accept_invite_url(app: Express, invitee_token: string, invite_url: string | null): Promise<void> {
    const accepted = await request(app).post('/v1/invitations/accept').set('Authorization', `Bearer ${invitee_token}`)
        .send({ token: token_from_invite_url(invite_url), decision: 'accept' });
    if (accepted.status !== 200) throw new Error(`accept: ${accepted.status} ${JSON.stringify(accepted.body)}`);
}
