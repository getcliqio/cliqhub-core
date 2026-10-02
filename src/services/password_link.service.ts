/**
 * "Set your password" and "Reset your password" links (`password_resets`),
 * and the public "Forgot password" per-email limit (`password_reset_requests`).
 *
 * A link's token is stored as a SHA-256 hash (lookup) plus an AES-GCM copy
 * (lib/secure_token.ts), so asking again sends the same link: the open row of
 * that user and purpose gets a new expiry and one more `send_count`. The raw
 * token is never returned, logged or stored in clear; emails rebuild the link
 * at delivery time (notifications/delivery_links.ts).
 */

import { Op, type Transaction } from 'sequelize';

import { ApiError } from '../errors/api_error.js';
import { hash_token, issue_token } from '../lib/secure_token.js';
import { PasswordReset, PasswordResetRequest } from '../models/index.js';
import type { PasswordLinkPurpose } from '../models/password_reset.model.js';
import { FORGOT_PASSWORD_LIMITS, RESET_LINK_TTL_MS, SETUP_LINK_TTL_MS } from '../config/identity_lifecycle.js';

/** How long a link of `purpose` stays valid from when it was (re)sent. */
export function password_link_ttl_ms(purpose: PasswordLinkPurpose): number {
    return purpose === 'setup' ? SETUP_LINK_TTL_MS : RESET_LINK_TTL_MS;
}

/** Where a link stands: usable, already used (or retired), or past its expiry. */
export type PasswordLinkState = 'open' | 'used' | 'expired';

/** The state of a link row at `now`. A used link reads `used` even after its expiry. */
export function password_link_state(row: { used_at: Date | null; expires_at: Date }, now: Date): PasswordLinkState {
    if (row.used_at) return 'used';
    if (row.expires_at.getTime() <= now.getTime()) return 'expired';
    return 'open';
}

/**
 * Whether one more public request would go over the per-email limit, given
 * how many requests the window already holds for that email.
 */
export function forgot_password_limited(requests_for_email: number): boolean {
    return requests_for_email >= FORGOT_PASSWORD_LIMITS.per_email;
}

/**
 * @throws ApiError 404 not_found (no link); 409 not_pending `{ status: 'used' }`; 410 expired
 */
function assert_link_open(row: { used_at: Date | null; expires_at: Date } | null, now: Date): void {
    if (!row) throw new ApiError('not_found', 'This link is not valid.', 404);
    const state = password_link_state(row, now);
    if (state === 'used') throw ApiError.not_pending('used', 'This link was already used.');
    if (state === 'expired') throw ApiError.expired(new Date(row.expires_at).toISOString());
}

/** A link after it was issued or sent again. */
export interface IssuedPasswordLink {
    id: string;
    expires_at: Date;
    send_count: number;
    /** True when an open link existed and was sent again (same token). */
    resent: boolean;
}

/**
 * Issues, redeems and retires password links; counts public reset requests.
 */
export class PasswordLinkService {
    /**
     * Issues a link of `purpose` for a user, or sends the open one again:
     * same token, expiry restarted, `send_count` + 1.
     *
     * @param user_id - Who the link is for.
     * @param purpose - `setup` (new user, 7 days) or `reset` (24 hours).
     * @param opts.requested_by - The site admin who asked; null for the public form.
     * @param opts.transaction - The caller's transaction.
     * @throws Error when `TOKEN_ENCRYPTION_KEY` is not configured (new link only)
     */
    async issue(
        user_id: string,
        purpose: PasswordLinkPurpose,
        opts: { requested_by: string | null; transaction: Transaction; now?: Date },
    ): Promise<IssuedPasswordLink> {
        const now = opts.now ?? new Date();
        const expires_at = new Date(now.getTime() + password_link_ttl_ms(purpose));
        const t = opts.transaction;

        // One issuer per user and purpose at a time: two concurrent asks must not both create a row.
        await PasswordReset.sequelize!.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
            replacements: { key: `password_link:${user_id}:${purpose}` },
            transaction: t,
        });
        const open = await PasswordReset.findOne({
            where: { user_id, purpose, used_at: { [Op.is]: null } },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (open) {
            open.expires_at = expires_at;
            open.send_count += 1;
            open.last_sent_at = now;
            if (opts.requested_by) open.requested_by = opts.requested_by;
            await open.save({ transaction: t });
            return { id: open.id, expires_at, send_count: open.send_count, resent: true };
        }

        const { token_hash, token_enc } = issue_token();
        const row = await PasswordReset.create({
            user_id, purpose, token_hash, token_enc, expires_at,
            send_count: 1, last_sent_at: now, requested_by: opts.requested_by,
        } as never, { transaction: t });
        return { id: row.id, expires_at, send_count: 1, resent: false };
    }

    /**
     * Checks that the link behind `token` can still be used, without
     * changing it (a cheap check before work that {@link redeem} repeats
     * under a lock).
     *
     * @throws ApiError 404 not_found; 409 not_pending `{ status: 'used' }`; 410 expired
     */
    async assert_open(token: string, now: Date = new Date()): Promise<void> {
        const row = await PasswordReset.findOne({ where: { token_hash: hash_token(token) }, attributes: ['used_at', 'expires_at'], raw: true });
        assert_link_open(row, now);
    }

    /**
     * Marks the link behind `token` used, inside the caller's transaction (a
     * rollback leaves it open).
     *
     * @returns The link row (its `user_id` and `purpose`).
     * @throws ApiError 404 not_found for an unknown token; 409 not_pending
     *   `{ status: 'used' }` when it was already used; 410 expired `{ expired_at }`
     */
    async redeem(token: string, t: Transaction, now: Date = new Date()): Promise<PasswordReset> {
        const row = await PasswordReset.findOne({
            where: { token_hash: hash_token(token) },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        assert_link_open(row, now);
        row!.used_at = now;
        await row!.save({ transaction: t });
        return row!;
    }

    /**
     * Retires every open link of a user (their password was just set), so an
     * older email can no longer change it.
     *
     * @returns How many links were retired.
     */
    async retire_open(user_id: string, t: Transaction, now: Date = new Date()): Promise<number> {
        const [count] = await PasswordReset.update(
            { used_at: now },
            { where: { user_id, used_at: { [Op.is]: null } }, transaction: t },
        );
        return count;
    }

    /**
     * Counts a public "Forgot password" request against the hourly per-email
     * limit and records it. Requests for unknown emails count the same, so the
     * limit never tells whether an account exists.
     *
     * The count and the insert run in one transaction holding an advisory lock
     * on the email, so concurrent requests are counted one after another and
     * the limit holds.
     *
     * @param email - Normalized (trimmed, lowercase) email.
     * @throws ApiError 429 rate_limited (the request is not recorded)
     */
    async record_forgot_request(email: string, now: Date = new Date()): Promise<void> {
        const since = new Date(now.getTime() - FORGOT_PASSWORD_LIMITS.window_ms);
        const sq = PasswordResetRequest.sequelize!;
        await sq.transaction(async (t) => {
            await sq.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `forgot_password:email:${email}` }, transaction: t });
            const count = await PasswordResetRequest.count({ where: { email, created_at: { [Op.gt]: since } }, transaction: t });
            if (forgot_password_limited(count)) throw ApiError.rate_limited();
            await PasswordResetRequest.create({ email, created_at: now }, { transaction: t });
        });
    }
}
