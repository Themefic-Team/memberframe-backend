/**
 * Member authentication: register, sign in, forgot, reset.
 *
 * Every function here is written against one rule, and it is the rule most
 * easily broken by a later change that looks like an improvement:
 *
 *   FROM THE OUTSIDE, "no such address", "no password set", AND "wrong
 *   password" MUST BE INDISTINGUISHABLE.
 *
 * Indistinguishable in three ways, not one:
 *   - the same status, 401
 *   - the same reason string, `invalid_credentials`
 *   - the same time taken, which is why `verifyAgainstNothing` exists
 *
 * FP-02 section 3.4 rule 3 asks for the first two. The third is the one that
 * gets forgotten, and it is the one that actually enumerates a member list: an
 * unknown address returning in under a millisecond while a real one takes
 * eighty is a reliable oracle no matter what the body says.
 *
 * The deliberate exception is `account_locked`, which does reveal that the
 * address exists. `05-member-auth.md` section 9.4 records that as a judgement
 * call: a member who has locked themselves out needs to know to wait, and the
 * alternative is someone guessing forever at an account that will refuse them
 * for fifteen minutes whatever they type.
 */

import { prisma } from "../config/db.js";
import { freeTierKey } from "../lib/tiers.js";
import { env } from "../config/env.js";
import {
  hashPassword,
  needsRehash,
  verifyAgainstNothing,
  verifyPassword,
} from "../lib/password.js";
import { isAcceptablePassword, normalizeEmail, passwordProblems } from "../lib/credentials.js";
import { expiryFrom, generateOtpCode, generateToken, hashToken, isExpired, tokensMatch } from "../lib/tokens.js";
import { badRequest, forbidden, unauthorized } from "../middleware/errors.js";
import {
  otpMail,
  passwordChangedMail,
  passwordResetMail,
  sendMail,
  verifyEmailMail,
} from "../lib/mailer.js";
import { passwordResetUrl } from "../lib/siteLinks.js";
import { emitMemberEvent } from "./webhookService.js";
import { revokeAllSessionsForMember } from "./sessionService.js";
import { loadSiteSettings } from "./settingsService.js";

export interface AuthenticatedMember {
  id: string;
  siteId: string;
  email: string;
  name: string | null;
  activeTier: string;
  status: string;
}

const SAFE_MEMBER_FIELDS = {
  id: true,
  siteId: true,
  email: true,
  name: true,
  activeTier: true,
  status: true,
} as const;

// ============================================================================
// REGISTER
// ============================================================================

/**
 * Create a member, unverified, and email them a confirmation code.
 *
 * The member is NOT signed in. `verifyMemberEmail` confirms the address and
 * the member then signs in with their password. Until then
 * `signInWithPassword` refuses them with `email_not_verified`, so an account
 * opened with someone else's address cannot be used.
 *
 * CONFLICT C16. This is the one endpoint that does reveal whether an address is
 * registered, through `email_already_exists`, and FP-02 specifies it that way.
 * It is defensible here in a way it would not be on sign-in, because a sign-up
 * form that silently fails to create an account is unusable: the member would
 * see success, have no account, and no path to discovering why.
 *
 * Recorded as a conflict rather than resolved silently, so it stays a decision.
 */
export async function registerMember(input: {
  siteId: string;
  siteName: string;
  email: string;
  password: string;
  name: string | null;
}): Promise<{ member: AuthenticatedMember; verification: SendMemberOtpResult }> {
  const email = normalizeEmail(input.email);

  // Server-side policy, independent of the client's copy. The client's rules
  // are a hint; `lib/credentials.ts` is the rule. A request that bypasses the
  // form entirely arrives here and is refused the same way.
  if (!isAcceptablePassword(input.password, email)) {
    throw badRequest("weak_password", {
      problems: passwordProblems(input.password, email, true),
    });
  }

  const existing = await prisma.member.findFirst({
    where: { siteId: input.siteId, email, deletedAt: null },
    select: { id: true },
  });

  if (existing) throw badRequest("email_already_exists");

  const passwordHash = await hashPassword(input.password);

  try {
    const member = await prisma.member.create({
      data: {
        siteId: input.siteId,
        email,
        name: input.name?.trim() === "" ? null : (input.name?.trim() ?? null),
        passwordHash,
        passwordUpdatedAt: new Date(),
        // Set by `verifyMemberEmail`. Sign in waits on it.
        emailVerifiedAt: null,
        activeTier: await freeTierKey(input.siteId),
        status: "active",
      },
      select: SAFE_MEMBER_FIELDS,
    });

    const verification = await sendMemberOtp({
      siteId: input.siteId,
      siteName: input.siteName,
      email,
      purpose: "verify",
    });

    return { member, verification };
  } catch (error) {
    // The check above is not a guarantee. Two simultaneous sign-ups for the
    // same address both pass it, and the unique index on the generated
    // `active_email` column is what actually stops the second. Prisma reports
    // that as P2002.
    if (error instanceof Error && error.message.includes("P2002")) {
      throw badRequest("email_already_exists");
    }
    throw error;
  }
}

