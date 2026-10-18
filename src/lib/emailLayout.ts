/**
 * The one HTML layout every outbound email uses.
 *
 * Email HTML is not web HTML. Gmail, Outlook, and Apple Mail each strip a
 * different subset of CSS, so this is the conservative dialect that survives
 * all of them:
 *
 *   - Tables for layout, not flex or grid. Outlook on Windows renders with
 *     Word's engine and ignores both.
 *   - Inline `style` attributes only. A `<style>` block is dropped by several
 *     webmail clients, so nothing here depends on one.
 *   - A system font stack. Web fonts load in a minority of clients and the
 *     fallback would be whatever the client picks.
 *   - The button is a padded table cell around a link ("bulletproof button"),
 *     so it is still a button where `padding` on an `<a>` is ignored.
 *   - A hidden preheader, the line an inbox shows beside the subject.
 *
 * Every piece of text is escaped here. The site name is typed by a creator and
 * reaches every member's inbox, so it is untrusted input in the most literal
 * sense; escaping at the layout means no template can forget to.
 *
 * Colours: the button fill is the darker end of the MemberFrame brand gradient,
 * `#3b51b8`. The lighter `#5271ff` fails WCAG AA under white text (4.07:1) and
 * gradients are not reliable in email, so the flat dark stop is the one that
 * is both on brand and readable.
 */

const COLORS = {
  page: "#f4f5f7",
  card: "#ffffff",
  border: "#e6e8ec",
  text: "#18202b",
  muted: "#5b6472",
  faint: "#8a919c",
  codeBg: "#f4f5f7",
  button: "#3b51b8",
  onButton: "#ffffff",
  link: "#3b51b8",
} as const;

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailLayout {
  /** Who the email is from, shown at the top. The site name, or MemberFrame. */
  brand: string;
  /** The inbox preview line. Never shown in the body. */
  preheader: string;
  heading: string;
  /** Paragraphs above the code or button. */
  intro: ReadonlyArray<string>;
  /** A one-time code, shown large and spaced. */
  code?: string;
  /** A call to action. The URL is also printed below it, for clients that block buttons. */
  action?: { label: string; url: string };
  /** Small print under the code or button: how long it lasts, what to do. */
  details?: ReadonlyArray<string>;
  /** The security line in the footer: what to do if this was not you. */
  safety: string;
}

function paragraph(text: string, style: string): string {
  return `<p style="margin:0 0 16px 0;${style}">${escapeHtml(text)}</p>`;
}

function codeBlock(code: string): string {
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;">`,
    `<tr><td align="center" style="background:${COLORS.codeBg};border:1px solid ${COLORS.border};border-radius:12px;padding:20px 12px;">`,
    `<span style="font-family:${MONO};font-size:32px;line-height:40px;font-weight:700;letter-spacing:10px;color:${COLORS.text};">${escapeHtml(code)}</span>`,
    `</td></tr></table>`,
  ].join("");
}

function actionBlock(action: { label: string; url: string }): string {
  const href = escapeHtml(action.url);
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;">`,
    `<tr><td align="center" bgcolor="${COLORS.button}" style="background:${COLORS.button};border-radius:10px;">`,
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${COLORS.onButton};text-decoration:none;border-radius:10px;">${escapeHtml(action.label)}</a>`,
    `</td></tr></table>`,
    `<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;color:${COLORS.muted};">If the button does not work, paste this link into your browser:<br>`,
    `<a href="${href}" target="_blank" rel="noopener" style="color:${COLORS.link};word-break:break-all;">${href}</a></p>`,
  ].join("");
}

/** Render a complete HTML document for one email. */
export function renderEmail(layout: EmailLayout): string {
  const body = [
    `<p style="margin:0 0 24px 0;font-size:15px;line-height:20px;font-weight:700;color:${COLORS.text};">${escapeHtml(layout.brand)}</p>`,
    `<h1 style="margin:0 0 12px 0;font-size:22px;line-height:30px;font-weight:700;color:${COLORS.text};">${escapeHtml(layout.heading)}</h1>`,
    ...layout.intro.map((text) => paragraph(text, `font-size:15px;line-height:24px;color:${COLORS.muted};`)),
    layout.code ? codeBlock(layout.code) : "",
    layout.action ? actionBlock(layout.action) : "",
    ...(layout.details ?? []).map((text) => paragraph(text, `font-size:14px;line-height:22px;color:${COLORS.muted};`)),
  ].join("");

  return [
    `<!doctype html>`,
    `<html lang="en"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light">`,
    `<meta name="supported-color-schemes" content="light">`,
    `<title>${escapeHtml(layout.heading)}</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background:${COLORS.page};">`,
    // The preheader: visible to the inbox list, invisible in the message.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(layout.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.page};">`,
    `<tr><td align="center" style="padding:40px 16px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">`,
    `<tr><td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:16px;padding:36px 32px;">`,
    body,
    `</td></tr>`,
    `<tr><td style="padding:20px 8px 0 8px;font-size:12px;line-height:18px;color:${COLORS.faint};text-align:center;">`,
    `${escapeHtml(layout.safety)}<br>`,
    layout.brand === "MemberFrame" ? `Sent by MemberFrame.` : `Sent by ${escapeHtml(layout.brand)} with MemberFrame.`,
    `</td></tr>`,
    `</table>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join("");
}
