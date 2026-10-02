/**
 * Org-scoped identity events: names, envelope and payload types.
 *
 * Every invite, org-lifecycle and account email event belongs to one org
 * (account emails to the user's own account org). CliqHub raises them through
 * {@link OrgEventService} after the change is committed; the org's
 * notification rules pick recipients (notifications/recipients.ts) and
 * channels. The stored payload is `{ actor, data }` and never contains a
 * token or a link: links are rebuilt at delivery from a {@link DeliveryLinkRef}
 * (notifications/delivery_links.ts).
 */

import type { InviteDecision } from '../models/account_invite.model.js';

/** Which invite: an org's owner invite, an org member invite, or a realm invite. */
export type InviteKind = 'owner' | 'org' | 'realm';

/** Every invite kind. */
export const INVITE_KINDS: readonly InviteKind[] = ['owner', 'org', 'realm'];

/** What happened to an invite. */
export type InviteAction = 'sent' | 'reminder' | 'accepted' | 'declined' | 'expired' | 'revoked';

/** `invite.<kind>.<action>`, e.g. `invite.org.sent`. */
export type InviteEventType = `invite.${InviteKind}.${InviteAction}`;

/** The event name for an invite kind and action. */
export function invite_event(kind: InviteKind, action: InviteAction): InviteEventType {
    return `invite.${kind}.${action}`;
}

/** An owner invite expired and the org has no active member: the org was soft-deleted. */
export const ORG_ABANDONED = 'org.abandoned';
/** A new user was sent a "Set your password" link. */
export const USER_SETUP_SENT = 'user.setup.sent';
/** A user was sent a password reset link. */
export const USER_PASSWORD_RESET_SENT = 'user.password_reset.sent';
/** A user's password was changed. */
export const USER_PASSWORD_CHANGED = 'user.password.changed';

/** Account email events (raised in the user's account org). */
export type UserEventType = typeof USER_SETUP_SENT | typeof USER_PASSWORD_RESET_SENT | typeof USER_PASSWORD_CHANGED;

/** Every org-scoped event CliqHub raises. */
export type OrgEventType = InviteEventType | typeof ORG_ABANDONED | UserEventType;

/**
 * Who caused the event: a user, the invite sweep, or an invited person who
 * has no account (declining from the invite link).
 */
export type EventActor = { user_id: string } | { system: 'sweep' } | { invitee_email: string };

/** A display reference to an org or realm. */
export interface NamedRef {
    slug: string;
    display_name: string;
}

/** `data` of every `invite.*` event (stored in the event row as `payload_json.data`). */
export interface InviteEventData {
    invite_id: string;
    kind: InviteKind;
    role: string;
    invitee_email: string;
    inviter: { id: string; display_name: string };
    org: NamedRef;
    /** Set for realm invites. */
    realm: NamedRef | null;
    /** ISO timestamp. */
    expires_at: string;
    send_count: number;
    /** accepted: the account that accepted. */
    accepted_user?: { id: string; username: string | null };
    /** accepted / declined. */
    decision?: InviteDecision;
}

/** `data` of `org.abandoned`. */
export interface OrgAbandonedData {
    org: NamedRef & { id: string };
    /** The owner invite that expired. */
    invite_id: string;
    invitee_email: string;
    inviter: { id: string; display_name: string };
    /** ISO timestamp when the owner invite expired. */
    expired_at: string;
}

/** The user an account email is about. */
export interface EventUser {
    id: string;
    username: string | null;
    email: string;
    display_name: string;
}

/** `data` of `user.setup.sent` and `user.password_reset.sent`. */
export interface UserLinkEventData {
    user: EventUser;
    /** `password_resets.id`. */
    reset_id: string;
    /** ISO timestamp. */
    expires_at: string;
    send_count: number;
}

/** `data` of `user.password.changed`. */
export interface UserPasswordChangedData {
    user: EventUser;
    /** Other sessions signed out by the change. */
    sessions_revoked: number;
}

