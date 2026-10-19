/**
 * Outbound email: the OTP code and the password reset link.
 *
 * Two drivers.
 *
 * `log` writes the message to `storage/mail/` and prints a summary, and sends
 * nothing. It exists so the whole auth flow is testable with no SMTP account:
 * a developer runs the reset flow, opens the newest file, and clicks the link.
 * It is the default, because the alternative default is a server that needs
 * credentials before it can do anything at all.
 *
 * `smtp` sends through nodemailer.
 *
 * A site may also have its own SMTP server (25-custom-smtp.md). A member email
 * for that site goes through it first, logged as driver `site_smtp`; if that
 * send fails, the same email goes out through the platform sender above, so a
 * member is never locked out by a creator's broken mail settings.
 *
 * Every attempt is recorded in `email_logs` either way, with the subject and
 * the recipient and NEVER the body. A reset link sitting in a database row is a
 * reset link any operator can use, and the point of a single-use token is that
 * only the member holds it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";
import { renderEmail } from "./emailLayout.js";
import { customerMail } from "./frameficMail.js";
import {
  SITE_SMTP_ID,
  fromHeader,
  readSiteSmtp,
  resolveMailHost,
  shortError,
  transportOptions,
  type SiteSmtpConfig,
} from "./siteSmtp.js";
import { loadSiteSettings } from "../services/settingsService.js";
import { readIntegrationSecret } from "../services/integrationSecrets.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Images the HTML references as cid:..., such as the Framefic logo (F19 mail design). */
  attachments?: ReadonlyArray<{ filename: string; path: string; cid: string }>;
  /** For the log, so a row says what kind of message it was. */
  template: string;
  siteId?: string | null;
}

export interface MailResult {
  sent: boolean;
  messageId: string | null;
  /** Where the `log` driver put it, so a caller can tell the developer. */
  file?: string;
  error?: string;
}

const MAIL_DIR = path.join(process.cwd(), "storage", "mail");

let transporter: Transporter | null = null;

function smtpTransport(): Transporter {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth:
      env.mail.user !== ""
        ? { user: env.mail.user, pass: env.mail.password }
        : undefined,
  });

  return transporter;
}

// ============================================================================
// SENDING
// ============================================================================

/**
 * Send, and never throw.
 *
 * A failed send must not fail the request that triggered it, and the reason is
 * specific to this flow rather than general politeness: `forgot-password` is
 * required to answer 200 whether or not the address is registered (FP-02
 * section 3.4 rule 3). If a provider outage turned that into a 500, the
 * difference between a real failure and a deliberate no-op would become
 * visible, and the endpoint would start enumerating accounts.
 *
 * So the caller gets a result it can log and ignore.
 */
export async function sendMail(mail: Mail): Promise<MailResult> {
  if (mail.siteId) {
    const sender = await loadSiteSender(mail.siteId);
    if (sender) {
      const own = await sendViaSite(mail, sender);
      await recordAttempt(mail, own, SITE_SMTP_DRIVER);
      if (own.sent) return own;
      process.stderr.write(`[mail] site SMTP failed for ${mail.template}, using the platform sender: ${own.error}\n`);
    }
  }

  const result =
    env.mail.driver === "smtp" ? await sendViaSmtp(mail) : await sendViaLog(mail);

  await recordAttempt(mail, result, env.mail.driver);
  return result;
}

/** How a send through a site's own SMTP is logged in `email_logs.driver`. */
export const SITE_SMTP_DRIVER = "site_smtp";

interface SiteSender {
  config: SiteSmtpConfig;
  password: string;
}

/**
 * The site's own SMTP, when it is on and complete. Null otherwise, and null on
 * any error reading it: a settings problem must cost the member nothing, since
 * the platform sender is always there to fall back on.
 */
export async function loadSiteSender(siteId: string): Promise<SiteSender | null> {
  try {
    const settings = await loadSiteSettings(siteId);
    const entry = settings.integrations[SITE_SMTP_ID];
    if (!entry || !entry.enabled) return null;

    const config = readSiteSmtp(entry.values, env.mail.siteSmtpAllowPrivate);
    if (!config) return null;

    const password = await readIntegrationSecret(siteId, SITE_SMTP_ID, "password", entry.values);
    if (config.username !== "" && password === "") return null;
    return { config, password };
  } catch {
    return null;
  }
}

