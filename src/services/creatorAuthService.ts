/**
 * Creator identity, and how a Framer project becomes a site.
 *
 * Sign in happens on the hosted account page (`routes/creatorAccount.ts`):
 * the creator proves their address with a six-digit code or a password there,
 * and the panel receives a token through the hand-off. The panel then calls
 * `attachProject` with the site id it keeps in the project's plugin data.
 *
 * ## Nothing from Framer is stored
 *
 * Since 2026-10-28 (Marketplace review, memberframe/docs/development-docs/
 * 35-marketplace-review-report.md) the panel reads neither the Framer user nor
 * the project's name, id, or published domains, and this server would not
 * keep them if it did. A site is known by its own id only. Its name starts
 * empty and its domains are the ones the creator types in Profile.
 *
 * ## Ownership is first come, and that is a real limitation
 *
 * A site belongs to the account that created it. Another account opening the
 * same project finds the site id in plugin data and gets 403, which is
 * correct and also means a project set up by a contractor who has left needs
 * support to reassign. There is no transfer flow and no team model (conflict
 * C28).
 */

import { prisma } from "../config/db.js";
import { FREE_TIER_RANK, NEW_FREE_TIER_KEY } from "../lib/tiers.js";
import { env } from "../config/env.js";
import { badRequest, forbidden, notFound, unauthorized } from "../middleware/errors.js";
import { accountCodeMail, creatorCodeMail, sendMail, type AccountCodePurpose } from "../lib/mailer.js";
import {
  expiryFrom,
  generateGrantSalt,
  generateOtpCode,
  generateSiteKey,
  generateToken,
  hashToken,
  isExpired,
  tokensMatch,
} from "../lib/tokens.js";
import { defaultSettings, toJsonDocument } from "../lib/siteSettings.js";

/** How long a creator session lasts. Thirty days, then the code again. */
export const CREATOR_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface StartConnectInput {
  email: string;
  /** What the code is scoped to, stored in `creator_otps.framer_project_id`. Always `ACCOUNT_CODE_SCOPE` now. */
  scope: string;
  /**
   * Which email to send. `connect` is the panel's own code form; `account`
   * is the hosted account page opened in a browser tab (F19), whose codes are
   * scoped to `ACCOUNT_CODE_SCOPE` rather than to a project.
   */
  purpose?: "connect" | "account";
  /** For an account page code: which email (sign in, sign up, or reset), and who to greet. */
  accountPurpose?: AccountCodePurpose;
  name?: string;
}

/** The scope a hosted account page code is stored under. */
export const ACCOUNT_CODE_SCOPE = "account";

/**
 * Send the code. Always succeeds, from the caller's point of view.
 *
 * Returns nothing at all, and that is the point: there is no branch here for a
 * route to accidentally report. A creator who mistypes their address and one
 * who typed it correctly see the same screen, which is also what stops this
 * endpoint being used to test whether an address has a MemberFrame account.
 *
 * The resend lock is the one thing that can refuse, and it refuses on the
 * (address, project) pair rather than on the address, so it cannot be used to
 * probe either.
 */
