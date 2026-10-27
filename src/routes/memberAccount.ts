/**
 * A member's own account area, behind `<MemberDashboard>`'s Security and
 * Profile sections (memberframe docs/development-docs/33-member-account.md).
 *
 * Mounted under `/api/member` with `resolveSite` and `requireActiveLicense`,
 * like every member route. Each handler is authorized by the member's own
 * session cookie and acts only on that member: every query is scoped by the
 * member id from the session and the site id from the request, never by an id
 * the request names on its own. The rules are in `lib/memberAccount.ts`.
 *
 *   GET    /account                 security summary
 *   POST   /password                change or set the password
 *   DELETE /identities/:provider    unlink a sign-in method
 *   DELETE /sessions/:id            sign out one other device
 *   POST   /avatar                  upload a photo (raw image body)
 *   DELETE /avatar                  remove the uploaded photo
 *   DELETE /account                 delete the account
 *
 * The photo itself is served by `handleAvatar`, mounted before the site check
 * because an `<img>` request carries no Origin.
 */

import express, { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";
import { badRequest, ok, route, unauthorized } from "../middleware/errors.js";
import { requireSite } from "../middleware/site.js";
import { guardCredentialCheck } from "../middleware/rateLimit.js";
import { clearSessionCookie } from "../lib/cookies.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { isAcceptablePassword, passwordProblems } from "../lib/credentials.js";
import { hashToken } from "../lib/tokens.js";
import { passwordChangedMail, sendMail } from "../lib/mailer.js";
import { publicApiBase } from "../lib/publicApiBase.js";
import {
  AVATAR_MAX_BYTES,
  avatarTokenFromUrl,
  blocksAccountDeletion,
  canUnlink,
  confirmsEmail,
  deviceLabel,
  signAvatarToken,
  sniffImageType,
  verifyAvatarToken,
} from "../lib/memberAccount.js";
import { loadSession, revokeAllSessionsForMember } from "../services/sessionService.js";
import { loadSiteSettings } from "../services/settingsService.js";
import { MEMBER_SNAPSHOT_SELECT, emitMemberEvent } from "../services/webhookService.js";
import { openFile, putFile, removeFile } from "../services/assets/storage.js";

export const memberAccountRouter = Router();

/** The signed-in member for this site, or a 401. */
async function requireMemberSession(req: Request) {
  const site = requireSite(req);
  const token = req.cookies?.[env.session.cookieName] as string | undefined;
  const session = await loadSession(token, site.id);
  if (!session || !token) throw unauthorized();
  return { site, session, token, memberId: session.member.memberId };
}

/** Remove a photo we stored. A Google or GitHub photo address is left alone. */
async function removeStoredAvatar(avatarUrl: string | null | undefined): Promise<void> {
  const token = avatarTokenFromUrl(avatarUrl);
  const payload = token ? verifyAvatarToken(token) : null;
  if (payload) await removeFile(payload.storageKey).catch(() => undefined);
}

// ============================================================================
// GET /api/member/account
// ============================================================================

memberAccountRouter.get(
  "/account",
  route(async (req, res) => {
    const { site, session, token, memberId } = await requireMemberSession(req);
    res.setHeader("Cache-Control", "private, no-store");

    const [member, identities, sessions] = await Promise.all([
      prisma.member.findFirst({
        where: { id: memberId, siteId: site.id, deletedAt: null },
        select: { passwordHash: true, emailVerifiedAt: true, createdAt: true, avatarUrl: true },
      }),
      prisma.memberIdentity.findMany({
        where: { memberId, siteId: site.id },
        select: { provider: true, email: true, createdAt: true, lastUsedAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.memberSession.findMany({
        where: { memberId, siteId: site.id, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, tokenHash: true, userAgent: true, createdAt: true, lastSeenAt: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    if (!member) throw unauthorized();

    const current = hashToken(token);
    ok(res, {
      hasPassword: member.passwordHash !== null && member.passwordHash !== "",
      emailVerified: member.emailVerifiedAt !== null,
      memberSince: member.createdAt.toISOString(),
      avatarUrl: member.avatarUrl ?? null,
      identities: identities.map((identity) => ({
        provider: identity.provider,
        email: identity.email,
        createdAt: identity.createdAt.toISOString(),
        lastUsedAt: identity.lastUsedAt.toISOString(),
      })),
      // The IP address is never sent: a device name is enough to recognise it.
      sessions: sessions.map((row) => ({
        id: row.id,
        current: row.tokenHash === current,
        device: deviceLabel(row.userAgent),
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      })),
      tiers: session.tiers,
    });
  })
);

// ============================================================================
// POST /api/member/password
// ============================================================================
// Change the password, or set a first one for a member who signed up with
// Google or another provider. Every other device is signed out afterwards, as
// a reset does, and the "password changed" email goes to the address.

const passwordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(1).max(200),
});

memberAccountRouter.post(
  "/password",
  route(async (req, res) => {
    const { site, token, memberId } = await requireMemberSession(req);
    const input = passwordSchema.parse(req.body);
    guardCredentialCheck(req, "change-password");

    const member = await prisma.member.findFirst({
      where: { id: memberId, siteId: site.id, deletedAt: null },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!member) throw unauthorized();

    if (member.passwordHash) {
      const matches = input.currentPassword ? await verifyPassword(input.currentPassword, member.passwordHash) : false;
      if (!matches) throw badRequest("wrong_password");
    }

    const { passwordPolicy } = (await loadSiteSettings(site.id)).auth;
    if (!isAcceptablePassword(input.newPassword, member.email, passwordPolicy)) {
      throw badRequest("weak_password", { problems: passwordProblems(input.newPassword, member.email, passwordPolicy) });
    }

    await prisma.member.update({
      where: { id: member.id },
      data: { passwordHash: await hashPassword(input.newPassword), passwordUpdatedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    const signedOut = await revokeAllSessionsForMember(member.id, token);
    await sendMail(passwordChangedMail(member.email, site.siteName, site.id));

    ok(res, { changed: true, otherDevicesSignedOut: signedOut });
  })
);

// ============================================================================
// DELETE /api/member/identities/:provider
// ============================================================================

memberAccountRouter.delete(
  "/identities/:provider",
  route(async (req, res) => {
    const { site, memberId } = await requireMemberSession(req);
    const provider = String(req.params["provider"] ?? "").toLowerCase();

    const [member, identities] = await Promise.all([
      prisma.member.findFirst({ where: { id: memberId, siteId: site.id, deletedAt: null }, select: { passwordHash: true } }),
      prisma.memberIdentity.findMany({ where: { memberId, siteId: site.id }, select: { provider: true } }),
    ]);
    if (!member) throw unauthorized();

    const providers = identities.map((identity) => identity.provider);
    if (!providers.includes(provider)) throw badRequest("not_linked");
    if (!canUnlink(provider, Boolean(member.passwordHash), providers)) throw badRequest("last_sign_in_method");

    await prisma.memberIdentity.deleteMany({ where: { memberId, siteId: site.id, provider } });
    ok(res, { unlinked: provider });
  })
);

// ============================================================================
// DELETE /api/member/sessions/:id
// ============================================================================

memberAccountRouter.delete(
  "/sessions/:id",
  route(async (req, res) => {
    const { site, token, memberId } = await requireMemberSession(req);
    const id = String(req.params["id"] ?? "");

    const target = await prisma.memberSession.findFirst({
      where: { id, memberId, siteId: site.id, revokedAt: null },
      select: { id: true, tokenHash: true },
    });
    if (!target) throw badRequest("session_not_found");
    // This device signs out with Sign out, which also clears its cookie.
    if (target.tokenHash === hashToken(token)) throw badRequest("current_session");

    await prisma.memberSession.update({ where: { id: target.id }, data: { revokedAt: new Date() } });
    ok(res, { signedOut: target.id });
  })
);

// ============================================================================
// POST and DELETE /api/member/avatar
// ============================================================================

memberAccountRouter.post(
  "/avatar",
  // Its own body parser: the global JSON limit is 16 KB, and a photo is the
  // raw image, not JSON.
  express.raw({ type: () => true, limit: AVATAR_MAX_BYTES }),
  route(async (req, res) => {
    const { site, memberId } = await requireMemberSession(req);
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("no_image");
    if (body.length > AVATAR_MAX_BYTES) throw badRequest("image_too_large");

    const type = sniffImageType(body);
    if (!type) throw badRequest("unsupported_image");

    const member = await prisma.member.findFirst({
      where: { id: memberId, siteId: site.id, deletedAt: null },
      select: { avatarUrl: true },
    });
    if (!member) throw unauthorized();

    const stored = await putFile(site.id, Readable.from(body), AVATAR_MAX_BYTES);
    const avatarUrl = `${publicApiBase(req)}/api/avatars/${signAvatarToken({ storageKey: stored.storageKey, type })}`;
    await prisma.member.update({ where: { id: memberId }, data: { avatarUrl } });
    await removeStoredAvatar(member.avatarUrl);

    ok(res, { avatarUrl });
  })
);

memberAccountRouter.delete(
  "/avatar",
  route(async (req, res) => {
    const { site, memberId } = await requireMemberSession(req);
    const member = await prisma.member.findFirst({
      where: { id: memberId, siteId: site.id, deletedAt: null },
      select: { avatarUrl: true },
    });
    if (!member) throw unauthorized();

    await prisma.member.update({ where: { id: memberId }, data: { avatarUrl: null } });
    await removeStoredAvatar(member.avatarUrl);
    ok(res, { avatarUrl: null });
  })
);

// ============================================================================
// DELETE /api/member/account
// ============================================================================
// The member deletes their own account: the same delete as the creator's in
// `routes/site.ts` (webhook from the record as it is now, pending codes
// cleared, the row and everything hanging off it removed). Refused while a
// plan would charge again, because nothing here cancels at the gateway.
// Payments carry no member key and stay, as the creator's revenue record.

const deleteSchema = z.object({ confirmEmail: z.string().max(255) });

memberAccountRouter.delete(
  "/account",
  route(async (req, res) => {
    const { site, memberId } = await requireMemberSession(req);
    const input = deleteSchema.parse(req.body ?? {});

    const member = await prisma.member.findFirst({
      where: { id: memberId, siteId: site.id, deletedAt: null },
      select: { ...MEMBER_SNAPSHOT_SELECT, avatarUrl: true },
    });
    if (!member) throw unauthorized();
    if (!confirmsEmail(input.confirmEmail, member.email)) throw badRequest("email_mismatch");

    const subscriptions = await prisma.subscription.findMany({
      where: { memberId, siteId: site.id, endedAt: null },
      select: { status: true, interval: true, cancelAtPeriodEnd: true },
    });
    if (subscriptions.some(blocksAccountDeletion)) throw badRequest("active_plan");

    const { avatarUrl, ...snapshot } = member;
    await emitMemberEvent("member.deleted", snapshot);
    await prisma.$transaction([
      prisma.memberOtp.deleteMany({ where: { siteId: site.id, email: member.email } }),
      prisma.member.delete({ where: { id: member.id } }),
    ]);
    await removeStoredAvatar(avatarUrl);

    clearSessionCookie(res);
    ok(res, { deleted: true });
  })
);

// ============================================================================
// GET /api/avatars/:token
// ============================================================================
// The photo itself. Public, mounted before the site check: an `<img>` sends no
// Origin. The token is signed and names only the stored file, so it cannot be
// guessed or edited to read another; only images that passed the type check
// at upload are ever stored under one.

export async function handleAvatar(req: Request, res: Response): Promise<void> {
  const payload = verifyAvatarToken(String(req.params["token"] ?? ""));
  if (!payload) {
    res.status(404).end();
    return;
  }
  try {
    const file = await openFile(payload.storageKey);
    res.setHeader("Content-Type", payload.type);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (file.sizeBytes !== null) res.setHeader("Content-Length", String(file.sizeBytes));
    file.stream.on("error", () => res.destroy());
    file.stream.pipe(res);
  } catch {
    res.status(404).end();
  }
}
