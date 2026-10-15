/**
 * Creator identity, and the connect handshake.
 *
 * This closes conflict C10. Every `/api/site/*` route needed a creator session
 * and nothing in the 72-task plan built one, so the plugin's Manage and
 * Settings tabs have rendered their signed-out state since the project began.
 *
 * ## The handshake, and why it has two steps
 *
 * The plugin knows the Framer project id and the creator's name, from
 * `framer.getProjectInfo()` and `framer.getCurrentUser()`. It does NOT know
 * their email address: blocker B7 records that the SDK exposes none. So the
 * creator types one, and an address a creator typed is a claim, not a fact.
 *
 * One step would mean: send a project id and an address, receive a token that
 * reads every member of that site. Anyone who learned a project id could type
 * any address and take the site. So:
 *
 *   1. `startConnect` sends a six-digit code to the address and answers 200
 *      whatever happens.
 *   2. `verifyConnect` takes the code and only then creates the account, claims
 *      the project, and issues a token.
 *
 * The code proves the address belongs to whoever is typing. That is the whole
 * security model of this flow, and it is the same one the member OTP uses.
 *
 * ## Claiming is first come, and that is a real limitation
 *
 * The first address to verify against a Framer project id owns that site.
 * A second creator connecting the same project gets 403 rather than access,
 * which is correct and also means a project connected by mistake, or by a
 * contractor who has left, needs support to reassign. There is no transfer
 * flow and no team model. Recorded as conflict C28 rather than invented here:
 * a wrong guess about ownership transfer is expensive to undo.
 */

import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { badRequest, forbidden, notFound, unauthorized } from "../middleware/errors.js";
import { creatorCodeMail, sendMail } from "../lib/mailer.js";
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
  framerProjectId: string;
}

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
      framerProjectId: input.framerProjectId,
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
    where: { email, framerProjectId: input.framerProjectId, consumedAt: null },
    data: { consumedAt: now },
  });

  await prisma.creatorOtp.create({
    data: {
      email,
      framerProjectId: input.framerProjectId,
      codeHash: hashToken(code),
      expiresAt: expiryFrom(env.otp.ttlSeconds, now),
      resendAvailableAt: expiryFrom(env.otp.resendLockSeconds, now),
    },
  });

  // The mailer never throws: a send failure is logged and the flow continues.
  // That is right here. If SMTP is down, telling the creator "we could not
  // send" is useful, but failing the request after the code is already stored
  // would leave a usable code with no way to learn it.
  await sendMail(creatorCodeMail(email, code));
}

export interface VerifyConnectInput {
  email: string;
  code: string;
  framerProjectId: string;
  projectName: string;
  creatorName: string | null;
  /** Origins this site will be served from. Added to the allowlist on claim. */
  origins: string[];
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface ConnectedSite {
  siteId: string;
  siteKey: string;
  siteName: string;
  framerProjectId: string;
  allowedOrigins: string[];
}

export interface VerifyConnectResult {
  token: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string };
  site: ConnectedSite;
}

/**
 * Check the code, then create or find everything behind it.
 *
 * The order is deliberate and it is the whole of the authorization story:
 * nothing below the code check reads or writes a site. A wrong code returns
 * before `framerProjectId` has been used for anything at all.
 */
export async function verifyConnect(input: VerifyConnectInput): Promise<VerifyConnectResult> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();

  const otp = await prisma.creatorOtp.findFirst({
    where: { email, framerProjectId: input.framerProjectId, consumedAt: null },
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

  if (!tokensMatch(otp.codeHash, hashToken(input.code.trim()))) {
    await prisma.creatorOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    throw unauthorized("invalid_code");
  }

  await prisma.creatorOtp.update({ where: { id: otp.id }, data: { consumedAt: now } });

  // ------------------------------------------------------------------------
  // The address is proven. Everything below is ordinary bookkeeping.
  // ------------------------------------------------------------------------

  // Find, then create. Not an upsert with an empty update branch: an existing
  // creator's name is theirs, and overwriting it with whatever Framer reports
  // on this machine would silently rename them every reconnect.
  const found = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });

  const user =
    found ??
    (await prisma.user.create({
      data: {
        email,
        name: input.creatorName?.trim() || email.split("@")[0] || "Creator",
        emailVerifiedAt: now,
        passwordHash: null,
      },
      select: { id: true, email: true, name: true },
    }));

  const existing = await prisma.site.findUnique({
    where: { framerSiteId: input.framerProjectId },
    select: { id: true, userId: true, siteKey: true, siteName: true, allowedOrigins: true },
  });

  if (existing && existing.userId !== user.id) {
    // First claim wins. See the header note: there is no transfer flow, and
    // inventing one here would be a product decision made in a service file.
    throw forbidden("project_claimed_by_another_account");
  }

  const origins = normalizeOrigins(input.origins);

  const site = existing
    ? await prisma.site.update({
        where: { id: existing.id },
        data: {
          siteName: input.projectName.trim() || existing.siteName,
          // Union, never replace. A creator reconnecting from a preview URL
          // must not lose the custom domain they added last week.
          allowedOrigins: mergeOrigins(existing.allowedOrigins, origins),
        },
        select: { id: true, siteKey: true, siteName: true, allowedOrigins: true },
      })
    : await createSite(user.id, input, origins);

  const token = generateToken();

  await prisma.creatorSession.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: expiryFrom(CREATOR_SESSION_TTL_SECONDS, now),
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      ipAddress: input.ipAddress?.slice(0, 45) ?? null,
    },
  });

  return {
    token,
    expiresAt: expiryFrom(CREATOR_SESSION_TTL_SECONDS, now),
    user,
    site: {
      siteId: site.id,
      siteKey: site.siteKey,
      siteName: site.siteName,
      framerProjectId: input.framerProjectId,
      allowedOrigins: readOrigins(site.allowedOrigins),
    },
  };
}

/**
 * A new site, with its tier ladder and its settings document.
 *
 * All three in one transaction. A site with no tiers is not a partially
 * configured site, it is a broken one: `isEntitled` looks a member's tier up in
 * this table, and an empty ladder means every gate on the canvas denies
 * everyone with no error anywhere.
 */
async function createSite(
  userId: string,
  input: VerifyConnectInput,
  origins: string[]
): Promise<{ id: string; siteKey: string; siteName: string; allowedOrigins: unknown }> {
  return prisma.$transaction(async (tx) => {
    const site = await tx.site.create({
      data: {
        userId,
        siteName: input.projectName.trim() || "Untitled project",
        siteKey: generateSiteKey(),
        framerSiteId: input.framerProjectId,
        allowedOrigins: origins,
        grantSalt: generateGrantSalt(),
      },
      select: { id: true, siteKey: true, siteName: true, allowedOrigins: true },
    });

    // The same four keys `types/member.ts` declares as DEFAULT_SITE_TIERS, and
    // the same ranks. The plugin's property control offers exactly these four
    // (conflict C9), so a site seeded with anything else would have gates
    // pointing at tiers that do not exist.
    await tx.tier.createMany({
      data: [
        { siteId: site.id, key: "free_member", name: "Free", rank: 0 },
        { siteId: site.id, key: "tier_1", name: "Silver", rank: 1 },
        { siteId: site.id, key: "tier_2", name: "Gold", rank: 2 },
        { siteId: site.id, key: "vip", name: "VIP", rank: 3 },
      ],
    });

    await tx.siteSettings.create({
      data: {
        siteId: site.id,
        settings: toJsonDocument({
          ...defaultSettings(),
          branding: { displayName: site.siteName, supportEmail: "" },
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

  return site;
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