export async function startConnect(input: StartConnectInput): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();

  const outstanding = await prisma.creatorOtp.findFirst({
    where: {
      email,
      framerProjectId: input.scope,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (outstanding && outstanding.resendAvailableAt > now) {
    const wait = Math.ceil((outstanding.resendAvailableAt.getTime() - now.getTime()) / 1000);
    // A 429 rather than a silent success. The panel shows a countdown, and
    // pretending to have sent a second code would leave a creator waiting for
    // an email that is not coming.
    throw badRequest("resend_too_soon", { retryAfterSeconds: wait });
  }

  const code = generateOtpCode();

  // Invalidate every outstanding code for this pair before minting a new one.
  // Otherwise requesting five codes leaves five valid, which multiplies the
  // guessing surface by five for no benefit to anyone.
  await prisma.creatorOtp.updateMany({
    where: { email, framerProjectId: input.scope, consumedAt: null },
    data: { consumedAt: now },
  });

  await prisma.creatorOtp.create({
    data: {
      email,
      framerProjectId: input.scope,
      codeHash: hashToken(code),
      expiresAt: expiryFrom(env.otp.ttlSeconds, now),
      resendAvailableAt: expiryFrom(env.otp.resendLockSeconds, now),
    },
  });

  // The mailer never throws: a send failure is logged and the flow continues.
  // That is right here. If SMTP is down, telling the creator "we could not
  // send" is useful, but failing the request after the code is already stored
  // would leave a usable code with no way to learn it.
  await sendMail(input.purpose === "account" ? accountCodeMail(email, code, input.accountPurpose, input.name || "there") : creatorCodeMail(email, code));
}

export interface ConnectedSite {
  siteId: string;
  siteKey: string;
  /** Null for a site created since 2026-10-28. */
  siteName: string | null;
  allowedOrigins: string[];
}



/**
 * Check a creator's six-digit code and spend it, or throw `invalid_code`.
 *
 * The order is deliberate and it is the whole of the authorization story:
 * nothing below the code check reads or writes a site. A wrong code returns
 * before anything else has been read.
 */
export async function consumeCreatorCode(email: string, code: string, scope: string, now: Date = new Date()): Promise<void> {
  const otp = await prisma.creatorOtp.findFirst({
    where: { email, framerProjectId: scope, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  // One answer for "no code was ever requested", "it expired", and "it was
  // already used". Distinguishing them would say whether a code is outstanding
  // for an address, which is exactly what someone probing wants to know.
  if (!otp || isExpired(otp.expiresAt, now)) throw unauthorized("invalid_code");

  if (otp.attempts >= env.otp.maxAttempts) {
    // Burn it. F05's rule for the member OTP and the same reasoning: without
    // this, a dead code can still be guessed against forever.
    await prisma.creatorOtp.update({ where: { id: otp.id }, data: { consumedAt: now } });
    throw unauthorized("invalid_code");
  }

  if (!tokensMatch(otp.codeHash, hashToken(code.trim()))) {
    await prisma.creatorOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    throw unauthorized("invalid_code");
  }

  await prisma.creatorOtp.update({ where: { id: otp.id }, data: { consumedAt: now } });
}

/**
 * The creator behind a proven address, made if new.
 *
 * Find, then create. Not an upsert with an empty update branch: an existing
 * creator's name is theirs, typed on the account page, and overwriting it on
 * a later sign in would silently rename them.
 */
export async function findOrCreateCreator(
  email: string,
  name: string | null | undefined,
  now: Date = new Date(),
  extra: { passwordHash?: string; googleId?: string; avatarUrl?: string } = {}
): Promise<{ id: string; email: string; name: string }> {
  const found = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });
  if (found) return found;

  return prisma.user.create({
    data: {
      email,
      name: name?.trim() || email.split("@")[0] || "Creator",
      emailVerifiedAt: now,
      passwordHash: extra.passwordHash ?? null,
      googleId: extra.googleId ?? null,
      avatarUrl: extra.avatarUrl ?? null,
    },
    select: { id: true, email: true, name: true },
  });
}

/**
 * The site for this project, by the id the panel keeps in plugin data.
 *
 * No id, or an id that no longer exists: a new site. An id that belongs to
 * another account: 403, as before (first claim wins, see the header). The
 * creator's own id: that site, untouched. Nothing about the Framer project
 * is read or written here.
 */
export async function attachProject(userId: string, input: { siteId?: string | undefined }): Promise<ConnectedSite> {
  const existing = input.siteId
    ? await prisma.site.findUnique({
        where: { id: input.siteId },
        select: { id: true, userId: true, siteKey: true, siteName: true, allowedOrigins: true },
      })
    : null;

  if (existing && existing.userId !== userId) throw forbidden("project_claimed_by_another_account");

  const site = existing ?? (await createSite(userId));

  return {
    siteId: site.id,
    siteKey: site.siteKey,
    siteName: site.siteName,
    allowedOrigins: readOrigins(site.allowedOrigins),
  };
}

/** A new bearer token for the panel. Only its hash is stored. */
export async function issueCreatorSession(
  userId: string,
  meta: { userAgent?: string | undefined },
  now: Date = new Date()
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = expiryFrom(CREATOR_SESSION_TTL_SECONDS, now);

  await prisma.creatorSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
    },
  });

  return { token, expiresAt };
}

/**
 * A new site, with its tier ladder and its settings document.
 *
 * All three in one transaction. A site with no tiers is not a partially
 * configured site, it is a broken one: `isEntitled` looks a member's tier up in
 * this table, and an empty ladder means every gate on the canvas denies
 * everyone with no error anywhere.
 */
