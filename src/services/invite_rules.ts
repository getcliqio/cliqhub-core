/**
 * Pure rules for org, owner and realm invites, shared by the invitations
 * service and the invite sweep: which roles a target accepts, the kind of an
 * invite, its effective status at a given time, when the next reminder is
 * due, and how `invitations/get` sorts.
 */

import { ApiError } from '../errors/api_error.js';
import { INVITE_REMINDER_OFFSETS_MS } from '../config/identity_lifecycle.js';
import type { InviteStatus } from '../models/account_invite.model.js';
import type { InviteKind } from '../notifications/org_events.js';

/** What an invite grants access to. */
export type InviteTargetType = 'org' | 'realm';

/** Roles an org invite can carry (`owner` makes the person an owner of the org). */
export type OrgInviteRole = 'owner' | 'admin' | 'member';

/** Roles a realm invite can carry. */
export type RealmInviteRole = 'admin' | 'operator' | 'member';

/** Any invite role. */
export type InviteRole = OrgInviteRole | RealmInviteRole;

/** The role an invite gets when the request names none. */
export const DEFAULT_INVITE_ROLE = 'member' as const;

/**
 * Checks that `role` is valid for the target: `owner` is for orgs only,
 * `operator` for realms only.
 *
 * @throws ApiError 422 invalid_params for a role the target does not have
 */
export function assert_role_for_target(target: InviteTargetType, role: InviteRole): void {
    if (target === 'realm' && role === 'owner') {
        throw new ApiError('invalid_params', 'owner role is not valid for realm invites', 422, { field: 'role' });
    }
    if (target === 'org' && role === 'operator') {
        throw new ApiError('invalid_params', 'operator role is not valid for org invites', 422, { field: 'role' });
    }
}

/** The event kind of an invite: realm invites are `realm`, org invites `owner` or `org` by role. */
export function invite_kind(target: InviteTargetType, role: string): InviteKind {
    if (target === 'realm') return 'realm';
    return role === 'owner' ? 'owner' : 'org';
}

/**
 * The value of the `org_members.role` text column for an org role: owners
 * and admins are stored as `admin` (the owner role is carried by `role_id`).
 */
export function org_member_role_column(role: OrgInviteRole): 'admin' | 'member' {
    return role === 'member' ? 'member' : 'admin';
}

/** `Date` from a stored timestamp. */
export function to_date(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

/**
 * The status an invite has at `now`: a `pending` invite past its expiry is
 * `expired` even before the sweep has written that.
 */
export function effective_status(invite: { status: InviteStatus; expires_at: Date | string }, now: Date): InviteStatus {
    if (invite.status === 'pending' && to_date(invite.expires_at).getTime() <= now.getTime()) return 'expired';
    return invite.status;
}

/**
 * Whether a reminder is due for a pending invite at `now`, and what
 * `reminders_sent` becomes once it is sent.
 *
 * Reminder `n` (0-based) is due when `reminders_sent === n` and the time left
 * is at most `INVITE_REMINDER_OFFSETS_MS[n]`. When several are due at once
 * (the sweep did not run for a while) one reminder goes out and the counter
 * skips past all of them, so each reminder is sent at most once.
 *
 * @param invite - The invite's `expires_at` and `reminders_sent`.
 * @param now - The sweep's clock.
 * @param offsets - Reminder offsets before expiry, largest first.
 * @returns `null` when nothing is due (or the invite has expired).
 */
export function reminder_due(
    invite: { expires_at: Date | string; reminders_sent: number },
    now: Date,
    offsets: readonly number[] = INVITE_REMINDER_OFFSETS_MS,
): { reminders_sent: number } | null {
    const left = to_date(invite.expires_at).getTime() - now.getTime();
    if (left <= 0) return null;
    let next = invite.reminders_sent;
    while (next < offsets.length && left <= offsets[next]) next += 1;
    return next > invite.reminders_sent ? { reminders_sent: next } : null;
}

/** Fields `invitations/get` can sort by. */
export const INVITE_SORT_FIELDS = ['created_at', 'expires_at', 'last_sent_at', 'email', 'role', 'status', 'send_count'] as const;

/** One sortable field. */
export type InviteSortField = (typeof INVITE_SORT_FIELDS)[number];

/**
 * Parses a sort like `-created_at` (a `-` first means descending).
 * Defaults to newest first.
 *
 * @throws ApiError 422 invalid_params for an unknown field
 */
export function parse_invite_sort(sort: string | undefined): { field: InviteSortField; dir: 'ASC' | 'DESC' } {
    if (!sort) return { field: 'created_at', dir: 'DESC' };
    const desc = sort.startsWith('-');
    const field = (desc ? sort.slice(1) : sort) as InviteSortField;
    if (!INVITE_SORT_FIELDS.includes(field)) {
        throw new ApiError('invalid_params', `sort must be one of ${INVITE_SORT_FIELDS.join(', ')} (prefix - for descending)`, 422, { field: 'sort' });
    }
    return { field, dir: desc ? 'DESC' : 'ASC' };
}
