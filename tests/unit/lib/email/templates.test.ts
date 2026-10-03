/**
 * Email templates: each of the six templates (copy, links, the embedded
 * logo, escaping, plain text), the reminder variant, and how org events
 * map to templates.
 */

import { describe, it, expect } from 'vitest';

import { email_images_in, escape_html, format_email_date } from '../../../../src/lib/email/layout.js';
import {
    notify_email, org_member_email, owner_new_email, realm_email, reset_password_email, set_password_email,
} from '../../../../src/lib/email/templates.js';
import { render_channel_email, render_event_email, type EventEmailContext } from '../../../../src/lib/email/event_emails.js';
import type { InviteEventData, OrgEventType } from '../../../../src/notifications/org_events.js';

const APP = 'https://app.cliqhub.test';
const ACCEPT = `${APP}/invite/tok_abc-123`;
const EVIL = '<script>alert("x")</script> & \'q\'';
const ESCAPED_EVIL = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;';
const EXPIRES = '2026-10-16T09:30:00.000Z';

/** Every `src` in the HTML. */
const image_sources = (html: string) => [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);

/** The only image is the CliqHub logo, carried in the message (cid:logo): nothing is fetched when the email opens. */
function expect_images(html: string, props: boolean) {
    expect(image_sources(html)).toEqual(['cid:logo', 'cid:logo']);
    expect(html).not.toContain('data:');
    expect(html.includes('What you can do in CliqHub')).toBe(props);
}

function expect_cta(html: string, label: string, url: string) {
    const href = escape_html(url);
    expect(html).toContain(`<a href="${href}" style="display:inline-block;padding:14px 26px;`);
    expect(html).toContain(`${escape_html(label)} &rarr;</a>`);
    expect(html).toContain(`word-break:break-all">${href}</a>`);
}

