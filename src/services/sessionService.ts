/**
 * Member sessions: issue, read, revoke.
 *
 * A session is a row with a hashed opaque token, not a JWT. `lib/tokens.ts`
 * explains why at length; the short version is that a password reset must
 * invalidate every other session, and you cannot revoke a stateless token.
 */

import { prisma } from "../config/db.js";
import { expiryFrom, generateToken, hashToken } from "../lib/tokens.js";
import {
  type MemberSessionData,
  type MemberStatus,
  type TierLadderEntry,
} from "../lib/entitlement.js";

export interface IssuedSession {
  /** The plaintext. Goes into the cookie and is never stored or logged. */
  token: string
  expiresAt: Date;
}

const VALID_STATUSES: ReadonlyArray<MemberStatus> = [
  "active",
  "trialing",
  "past_due",
  "canceled",
];

/**
 * Coerce whatever is in the status column into the union.
 *
 * The column is a VARCHAR rather than a MySQL enum, so a value written by a
 * migration, a webhook, or a hand edit might not be one of the four. Anything
 * unrecognised becomes `canceled`, which `isEntitled` then evaluates against
 * `currentPeriodEnd`: a past date means no access. Failing closed on a value
 * nobody planned for is the whole point of S11.
 */
export function toMemberStatus(value: string): MemberStatus {
  return VALID_STATUSES.includes(value as MemberStatus) ? (value as MemberStatus) : "canceled";
}

export async function issueSession(
  memberId: string,
  siteId: string,
  ttlSeconds: number,
  context: { userAgent?: string | undefined; ipAddress?: string | undefined } = {}
): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = expiryFrom(ttlSeconds);

  await prisma.memberSession.create({
    data: {
      memberId,
      siteId,
      tokenHash: hashToken(token),
      expiresAt,
      // Truncated rather than rejected: a browser can send a very long UA and
      // that is not a reason to fail a sign-in.
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      ipAddress: context.ipAddress?.slice(0, 45) ?? null,
      lastSeenAt: new Date(),
    },
  });

  return { token, expiresAt };
}

export interface LoadedSession {
  sessionId: string;
  member: MemberSessionData;
  tiers: TierLadderEntry[];
}

/**
 * Read a session from a cookie value.
 *
 * Returns null for every failure, with no distinction between them: no cookie,
 * unknown token, expired, revoked, member soft deleted, or wrong site. The
 * caller turns null into a 401, and a 401 is the only thing the client needs.
 * Reporting *why* would say whether a token was ever valid.
 *
 * Scoped by `siteId` as well as by token. Without that, a session issued for
 * site A would authenticate on site B, which is the cross-tenant leak PRD
 * section 16.4 makes a release blocker.
 */
export async function loadSession(
  token: string | undefined,
  siteId: string,
  now: Date = new Date()
): Promise<LoadedSession | null> {
  if (!token || token.trim() === "") return null;

  const session = await prisma.memberSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      member: {
        select: {
          id: true,
          siteId: true,
          email: true,
          name: true,
          activeTier: true,
          status: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!session) return null;
  if (session.siteId !== siteId) return null;
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  const member = session.member;
  if (!member || member.deletedAt !== null) return null;
  if (member.siteId !== siteId) return null;

  const tiers = await loadTierLadder(siteId);

  // The subscription behind the member's tier, if a purchase put them there.
  // Its dates are what let `isEntitled` keep a canceled member in until the
  // period they paid for ends, and a past_due one in through the grace window.
  const billing = await prisma.subscription.findFirst({
    where: {
      siteId,
      memberId: member.id,
      tierKey: member.activeTier,
      status: { in: ["active", "past_due", "canceling"] },
    },
    orderBy: { createdAt: "desc" },
    select: { currentPeriodEnd: true, gracePeriodEndsAt: true, interval: true },
  });

  const unix = (date: Date | null | undefined) => (date ? Math.floor(date.getTime() / 1000) : 0);

  return {
    sessionId: session.id,
    member: {
      memberId: member.id,
      email: member.email,
      name: member.name,
      activeTier: member.activeTier,
      status: toMemberStatus(member.status),
      // Zero when no subscription explains the tier: a free member, a tier
      // granted by hand, or a lifetime purchase. `isEntitled` reads these
      // only for `past_due` and `canceled`, so a zero can only deny.
      currentPeriodEnd: unix(billing?.currentPeriodEnd),
      gracePeriodEndsAt: unix(billing?.gracePeriodEndsAt),
      siteId: member.siteId,
    },
    tiers,
  };
}

/**
 * The site's tier ladder.
 *
 * CONFLICT C5, resolved. `isEntitled` compares `held.rank >= required.rank`
 * and both canvas components currently ship a hardcoded default ladder because
 * the session response carried none. Returning the real one retires that
 * default, and it also retires conflict C9: once a component can see the site's
 * actual keys, the generator can emit them as the gate's enum options instead
 * of a fixed list of four.
 *
 * Inactive tiers are included. `isEntitled` looks a tier up by key without
 * checking `isActive`, so omitting a hidden tier would make a member who holds
 * it fail every gate.
 */
export async function loadTierLadder(siteId: string): Promise<TierLadderEntry[]> {
  const tiers = await prisma.tier.findMany({
    where: { siteId },
    select: { key: true, rank: true, name: true },
    orderBy: { rank: "asc" },
  });

  return tiers.map((tier) => ({ key: tier.key, rank: tier.rank, name: tier.name }));
}

/** Note that a session was used. Best effort: a failure must not break the request. */
export async function touchSession(sessionId: string): Promise<void> {
  try {
    await prisma.memberSession.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    });
  } catch {
    // A session deleted between the read and this write. Nothing to do.
  }
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.memberSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every session for a member.
 *
 * What makes a password reset a recovery rather than a password change. FP-02
 * section 2.3: "Existing sessions are invalidated". If someone else was signed
 * in as this member, this is what removes them.
 *
 * `except` lets a reset keep the session it just issued, so the member is not
 * signed out of the tab they are standing in.
 */
export async function revokeAllSessionsForMember(
  memberId: string,
  except?: string
): Promise<number> {
  const result = await prisma.memberSession.updateMany({
    where: {
      memberId,
      revokedAt: null,
      ...(except ? { NOT: { tokenHash: hashToken(except) } } : {}),
    },
    data: { revokedAt: new Date() },
  });

  return result.count;
}

/**
 * Delete expired and long-revoked rows.
 *
 * Not called automatically. There is no scheduler yet, and inventing one here
 * would hide it: run `npm run db:sweep` or add a cron entry. Expired sessions
 * are already refused by `loadSession`, so this is housekeeping rather than
 * security.
 */
export async function sweepSessions(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

  const result = await prisma.memberSession.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }],
    },
  });

  return result.count;
}
