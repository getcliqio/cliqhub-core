/**
 * Picks and fills the email template for one org event and one recipient.
 *
 *   - `invite.owner.sent|reminder` → owner_new when the org is waiting for its
 *     owner, otherwise org_member with the Owner role;
 *   - `invite.org.sent|reminder` → org_member; `invite.realm.sent|reminder` → realm;
 *   - `user.setup.sent` → set_password; `user.password_reset.sent` → reset_password;
 *   - everything else (accepted, declined, expired, revoked, `org.abandoned`,
 *     `user.password.changed`) → notify.
 *
 * A link email needs its link: a recipient of a sent / reminder / setup /
 * reset event without one (someone a custom rule added) gets the notify
 * template describing the event instead. Reminders reuse the sent template
 * with the "Reminder" eyebrow and subject prefix.
 */

import {
    describe_org_event,
    is_invite_event,
    ORG_ABANDONED,
    USER_PASSWORD_CHANGED,
    USER_PASSWORD_RESET_SENT,
    USER_SETUP_SENT,
    type DeliveryLinks,
    type InviteAction,
    type InviteEventData,
    type OrgAbandonedData,
    type OrgEventData,
    type OrgEventType,
    type UserLinkEventData,
    type UserPasswordChangedData,
} from '../../notifications/org_events.js';
import { bold, format_email_date, html_join, link, type RenderedEmail } from './layout.js';
import {
    notify_email, org_member_email, owner_new_email, realm_email, reset_password_email, role_label, set_password_email,
} from './templates.js';

/** Everything a template needs besides the event itself, looked up by the deliverer. */
export interface EventEmailContext {
    /** Base URL of the web app, no trailing slash. */
    app_url: string;
    /** The event's org (`events.org_id`). */
    org_id: string;
    /** Display name of the event's org, when known. */
    org_display_name: string | null;
    /** True when the event's org is waiting for its owner (owner invite of a new org). */
    org_awaiting_owner: boolean;
    /** Display name of the user who caused the event, when it was a user. */
    actor_name: string | null;
    /** Name of the notification channel the email goes through. */
    channel_name: string | null;
}

/** One org event for one recipient, as the Email channel renders it. */
export interface EventEmailInput {
    event: OrgEventType;
    data: OrgEventData;
    /** ISO timestamp the event happened. */
    occurred_at: string;
    /** Links for this recipient only (empty for anyone but the invitee / the user). */
    links: DeliveryLinks;
}

/**
 * Renders the email for one org event and recipient.
 *
 * @param input - The event, its data, when it happened and this recipient's links.
 * @param ctx - App URL and looked-up names.
 * @returns Subject, HTML and text.
 */
export function render_event_email(input: EventEmailInput, ctx: EventEmailContext): RenderedEmail {
    const { event, links } = input;
    if (is_invite_event(event)) {
        const d = input.data as InviteEventData;
        const action = event.split('.')[2] as InviteAction;
        if ((action === 'sent' || action === 'reminder') && links.accept_url) {
            return invite_email(d, links.accept_url, action === 'reminder', ctx);
        }
        return invite_notify_email(event, action, d, ctx);
    }
    if (event === USER_SETUP_SENT && links.setup_url) {
        const d = input.data as UserLinkEventData;
        return set_password_email({
            app_url: ctx.app_url, creator_name: ctx.actor_name ?? 'A CliqHub admin',
            username: d.user.username, email: d.user.email, expires_at: d.expires_at, setup_url: links.setup_url,
        });
    }
    if (event === USER_PASSWORD_RESET_SENT && links.reset_url) {
        const d = input.data as UserLinkEventData;
        return reset_password_email({
            app_url: ctx.app_url, account_name: d.user.username ?? d.user.email,
            requested_at: input.occurred_at, expires_at: d.expires_at, reset_url: links.reset_url,
        });
    }
    if (event === USER_PASSWORD_CHANGED) return password_changed_email(input.data as UserPasswordChangedData, input.occurred_at, ctx);
    if (event === ORG_ABANDONED) return org_abandoned_email(input.data as OrgAbandonedData, ctx);
    return described_email(event, input.data, ctx);
}

