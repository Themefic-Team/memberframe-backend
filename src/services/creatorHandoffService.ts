/**
 * The hosted account page's hand-off to the plugin panel. F19,
 * 19-pro-lock-and-trial.md section 2.1, BEAF's "social-status" polling.
 *
 *   1. The panel makes a random session id and opens /auth?sessionId=... in a
 *      new browser tab (a plugin iframe cannot hold a sign-in form that
 *      Google, password managers, and the creator all trust).
 *   2. The creator signs in there; `completeHandoff` records who, for ten
 *      minutes.
 *   3. The panel, polling, calls `claimHandoff`; the first call turns the row
 *      into a creator session token and spends it. Every later call gets null.
 *
 * BEAF kept this in a process-memory Map, lost on restart and invisible to a
 * second server. It is a table here. Only the session id's hash is stored, as
 * for every token: a database read must not hand out sessions.
 */

import { prisma } from "../config/db.js";
import { hashToken } from "../lib/tokens.js";
import { issueCreatorSession } from "./creatorAuthService.js";

export const HANDOFF_TTL_SECONDS = 600;

/** The plugin makes it with `crypto.randomUUID()`; anything this shape is accepted. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{16,100}$/.test(value);
}

/** The creator signed in on the page: remember it for the panel. */
export async function completeHandoff(sessionId: string, userId: string, now: Date = new Date()): Promise<void> {
  const sessionIdHash = hashToken(sessionId);
  const expiresAt = new Date(now.getTime() + HANDOFF_TTL_SECONDS * 1000);
  await prisma.creatorAuthHandoff.upsert({
    where: { sessionIdHash },
    // A row already spent stays spent: a second sign-in on the same page
    // cannot mint a second session.
    update: {},
    create: { sessionIdHash, userId, expiresAt },
  });
}

export interface ClaimedHandoff {
  token: string;
  expiresAt: Date;
  creator: { email: string; name: string; avatarUrl: string | null };
}

/** The panel's poll. A session token the first time; null before sign-in, after expiry, and ever after. */
export async function claimHandoff(
  sessionId: string,
  meta: { userAgent?: string | undefined },
  now: Date = new Date()
): Promise<ClaimedHandoff | null> {
  const row = await prisma.creatorAuthHandoff.findUnique({
    where: { sessionIdHash: hashToken(sessionId) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (!row || row.consumedAt || row.expiresAt <= now) return null;

  // Spend it atomically: two polls racing get one token between them.
  const spent = await prisma.creatorAuthHandoff.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (spent.count !== 1) return null;

  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { email: true, name: true, avatarUrl: true },
  });
  if (!user) return null;

  const session = await issueCreatorSession(row.userId, meta, now);
  return { ...session, creator: user };
}