async function sendViaSite(mail: Mail, sender: SiteSender): Promise<MailResult> {
  try {
    const address = await resolveMailHost(sender.config.host, env.mail.siteSmtpAllowPrivate);
    const transport = nodemailer.createTransport(transportOptions(sender.config, sender.password, address));
    try {
      const info = await transport.sendMail({
        from: fromHeader(sender.config),
        replyTo: sender.config.replyTo !== "" ? sender.config.replyTo : undefined,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: mail.attachments ? [...mail.attachments] : undefined,
      });
      return { sent: true, messageId: info.messageId ?? null };
    } finally {
      transport.close();
    }
  } catch (error) {
    return { sent: false, messageId: null, error: shortError(error) };
  }
}

/**
 * Send through the site's own SMTP only, with no fallback. For the panel's
 * test button: a test that quietly succeeded through the platform sender would
 * tell the creator their settings work when they do not.
 */
export async function sendWithSiteSmtp(siteId: string, mail: Mail): Promise<MailResult> {
  const sender = await loadSiteSender(siteId);
  if (!sender) {
    return { sent: false, messageId: null, error: "Custom SMTP is off or incomplete. Turn it on and save it first." };
  }

  const result = await sendViaSite(mail, sender);
  await recordAttempt({ ...mail, siteId }, result, SITE_SMTP_DRIVER);
  return result;
}

async function sendViaSmtp(mail: Mail): Promise<MailResult> {
  try {
    const info = await smtpTransport().sendMail({
      from: `"${env.mail.fromName}" <${env.mail.fromAddress}>`,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: mail.attachments ? [...mail.attachments] : undefined,
    });

    return { sent: true, messageId: info.messageId ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mail] send failed for ${mail.template}: ${message}\n`);
    return { sent: false, messageId: null, error: message };
  }
}

async function sendViaLog(mail: Mail): Promise<MailResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(MAIL_DIR, `${stamp}_${mail.template}.txt`);

  const body = [
    `To:      ${mail.to}`,
    `From:    "${env.mail.fromName}" <${env.mail.fromAddress}>`,
    `Subject: ${mail.subject}`,
    `Driver:  log (nothing was sent)`,
    "",
    "-".repeat(72),
    "",
    mail.text,
    "",
  ].join("\n");

  try {
    await mkdir(MAIL_DIR, { recursive: true });
    await writeFile(file, body, "utf-8");
    // The HTML beside it, so the designed message can be opened in a browser.
    if (mail.html) await writeFile(file.replace(/.txt$/, ".html"), mail.html, "utf-8");

    // Printed as well as written. During the cookie spike the developer is
    // watching the terminal, not a directory.
    process.stdout.write(
      [
        "",
        "  ".padEnd(2) + "-".repeat(66),
        `  MAIL (not sent, driver=log)`,
        `  to      ${mail.to}`,
        `  subject ${mail.subject}`,
        `  file    ${path.relative(process.cwd(), file)}`,
        "  " + "-".repeat(66),
        "",
      ].join("\n")
    );

    return { sent: true, messageId: null, file };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sent: false, messageId: null, error: message };
  }
}

/**
 * Record the attempt.
 *
 * Wrapped in its own try/catch: a logging failure must not become the caller's
 * problem. If the mail went out and the row did not, the member is still served.
 */
async function recordAttempt(mail: Mail, result: MailResult, driver: string): Promise<void> {
  try {
    await prisma.emailLog.create({
      data: {
        siteId: mail.siteId ?? null,
        toAddress: mail.to,
        subject: mail.subject,
        template: mail.template,
        driver,
        messageId: result.messageId,
        sentAt: result.sent ? new Date() : null,
        error: result.error ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mail] could not record the attempt: ${message}\n`);
  }
}

// ============================================================================
// TEMPLATES
// ============================================================================
// Plain text, with HTML as a nicety. Text first because a password reset that
// renders as a blank page in a text-only client is a member who cannot get in,
// and because every HTML email client strips something different.
//
// Every HTML body comes from `renderEmail` in `emailLayout.ts`, which owns the
// look and escapes every string, the creator-typed site name included. A
// template here only says what to say.