function invite_email(d: InviteEventData, accept_url: string, reminder: boolean, ctx: EventEmailContext): RenderedEmail {
    const base = { app_url: ctx.app_url, inviter_name: d.inviter.display_name, org: d.org, role: d.role, expires_at: d.expires_at, accept_url, reminder };
    if (d.kind === 'realm' && d.realm) return realm_email({ ...base, realm: d.realm });
    if (d.kind === 'owner' && ctx.org_awaiting_owner) return owner_new_email(base);
    return org_member_email(base);
}

function members_url(ctx: EventEmailContext): string {
    return `${ctx.app_url}/orgs/${encodeURIComponent(ctx.org_id)}?tab=members`;
}

function channel_footer(ctx: EventEmailContext): string {
    const channel = ctx.channel_name ?? 'Email';
    const org = ctx.org_display_name ? ` in ${ctx.org_display_name}` : '';
    return `You get this email because the notification channel “${channel}”${org} sends to this address. Manage it in Org settings › Notifications.`;
}

function invite_notify_email(event: OrgEventType, action: InviteAction, d: InviteEventData, ctx: EventEmailContext): RenderedEmail {
    const target = d.realm ? `${d.realm.display_name} (${d.org.display_name})` : d.org.display_name;
    const email = d.invitee_email;
    const expires = format_email_date(d.expires_at);
    const copy: Record<InviteAction, { eyebrow: string; heading: string; sentence: [string, string] }> = {
        sent: { eyebrow: 'Invite sent', heading: `${d.inviter.display_name} invited ${email}`, sentence: [' was invited to ', ` by ${d.inviter.display_name}.`] },
        reminder: { eyebrow: 'Invite reminder', heading: `${email} has not answered yet`, sentence: [' has not answered the invite to ', ` yet. It expires on ${expires}.`] },
        accepted: { eyebrow: 'Invite accepted', heading: `${email} joined ${target}`, sentence: [' accepted the invite to ', ` as ${role_label(d.role)}.`] },
        declined: { eyebrow: 'Invite declined', heading: `${email} declined the invite`, sentence: [' declined the invite to ', '. You can send a new invite from the members page.'] },
        expired: { eyebrow: 'Invite expired', heading: `The invite for ${email} expired`, sentence: [' did not answer the invite to ', ` before it expired on ${expires}. Send it again from the members page if they still need access.`] },
        revoked: { eyebrow: 'Invite revoked', heading: `The invite for ${email} was revoked`, sentence: ['’s invite to ', ' was revoked. The link in their email no longer works.'] },
    };
    const c = copy[action];
    const facts: Array<[string, string, boolean?]> = [
        ...(d.realm ? [['Realm', `${d.org.slug}.${d.realm.slug}`, true] as [string, string, boolean]] : []),
        ['Organization', d.org.display_name],
        ['Invited', email],
        ['Role', role_label(d.role)],
        ['Invited by', d.inviter.display_name],
        ...(d.accepted_user?.username ? [['Username', d.accepted_user.username, true] as [string, string, boolean]] : []),
        ['Event', event, true],
    ];
    return notify_email({
        app_url: ctx.app_url,
        subject: `[CliqHub] ${c.eyebrow}: ${email} · ${target}`,
        preheader: `${email}${c.sentence[0]}${target}${c.sentence[1]}`,
        eyebrow: c.eyebrow,
        heading: c.heading,
        intro: html_join(bold(email), c.sentence[0], bold(target), c.sentence[1]),
        intro_text: `${email}${c.sentence[0]}${target}${c.sentence[1]}`,
        facts,
        cta: { label: 'Open members', url: members_url(ctx) },
        footer_note: channel_footer(ctx),
    });
}