/** Event name → its `data` type. */
export type OrgEventDataMap = { [K in InviteEventType]: InviteEventData } & {
    [ORG_ABANDONED]: OrgAbandonedData;
    [USER_SETUP_SENT]: UserLinkEventData;
    [USER_PASSWORD_RESET_SENT]: UserLinkEventData;
    [USER_PASSWORD_CHANGED]: UserPasswordChangedData;
};

/** Any org event's `data`. */
export type OrgEventData = OrgEventDataMap[OrgEventType];

/**
 * Points at the stored token a delivery-time link is built from. Invites of
 * kind `owner` and `org` live in `account_invites`, realm invites in
 * `realm_invites`; password links in `password_resets`.
 */
export type DeliveryLinkRef =
    | { kind: 'invite'; table: 'account_invites' | 'realm_invites'; invite_id: string }
    | { kind: 'password'; reset_id: string };

/** Links built at delivery time; only the invitee / the user ever receives them. */
export interface DeliveryLinks {
    /** `${PUBLIC_APP_URL}/invite/<token>` */
    accept_url?: string;
    /** `${PUBLIC_APP_URL}/reset/<token>` for a setup link. */
    setup_url?: string;
    /** `${PUBLIC_APP_URL}/reset/<token>` for a reset link. */
    reset_url?: string;
}

/** What raising an org event takes. */
export interface RaiseOrgEventInput<T extends OrgEventType = OrgEventType> {
    event: T;
    /** The org the event belongs to (account org for `user.*`). */
    org_id: string;
    /** Set for realm invite events. */
    realm_id?: string | null;
    actor: EventActor;
    data: OrgEventDataMap[T];
    /** Where the email link comes from (sent / reminder / setup / reset events). */
    link?: DeliveryLinkRef;
    /** ISO timestamp; defaults to now. */
    occurred_at?: string;
}

/** The stored payload (`events.payload_json`) of an org event. */
export interface OrgEventPayload {
    actor: EventActor;
    data: OrgEventData;
}

/** One delivery attempt made for an org event. */
export interface OrgDeliveryOutcome {
    channel_id: string;
    rule_id: string | null;
    /** Destination type (`email`, `cliqhub`, `slack`, …). */
    type: string;
    /** Recipient address or user id; null for channel-addressed destinations. */
    to: string | null;
    /** True when this delivery carried the event's links (invitee / user). */
    with_links: boolean;
    ok: boolean;
    error: string | null;
}

/** What raising an org event did. */
export interface OrgEventResult {
    /** `events.id`; null when the event could not be stored. */
    event_id: string | null;
    status: 'dispatched' | 'skipped' | 'failed';
    deliveries: OrgDeliveryOutcome[];
    /**
     * True when an email reached its recipient: for events with a link, an
     * email that carried the link; otherwise any email. False means the caller
     * returns the link itself (`invite_url`, `setup_url`, `reset_url`).
     */
    email_sent: boolean;
}

/** True for `invite.*` event names. */
export function is_invite_event(type: string): type is InviteEventType {
    return type.startsWith('invite.');
}