async function createSite(userId: string): Promise<{ id: string; siteKey: string; siteName: string | null; allowedOrigins: unknown }> {
  return prisma.$transaction(async (tx) => {
    // No name and no domains: both are the creator's to type (Profile), never
    // read from Framer. `framerSiteId` stays null.
    const site = await tx.site.create({
      data: {
        userId,
        siteName: null,
        siteKey: generateSiteKey(),
        allowedOrigins: [],
        grantSalt: generateGrantSalt(),
      },
      select: { id: true, siteKey: true, siteName: true, allowedOrigins: true },
    });

    // Free only. Every member starts on it and it is the tier a member falls
    // back to, so a site cannot be without it. Any paid tier is one the creator
    // creates in the Manage tab: seeding Silver, Gold, and VIP filled every new
    // site with tiers the creator never made. The plugin's gate and paywall
    // controls are written from the site's real tiers (conflict C9), so a gate
    // never points at a tier that does not exist.
    await tx.tier.create({
      data: { siteId: site.id, key: NEW_FREE_TIER_KEY, name: "Free", rank: FREE_TIER_RANK },
    });

    await tx.siteSettings.create({
      data: {
        siteId: site.id,
        settings: toJsonDocument({
          ...defaultSettings(),
          branding: { displayName: "", supportEmail: "" },
        }),
      },
    });

    return site;
  });
}

// ============================================================================
// SESSIONS
// ============================================================================

export interface LoadedCreator {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
}

/**
 * Resolve a bearer token to a creator, or null.
 *
 * Null for every failure: absent, unknown, revoked, expired. The caller turns
 * that into one 401, because a route that could tell "expired" from "unknown"
 * would be answering a question nobody signed in has the right to ask.
 */
export async function loadCreator(token: string | undefined): Promise<LoadedCreator | null> {
  if (!token || token.trim() === "") return null;

  const session = await prisma.creatorSession.findUnique({
    where: { tokenHash: hashToken(token.trim()) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });

  if (!session) return null;
  if (session.revokedAt !== null) return null;
  if (isExpired(session.expiresAt)) return null;

  return {
    sessionId: session.id,
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

/** Fire and forget. A failed `lastSeenAt` write must never fail a request. */
export function touchCreatorSession(sessionId: string): void {
  void prisma.creatorSession
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);
}

export async function revokeCreatorSession(token: string | undefined): Promise<void> {
  if (!token || token.trim() === "") return;

  await prisma.creatorSession.updateMany({
    where: { tokenHash: hashToken(token.trim()), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * The site this creator owns, by id.
 *
 * 404 rather than 403 when it belongs to someone else, which is the rule the
 * backend PRD sets for every cross-tenant read: a 403 confirms the row exists,
 * so a creator could enumerate other people's site ids and learn which are
 * real. A 404 says only "not yours or not there", which are the same thing
 * from where the caller stands.
 */
export async function requireOwnedSite(
  userId: string,
  siteId: string
): Promise<{ id: string; siteKey: string; siteName: string; allowedOrigins: unknown }> {
  const site = await prisma.site.findFirst({
    where: { id: siteId, userId },
    select: { id: true, siteKey: true, siteName: true, allowedOrigins: true },
  });

  if (!site) throw notFound("site_not_found");

  // A site created since 2026-10-28 has no name. Every reader gets "" and
  // falls back where it shows one (a member email signs as "MemberFrame").
  return { ...site, siteName: site.siteName ?? "" };
}

// ============================================================================
// ORIGINS
// ============================================================================

/**
 * Keep only well-formed, exact origins.
 *
 * An origin is scheme, host, and optional port, and nothing else. A path, a
 * query, or a trailing slash all get stripped, because `Origin` headers never
 * carry them and a stored value that does could never match.
 *
 * `http:` is accepted only for a loopback host. Allowing plain `http` for a
 * real domain would let a network attacker read a session cookie, and a
 * developer running Framer locally is the only legitimate case for it.
 */
export function normalizeOrigins(values: ReadonlyArray<string>): string[] {
  const out: string[] = [];

  for (const raw of values) {
    if (typeof raw !== "string") continue;

    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      continue;
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";

    if (parsed.protocol === "http:" && !isLoopback) continue;

    const origin = parsed.origin;
    if (origin === "null") continue;
    if (!out.includes(origin)) out.push(origin);
  }

  // A bound, so a malformed client cannot grow one row without limit.
  return out.slice(0, 25);
}

function readOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function mergeOrigins(stored: unknown, added: ReadonlyArray<string>): string[] {
  const existing = readOrigins(stored);
  const merged = [...existing];

  for (const origin of added) {
    if (!merged.includes(origin)) merged.push(origin);
  }

  return merged.slice(0, 25);
}
