/**
 * Timing and size rules for invites, set-password / reset-password links,
 * the invite sweep, email sends and the public "Forgot password" form. Every
 * duration and batch size the identity flows use comes from here; none is
 * written as a literal elsewhere.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long an invite link stays valid; "send again" restarts it. */
export const INVITE_TTL_MS = 14 * DAY_MS;

/**
 * When the sweep sends reminders, as time left before the invite expires,
 * largest first. `reminders_sent` on an invite counts how many have gone out,
 * so reminder `n` (0-based) is due once `expires_at - now <= INVITE_REMINDER_OFFSETS_MS[n]`.
 */
export const INVITE_REMINDER_OFFSETS_MS: readonly number[] = [3 * DAY_MS, 1 * DAY_MS];

/** How long a "Set your password" link (new user) stays valid. */
export const SETUP_LINK_TTL_MS = 7 * DAY_MS;

/** How long a password reset link stays valid. */
export const RESET_LINK_TTL_MS = 24 * HOUR_MS;

/** How often the invite sweep runs (reminders, expiry, abandoned orgs). */
export const INVITE_SWEEP_INTERVAL_MS = 15 * MINUTE_MS;

/**
 * Public "Forgot password" limit: requests allowed per email per window. The
 * per-address limit is the BFF's, which sees the person's address.
 */
export const FORGOT_PASSWORD_LIMITS = {
    window_ms: HOUR_MS,
    per_email: 3,
} as const;

/** Invites the sweep handles per table and step in one run; the rest wait for the next run. */
export const INVITE_SWEEP_BATCH = 500;

/** How long one email send may take before the provider request is aborted. */
export const EMAIL_SEND_TIMEOUT_MS = 10 * 1000;
