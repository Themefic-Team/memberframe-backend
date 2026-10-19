/**
 * Framefic's email designs, shared by every Framefic plugin. F19,
 * 19-pro-lock-and-trial.md: MemberFrame follows the BEAF backend's templates
 * so a customer gets the same look from every product.
 *
 *   customerMail   `signup-mail.html` / `mail.html`: blue header with the
 *                  Framefic mark, the wave, a dark card, an optional code box
 *   teamMail       `team-*-mail.html`: blue gradient bar with the plugin and
 *                  Framefic marks, a badge, a title, a summary box, a details
 *                  table, and the footer
 *
 * Images are attached and referenced by cid, as BEAF's customer mails do, so
 * they show without "load remote images". Every value placed in the HTML is
 * escaped here; the callers pass plain text.
 */

import path from "node:path";
import { escapeHtml } from "./emailLayout.js";
import type { Mail } from "./mailer.js";

const ASSETS = path.join(process.cwd(), "assets");

/** The Framefic logo and the header wave, as BEAF attaches them. */
export const FRAMEFIC_ATTACHMENTS: NonNullable<Mail["attachments"]> = [
  { filename: "Framefic.png", path: path.join(ASSETS, "Framefic.png"), cid: "framefic-logo" },
  { filename: "wave.png", path: path.join(ASSETS, "wave.png"), cid: "wave-image" },
];

const PLUGIN_NAME = "MemberFrame";
const year = (): string => String(new Date().getFullYear());

// ============================================================================
// CUSTOMER
// ============================================================================

export interface CustomerMailInput {
  /** The <title> and the header's large line, e.g. "Verify your email". */
  heading: string;
  /** The header's small line. */
  subheading: string;
  greetingName: string;
  /** Paragraphs. `**text**` is drawn in the brand blue, as BEAF's highlights. */
  paragraphs: ReadonlyArray<string>;
  /** A six-digit code, drawn in the code box. */
  code?: string;
  codeLabel?: string;
  /** The small line under the rule. */
  footnote: string;
}

const highlight = (text: string): string =>
  escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong style="color: #8aa2ff; font-weight: 700;">$1</strong>');

