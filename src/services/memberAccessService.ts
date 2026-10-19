/**
 * The creator's member actions that reach past MemberFrame's own record:
 * revoking access (which also stops the member's billing), restoring it, and
 * emailing a one-click sign-in link. Development doc 26-magic-link-and-revoke.md.
 */

import { prisma } from "../config/db.js";
import { ApiError } from "../middleware/errors.js";
import { freeTierKey } from "../lib/tiers.js";
import { pickSiteOrigin } from "../lib/siteLinks.js";
import { magicLinkMail, sendMail } from "../lib/mailer.js";
import { issueSession, revokeAllSessionsForMember, revokeSession } from "./sessionService.js";
import { loadSiteSettings } from "./settingsService.js";
import { emitMemberEvent } from "./webhookService.js";
import { ADAPTERS, loadCredentials } from "./payments/gatewayStore.js";
import { RUNNING } from "./payments/apply.js";
import { GatewayError, type GatewayId, type PaymentMode } from "./payments/types.js";

/** How long a magic link works. Long enough to find the email, short enough to matter. */
export const MAGIC_LINK_TTL_SECONDS = 60 * 60;

/** Every message below is shown as is in a panel toast, so each stays within 45 characters. */
const GATEWAY_NAMES: Record<GatewayId, string> = { stripe: "Stripe", lemonsqueezy: "Lemon Squeezy", razorpay: "Razorpay" };

function log(message: string): void {
  process.stdout.write(`[members] ${message}\n`);
}

async function findMember(siteId: string, memberId: string) {
  const member = await prisma.member.findFirst({
    where: { id: memberId, siteId, deletedAt: null },
    select: { id: true, email: true, activeTier: true, status: true },
  });
  if (!member) throw new ApiError(400, "member_not_found");
  return member;
}

/**
 * Take a member's access away for good: their subscriptions end at the
 * gateway now (no refund), they drop to Free with status `canceled`, and every
 * session they hold is signed out.
 *
 * Free, not the tier they held: `recomputeMember` puts a member who bought
 * their tier back on Free with status `active` once nothing is running, which
 * the gateway's own "ended" webhook would trigger. A Free member is left alone.
 *
 * A gateway that refuses the cancel stops the revoke before the member changes,
 * so the creator never sees "revoked" while the card keeps being charged.
 */
export async function revokeMemberAccess(siteId: string, memberId: string): Promise<{ canceledSubscriptions: number }> {
  const member = await findMember(siteId, memberId);
  const running = await prisma.subscription.findMany({
    where: { siteId, memberId: member.id, status: { in: [...RUNNING] } },
    select: { id: true, gateway: true, mode: true, interval: true, externalId: true },
  });

  const now = new Date();
  let canceled = 0;
  for (const subscription of running) {
    const gateway = subscription.gateway as GatewayId;
    if (subscription.interval !== "lifetime") {
      const credentials = await loadCredentials(siteId, gateway, subscription.mode as PaymentMode);
      if (credentials) {
        try {
          await ADAPTERS[gateway].cancelNow(credentials, subscription.externalId);
        } catch (error) {
          if (error instanceof GatewayError) {
            const name = GATEWAY_NAMES[gateway] ?? gateway;
            throw new ApiError(502, "gateway_cancel_failed", `${name} refused the cancel. Nothing changed.`, {
              gateway,
              message: `${name} refused the cancel. Nothing changed.`,
            });
          }
          throw error;
        }
      } else {
        // No keys for this gateway any more: nothing can cancel it from here,
        // and nothing can deliver a verified webhook to revive it either.
        log(`no ${gateway} keys for site ${siteId}; ending subscription ${subscription.id} here only`);
      }
      canceled += 1;
    }
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "ended", endedAt: now, cancelAtPeriodEnd: false },
    });
  }

  const freeKey = await freeTierKey(siteId);
  await prisma.member.update({ where: { id: member.id }, data: { activeTier: freeKey, status: "canceled" } });
  await revokeAllSessionsForMember(member.id);

  void emitMemberEvent(
    member.activeTier !== freeKey ? "member.tier_changed" : "member.updated",
    { id: member.id, siteId },
    member.activeTier !== freeKey ? { previousTier: member.activeTier } : {}
  );
  log(`member ${member.id} revoked; ${canceled} subscription(s) canceled`);

  return { canceledSubscriptions: canceled };
}

/** Undo a revoke: active on Free again. Nothing paid comes back; the member buys again for that. */
export async function restoreMemberAccess(siteId: string, memberId: string): Promise<void> {
  const member = await findMember(siteId, memberId);
  if (member.status !== "canceled") return;
  await prisma.member.update({ where: { id: member.id }, data: { status: "active" } });
  void emitMemberEvent("member.updated", { id: member.id, siteId });
}

/**
 * Email a member a one-click sign in: `{site}{loginPath}#mf_oauth={code}`.
 *
 * The code is a member session made only to be exchanged, the same handoff
 * social sign in uses, so `<MemberAuth>` on the login page signs the member in
 * with no change to the published components. It is single use (the exchange
 * revokes it) and travels in the fragment, so neither the site's server nor a
 * mail scanner that fetches the page can spend it.
 */
export async function issueMagicLink(
  site: { id: string; siteName: string; allowedOrigins: unknown },
  memberId: string,
  context: { userAgent?: string | undefined; ipAddress?: string | undefined } = {}
): Promise<{ url: string; email: string; minutes: number }> {
  const member = await findMember(site.id, memberId);
  if (member.status === "canceled") {
    throw new ApiError(409, "member_revoked", "Restore this member's access first.", {
      message: "Restore this member's access first.",
    });
  }

  const allowed = Array.isArray(site.allowedOrigins) ? site.allowedOrigins.filter((origin): origin is string => typeof origin === "string") : [];
  const origin = pickSiteOrigin(undefined, allowed);
  if (!origin) {
    throw new ApiError(409, "no_site_url", "Publish the site, or add its domain.", {
      message: "Publish the site, or add its domain.",
    });
  }

  const settings = await loadSiteSettings(site.id);
  const handoff = await issueSession(member.id, site.id, MAGIC_LINK_TTL_SECONDS, context);
  const path = settings.auth.loginPath.startsWith("/") ? settings.auth.loginPath : `/${settings.auth.loginPath}`;
  const url = `${origin}${path}#mf_oauth=${encodeURIComponent(handoff.token)}`;
  const minutes = Math.round(MAGIC_LINK_TTL_SECONDS / 60);

  const sent = await sendMail(magicLinkMail(member.email, url, minutes, site.siteName, site.id));
  if (!sent.sent) {
    // The creator pressed Send: saying "sent" when it was not would be worse
    // than the error. The unused code goes with it.
    await revokeSession(handoff.token);
    throw new ApiError(502, "mail_failed", "Email failed. Check Settings, Config.", {
      message: "Email failed. Check Settings, Config.",
    });
  }
  return { url, email: member.email, minutes };
}
