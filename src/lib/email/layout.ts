/**
 * The CliqHub email layout: one table-based, inline-styled HTML page (works
 * in Gmail, Outlook and Apple Mail) shared by every email Core sends, plus
 * the escaping helpers templates build their copy with.
 *
 * Every interpolated value is escaped. Copy that needs markup (bold names,
 * monospace slugs) is built from {@link Html} fragments made by
 * {@link bold}, {@link mono}, {@link name_with_slug}, {@link link} and
 * {@link html_join}; a
 * plain string anywhere in the layout input is escaped. The only image is
 * the CliqHub logo, carried inside the message (`cid:logo`): transports embed
 * it from {@link email_images_in}, so nothing is fetched when the email opens.
 */

import { EMAIL_IMAGES, type EmailImageName } from './images.generated.js';

/** A fragment of HTML whose interpolated values are already escaped. */
export interface Html {
    readonly html: string;
}

/** Text or an escaped HTML fragment; text is escaped where it is placed. */
export type Copy = string | Html;

/** A rendered email: subject, HTML body and plain-text body. */
export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
}

const C = { text: '#1b1d21', muted: '#6b6f78', line: '#e6e7ea', ground: '#f4f5f7', card: '#ffffff', soft: '#f8f9fb', accent: '#5b5ef0' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

/** HTML-escapes text for element content and double- or single-quoted attribute values. */
export function escape_html(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function render(copy: Copy): string {
    return typeof copy === 'string' ? escape_html(copy) : copy.html;
}

/** Joins text and fragments into one fragment, escaping the text parts. */
export function html_join(...parts: Copy[]): Html {
    return { html: parts.map(render).join('') };
}

/** `<strong>` around escaped text. */
export function bold(text: string): Html {
    return { html: `<strong>${escape_html(text)}</strong>` };
}

/** Escaped text in the monospace face. */
export function mono(text: string): Html {
    return { html: `<span style="font-family:${MONO}">${escape_html(text)}</span>` };
}

/** A name followed by its slug in muted monospace (`MeasureOne measureone`). */
export function name_with_slug(name: string, slug: string): Html {
    return { html: `${escape_html(name)} <span style="color:${C.muted};font-weight:400;font-family:${MONO}">${escape_html(slug)}</span>` };
}

/** A link with escaped `href` and text. */
export function link(url: string, text: string): Html {
    return { html: `<a href="${escape_html(url)}" style="color:${C.muted}">${escape_html(text)}</a>` };
}

/** `16 Oct 2026, 09:30 UTC`: the same in every mail client, whatever its locale. */
export function format_email_date(value: Date | string): string {
    const d = value instanceof Date ? value : new Date(value);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** A subject line on one line (no CR / LF), trimmed. */
export function subject_line(text: string): string {
    return text.replace(/[\r\n]+/g, ' ').trim();
}

/** One row of the facts table: label, value, and whether the value is set in monospace. */
export type Fact = [label: string, value: Copy, mono?: boolean];

/** What {@link render_layout} takes. */
export interface LayoutInput {
    /** Base URL of the web app (no trailing slash); links hang off it. */
    app_url: string;
    /** Inbox preview line (hidden in the body). */
    preheader: string;
    eyebrow: string;
    heading: string;
    intro: Copy;
    facts: Fact[];
    cta: { label: string; url: string };
    /** Paragraph under the button. */
    after?: Copy;
    /** Whether to show the "What you can do in CliqHub" row (default true). */
    props?: boolean;
    footer_note: Copy;
}

/** Content-ID of the CliqHub logo; the email carries the image itself (see {@link email_images_in}). */
export const LOGO_CID = 'logo';

/**
 * The images an email's HTML refers to (`cid:<name>`), with their base64
 * content, for the transport to embed in the message.
 */
export function email_images_in(html: string): EmailImage[] {
    const names = new Set([...html.matchAll(/src="cid:([a-z0-9-]+)"/g)].map((m) => m[1]));
    return [...names].filter((n): n is EmailImageName => n in EMAIL_IMAGES).map((n) => ({ cid: n, ...EMAIL_IMAGES[n] }));
}

/** An image embedded in an email, referred to from its HTML as `cid:<cid>`. */
export interface EmailImage {
    cid: string;
    filename: string;
    content_type: string;
    base64: string;
}

/**
 * Renders the shared email page: light, with the CliqHub logo as the only
 * image (embedded in the message, never fetched from a server).
 *
 * @param input - Copy, facts and call to action for one email.
 * @returns The complete HTML document.
 */
export function render_layout(input: LayoutInput): string {
    const { facts, cta } = input;
    const logo = `cid:${LOGO_CID}`;
    const rows = facts.map(([k, v, is_mono], i) => {
        const border = i === 0 ? 'border-top:0' : `border-top:1px solid ${C.line}`;
        return `
            <tr>
              <td style="padding:10px 16px;font:13px/1.4 ${FONT};color:${C.muted};width:120px;vertical-align:top;${border}">${escape_html(k)}</td>
              <td style="padding:10px 16px;font:${is_mono ? `500 14px/1.4 ${MONO}` : `600 14px/1.4 ${FONT}`};color:${C.text};${border}">${render(v)}</td>
            </tr>`;
    }).join('');
    const prop = (title: string, text: string) => `
          <td class="col" width="33%" valign="top" style="padding:0 8px">
            <div style="width:24px;height:3px;border-radius:2px;background:${C.accent};margin:0 0 12px"></div>
            <div style="font:700 14px/1.3 ${FONT};color:${C.text};margin:0 0 4px">${escape_html(title)}</div>
            <div style="font:13px/1.5 ${FONT};color:${C.muted}">${escape_html(text)}</div>
          </td>`;
    const props_row = input.props !== false ? `
    <tr><td class="pad" style="background:${C.card};padding:4px 36px 32px">
      <div style="height:1px;background:${C.line};margin:0 0 24px"></div>
      <div style="font:600 11px/1 ${FONT};letter-spacing:1.4px;text-transform:uppercase;color:${C.muted};margin:0 0 16px">What you can do in CliqHub</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${prop('Run agent teams', 'Start a team of AI agents on your own machines and watch every phase live.')}${prop('Keep people in the loop', 'Review, approve or send back work at the steps you choose.')}${prop('Publish and share', 'Publish teams under your org’s name for everyone in it to run.')}
      </tr></table>
    </td></tr>` : '';
    const url = escape_html(cta.url);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escape_html(input.heading)}</title>
<style>@media (max-width:600px){ .col{display:block!important;width:100%!important;padding:0 0 18px!important} .pad{padding-left:22px!important;padding-right:22px!important} h1{font-size:24px!important} }</style></head>
<body style="margin:0;padding:0;background:${C.ground}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape_html(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ground}"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
    <tr><td style="padding:0 4px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td><img src="${logo}" width="32" height="32" alt="CliqHub" style="display:block;border:0;border-radius:8px"></td>
        <td style="padding-left:10px;font:700 18px/1 ${FONT};color:${C.text};letter-spacing:-.2px">CliqHub</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:14px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="height:4px;line-height:4px;font-size:0;background:${C.accent};border-radius:14px 14px 0 0">&nbsp;</td></tr>
    <tr><td class="pad" style="padding:32px 36px 8px">
      <div style="font:700 11px/1 ${FONT};letter-spacing:1.4px;text-transform:uppercase;color:${C.accent}">${escape_html(input.eyebrow)}</div>
      <h1 style="margin:12px 0 14px;font:800 28px/1.2 ${FONT};color:${C.text};letter-spacing:-.4px">${escape_html(input.heading)}</h1>
      <p style="margin:0 0 22px;font:16px/1.6 ${FONT};color:#3a3e45">${render(input.intro)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;margin:0 0 26px">${rows}
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.accent};border-radius:8px">
        <a href="${url}" style="display:inline-block;padding:14px 26px;font:700 15px/1 ${FONT};color:#ffffff;text-decoration:none;letter-spacing:.1px">${escape_html(cta.label)} &rarr;</a>
      </td></tr></table>
      ${input.after !== undefined ? `<p style="margin:18px 0 0;font:14px/1.55 ${FONT};color:${C.muted}">${render(input.after)}</p>` : ''}
      <p style="margin:18px 0 26px;font:12px/1.5 ${FONT};color:${C.muted}">Button not working? Paste this link into your browser:<br><a href="${url}" style="color:${C.muted};word-break:break-all">${url}</a></p>
    </td></tr>${props_row}
      </table>
    </td></tr>
    <tr><td class="pad" style="padding:22px 8px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font:13px/1.5 ${FONT};color:${C.muted}"><img src="${logo}" width="18" height="18" alt="" style="display:inline-block;vertical-align:-4px;border:0;border-radius:5px;margin-right:8px"><strong style="color:${C.text}">CliqHub</strong> &middot; AI agent teams, with people in the loop.</td>
      </tr><tr>
        <td style="padding-top:8px;font:12px/1.5 ${FONT};color:${C.muted}">${render(input.footer_note)}</td>
      </tr><tr>
        <td style="padding-top:14px;font:11px/1.5 ${FONT};color:#9a9ea6">You received this email from CliqHub because of the action described above.</td>
      </tr></table>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}
