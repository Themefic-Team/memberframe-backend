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

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
  const result =
    env.mail.driver === "smtp" ? await sendViaSmtp(mail) : await sendViaLog(mail);

  await recordAttempt(mail, result);
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
async function recordAttempt(mail: Mail, result: MailResult): Promise<void> {
  try {
    await prisma.emailLog.create({
      data: {
        siteId: mail.siteId ?? null,
        toAddress: mail.to,
        subject: mail.subject,
        template: mail.template,
        driver: env.mail.driver,
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

export function otpMail(to: string, code: string, siteName: string, siteId: string): Mail {
  const minutes = Math.round(env.otp.ttlSeconds / 60);

  return {
    to,
    siteId,
    template: "member_otp",
    subject: `Your ${siteName} sign-in code`,
    text: [
      `Your sign-in code is ${code}`,
      "",
      `It works for ${minutes} minutes and can be used once.`,
      "",
      "If you did not ask for this code, you can ignore this message. Nobody",
      "can sign in without it.",
    ].join("\n"),
    html: [
      `<p>Your sign-in code is</p>`,
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>`,
      `<p>It works for ${minutes} minutes and can be used once.</p>`,
      `<p style="color:#5b6472;font-size:13px">If you did not ask for this code,`,
      `you can ignore this message. Nobody can sign in without it.</p>`,
    ].join(""),
  };
}

export function passwordResetMail(
  to: string,
  token: string,
  siteName: string,
  siteId: string
): Mail {
  const url = env.passwordReset.urlTemplate.replace("{token}", encodeURIComponent(token));
  const minutes = Math.round(env.passwordReset.ttlSeconds / 60);

  return {
    to,
    siteId,
    template: "member_password_reset",
    subject: `Reset your ${siteName} password`,
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
    html: [
      `<p>Someone asked to reset the password for this address.</p>`,
      `<p><a href="${url}">Choose a new password</a></p>`,
      `<p>The link works for ${minutes} minutes and can be used once.</p>`,
      `<p style="color:#5b6472;font-size:13px">If this was not you, ignore this`,
      ` message. Your password has not changed and nobody can change it without`,
      ` this link.</p>`,
    ].join(""),
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
  return {
    to,
    siteId,
    template: "member_password_changed",
    subject: `Your ${siteName} password was changed`,
    text: [
      "The password for this address was just changed, and every other signed-in",
      "session was ended.",
      "",
      "If that was you, there is nothing to do.",
      "",
      "If it was not, reset the password again now and contact the site owner.",
    ].join("\n"),
  };
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
    html: [
      `<p>Your connect code is</p>`,
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>`,
      `<p>It works for ${minutes} minutes and can be used once.</p>`,
      `<p>Enter it in the MemberFrame plugin to connect this Framer project.</p>`,
      `<p style="color:#5b6472;font-size:13px">If you did not ask for this code,`,
      `you can ignore this message. Nobody can connect your project without it.</p>`,
    ].join(""),
  };
}
