/**
 * The six CliqHub email templates, each rendered to a subject, an HTML body
 * (the shared layout in ./layout.ts) and a plain-text body:
 *
 *   - {@link owner_new_email}       — own a new org (it becomes active on accept);
 *   - {@link org_member_email}      — join an existing org;
 *   - {@link realm_email}           — join a realm (and its org);
 *   - {@link set_password_email}    — a new account's first password;
 *   - {@link reset_password_email}  — a password reset link;
 *   - {@link notify_email}          — any other notification (invite outcomes, org removed, password changed).
 *
 * The three invite templates take `reminder: true` for the reminder variant:
 * a "Reminder" eyebrow and a "Reminder: " subject prefix. Links arrive ready
 * to use and appear only in the body of the email they belong to.
 */

import {
    bold, format_email_date, html_join, mono, name_with_slug, render_layout, subject_line,
    type Copy, type Fact, type RenderedEmail,
} from './layout.js';

const IGNORE = 'If you weren’t expecting this email, you can ignore it. Nothing happens unless you accept.';

/** `member` → `Member`. */
export function role_label(role: string): string {
    return role ? role.charAt(0).toUpperCase() + role.slice(1) : role;
}

/** `a member`, `an admin`, `an owner`, `an operator`. */
function with_article(word: string): string {
    return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/** A named org or realm reference. */
export interface EmailNamedRef {
    slug: string;
    display_name: string;
}

/** What every invite template takes. */
export interface InviteEmailInput {
    app_url: string;
    inviter_name: string;
    org: EmailNamedRef;
    role: string;
    /** ISO timestamp. */
    expires_at: string;
    accept_url: string;
    /** Reminder variant: "Reminder" eyebrow and subject prefix. */
    reminder?: boolean;
}

function reminder_subject(subject: string, reminder?: boolean): string {
    return subject_line(reminder ? `Reminder: ${subject}` : subject);
}

function reminder_text(text: string, expires: string, reminder?: boolean): string {
    return reminder ? `Reminder: this invitation expires on ${expires}.\n\n${text}` : text;
}

/**
 * Invitation to own a new org, which becomes active when the invite is accepted.
 *
 * @param i - Inviter, org, expiry and accept link.
 */
export function owner_new_email(i: InviteEmailInput): RenderedEmail {
    const expires = format_email_date(i.expires_at);
    const org = i.org.display_name;
    const slug = i.org.slug;
    const html = render_layout({
        app_url: i.app_url,
        preheader: `${i.reminder ? 'Reminder: ' : ''}Accept to create the ${org} organization with you as its owner.`,
        eyebrow: i.reminder ? 'Reminder' : 'Your new organization',
        heading: `${org} is waiting for you`,
        intro: html_join(bold(i.inviter_name), ' invited you to own a new organization on CliqHub. It is created when you accept, with you as its owner. The name ', mono(slug), ' is held for you until then.'),
        facts: [['Organization', org], ['Name', slug, true], ['Team names', `@${slug}/…`, true], ['Your role', 'Owner'], ['Expires', expires]],
        cta: { label: 'Accept and set up', url: i.accept_url },
        after: 'You’ll choose a username and password if you don’t have a CliqHub account yet.',
        footer_note: IGNORE,
    });
    const text = `${i.inviter_name} invited you to own a new organization on CliqHub.\n\nOrganization: ${org} (${slug})\nYour role: Owner\nExpires: ${expires}\n\nThe organization is created when you accept, with you as its owner. The name ${slug} is held for you until then.\n\nAccept and set up: ${i.accept_url}\n\n${IGNORE}`;
    return {
        subject: reminder_subject(`${i.inviter_name} invited you to own ${org} on CliqHub`, i.reminder),
        html,
        text: reminder_text(text, expires, i.reminder),
    };
}

/**
 * Invitation to join an existing org with a role (member, admin, operator or owner).
 *
 * @param i - Inviter, org, role, expiry and accept link.
 */
export function org_member_email(i: InviteEmailInput): RenderedEmail {
    const expires = format_email_date(i.expires_at);
    const org = i.org.display_name;
    const role = role_label(i.role);
    const html = render_layout({
        app_url: i.app_url,
        preheader: `${i.reminder ? 'Reminder: ' : ''}Join ${org} as ${with_article(i.role.toLowerCase())}.`,
        eyebrow: i.reminder ? 'Reminder' : 'Team invite',
        heading: `Join ${org} on CliqHub`,
        intro: html_join(bold(i.inviter_name), ' invited you to join the organization ', bold(org), '.'),
        facts: [['Organization', name_with_slug(org, i.org.slug)], ['Your role', role], ['Invited by', i.inviter_name], ['Expires', expires]],
        cta: { label: 'Accept invitation', url: i.accept_url },
        after: 'Already have an account? Sign in with this email address and accept.',
        footer_note: IGNORE,
    });
    const text = `${i.inviter_name} invited you to join the organization ${org} (${i.org.slug}) on CliqHub.\n\nYour role: ${role}\nExpires: ${expires}\n\nAccept: ${i.accept_url}\n\nAlready have an account? Sign in with this email address and accept.\n\n${IGNORE}`;
    return {
        subject: reminder_subject(`${i.inviter_name} invited you to join ${org} on CliqHub`, i.reminder),
        html,
        text: reminder_text(text, expires, i.reminder),
    };
}

/** What {@link realm_email} takes. */
export interface RealmEmailInput extends InviteEmailInput {
    realm: EmailNamedRef;
}

/**
 * Invitation to a realm; accepting also makes the person a member of the realm's org.
 *
 * @param i - Inviter, org, realm, role, expiry and accept link.
 */
export function realm_email(i: RealmEmailInput): RenderedEmail {
    const expires = format_email_date(i.expires_at);
    const org = i.org.display_name;
    const realm = i.realm.display_name;
    const qualified = `${i.org.slug}.${i.realm.slug}`;
    const role = role_label(i.role);
    const html = render_layout({
        app_url: i.app_url,
        preheader: `${i.reminder ? 'Reminder: ' : ''}Join the ${i.realm.slug} realm in ${org}.`,
        eyebrow: i.reminder ? 'Reminder' : 'Realm invite',
        heading: `You’re in for ${realm}`,
        intro: html_join(bold(i.inviter_name), ' invited you to the realm ', bold(realm), ' in ', bold(org), '. Realms are where teams run on your daemons.'),
        facts: [['Realm', name_with_slug(realm, qualified)], ['Organization', org], ['Your role', role], ['Expires', expires]],
        cta: { label: 'Accept invitation', url: i.accept_url },
        after: `Accepting also adds you to ${org} as a member.`,
        footer_note: IGNORE,
    });
    const text = `${i.inviter_name} invited you to the realm ${realm} (${qualified}) in ${org} on CliqHub.\n\nYour role: ${role}\nExpires: ${expires}\n\nAccept: ${i.accept_url}\n\nAccepting also adds you to ${org} as a member.\n\n${IGNORE}`;
    return {
        subject: reminder_subject(`${i.inviter_name} invited you to the realm ${qualified} on CliqHub`, i.reminder),
        html,
        text: reminder_text(text, expires, i.reminder),
    };
}

/** What {@link set_password_email} takes. */
export interface SetPasswordEmailInput {
    app_url: string;
    /** Who created the account. */
    creator_name: string;
    username: string | null;
    email: string;
    /** ISO timestamp. */
    expires_at: string;
    setup_url: string;
}

/**
 * "Set your password" for an account a site admin created.
 *
 * @param i - Creator, account, expiry and set-password link.
 */
export function set_password_email(i: SetPasswordEmailInput): RenderedEmail {
    const expires = format_email_date(i.expires_at);
    const facts: Fact[] = [
        ...(i.username ? [['Username', i.username, true] as Fact] : []),
        ['Email', i.email],
        ['Link expires', expires],
    ];
    const html = render_layout({
        app_url: i.app_url,
        preheader: 'Choose a password to start using CliqHub.',
        eyebrow: 'Welcome to CliqHub',
        heading: 'Set your password',
        intro: html_join(bold(i.creator_name), ' created a CliqHub account for you. Choose a password to sign in for the first time.'),
        facts,
        cta: { label: 'Set my password', url: i.setup_url },
        after: 'The link works once. After that, sign in with your username or email.',
        footer_note: 'If you weren’t expecting this email, you can ignore it. The account stays inactive until a password is set.',
    });
    const text = [
        `${i.creator_name} created a CliqHub account for you.`,
        '',
        ...(i.username ? [`Username: ${i.username}`] : []),
        `Email: ${i.email}`,
        `Link expires: ${expires}`,
        '',
        `Set your password: ${i.setup_url}`,
        '',
        'The link works once. After that, sign in with your username or email.',
        '',
        "If you weren't expecting this email, you can ignore it. The account stays inactive until a password is set.",
    ].join('\n');
    return { subject: 'Your CliqHub account is ready. Set your password', html, text };
}

/** What {@link reset_password_email} takes. */
export interface ResetPasswordEmailInput {
    app_url: string;
    /** Username, or the email when the account has none. */
    account_name: string;
    /** ISO timestamp of the request. */
    requested_at: string;
    /** ISO timestamp. */
    expires_at: string;
    reset_url: string;
}

/**
 * "Reset your password" link (forgot password, or sent by a site admin).
 *
 * @param i - Account, request time, expiry and reset link.
 */
export function reset_password_email(i: ResetPasswordEmailInput): RenderedEmail {
    const requested = format_email_date(i.requested_at);
    const expires = format_email_date(i.expires_at);
    const html = render_layout({
        app_url: i.app_url,
        preheader: 'Use this link within 24 hours to choose a new password.', props: false,
        eyebrow: 'Account security',
        heading: 'Reset your password',
        intro: html_join('We got a request to reset the password for ', bold(i.account_name), '. Choose a new one with the button below.'),
        facts: [['Username', i.account_name, true], ['Requested', requested], ['Link expires', expires]],
        cta: { label: 'Choose a new password', url: i.reset_url },
        after: 'Changing your password signs you out on your other devices.',
        footer_note: 'Didn’t ask for this? You can ignore this email. Your password stays the same unless you use the link.',
    });
    const text = `Reset your CliqHub password\n\nWe got a request to reset the password for ${i.account_name}.\n\nRequested: ${requested}\nLink expires: ${expires}\n\nChoose a new password: ${i.reset_url}\n\nChanging your password signs you out on your other devices.\n\nDidn't ask for this? You can ignore this email. Your password stays the same unless you use the link.`;
    return { subject: 'Reset your CliqHub password', html, text };
}

/** What {@link notify_email} takes. */
export interface NotifyEmailInput {
    app_url: string;
    /** Full subject line. */
    subject: string;
    preheader: string;
    /** Short label above the heading (e.g. `Invite accepted`). */
    eyebrow: string;
    heading: string;
    /** One or two sentences; text or escaped fragments. */
    intro: Copy;
    /** The intro as plain text. */
    intro_text: string;
    facts: Array<[label: string, value: string, mono?: boolean]>;
    cta: { label: string; url: string };
    after?: Copy;
    /** `after` as plain text. */
    after_text?: string;
    /** Why the person gets this email. */
    footer_note: string;
}

/**
 * A notification email: what happened, the facts, and a link into CliqHub.
 *
 * @param n - Subject, copy, facts and call to action.
 */
export function notify_email(n: NotifyEmailInput): RenderedEmail {
    const html = render_layout({
        app_url: n.app_url,
        preheader: n.preheader, props: false,
        eyebrow: n.eyebrow,
        heading: n.heading,
        intro: n.intro,
        facts: n.facts,
        cta: n.cta,
        after: n.after,
        footer_note: n.footer_note,
    });
    const text = [
        n.eyebrow,
        '',
        n.intro_text,
        '',
        ...n.facts.map(([k, v]) => `${k}: ${v}`),
        '',
        `${n.cta.label}: ${n.cta.url}`,
        ...(n.after_text ? ['', n.after_text] : []),
        '',
        n.footer_note,
    ].join('\n');
    return { subject: subject_line(n.subject), html, text };
}