/** The name a member's email is signed with. A blank site name falls back to the product. */
function brandOf(siteName: string): string {
  const trimmed = siteName.trim();
  return trimmed === "" ? "MemberFrame" : trimmed;
}

export function otpMail(to: string, code: string, siteName: string, siteId: string): Mail {
  const minutes = Math.round(env.otp.ttlSeconds / 60);
  const brand = brandOf(siteName);

  return {
    to,
    siteId,
    template: "member_otp",
    subject: `Your ${brand} sign-in code`,
    text: [
      `Your sign-in code is ${code}`,
      "",
      `It works for ${minutes} minutes and can be used once.`,
      "",
      "If you did not ask for this code, you can ignore this message. Nobody",
      "can sign in without it.",
    ].join("\n"),
    html: renderEmail({
      brand,
      preheader: `Your sign-in code is ${code}`,
      heading: "Your sign-in code",
      intro: [`Enter this code to sign in to ${brand}.`],
      code,
      details: [`It works for ${minutes} minutes and can be used once.`],
      safety: "If you did not ask for this code, you can ignore this message. Nobody can sign in without it.",
    }),
  };
}

/** The code that confirms a new account's address. Same code store as sign in. */
export function verifyEmailMail(to: string, code: string, siteName: string, siteId: string): Mail {
  const minutes = Math.round(env.otp.ttlSeconds / 60);
  const brand = brandOf(siteName);

  return {
    to,
    siteId,
    template: "member_verify_email",
    subject: `Confirm your email for ${brand}`,
    text: [
      `Your confirmation code is ${code}`,
      "",
      `Enter it on the sign up page to finish creating your account.`,
      `It works for ${minutes} minutes and can be used once.`,
      "",
      "If you did not create an account, you can ignore this message.",
    ].join("\n"),
    html: renderEmail({
      brand,
      preheader: `Your confirmation code is ${code}`,
      heading: "Confirm your email",
      intro: [`Welcome to ${brand}. Enter this code on the sign up page to finish creating your account.`],
      code,
      details: [`It works for ${minutes} minutes and can be used once.`],
      safety: "If you did not create an account, you can ignore this message.",
    }),
  };
}

/**
 * `url` is the finished link, built by `passwordResetUrl` from the site's own
 * origin and reset page. The template only presents it.
 */
export function passwordResetMail(
  to: string,
  url: string,
  siteName: string,
  siteId: string
): Mail {
  const minutes = Math.round(env.passwordReset.ttlSeconds / 60);
  const brand = brandOf(siteName);

  return {
    to,
    siteId,
    template: "member_password_reset",
    subject: `Reset your ${brand} password`,
    text: [
      "Someone asked to reset the password for this address.",
      "",
      "Open this link to choose a new one:",
      url,
      "",
      `The link works for ${minutes} minutes and can be used once.`,
      "",
      "If this was not you, ignore this message. Your password has not changed",
      "and nobody can change it without this link.",
    ].join("\n"),
    html: renderEmail({
      brand,
      preheader: `Choose a new password for ${brand}.`,
      heading: "Reset your password",
      intro: ["Someone asked to reset the password for this address. Use the button below to choose a new one."],
      action: { label: "Choose a new password", url },
      details: [`The link works for ${minutes} minutes and can be used once.`],
      safety:
        "If this was not you, ignore this message. Your password has not changed and nobody can change it without this link.",
    }),
  };
}

/**
 * Sent after a successful reset, to the address that was reset.
 *
 * Not a courtesy. If an attacker completed a reset, this is the only signal the
 * real owner gets, and it arrives at an address the attacker does not control
 * unless they already own the mailbox, in which case nothing here would have
 * helped anyway.
 */
export function passwordChangedMail(to: string, siteName: string, siteId: string): Mail {
  const brand = brandOf(siteName);

  return {
    to,
    siteId,
    template: "member_password_changed",
    subject: `Your ${brand} password was changed`,
    text: [
      "The password for this address was just changed, and every other signed-in",
      "session was ended.",
      "",
      "If that was you, there is nothing to do.",
      "",
      "If it was not, reset the password again now and contact the site owner.",
    ].join("\n"),
    html: renderEmail({
      brand,
      preheader: `Your ${brand} password was just changed.`,
      heading: "Your password was changed",
      intro: [
        "The password for this address was just changed, and every other signed-in session was ended.",
        "If that was you, there is nothing to do.",
      ],
      safety: "If it was not you, reset the password again now and contact the site owner.",
    }),
  };
}