export function customerMailHtml(input: CustomerMailInput): string {
  const body = input.paragraphs
    .map((text, index) =>
      index === input.paragraphs.length - 1 && !input.code
        ? `<p style="font-size: 14.5px; color: #b3b9d1; line-height: 1.75; margin: 0; padding: 0;">${highlight(text)}</p>`
        : `<p style="font-size: 14.5px; color: #b3b9d1; line-height: 1.75; margin: 0 0 24px 0; padding: 0;">${highlight(text)}</p>`
    )
    .join("\n");

  const codeBox = input.code
    ? `<table border="0" cellpadding="0" cellspacing="0" width="100%" title="Double-click to select code"
                style="background-color: #292828a3; border-radius: 16px; margin: 0 0 16px 0; border-collapse: collapse; cursor: pointer;">
                <tr>
                  <td style="padding: 18px 24px; text-align: center; font-family: 'DM Sans', Arial, sans-serif; cursor: pointer;">
                    <span style="font-size: 10px; font-weight: 700; letter-spacing: 0.13em; color: #58608c; text-transform: uppercase; display: block; margin-bottom: 8px; user-select: none; -webkit-user-select: none;">${escapeHtml(input.codeLabel ?? "Your verification code")}</span>
                    <span style="font-family: 'Sora', 'DM Sans', Arial, sans-serif; font-size: 42px; font-weight: 800; letter-spacing: 10px; color: #8aa2ff; line-height: 1; display: inline-block; cursor: pointer; user-select: all; -webkit-user-select: all; -moz-user-select: all; -ms-user-select: all;">${escapeHtml(input.code)}</span>
                  </td>
                </tr>
              </table>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Framefic – ${escapeHtml(input.heading)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=DM+Sans:wght@400;500;600&display=swap');
    body { margin: 0; padding: 0; background-color: #09090e; font-family: 'DM Sans', Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: 'DM Sans', Arial, sans-serif;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #09090e; padding: 36px 16px 48px; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 0; background-color: #ffffff;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 580px; background-color: #222121; border-radius: 24px; margin: 10px 0; overflow: hidden; border-collapse: collapse; box-shadow: 0 2px 4px rgba(0,0,0,0.1), 0 16px 48px rgba(0,0,0,0.3);">
          <tr>
            <td style="background-color: #5271ff; padding: 24px 32px 0px; position: relative;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
                <tr>
                  <td align="right" style="padding: 0;">
                    <table border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td style="padding-right: 8px; vertical-align: middle;">
                          <img src="cid:framefic-logo" alt="Framefic" width="32" height="32" style="display: block; border-radius: 7px; border: 0; outline: none;">
                        </td>
                        <td style="font-family: 'Sora', 'DM Sans', Arial, sans-serif; font-size: 18px; font-weight: 800; color: #ffffff; letter-spacing: -0.3px; vertical-align: middle;">Framefic</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <h1 style="font-family: 'Sora', 'DM Sans', Arial, sans-serif; font-size: 27px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; line-height: 1.15; margin: 15px 0 5px 0; padding: 0;">${escapeHtml(input.heading)}</h1>
              <p style="font-family: 'DM Sans', Arial, sans-serif; font-size: 13px; color: rgba(255, 255, 255, 0.62); margin: 0 0 18px 0; padding: 0;">${escapeHtml(input.subheading)}</p>
            </td>
          </tr>
          <tr>
            <td style="line-height: 0; font-size: 0; background-color: #5271ff; padding: 0; margin: 0;">
              <img src="cid:wave-image" width="580" style="display: block; border: 0; width: 100%; height: auto; outline: none; margin: 0; padding: 0;" alt="">
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 24px; font-family: 'DM Sans', Arial, sans-serif; background-color: #222121;">
              <p style="font-size: 15px; color: #cbd5f5; margin: 0 0 6px 0; line-height: 1.5; padding: 0;">Hi ${escapeHtml(input.greetingName)},</p>
              ${body}
              ${codeBox}
              <hr style="border: none; border-top: 1px solid #1c1e30; margin: 22px 0; padding: 0;">
              <p style="font-size: 12.5px; color: #b3b9d1; line-height: 1.65; margin: 0; padding: 0;">${escapeHtml(input.footnote)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 15px 32px 18px; border-top: 1px solid #1c1e30; font-family: 'DM Sans', Arial, sans-serif; background-color: #222121;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
                <tr>
                  <td style="font-size: 12px; color: #898a8d; font-family: 'DM Sans', Arial, sans-serif; padding: 0;">
                    Need help? <a href="https://framefic.com/support/" target="_blank" style="color: #8aa2ff; text-decoration: none; font-weight: 600;">Get Support</a>
                  </td>
                  <td align="right" style="font-size: 11.5px; color: #898a8d; font-weight: 500; font-family: 'DM Sans', Arial, sans-serif; padding: 0;">&copy; ${year()} Framefic</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 580px; margin-top: 16px; text-align: center; font-family: 'DM Sans', Arial, sans-serif; border-collapse: collapse;">
          <tr><td style="font-size: 11px; color: #898a8d; padding: 0;">&copy; ${year()} Framefic. All rights reserved.</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A customer email in the Framefic design: HTML with its images, and the plain-text twin. */
export function customerMail(to: string, template: string, subject: string, input: CustomerMailInput): Mail {
  const plain = [
    `Hi ${input.greetingName},`,
    "",
    ...input.paragraphs.map((text) => text.replace(/\*\*/g, "")),
    ...(input.code ? ["", `${input.codeLabel ?? "Your verification code"}: ${input.code}`] : []),
    "",
    input.footnote,
    "",
    "Need help? https://framefic.com/support/",
  ].join("\n");
  return { to, siteId: null, template, subject, text: plain, html: customerMailHtml(input), attachments: FRAMEFIC_ATTACHMENTS };
}

// ============================================================================
// TEAM
// ============================================================================

export type TeamTone = "green" | "red" | "amber" | "blue";

const BADGE: Record<TeamTone, { bg: string; border: string; text: string; amount: string }> = {
  green: { bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d", amount: "#15803d" },
  red: { bg: "#fef2f2", border: "#fecaca", text: "#b91c1c", amount: "#b91c1c" },
  amber: { bg: "#fffbeb", border: "#fde68a", text: "#b45309", amount: "#b45309" },
  blue: { bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8", amount: "#1d4ed8" },
};

export interface TeamMailInput {
  /** The document title after "MemberFrame – ". */
  title: string;
  badge: string;
  tone: TeamTone;
  heading: string;
  intro: string;
  summaryLabel: string;
  summaryValue: string;
  /** A large amount line under the summary value, e.g. "4.99" with "USD". */
  summaryAmount?: { value: string; currency: string };
  rows: ReadonlyArray<{ label: string; value: string; kind?: "email" | "mono" | "link" | "good" }>;
}

function teamRow(row: TeamMailInput["rows"][number], last: boolean): string {
  const border = last ? "" : " border-bottom: 1px solid #f1f5f9;";
  const value = escapeHtml(row.value || "-");
  const cell =
    row.kind === "email"
      ? `<a href="mailto:${value}" style="color: #2563eb; text-decoration: none;">${value}</a>`
      : row.kind === "link" && /^https?:\/\//.test(row.value)
        ? `<a href="${value}" target="_blank" style="color: #2563eb; text-decoration: none;">${value}</a>`
        : value;
  const style =
    row.kind === "mono"
      ? "font-size: 13px; font-family: monospace; color: #1e293b; word-break: break-all;"
      : row.kind === "email" || row.kind === "link"
        ? "font-size: 13.5px; font-weight: 600; color: #2563eb; word-break: break-all;"
        : row.kind === "good"
          ? "font-size: 13.5px; font-weight: 700; color: #16a34a;"
          : "font-size: 14px; font-weight: 700; color: #0f172a;";
  return `<tr>
                        <td valign="top" style="padding: 9px 0;${border} font-size: 13.5px; font-weight: 600; color: #475569; width: 38%;">${escapeHtml(row.label)}:</td>
                        <td valign="top" style="padding: 9px 0;${border} ${style}">${cell}</td>
                      </tr>`;
}

export function teamMailHtml(input: TeamMailInput, sentTo: string): string {
  const tone = BADGE[input.tone];
  const amount = input.summaryAmount
    ? `<span style="font-family: 'Sora', 'DM Sans', Arial, Helvetica, sans-serif; font-size: 28px; font-weight: 800; color: ${tone.amount}; letter-spacing: -0.5px;">${escapeHtml(input.summaryAmount.value)} <span style="font-size: 14px; font-weight: 600; color: #64748b; text-transform: uppercase;">${escapeHtml(input.summaryAmount.currency)}</span></span>`
    : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${PLUGIN_NAME} – ${escapeHtml(input.title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Sora:wght@600;700;800&display=swap" rel="stylesheet" />
  <style type="text/css">
    body { margin: 0; padding: 0; width: 100% !important; min-width: 100%; background-color: #f1f5f9; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
    table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; line-height: 100%; outline: none; text-decoration: none; display: block; }
    @media only screen and (max-width: 600px) {
      .outer-padding { padding: 20px 10px 28px !important; }
      .main-card { width: 100% !important; max-width: 100% !important; border-radius: 12px !important; }
      .header-cell { padding: 18px 20px 16px !important; }
      .content-padding { padding: 20px 18px 20px !important; }
      .main-title { font-size: 20px !important; line-height: 1.3 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, Arial, sans-serif;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f1f5f9; width: 100%;">
    <tr>
      <td align="center" class="outer-padding" style="padding: 20px 14px 48px; background-color: #f1f5f9;">
        <table border="0" cellpadding="0" cellspacing="0" width="580" class="main-card" style="max-width: 580px; width: 100%; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.08);">
          <tr>
            <td class="header-cell" style="background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 55%, #3b82f6 100%); background-color: #2563eb; padding: 24px 32px 22px; border-top-left-radius: 16px; border-top-right-radius: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.15);">
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="left" valign="middle">
                    <table border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td valign="middle" style="padding-right: 10px;">
                          <div style="width: 32px; height: 32px; line-height: 32px; text-align: center; border-radius: 7px; background-color: #5271ff; color: #ffffff; font-family: 'Sora', Arial, sans-serif; font-weight: 800; font-size: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.18);">M</div>
                        </td>
                        <td valign="middle" style="font-family: 'Sora', 'DM Sans', Arial, Helvetica, sans-serif; font-size: 16px; font-weight: 700; color: #ffffff; letter-spacing: -0.2px;">${PLUGIN_NAME}</td>
                      </tr>
                    </table>
                  </td>
                  <td align="right" valign="middle">
                    <table border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td valign="middle" style="padding-right: 8px;">
                          <img src="cid:framefic-logo" width="32" height="32" style="width: 32px; height: 32px; display: block; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);" alt="Framefic Logo" />
                        </td>
                        <td valign="middle" style="font-family: 'Sora', 'DM Sans', Arial, Helvetica, sans-serif; font-size: 16px; font-weight: 700; color: #ffffff; letter-spacing: -0.2px;">Framefic</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="content-padding" style="padding: 24px 32px 24px; background-color: #ffffff;">
              <div>
                <span style="background-color: ${tone.bg}; border: 1px solid ${tone.border}; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04); border-radius: 6px; padding: 5px 12px; font-size: 11px; font-weight: 700; color: ${tone.text}; letter-spacing: 0.5px; text-transform: uppercase; display: inline-block;">${escapeHtml(input.badge)}</span>
              </div>
              <h1 class="main-title" style="font-family: 'Sora', 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 800; color: #0f172a; margin: 14px 0 8px 0; line-height: 1.3; letter-spacing: -0.4px;">${escapeHtml(input.heading)}</h1>
              <p style="font-family: 'DM Sans', Arial, Helvetica, sans-serif; font-size: 14px; color: #475569; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(input.intro)}</p>
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 20px;">
                <tr>
                  <td align="center" style="padding: 20px 22px;">
                    <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: #1d4ed8; text-transform: uppercase; display: block; margin-bottom: 4px;">${escapeHtml(input.summaryLabel)}</span>
                    <span style="font-family: 'Sora', 'DM Sans', Arial, Helvetica, sans-serif; font-size: 21px; font-weight: 800; color: #0f172a; display: block; margin-bottom: 6px; letter-spacing: -0.3px;">${escapeHtml(input.summaryValue)}</span>
                    ${amount}
                  </td>
                </tr>
              </table>
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 18px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      ${input.rows.map((row, index) => teamRow(row, index === input.rows.length - 1)).join("\n")}
                    </table>
                  </td>
                </tr>
              </table>
              <p style="font-family: 'DM Sans', Arial, Helvetica, sans-serif; font-size: 12.5px; color: #64748b; margin: 16px 0 0 0; line-height: 1.5;">This is an automated notification generated by the Framefic platform for the ${PLUGIN_NAME} plugin. No action is required.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="left" style="font-size: 12px; color: #64748b;">${PLUGIN_NAME} &bull; <a href="https://framefic.com" target="_blank" style="color: #2563eb; text-decoration: none; font-weight: 600;">framefic.com</a></td>
                  <td align="right" style="font-size: 12px; color: #64748b;">&copy; ${year()} Framefic</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table border="0" cellpadding="0" cellspacing="0" width="580" class="main-card" style="max-width: 580px; width: 100%; margin-top: 14px;">
          <tr><td align="center" style="font-size: 11px; color: #94a3b8; padding-bottom: 20px;">Notification sent to ${escapeHtml(sentTo)}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A team notice in the Framefic design. */
export function teamMail(to: string, template: string, subject: string, input: TeamMailInput): Mail {
  const plain = [
    input.heading,
    "",
    input.intro,
    "",
    `${input.summaryLabel}: ${input.summaryValue}${input.summaryAmount ? ` ${input.summaryAmount.value} ${input.summaryAmount.currency}` : ""}`,
    ...input.rows.map((row) => `${row.label}: ${row.value || "-"}`),
  ].join("\n");
  return {
    to,
    siteId: null,
    template,
    subject,
    text: plain,
    html: teamMailHtml(input, to),
    attachments: FRAMEFIC_ATTACHMENTS.slice(0, 1),
  };
}