function org_abandoned_email(d: OrgAbandonedData, ctx: EventEmailContext): RenderedEmail {
    const expired = format_email_date(d.expired_at);
    const sentence = ` was removed: nobody accepted the owner invite sent to ${d.invitee_email} before it expired on ${expired}. Its name stays reserved; a site admin can reactivate it.`;
    return notify_email({
        app_url: ctx.app_url,
        subject: `[CliqHub] Org removed: ${d.org.display_name}`,
        preheader: `${d.org.display_name}${sentence}`,
        eyebrow: 'Org removed',
        heading: `${d.org.display_name} was removed`,
        intro: html_join('The organization ', bold(d.org.display_name), sentence),
        intro_text: `The organization ${d.org.display_name}${sentence}`,
        facts: [['Organization', d.org.display_name], ['Name', d.org.slug, true], ['Owner invite', d.invitee_email], ['Expired', expired], ['Event', ORG_ABANDONED, true]],
        cta: { label: 'Open CliqHub', url: `${ctx.app_url}/` },
        footer_note: channel_footer(ctx),
    });
}

function password_changed_email(d: UserPasswordChangedData, occurred_at: string, ctx: EventEmailContext): RenderedEmail {
    const account = d.user.username ?? d.user.email;
    const signed_out = d.sessions_revoked === 1 ? ' We signed you out on 1 other device.'
        : d.sessions_revoked > 1 ? ` We signed you out on ${d.sessions_revoked} other devices.` : '';
    const forgot = `${ctx.app_url}/forgot-password`;
    return notify_email({
        app_url: ctx.app_url,
        subject: 'Your CliqHub password was changed',
        preheader: `The password for ${account} was changed.`,
        eyebrow: 'Account security',
        heading: 'Your password was changed',
        intro: html_join('The password for ', bold(account), ` was changed.${signed_out}`),
        intro_text: `The password for ${account} was changed.${signed_out}`,
        facts: [['Username', account, true], ['Changed', format_email_date(occurred_at)], ['Signed out', String(d.sessions_revoked)]],
        cta: { label: 'Sign in', url: `${ctx.app_url}/login` },
        after: html_join('Didn’t change it? ', link(forgot, 'Reset your password'), ' right away.'),
        after_text: `Didn't change it? Reset your password right away: ${forgot}`,
        footer_note: 'We send this to the email address on your CliqHub account whenever its password changes.',
        hero: 'hero-key.png',
    });
}

/** Any other event (a link event for someone the link is not for): the event's own title and sentence. */
function described_email(event: OrgEventType, data: OrgEventData, ctx: EventEmailContext): RenderedEmail {
    const { title, message } = describe_org_event(event, data);
    return notify_email({
        app_url: ctx.app_url,
        subject: `[CliqHub] ${title}`,
        preheader: message,
        eyebrow: title,
        heading: title,
        intro: message,
        intro_text: message,
        facts: [['Event', event, true]],
        cta: { label: 'Open CliqHub', url: `${ctx.app_url}/` },
        footer_note: channel_footer(ctx),
    });
}

/** The parts of a channel notification payload the email shows. */
export interface ChannelNotification {
    event: string;
    title?: string;
    message?: string;
    team_slug?: string | null;
    run_name?: string | null;
    phase_name?: string | null;
    daemon_name?: string | null;
}

/**
 * Renders a notification for a channel-addressed email destination (any
 * event a channel's rules route to a fixed address).
 *
 * @param n - Event name, title, message and the run context it carries.
 * @param app_url - Base URL of the web app, no trailing slash.
 */
export function render_channel_email(n: ChannelNotification, app_url: string): RenderedEmail {
    const title = n.title?.trim() || n.event;
    const message = n.message?.trim() || title;
    const facts: Array<[string, string, boolean?]> = [];
    if (n.team_slug) facts.push(['Team', n.team_slug, true]);
    if (n.run_name) facts.push(['Run', n.run_name]);
    if (n.phase_name) facts.push(['Phase', n.phase_name]);
    if (n.daemon_name) facts.push(['Daemon', n.daemon_name]);
    facts.push(['Event', n.event, true]);
    return notify_email({
        app_url,
        subject: `[CliqHub] ${title}`,
        preheader: message,
        eyebrow: n.event,
        heading: title,
        intro: message,
        intro_text: message,
        facts,
        cta: { label: 'Open CliqHub', url: `${app_url}/` },
        footer_note: 'You get this email because a CliqHub notification channel sends to this address. Manage it in Org settings › Notifications.',
    });
}