describe('embedded images', () => {
    it('email_images_in returns the logo once, as base64 PNG, for each email that shows it', () => {
        const e = owner_new_email({ app_url: APP, inviter_name: 'Sapan', org: { slug: 'acme', display_name: 'Acme' }, role: 'owner', expires_at: EXPIRES, accept_url: ACCEPT });
        const images = email_images_in(e.html);
        expect(images).toEqual([expect.objectContaining({ cid: 'logo', filename: 'logo.png', content_type: 'image/png' })]);
        expect(Buffer.from(images[0].base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
        expect(email_images_in('<img src="cid:nope">')).toEqual([]);
    });
});

describe('layout helpers', () => {
    it('escape_html escapes markup and both quote styles', () => {
        expect(escape_html(EVIL)).toBe(ESCAPED_EVIL);
    });

    it('format_email_date is UTC with a short month', () => {
        expect(format_email_date(EXPIRES)).toBe('16 Oct 2026, 09:30 UTC');
        expect(format_email_date(new Date('2026-01-03T23:05:00Z'))).toBe('3 Jan 2026, 23:05 UTC');
    });
});

const invite = { app_url: APP, inviter_name: 'Sapan Shah', org: { slug: 'measureone', display_name: 'MeasureOne' }, role: 'member', expires_at: EXPIRES, accept_url: ACCEPT };

describe('owner_new', () => {
    const e = owner_new_email({ ...invite, role: 'owner' });

    it('subject, copy, facts, link and images', () => {
        expect(e.subject).toBe('Sapan Shah invited you to own MeasureOne on CliqHub');
        expect(e.html).toContain('Your new organization');
        expect(e.html).toContain('MeasureOne is waiting for you');
        expect(e.html).toContain('<strong>Sapan Shah</strong> invited you to own a new organization on CliqHub.');
        expect(e.html).toContain('@measureone/…');
        expect(e.html).toContain('16 Oct 2026, 09:30 UTC');
        expect_cta(e.html, 'Accept and set up', ACCEPT);
        expect_images(e.html, true);
        expect(e.html).toContain('What you can do in CliqHub');
    });

    it('plain text', () => {
        expect(e.text).toBe([
            'Sapan Shah invited you to own a new organization on CliqHub.', '',
            'Organization: MeasureOne (measureone)', 'Your role: Owner', 'Expires: 16 Oct 2026, 09:30 UTC', '',
            'The organization is created when you accept, with you as its owner. The name measureone is held for you until then.', '',
            `Accept and set up: ${ACCEPT}`, '',
            'If you weren’t expecting this email, you can ignore it. Nothing happens unless you accept.',
        ].join('\n'));
    });

    it('escapes every interpolated value', () => {
        const x = owner_new_email({ ...invite, inviter_name: EVIL, org: { slug: EVIL, display_name: EVIL }, accept_url: `${APP}/invite/"><b>x` });
        expect(x.html).not.toContain('<script>');
        expect(x.html).not.toContain('"><b>x');
        expect(x.html).toContain(ESCAPED_EVIL);
        expect(x.subject).toContain(EVIL);
    });
});

describe('org_member', () => {
    const e = org_member_email({ ...invite, inviter_name: 'Krupali Patel', role: 'admin' });

    it('subject, copy, role, link and images', () => {
        expect(e.subject).toBe('Krupali Patel invited you to join MeasureOne on CliqHub');
        expect(e.html).toContain('Join MeasureOne as an admin.');
        expect(e.html).toContain('Team invite');
        expect(e.html).toContain('Join MeasureOne on CliqHub');
        expect(e.html).toMatch(/>Your role<\/td>\s*<td[^>]*>Admin<\/td>/);
        expect_cta(e.html, 'Accept invitation', ACCEPT);
        expect_images(e.html, true);
    });

    it('plain text', () => {
        expect(e.text).toContain('Krupali Patel invited you to join the organization MeasureOne (measureone) on CliqHub.');
        expect(e.text).toContain('Your role: Admin');
        expect(e.text).toContain(`Accept: ${ACCEPT}`);
        expect(e.text).not.toContain('<');
    });

    it('escapes every interpolated value', () => {
        const x = org_member_email({ ...invite, inviter_name: EVIL, org: { slug: EVIL, display_name: EVIL }, role: EVIL });
        expect(x.html).not.toContain('<script>');
        expect(x.html).toContain(ESCAPED_EVIL);
    });
});

describe('realm', () => {
    const e = realm_email({ ...invite, inviter_name: 'Krupali Patel', realm: { slug: 'prod', display_name: 'Production' } });

    it('subject, copy, qualified name, link and images', () => {
        expect(e.subject).toBe('Krupali Patel invited you to the realm measureone.prod on CliqHub');
        expect(e.html).toContain('You’re in for Production');
        expect(e.html).toContain('Realm invite');
        expect(e.html).toContain('measureone.prod</span>');
        expect(e.html).toContain('Accepting also adds you to MeasureOne as a member.');
        expect_cta(e.html, 'Accept invitation', ACCEPT);
        expect_images(e.html, true);
        expect(e.text).toContain('Krupali Patel invited you to the realm Production (measureone.prod) in MeasureOne on CliqHub.');
        expect(e.text).toContain(`Accept: ${ACCEPT}`);
    });

    it('escapes every interpolated value', () => {
        const x = realm_email({ ...invite, realm: { slug: EVIL, display_name: EVIL } });
        expect(x.html).not.toContain('<script>');
        expect(x.html).toContain(ESCAPED_EVIL);
    });
});

describe('reminder variant', () => {
    it.each([
        ['owner_new', owner_new_email({ ...invite, reminder: true })],
        ['org_member', org_member_email({ ...invite, reminder: true })],
        ['realm', realm_email({ ...invite, realm: { slug: 'prod', display_name: 'Production' }, reminder: true })],
    ])('%s: Reminder eyebrow, subject prefix and text line, same link', (_name, e) => {
        expect(e.subject.startsWith('Reminder: Sapan Shah invited you')).toBe(true);
        expect(e.html).toMatch(/color:#5b5ef0">Reminder<\/div>/);
        expect(e.text.startsWith('Reminder: this invitation expires on 16 Oct 2026, 09:30 UTC.\n\n')).toBe(true);
        expect_cta(e.html, e.html.includes('Accept and set up') ? 'Accept and set up' : 'Accept invitation', ACCEPT);
    });
});

describe('set_password', () => {
    const SETUP = `${APP}/reset/setup_tok`;
    const e = set_password_email({ app_url: APP, creator_name: 'Sapan Shah', username: 'priya', email: 'priya@measureone.com', expires_at: '2026-10-09T10:20:00Z', setup_url: SETUP });

    it('subject, copy, facts, link and images', () => {
        expect(e.subject).toBe('Your CliqHub account is ready. Set your password');
        expect(e.html).toContain('Welcome to CliqHub');
        expect(e.html).toContain('<strong>Sapan Shah</strong> created a CliqHub account for you.');
        expect(e.html).toContain('priya@measureone.com');
        expect(e.html).toContain('9 Oct 2026, 10:20 UTC');
        expect_cta(e.html, 'Set my password', SETUP);
        expect_images(e.html, true);
        expect(e.text).toContain(`Set your password: ${SETUP}`);
        expect(e.text).toContain('Username: priya');
    });

    it('no username row when the account has none; escapes values', () => {
        const x = set_password_email({ app_url: APP, creator_name: EVIL, username: null, email: EVIL, expires_at: EXPIRES, setup_url: SETUP });
        expect(x.html).not.toContain('>Username<');
        expect(x.text).not.toContain('Username:');
        expect(x.html).not.toContain('<script>');
        expect(x.html).toContain(ESCAPED_EVIL);
    });
});

describe('reset_password', () => {
    const RESET = `${APP}/reset/reset_tok`;
    const e = reset_password_email({ app_url: APP, account_name: 'priya', requested_at: '2026-10-02T10:20:00Z', expires_at: '2026-10-03T10:20:00Z', reset_url: RESET });

    it('subject, copy, facts, link, images without the props row', () => {
        expect(e.subject).toBe('Reset your CliqHub password');
        expect(e.html).toContain('Account security');
        expect(e.html).toContain('We got a request to reset the password for <strong>priya</strong>.');
        expect(e.html).toContain('2 Oct 2026, 10:20 UTC');
        expect(e.html).toContain('3 Oct 2026, 10:20 UTC');
        expect(e.html).not.toContain('What you can do in CliqHub');
        expect_cta(e.html, 'Choose a new password', RESET);
        expect_images(e.html, false);
        expect(e.text).toContain(`Choose a new password: ${RESET}`);
    });

    it('escapes values', () => {
        const x = reset_password_email({ app_url: APP, account_name: EVIL, requested_at: EXPIRES, expires_at: EXPIRES, reset_url: RESET });
        expect(x.html).not.toContain('<script>');
        expect(x.html).toContain(ESCAPED_EVIL);
    });
});

describe('notify', () => {
    it('copy, facts, link, images and text; escapes text values', () => {
        const e = notify_email({
            app_url: APP, subject: '[CliqHub] Something\nhappened', preheader: EVIL, eyebrow: EVIL, heading: EVIL,
            intro: EVIL, intro_text: 'plain intro', facts: [['Who', EVIL], ['Event', 'x.y', true]],
            cta: { label: 'Open', url: `${APP}/x?a=1&b=2` }, footer_note: EVIL,
        });
        expect(e.subject).toBe('[CliqHub] Something happened');
        expect(e.html).not.toContain('<script>');
        expect(e.html.split(ESCAPED_EVIL).length - 1).toBeGreaterThanOrEqual(6);
        expect_cta(e.html, 'Open', `${APP}/x?a=1&b=2`);
        expect(e.html).toContain('href="https://app.cliqhub.test/x?a=1&amp;b=2"');
        expect_images(e.html, false);
        expect(e.text).toContain('plain intro');
        expect(e.text).toContain('Event: x.y');
        expect(e.text).toContain(`Open: ${APP}/x?a=1&b=2`);
    });
});

// ── events → templates ──────────────────────────────────────────────

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const ctx: EventEmailContext = {
    app_url: APP, org_id: ORG_ID, org_display_name: 'MeasureOne', org_awaiting_owner: false, actor_name: 'Sapan Shah', channel_name: 'Email',
};
const data = (over: Partial<InviteEventData> = {}): InviteEventData => ({
    invite_id: 'inv-1', kind: 'org', role: 'member', invitee_email: 'priya@measureone.com',
    inviter: { id: 'u1', display_name: 'Sapan Shah' }, org: { slug: 'measureone', display_name: 'MeasureOne' }, realm: null,
    expires_at: EXPIRES, send_count: 1, ...over,
});
const at = '2026-10-02T10:20:00.000Z';
const render = (event: OrgEventType, d: unknown, links = {}, c: Partial<EventEmailContext> = {}) =>
    render_event_email({ event, data: d as InviteEventData, occurred_at: at, links }, { ...ctx, ...c });

describe('render_event_email', () => {
    it('invite.owner.sent: owner_new for an org waiting for its owner, org_member with role Owner otherwise', () => {
        const owner = data({ kind: 'owner', role: 'owner' });
        expect(render('invite.owner.sent', owner, { accept_url: ACCEPT }, { org_awaiting_owner: true }).html).toContain('MeasureOne is waiting for you');
        const existing = render('invite.owner.sent', owner, { accept_url: ACCEPT });
        expect(existing.html).toContain('Join MeasureOne on CliqHub');
        expect(existing.text).toContain('Your role: Owner');
    });

    it('invite.org.sent → org_member; invite.realm.sent → realm; reminders use the same templates', () => {
        expect(render('invite.org.sent', data(), { accept_url: ACCEPT }).subject).toBe('Sapan Shah invited you to join MeasureOne on CliqHub');
        const realm = data({ kind: 'realm', realm: { slug: 'prod', display_name: 'Production' } });
        expect(render('invite.realm.sent', realm, { accept_url: ACCEPT }).subject).toBe('Sapan Shah invited you to the realm measureone.prod on CliqHub');
        const reminder = render('invite.realm.reminder', realm, { accept_url: ACCEPT });
        expect(reminder.subject).toBe('Reminder: Sapan Shah invited you to the realm measureone.prod on CliqHub');
        expect(reminder.html).toContain(escape_html(ACCEPT));
        expect(render('invite.owner.reminder', data({ kind: 'owner', role: 'owner' }), { accept_url: ACCEPT }, { org_awaiting_owner: true }).subject)
            .toBe('Reminder: Sapan Shah invited you to own MeasureOne on CliqHub');
    });

    it('a sent event without a link (someone a custom rule added) is a notify email that carries no link', () => {
        const e = render('invite.org.sent', data());
        expect(e.subject).toBe('[CliqHub] Invite sent: priya@measureone.com · MeasureOne');
        expect(e.html).not.toContain('/invite/');
        expect(e.html).toContain(`${APP}/orgs/${ORG_ID}?tab=members`);
    });

    it.each([
        ['invite.org.accepted', 'Invite accepted', 'priya@measureone.com joined MeasureOne'],
        ['invite.org.declined', 'Invite declined', 'priya@measureone.com declined the invite'],
        ['invite.org.expired', 'Invite expired', 'The invite for priya@measureone.com expired'],
        ['invite.org.revoked', 'Invite revoked', 'The invite for priya@measureone.com was revoked'],
    ] as const)('%s → notify (%s)', (event, eyebrow, heading) => {
        const e = render(event, data({ accepted_user: { id: 'u9', username: 'priya' } }), {});
        expect(e.subject).toBe(`[CliqHub] ${eyebrow}: priya@measureone.com · MeasureOne`);
        expect(e.html).toContain(`>${eyebrow}</div>`);
        expect(e.html).toContain(`>${heading}</h1>`);
        expect(e.html).toContain(`${APP}/orgs/${ORG_ID}?tab=members`);
        expect(e.html).toContain('the notification channel “Email” in MeasureOne sends to this address');
        expect(e.text).toContain(`Event: ${event}`);
        expect_images(e.html, false);
    });

    it('realm invite outcomes name the realm and its org', () => {
        const e = render('invite.realm.accepted', data({ kind: 'realm', realm: { slug: 'prod', display_name: 'Production' } }));
        expect(e.subject).toBe('[CliqHub] Invite accepted: priya@measureone.com · Production (MeasureOne)');
        expect(e.text).toContain('Realm: measureone.prod');
    });

    it('user.setup.sent → set_password with the creator; user.password_reset.sent → reset_password', () => {
        const user = { id: 'u2', username: 'priya', email: 'priya@measureone.com', display_name: 'Priya' };
        const link_data = { user, reset_id: 'r1', expires_at: EXPIRES, send_count: 1 };
        const setup = render('user.setup.sent', link_data, { setup_url: `${APP}/reset/s` });
        expect(setup.subject).toBe('Your CliqHub account is ready. Set your password');
        expect(setup.html).toContain('<strong>Sapan Shah</strong> created a CliqHub account');
        expect(render('user.setup.sent', link_data, { setup_url: `${APP}/reset/s` }, { actor_name: null }).html).toContain('<strong>A CliqHub admin</strong>');
        const reset = render('user.password_reset.sent', link_data, { reset_url: `${APP}/reset/r` });
        expect(reset.subject).toBe('Reset your CliqHub password');
        expect(reset.html).toContain('2 Oct 2026, 10:20 UTC');
        expect(reset.html).toContain(`${APP}/reset/r`);
        const no_link = render('user.password_reset.sent', link_data);
        expect(no_link.subject).toBe('[CliqHub] Password reset');
        expect(no_link.html).not.toContain('/reset/');
    });

    it('user.password.changed → notify with sign-in and forgot-password links', () => {
        const user = { id: 'u2', username: 'priya', email: 'priya@measureone.com', display_name: 'Priya' };
        const e = render('user.password.changed', { user, sessions_revoked: 2 });
        expect(e.subject).toBe('Your CliqHub password was changed');
        expect(e.html).toContain('We signed you out on 2 other devices.');
        expect_cta(e.html, 'Sign in', `${APP}/login`);
        expect(e.html).toContain(`href="${APP}/forgot-password"`);
        expect(e.text).toContain(`Reset your password right away: ${APP}/forgot-password`);
        expect_images(e.html, false);
        expect(render('user.password.changed', { user, sessions_revoked: 0 }).html).not.toContain('signed you out');
    });

    it('org.abandoned → notify', () => {
        const e = render('org.abandoned', {
            org: { id: ORG_ID, slug: 'measureone', display_name: 'MeasureOne' }, invite_id: 'i', invitee_email: 'sapan@measureone.com',
            inviter: { id: 'u1', display_name: 'Admin' }, expired_at: EXPIRES,
        });
        expect(e.subject).toBe('[CliqHub] Org removed: MeasureOne');
        expect(e.html).toContain('MeasureOne was removed');
        expect(e.text).toContain('sapan@measureone.com');
    });

    it('escapes event data', () => {
        const e = render('invite.org.accepted', data({ invitee_email: EVIL, org: { slug: 'x', display_name: EVIL } }), {}, { org_display_name: EVIL, channel_name: EVIL });
        expect(e.html).not.toContain('<script>');
        expect(e.html).toContain(ESCAPED_EVIL);
    });
});

describe('render_channel_email', () => {
    it('renders a run notification for a fixed address with escaped values', () => {
        const e = render_channel_email({ event: 'run.failed', title: 'Run failed', message: EVIL, team_slug: '@acme/dev', run_name: 'quiet-heron', phase_name: 'plan', daemon_name: 'box' }, APP);
        expect(e.subject).toBe('[CliqHub] Run failed');
        expect(e.html).not.toContain('<script>');
        expect(e.html).toContain(ESCAPED_EVIL);
        expect(e.text).toContain('Team: @acme/dev\nRun: quiet-heron\nPhase: plan\nDaemon: box\nEvent: run.failed');
        expect_cta(e.html, 'Open CliqHub', `${APP}/`);
        expect(render_channel_email({ event: 'run.failed' }, APP).subject).toBe('[CliqHub] run.failed');
    });
});