/** The panel's Send test email, through the site's own SMTP. */
export function smtpTestMail(to: string, siteName: string, siteId: string): Mail {
  const brand = brandOf(siteName);

  return {
    to,
    siteId,
    template: "site_smtp_test",
    subject: `Test email from ${brand}`,
    text: [
      `This is a test email from ${brand}, sent through your own SMTP server.`,
      "",
      "If you can read this, your members' sign-in codes and reset links will arrive the same way.",
    ].join("\n"),
    html: renderEmail({
      brand,
      preheader: "Your SMTP settings work.",
      heading: "Your SMTP settings work",
      intro: [
        `This is a test email from ${brand}, sent through your own SMTP server.`,
        "Your members' sign-in codes and reset links will arrive the same way.",
      ],
      safety: "Sent from the MemberFrame plugin's Send test email button. If you did not ask for it, you can ignore it.",
    }),
  };
}

/**
 * The hosted account page's code (F19), in Framefic's design: BEAF's
 * `signup-mail.html` for sign up and sign in, `mail.html` for a reset.
 */
export type AccountCodePurpose = "signin" | "signup" | "reset";

export function accountCodeMail(to: string, code: string, purpose: AccountCodePurpose = "signin", name = "there"): Mail {
  const minutes = Math.round(env.otp.ttlSeconds / 60);
  const expiry = `This code expires in **${minutes} minutes**.`;
  if (purpose === "reset") {
    return customerMail(to, "creator_account_reset", "Reset your MemberFrame password", {
      heading: "Reset your password",
      subheading: "Verify your identity to continue",
      greetingName: name,
      paragraphs: [`Use the code below to reset your **MemberFrame** account password. ${expiry}`],
      code,
      footnote: "Didn't request this? You can safely ignore this email - your account remains unchanged.",
    });
  }
  if (purpose === "signup") {
    return customerMail(to, "creator_account_signup", "Verify your MemberFrame account email", {
      heading: "Verify your email",
      subheading: "Confirm your email to complete registration",
      greetingName: name,
      paragraphs: [`Use the code below to complete your sign up for your **MemberFrame** account. ${expiry}`],
      code,
      footnote: "Didn't request this? You can safely ignore this email - no account will be created.",
    });
  }
  return customerMail(to, "creator_account_code", "Your MemberFrame sign-in code", {
    heading: "Your sign-in code",
    subheading: "Sign in to continue in Framer",
    greetingName: name,
    paragraphs: [`Use the code below to sign in to your **MemberFrame** account. ${expiry}`],
    code,
    footnote: "Didn't request this? You can safely ignore this email.",
  });
}

/**
 * The connect code, sent to a creator rather than to a member.
 *
 * `siteId` is deliberately absent: at the moment this is sent the site may not
 * exist, and if it does exist the address has not yet proved it may know that.
 * `EmailLog.siteId` is nullable for exactly this row.
 *
 * The copy names MemberFrame rather than the creator's site. A creator who
 * receives this is signing in to the plugin, not to their own membership, and
 * conflating the two is how someone pastes a creator code into a member form.
 */
export function creatorCodeMail(to: string, code: string): Mail {
  const minutes = Math.round(env.otp.ttlSeconds / 60);

  return {
    to,
    siteId: null,
    template: "creator_connect",
    subject: `Your MemberFrame connect code`,
    text: [
      `Your connect code is ${code}`,
      "",
      `It works for ${minutes} minutes and can be used once.`,
      "",
      "Enter it in the MemberFrame plugin to connect this Framer project.",
      "",
      "If you did not ask for this code, you can ignore this message. Nobody",
      "can connect your project without it.",
    ].join("\n"),
    html: renderEmail({
      brand: "MemberFrame",
      preheader: `Your connect code is ${code}`,
      heading: "Connect your Framer project",
      intro: ["Enter this code in the MemberFrame plugin to connect this Framer project."],
      code,
      details: [`It works for ${minutes} minutes and can be used once.`],
      safety: "If you did not ask for this code, you can ignore this message. Nobody can connect your project without it.",
    }),
  };
}