// ============================================================================
// SIGN IN
// ============================================================================

/**
 * Check a password and return the member.
 *
 * Four refusals, and three of them answer identically.
 */
export async function signInWithPassword(input: {
  siteId: string;
  siteName: string;
  email: string;
  password: string;
}): Promise<AuthenticatedMember> {
  const email = normalizeEmail(input.email);

  const member = await prisma.member.findFirst({
    where: { siteId: input.siteId, email, deletedAt: null },
    select: {
      ...SAFE_MEMBER_FIELDS,
      passwordHash: true,
      failedLoginCount: true,
      lockedUntil: true,
      emailVerifiedAt: true,
    },
  });

  // 1. No such member. Spend the time a real check would, then refuse with the
  //    same reason a wrong password gets.
  if (!member) {
    await verifyAgainstNothing(input.password);
    throw unauthorized("invalid_credentials");
  }

  // 2. Locked. Checked before the password, so a locked account does not also
  //    burn CPU on a hash, and so the counter cannot be driven higher while
  //    the lock is already in force.
  if (member.lockedUntil !== null && member.lockedUntil.getTime() > Date.now()) {
    throw unauthorized("account_locked", {
      retryAfterSeconds: Math.ceil((member.lockedUntil.getTime() - Date.now()) / 1000),
    });
  }

  // 3. No password set. This is a member who signed up with Google or a code.
  //    It MUST read exactly like a wrong password: a distinct error here would
  //    tell an attacker which addresses are SSO-only, and those are the ones
  //    worth phishing.
  if (member.passwordHash === null) {
    await verifyAgainstNothing(input.password);
    await recordFailure(member.id, member.failedLoginCount);
    throw unauthorized("invalid_credentials");
  }

  // 4. Wrong password.
  const matches = await verifyPassword(input.password, member.passwordHash);

  if (!matches) {
    await recordFailure(member.id, member.failedLoginCount);
    throw unauthorized("invalid_credentials");
  }

  // 5. Right password, unconfirmed address. Checked only after the password
  //    matched, so this reveals nothing to someone guessing. A fresh code goes
  //    out unless one is still within its resend lock, and the client opens
  //    its code step. Members who registered before verification existed land
  //    here once, on their next sign in.
  if (member.emailVerifiedAt === null) {
    await prisma.member.update({
      where: { id: member.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    let resendAfterSeconds = 0;
    try {
      const sent = await sendMemberOtp({
        siteId: input.siteId,
        siteName: input.siteName,
        email,
        purpose: "verify",
      });
      resendAfterSeconds = sent.resendAfterSeconds;
    } catch (error) {
      // A code from a moment ago is still live. Point at it rather than fail.
      const extra = (error as { extra?: { retryAfterSeconds?: number } }).extra;
      if (typeof extra?.retryAfterSeconds !== "number") throw error;
      resendAfterSeconds = extra.retryAfterSeconds;
    }

    throw forbidden("email_not_verified", { resendAfterSeconds });
  }

  // Success. Clear the counter: FP-02's lockout counts *consecutive* failures,
  // so a correct password resets it. Without this, five wrong attempts spread
  // over a year would eventually lock a member who never got it wrong twice in
  // a row.
  await prisma.member.update({
    where: { id: member.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      // Opportunistic upgrade. When the hashing parameters change, or when
      // Argon2id replaces scrypt, members migrate as they sign in rather than
      // through a migration that cannot read their passwords. See
      // `lib/password.ts`.
      ...(needsRehash(member.passwordHash)
        ? { passwordHash: await hashPassword(input.password) }
        : {}),
    },
  });

  return {
    id: member.id,
    siteId: member.siteId,
    email: member.email,
    name: member.name,
    activeTier: member.activeTier,
    status: member.status,
  };
}

/**
 * Count a failure and lock at the threshold.
 *
 * FP-02 section 3.4 rule 2: five consecutive failures, fifteen minutes.
 * Counted per member, in the database, because a lockout that a restart clears
 * is not a lockout.
 */
async function recordFailure(memberId: string, currentCount: number): Promise<void> {
  const next = currentCount + 1;
  const shouldLock = next >= env.login.maxFailures;

  await prisma.member.update({
    where: { id: memberId },
    data: {
      failedLoginCount: next,
      ...(shouldLock
        ? {
            lockedUntil: expiryFrom(env.login.lockoutSeconds),
            // Reset to zero with the lock. Otherwise the member unlocks after
            // fifteen minutes and the very next wrong attempt locks them
            // again, because the counter is still at five.
            failedLoginCount: 0,
          }
        : {}),
    },
  });
}

// ============================================================================
// FORGOT PASSWORD
// ============================================================================

/**
 * Send a reset link, or do nothing, and answer the same either way.
 *
 * Returns void with no indication of which happened, so a route cannot
 * accidentally branch on it. FP-02 section 3.4 rule 3, and the reason the
 * mailer never throws: a provider outage must not turn the no-op case and the
 * real case into different responses.
 */
export async function requestPasswordReset(input: {
  siteId: string;
  siteName: string;
  email: string;
  /** Where the emailed link opens: the published site and its reset page. */
  resetLink?: { origin: string | null; resetPath: string };
}): Promise<void> {
  const email = normalizeEmail(input.email);

  const member = await prisma.member.findFirst({
    where: { siteId: input.siteId, email, deletedAt: null },
    select: { id: true, email: true },
  });

  // No account. Return silently. No row is written, no mail is sent, and the
  // route answers 200 exactly as it would below.
  if (!member) return;

  const token = generateToken();

  // Invalidate any outstanding token for this member first. Two live reset
  // links means an old email still works after a new one is requested, which
  // is a longer window than the fifteen minutes anyone intended.
  await prisma.memberPasswordReset.updateMany({
    where: { memberId: member.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.memberPasswordReset.create({
    data: {
      siteId: input.siteId,
      memberId: member.id,
      tokenHash: hashToken(token),
      expiresAt: expiryFrom(env.passwordReset.ttlSeconds),
    },
  });

  const url = passwordResetUrl(token, input.resetLink ?? { origin: null, resetPath: "/reset-password" });
  await sendMail(passwordResetMail(member.email, url, input.siteName, input.siteId));
}

// ============================================================================
// RESET PASSWORD
// ============================================================================

export interface ResetResult {
  memberId: string;
  siteId: string;
  email: string;
  sessionsRevoked: number;
}

/**
 * Consume a reset token and set a new password.
 *
 * Three things happen together and all three matter: the token is spent, the
 * hash is replaced, and every other session is revoked. The last is what makes
 * this a recovery rather than a password change, and it is the one a first
 * implementation usually leaves out.
 */
export async function resetPassword(input: {
  siteId: string;
  /** For the "password changed" email. Optional so a caller without it still works. */
  siteName?: string;
  token: string;
  newPassword: string;
}): Promise<ResetResult> {
  const record = await prisma.memberPasswordReset.findUnique({
    where: { tokenHash: hashToken(input.token) },
    include: { member: { select: { id: true, siteId: true, email: true, deletedAt: true } } },
  });

  // Unknown, already used, wrong site, or the member is gone. All answer
  // `invalid_token`: distinguishing them would say whether a token ever
  // existed, and a token is a credential.
  if (!record || record.consumedAt !== null) throw badRequest("invalid_token");
  if (record.siteId !== input.siteId) throw badRequest("invalid_token");
  if (!record.member || record.member.deletedAt !== null) throw badRequest("invalid_token");

  // Expiry is its own reason, because it is actionable: the member should
  // request a new link rather than conclude the feature is broken. It reveals
  // only that a token existed, which they already knew from their own inbox.
  if (record.expiresAt.getTime() <= Date.now()) throw badRequest("token_expired");

  const email = record.member.email;

  if (!isAcceptablePassword(input.newPassword, email)) {
    throw badRequest("weak_password", {
      problems: passwordProblems(input.newPassword, email, true),
    });
  }

  const passwordHash = await hashPassword(input.newPassword);

  // One transaction. A reset that updated the password and then failed to
  // consume the token would leave a reusable link to an account whose owner
  // believes it is now secure.
  await prisma.$transaction([
    prisma.member.update({
      where: { id: record.member.id },
      data: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        // A reset is also how a locked-out member gets back in. Leaving the
        // lock in place would mean a correct new password still refused.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.memberPasswordReset.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
  ]);

  const sessionsRevoked = await revokeAllSessionsForMember(record.member.id);

  // Sent after the change, to the address that was changed. If this reset was
  // not the owner's doing, this message is the only signal they get.
  await sendMail(passwordChangedMail(email, input.siteName ?? "", input.siteId));

  return {
    memberId: record.member.id,
    siteId: record.member.siteId,
    email,
    sessionsRevoked,
  };
}

// ============================================================================
// OTP PASSWORDLESS AUTH (FP-03)
// ============================================================================

export interface SendMemberOtpInput {
  siteId: string;
  siteName: string;
  email: string;
  /** Which email carries the code. The code itself is the same either way. */
  purpose?: "signin" | "verify";
}

export type SendMemberOtpResult = {
  resendAfterSeconds: number;
  expiresInSeconds: number;
};

/**
 * Send a code. For sign in, only to a member who already has an account:
 * code sign in signs members in, it does not make them (2026-10-18). An
 * address with no account gets the same answer and no code, and nothing is
 * written, so the form cannot be used to find out who is a member, the same
 * rule as the password reset ("if this address has an account").
 */
export async function sendMemberOtp(input: SendMemberOtpInput): Promise<SendMemberOtpResult> {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const silent: SendMemberOtpResult = {
    resendAfterSeconds: env.otp.resendLockSeconds,
    expiresInSeconds: env.otp.ttlSeconds,
  };

  if (input.purpose !== "verify") {
    const member = await prisma.member.findFirst({
      where: { siteId: input.siteId, email, deletedAt: null },
      select: { id: true },
    });
    if (!member) return silent;
  }

  const outstanding = await prisma.memberOtp.findFirst({
    where: {
      siteId: input.siteId,
      email,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (outstanding && outstanding.resendAvailableAt > now) {
    const wait = Math.ceil((outstanding.resendAvailableAt.getTime() - now.getTime()) / 1000);
    throw badRequest("resend_too_soon", { retryAfterSeconds: wait });
  }

  const code = generateOtpCode();

  // Invalidate previous outstanding codes for this site + email
  await prisma.memberOtp.updateMany({
    where: { siteId: input.siteId, email, consumedAt: null },
    data: { consumedAt: now },
  });

  await prisma.memberOtp.create({
    data: {
      siteId: input.siteId,
      email,
      codeHash: hashToken(code),
      expiresAt: expiryFrom(env.otp.ttlSeconds, now),
      resendAvailableAt: expiryFrom(env.otp.resendLockSeconds, now),
    },
  });

  // Send mail without throwing on delivery errors
  await sendMail(
    input.purpose === "verify"
      ? verifyEmailMail(email, code, input.siteName, input.siteId)
      : otpMail(email, code, input.siteName, input.siteId)
  );

  return {
    resendAfterSeconds: env.otp.resendLockSeconds,
    expiresInSeconds: env.otp.ttlSeconds,
  };
}

export interface VerifyMemberOtpInput {
  siteId: string;
  email: string;
  code: string;
}

/**
 * Spend the newest outstanding code for this address, or throw.
 *
 * Shared by code sign in and by email confirmation, so the attempt limit and
 * the expiry rules cannot drift between them.
 */
async function consumeOtp(siteId: string, email: string, code: string, now: Date): Promise<void> {
  const otp = await prisma.memberOtp.findFirst({
    where: { siteId, email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!otp) {
    throw unauthorized("invalid_code");
  }

  if (isExpired(otp.expiresAt, now)) {
    throw unauthorized("expired_code");
  }

  if (otp.attempts >= env.otp.maxAttempts) {
    // Invalidate dead code
    await prisma.memberOtp.update({ where: { id: otp.id }, data: { consumedAt: now } });
    throw unauthorized("too_many_attempts");
  }

  if (!tokensMatch(otp.codeHash, hashToken(code.trim()))) {
    const updated = await prisma.memberOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });

    if (updated.attempts >= env.otp.maxAttempts) {
      await prisma.memberOtp.update({ where: { id: otp.id }, data: { consumedAt: now } });
      throw unauthorized("too_many_attempts");
    }

    throw unauthorized("invalid_code");
  }

  // Code matches! Mark consumed immediately
  await prisma.memberOtp.update({ where: { id: otp.id }, data: { consumedAt: now } });
}

/**
 * Sign a registered member in with their code. Never creates an account
 * (2026-10-18): an address with no member is refused as `invalid_code`, the
 * answer a wrong code gets, so this cannot list members either. A code proves
 * the address, so an unconfirmed member is confirmed by it.
 */
export async function verifyMemberOtp(input: VerifyMemberOtpInput): Promise<AuthenticatedMember> {
  const email = normalizeEmail(input.email);
  const now = new Date();

  await consumeOtp(input.siteId, email, input.code, now);

  // `emailVerifiedAt` is selected here and nowhere it would leave the service,
  // so an existing verification date is kept rather than reset on every login.
  const existing = await prisma.member.findFirst({
    where: { siteId: input.siteId, email, deletedAt: null },
    select: { id: true, emailVerifiedAt: true },
  });
  if (!existing) throw unauthorized("invalid_code");

  return prisma.member.update({
    where: { id: existing.id },
    data: {
      lastLoginAt: now,
      emailVerifiedAt: existing.emailVerifiedAt ?? now,
      failedLoginCount: 0,
      lockedUntil: null,
    },
    select: SAFE_MEMBER_FIELDS,
  });
}

// ============================================================================
// EMAIL CONFIRMATION
// ============================================================================

/**
 * Confirm a new account's address with the code `registerMember` sent.
 *
 * Signs nobody in: the member goes on to the sign in form, which is the flow
 * the creator designed. An address with no account answers `invalid_code`,
 * the same as a wrong code, so this cannot be used to list members.
 */
export async function verifyMemberEmail(input: VerifyMemberOtpInput): Promise<void> {
  const email = normalizeEmail(input.email);
  const now = new Date();

  const member = await prisma.member.findFirst({
    where: { siteId: input.siteId, email, deletedAt: null },
    select: { id: true, emailVerifiedAt: true },
  });

  await consumeOtp(input.siteId, email, input.code, now);

  if (!member) throw unauthorized("invalid_code");
  if (member.emailVerifiedAt !== null) return;

  await prisma.member.update({
    where: { id: member.id },
    data: { emailVerifiedAt: now },
  });

  // The account is real now, so this is when a CRM hears about it. An
  // unconfirmed sign up never reaches a webhook.
  void emitMemberEvent("member.created", { id: member.id, siteId: input.siteId });
}

/**
 * Send a fresh confirmation code. Answers the same whether or not the address
 * has an unconfirmed account, and only actually sends when it does.
 */
export async function resendEmailVerification(input: SendMemberOtpInput): Promise<SendMemberOtpResult> {
  const email = normalizeEmail(input.email);

  const member = await prisma.member.findFirst({
    where: { siteId: input.siteId, email, deletedAt: null },
    select: { emailVerifiedAt: true },
  });

  if (!member || member.emailVerifiedAt !== null) {
    return { resendAfterSeconds: env.otp.resendLockSeconds, expiresInSeconds: env.otp.ttlSeconds };
  }

  return sendMemberOtp({ ...input, email, purpose: "verify" });
}