/** A short title and sentence for in-app and chat destinations (never contains a link). */
export function describe_org_event(event: OrgEventType, data: OrgEventData): { title: string; message: string } {
    if (is_invite_event(event)) {
        const d = data as InviteEventData;
        const target = d.realm ? `${d.realm.display_name} (${d.org.display_name})` : d.org.display_name;
        const action = event.split('.')[2] as InviteAction;
        const verbs: Record<InviteAction, string> = {
            sent: `${d.inviter.display_name} invited ${d.invitee_email} to ${target}`,
            reminder: `Reminder: ${d.invitee_email} has not answered the invite to ${target}`,
            accepted: `${d.invitee_email} accepted the invite to ${target}`,
            declined: `${d.invitee_email} declined the invite to ${target}`,
            expired: `The invite for ${d.invitee_email} to ${target} expired`,
            revoked: `The invite for ${d.invitee_email} to ${target} was revoked`,
        };
        const titles: Record<InviteAction, string> = {
            sent: 'Invite sent', reminder: 'Invite reminder', accepted: 'Invite accepted',
            declined: 'Invite declined', expired: 'Invite expired', revoked: 'Invite revoked',
        };
        return { title: titles[action], message: verbs[action] };
    }
    if (event === ORG_ABANDONED) {
        const d = data as OrgAbandonedData;
        return { title: 'Org removed', message: `${d.org.display_name} was removed: ${d.invitee_email} never accepted the owner invite` };
    }
    const user = (data as UserLinkEventData | UserPasswordChangedData).user;
    const name = user.display_name || user.username || user.email;
    if (event === USER_SETUP_SENT) return { title: 'Set your password', message: `A set-password link was sent to ${name}` };
    if (event === USER_PASSWORD_RESET_SENT) return { title: 'Password reset', message: `A password reset link was sent to ${name}` };
    return { title: 'Password changed', message: `The password of ${name} was changed` };
}

/**
 * Title and sentence of an org event as one recipient's inbox shows it
 * (never contains a link): addressed to the invited person or the account
 * holder ("You're invited…", "Your password was changed"), or naming who
 * joined, declined or was not reached for the owners and the inviter.
 *
 * @param to_self - The recipient is the person the event is about (the
 *   invitee of an invite, the user of an account event).
 * @param names.accepted - Display name of the person who accepted, when known.
 */
export function describe_org_event_for_inbox(
    event: OrgEventType,
    data: OrgEventData,
    to_self: boolean,
    names: { accepted?: string | null } = {},
): { title: string; message: string } {
    if (is_invite_event(event)) {
        const d = data as InviteEventData;
        const target = d.realm ? `${d.realm.display_name} in ${d.org.display_name}` : d.org.display_name;
        const action = event.split('.')[2] as InviteAction;
        const role = d.kind === 'owner' ? 'owner' : d.role;
        if (to_self && action === 'sent') {
            return { title: `You're invited to join ${target}`, message: `${d.inviter.display_name} invited you to join ${target} as ${role}. Open the invite email to accept.` };
        }
        if (to_self && action === 'reminder') {
            return { title: `Reminder: you're invited to join ${target}`, message: `Your invite from ${d.inviter.display_name} to join ${target} is still open. Open the invite email to accept.` };
        }
        const who = names.accepted || d.accepted_user?.username || d.invitee_email;
        switch (action) {
            case 'accepted': return { title: `${who} joined ${target}`, message: `${who} accepted the invite to ${target} as ${role}.` };
            case 'declined': return { title: `${d.invitee_email} declined the invite to ${target}`, message: `${d.invitee_email} will not join ${target}.` };
            case 'expired': return { title: `The invite to ${target} expired`, message: `${d.invitee_email} did not answer in time. Send the invite again if they still need access.` };
            case 'revoked': return { title: `The invite to ${target} was revoked`, message: `The invite for ${d.invitee_email} no longer works.` };
            default: return describe_org_event(event, data);
        }
    }
    if (event === ORG_ABANDONED) {
        const d = data as OrgAbandonedData;
        return { title: `${d.org.display_name} was removed`, message: `${d.invitee_email} never accepted the owner invite, so ${d.org.display_name} was removed.` };
    }
    if (to_self && event === USER_PASSWORD_RESET_SENT) {
        return { title: 'Password reset requested', message: 'A link to reset your password was sent to your email. If this wasn’t you, you can ignore it.' };
    }
    if (to_self && event === USER_PASSWORD_CHANGED) {
        return { title: 'Your password was changed', message: 'Your other sessions were signed out. If this wasn’t you, reset your password right away.' };
    }
    return describe_org_event(event, data);
}
