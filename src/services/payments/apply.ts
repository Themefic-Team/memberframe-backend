/**
 * What a payment event does to a member. FP-16 sections 3.2, 4.3, and 10.
 *
 * Access is always the tier, never the payment: gates read `activeTier` and
 * `status` and nothing else. This file is the only place a payment changes
 * those two fields, through `recomputeMember`, so the rule for which tier a
 * member holds lives in one function:
 *
 *   the highest-ranked tier among their subscriptions that are still running
 *   (active, past_due, or canceling) in the site's current mode.
 *
 * A tier the creator granted by hand is left alone when no subscription
 * explains it. A subscription bought in test mode grants nothing in live mode.
 */

import { prisma } from "../../config/db.js";
import { freeTierKey } from "../../lib/tiers.js";
import { loadTierLadder } from "../sessionService.js";
import { emitMemberEvent } from "../webhookService.js";
import { ADAPTERS, loadCredentials, loadPaymentSettings } from "./gatewayStore.js";
import { tierAmount, unusedCredit } from "./prices.js";
import { sendMail } from "../../lib/mailer.js";
import { parseAllowedOrigins } from "../../middleware/site.js";
import type { GatewayCredentials, GatewayId, PaymentEvent, PaymentMode } from "./types.js";

/** Subscription statuses that still grant their tier. */
export const RUNNING = ["active", "past_due", "canceling"] as const;

const MEMBER_STATUS: Record<string, string> = {
  active: "active",
  past_due: "past_due",
  canceling: "canceled",
};

const DAY_MS = 86_400_000;

function log(message: string): void {
  process.stdout.write(`[payments] ${message}\n`);
}

/**
 * The subscription that decides a member's tier, or null.
 *
 * Exported for the session payload, which reads its period end and grace end,
 * so the shield and the gate apply PRD 11.3 without another request.
 */
export async function governingSubscription(siteId: string, memberId: string, mode?: PaymentMode) {
  const currentMode = mode ?? (await loadPaymentSettings(siteId)).mode;

  const [subscriptions, ladder] = await Promise.all([
    prisma.subscription.findMany({
      where: { siteId, memberId, mode: currentMode, status: { in: [...RUNNING] } },
      orderBy: { createdAt: "desc" },
    }),
    loadTierLadder(siteId),
  ]);

  const rank = (key: string) => ladder.find((tier) => tier.key === key)?.rank ?? -1;
  let best: (typeof subscriptions)[number] | null = null;
  for (const subscription of subscriptions) {
    if (!best || rank(subscription.tierKey) > rank(best.tierKey)) best = subscription;
  }
  return best;
}

/** Set a member's tier and status from their subscriptions. */
export async function recomputeMember(siteId: string, memberId: string): Promise<void> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, siteId },
    select: { id: true, activeTier: true, status: true },
  });
  if (!member) return;

  const governing = await governingSubscription(siteId, memberId);

  if (governing) {
    const status = MEMBER_STATUS[governing.status] ?? "active";
    if (member.activeTier !== governing.tierKey || member.status !== status) {
      await prisma.member.update({ where: { id: member.id }, data: { activeTier: governing.tierKey, status } });
      log(`member ${member.id} now ${governing.tierKey} (${status})`);
      void emitMemberEvent(
        member.activeTier !== governing.tierKey ? "member.tier_changed" : "member.updated",
        { id: member.id, siteId },
        member.activeTier !== governing.tierKey ? { previousTier: member.activeTier } : {}
      );
    }
    return;
  }

  // Nothing running. Drop to Free only if a purchase is what put them on
  // their tier; a tier granted by hand in the Manage tab stays.
  const bought = await prisma.subscription.findFirst({
    where: { siteId, memberId, tierKey: member.activeTier },
    select: { id: true },
  });

  const freeKey = bought ? await freeTierKey(siteId) : "";
  if (bought && (member.activeTier !== freeKey || member.status !== "active")) {
    await prisma.member.update({ where: { id: member.id }, data: { activeTier: freeKey, status: "active" } });
    log(`member ${member.id} back to ${freeKey}`);
    void emitMemberEvent(
      member.activeTier !== freeKey ? "member.tier_changed" : "member.updated",
      { id: member.id, siteId },
      member.activeTier !== freeKey ? { previousTier: member.activeTier } : {}
    );
  }
}

/** Moved to prices.ts (30-plan-changes.md); re-exported for existing callers. */
export { unusedCredit } from "./prices.js";

/** Refunds below this are not worth a gateway call or the buyer's attention. */
const MIN_CREDIT_MINOR = 50;

function priceFor(tier: { monthlyPriceMinor: number | null; annualPriceMinor: number | null; lifetimePriceMinor: number | null }, interval: string): number {
  if (interval === "month") return tier.monthlyPriceMinor ?? 0;
  if (interval === "year") return tier.annualPriceMinor ?? 0;
  return tier.lifetimePriceMinor ?? 0;
}

async function recordPayment(
  siteId: string,
  memberId: string,
  subscriptionId: string | null,
  gateway: GatewayId,
  mode: PaymentMode,
  payment: NonNullable<PaymentEvent["payment"]>
): Promise<void> {
  if (!payment.externalId) return;
  await prisma.payment.upsert({
    where: { gateway_externalId: { gateway, externalId: payment.externalId } },
    create: {
      siteId,
      memberId,
      subscriptionId,
      gateway,
      mode,
      externalId: payment.externalId,
      amountMinor: payment.amountMinor,
      currency: payment.currency.toUpperCase(),
      status: "paid",
      receiptUrl: payment.receiptUrl,
      paidAt: payment.paidAt,
    },
    update: { receiptUrl: payment.receiptUrl ?? undefined },
  });
}

/**
 * Activate the purchase a checkout started.
 *
 * Also ends the member's other running recurring subscriptions on this site:
 * buying Gold while on Silver is a switch, and leaving Silver renewing would
 * charge them twice. Lifetime purchases are never ended this way.
 */
async function activate(
  siteId: string,
  credentials: GatewayCredentials,
  event: PaymentEvent
): Promise<void> {
  if (!event.externalId) return;
  const gateway = credentials.gateway;

  const existing = await prisma.subscription.findUnique({
    where: { gateway_externalId: { gateway, externalId: event.externalId } },
  });

  if (existing) {
    if (existing.status !== "ended") {
      await prisma.subscription.update({
        where: { id: existing.id },
        data: {
          status: "active",
          ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
          ...(event.manageUrl ? { manageUrl: event.manageUrl } : {}),
          ...(event.customerId ? { externalCustomerId: event.customerId } : {}),
        },
      });
    }
    if (event.payment) await recordPayment(siteId, existing.memberId, existing.id, gateway, credentials.mode, event.payment);
    await recomputeMember(siteId, existing.memberId);
    return;
  }

  if (!event.checkoutId) {
    log(`${gateway} ${event.type}: no MemberFrame checkout id, ignored`);
    return;
  }

  const checkout = await prisma.checkout.findFirst({ where: { id: event.checkoutId, siteId, gateway } });
  if (!checkout) {
    log(`${gateway} ${event.type}: checkout ${event.checkoutId} not found for this site, ignored`);
    return;
  }

  const lifetime = checkout.interval === "lifetime";
  if ((event.onlyFor === "lifetime" && !lifetime) || (event.onlyFor === "recurring" && lifetime)) return;

  const tier = await prisma.tier.findFirst({ where: { siteId, key: checkout.tierKey } });
  const periodEnd =
    lifetime
      ? null
      : event.currentPeriodEnd ??
        (await ADAPTERS[gateway].periodEnd?.(credentials, event.externalId).catch(() => null)) ??
        null;

  const subscription = await prisma.subscription.create({
    data: {
      siteId,
      memberId: checkout.memberId,
      tierKey: checkout.tierKey,
      interval: checkout.interval,
      gateway,
      mode: credentials.mode,
      externalId: event.externalId,
      externalCustomerId: event.customerId,
      status: "active",
      currentPeriodEnd: periodEnd,
      amountMinor: event.payment?.amountMinor ?? checkout.amountMinor ?? (tier ? priceFor(tier, checkout.interval) : 0),
      currency: (event.payment?.currency ?? checkout.currency ?? tier?.currency ?? "USD").toUpperCase(),
      manageUrl: event.manageUrl,
    },
  });

  await prisma.checkout.update({
    where: { id: checkout.id },
    data: { state: "complete", completedAt: new Date(), externalId: checkout.externalId ?? event.externalId },
  });

  if (event.payment) await recordPayment(siteId, checkout.memberId, subscription.id, gateway, credentials.mode, event.payment);

  // A switch, not a second plan.
  const others = await prisma.subscription.findMany({
    where: {
      siteId,
      memberId: checkout.memberId,
      id: { not: subscription.id },
      mode: credentials.mode,
      status: { in: [...RUNNING] },
      interval: { not: "lifetime" },
    },
  });

  for (const other of others) {
    const otherCredentials =
      other.gateway === gateway && other.mode === credentials.mode
        ? credentials
        : await loadCredentials(siteId, other.gateway as GatewayId, other.mode as PaymentMode).catch(() => null);
    const otherAdapter = ADAPTERS[other.gateway as GatewayId];

    if (otherCredentials) {
      await otherAdapter.cancelNow(otherCredentials, other.externalId).catch((error: unknown) => {
        log(`could not end replaced subscription ${other.id}: ${error instanceof Error ? error.message : String(error)}`);
      });

      // Credit the unused time on the plan being left, as a partial refund of
      // its last payment. A failure is logged, never fatal: the new plan is
      // already paid for and must not be held up by the old one's refund.
      const lastPaid = await prisma.payment.findFirst({
        where: { subscriptionId: other.id, status: "paid" },
        orderBy: { paidAt: "desc" },
      });
      const credit = lastPaid ? unusedCredit(lastPaid.amountMinor, other.interval, other.currentPeriodEnd) : 0;
      // Already given off this purchase's first charge (30-plan-changes.md):
      // refunding it as well would credit the member twice.
      if ((checkout.creditMinor ?? 0) > 0) {
        log(`unused time on ${other.tierKey} already credited as a discount of ${checkout.creditMinor}`);
      } else if (!lastPaid) {
        log(`no recorded payment on ${other.id} to refund its unused time from`);
      } else if (credit >= MIN_CREDIT_MINOR && otherAdapter.refund) {
        try {
          await otherAdapter.refund(otherCredentials, lastPaid.externalId, credit, lastPaid.currency);
          log(`credited ${credit} ${lastPaid.currency} for unused time on ${other.tierKey}`);
          // In the member's history as its own line.
          await prisma.payment.create({
            data: {
              siteId,
              memberId: checkout.memberId,
              subscriptionId: other.id,
              gateway: other.gateway,
              mode: other.mode,
              externalId: `credit-${other.id}`,
              amountMinor: credit,
              currency: lastPaid.currency,
              status: "credited",
              receiptUrl: null,
              paidAt: new Date(),
            },
          }).catch(() => undefined);
        } catch (error) {
          log(`could not credit unused time on ${other.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    await prisma.subscription.update({ where: { id: other.id }, data: { status: "ended", endedAt: new Date() } });
  }

  log(`member ${checkout.memberId} bought ${checkout.tierKey} (${checkout.interval}) through ${gateway}`);
  await recomputeMember(siteId, checkout.memberId);
}

/** Apply one event. Throws on a database failure so the webhook answers 500 and the gateway retries. */
export async function applyPaymentEvent(siteId: string, credentials: GatewayCredentials, event: PaymentEvent): Promise<void> {
  const gateway = credentials.gateway;

  if (event.action === "activate") {
    await activate(siteId, credentials, event);
    return;
  }

  if (!event.externalId) return;

  const subscription = await prisma.subscription.findUnique({
    where: { gateway_externalId: { gateway, externalId: event.externalId } },
  });

  if (!subscription || subscription.siteId !== siteId) {
    // A renewal can arrive before the checkout's own event. It carries the
    // checkout id too, so it can activate.
    if (event.action === "renewed" && event.checkoutId) {
      await activate(siteId, credentials, { ...event, action: "activate", onlyFor: "recurring" });
    }
    return;
  }

  const now = new Date();

  switch (event.action) {
    case "renewed": {
      // A downgrade scheduled for this renewal takes effect now (30-plan-changes.md).
      if (subscription.scheduledTierKey) {
        const next = await prisma.tier.findFirst({
          where: { siteId, key: subscription.scheduledTierKey },
          include: { extraPrices: { select: { currency: true, interval: true, amountMinor: true } } },
        });
        const nextInterval = (subscription.scheduledInterval ?? subscription.interval) as "month" | "year";
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            tierKey: subscription.scheduledTierKey,
            interval: nextInterval,
            amountMinor: (next ? tierAmount(next, nextInterval, subscription.currency) : null) ?? subscription.amountMinor,
            scheduledTierKey: null,
            scheduledInterval: null,
          },
        });
        log(`member ${subscription.memberId} moved to ${subscription.scheduledTierKey} on renewal, as scheduled`);
      }
      const periodEnd =
        event.currentPeriodEnd ??
        (await ADAPTERS[gateway].periodEnd?.(credentials, subscription.externalId).catch(() => null)) ??
        subscription.currentPeriodEnd;
      if (subscription.status !== "ended") {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: subscription.cancelAtPeriodEnd ? "canceling" : "active",
            currentPeriodEnd: periodEnd,
            gracePeriodEndsAt: null,
          },
        });
      }
      if (event.payment) await recordPayment(siteId, subscription.memberId, subscription.id, gateway, subscription.mode as PaymentMode, event.payment);
      break;
    }

    case "payment_failed": {
      if (subscription.status === "ended") return;
      const { graceDays } = await loadPaymentSettings(siteId);
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: "past_due",
          // The first failure starts the window; a retry failing later does not extend it.
          gracePeriodEndsAt: subscription.gracePeriodEndsAt ?? new Date(now.getTime() + graceDays * DAY_MS),
        },
      });
      break;
    }

    case "cancel_scheduled":
      if (subscription.status === "ended") return;
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: "canceling",
          cancelAtPeriodEnd: true,
          ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
        },
      });
      break;

    case "resumed":
      if (subscription.status === "ended") return;
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: "active",
          cancelAtPeriodEnd: false,
          gracePeriodEndsAt: null,
          ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
          ...(event.manageUrl ? { manageUrl: event.manageUrl } : {}),
        },
      });
      break;

    case "ended":
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "ended", endedAt: subscription.endedAt ?? now },
      });
      // A Lemon Squeezy downgrade is a cancel at period end: now that it has
      // ended, invite the member to continue on the plan they chose.
      if (subscription.scheduledTierKey && subscription.status !== "ended") {
        await inviteToScheduledPlan(siteId, subscription.memberId, subscription.scheduledTierKey).catch((error: unknown) => {
          log(`could not email the scheduled plan link: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      break;

    case "refunded":
      await prisma.payment.updateMany({
        where: { gateway, externalId: event.externalId },
        data: { status: "refunded" },
      });
      // A refunded one-time purchase takes its access with it. A refunded
      // renewal does not end the subscription by itself.
      if (subscription.interval === "lifetime") {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { status: "ended", endedAt: now },
        });
      }
      break;
  }

  await recomputeMember(siteId, subscription.memberId);
}

/** Email a member whose plan ended with a downgrade scheduled: a link to continue on that plan. */
async function inviteToScheduledPlan(siteId: string, memberId: string, tierKey: string): Promise<void> {
  const [member, site, tier, settings] = await Promise.all([
    prisma.member.findFirst({ where: { id: memberId, siteId }, select: { email: true, name: true } }),
    prisma.site.findUnique({ where: { id: siteId }, select: { siteName: true, allowedOrigins: true } }),
    prisma.tier.findFirst({ where: { siteId, key: tierKey }, select: { name: true } }),
    loadPaymentSettings(siteId),
  ]);
  const origin = site ? parseAllowedOrigins(site.allowedOrigins)[0] : undefined;
  if (!member || !site || !tier || !origin) return;
  const url = `${origin}${settings.pricingPath}`;
  await sendMail({
    to: member.email,
    subject: `Continue on ${tier.name} at ${site.siteName}`,
    text: [
      `Hi ${member.name || "there"},`,
      "",
      `Your previous plan at ${site.siteName} has ended, as you asked. To continue on ${tier.name}, choose it here:`,
      url,
      "",
      "Nothing is charged until you confirm.",
    ].join("\n"),
    template: "plan_downgrade_continue",
    siteId,
  });
}

/**
 * End what has run out. FP-16 section 10.
 *
 * A safety net under the gateways' own "ended" events, which normally arrive
 * first: a canceled plan past its period end, and a failed payment past its
 * grace window. Also expires checkouts nobody finished.
 */
/** How long past its period end an active plan waits for the gateway's renewal before it is checked. */
const RENEWAL_WAIT_MS = 60 * 60 * 1000;
/** How long past its period end, with no answer from the gateway, before the grace period starts. */
const UNANSWERED_MS = DAY_MS;

/**
 * Active monthly or yearly plans past their period end with no renewal: a
 * missed webhook. Ask the gateway what happened and apply its answer exactly
 * as the webhook would have. A renewal moves the period on (and switches a
 * scheduled downgrade); a failure starts the grace period; a cancel or end is
 * applied. When the gateway cannot be asked, or still has not renewed a day
 * later, the plan goes into its grace period and the sweep ends it after that.
 */
export async function reconcileOverdue(now: Date = new Date()): Promise<number> {
  const overdue = await prisma.subscription.findMany({
    where: {
      status: "active",
      interval: { not: "lifetime" },
      currentPeriodEnd: { lt: new Date(now.getTime() - RENEWAL_WAIT_MS) },
    },
    take: 50,
  });

  let changed = 0;
  for (const subscription of overdue) {
    const gateway = subscription.gateway as GatewayId;
    const credentials = await loadCredentials(subscription.siteId, gateway, subscription.mode as PaymentMode).catch(() => null);
    const adapter = ADAPTERS[gateway];
    let event: PaymentEvent | null = null;
    if (credentials && adapter?.syncStatus) {
      event = await adapter.syncStatus(credentials, subscription.externalId).catch((error: unknown) => {
        log(`could not check ${gateway} subscription ${subscription.externalId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    }

    const renewedPastNow =
      event?.action === "renewed" && event.currentPeriodEnd !== null && event.currentPeriodEnd !== undefined && event.currentPeriodEnd > now;
    const overdueLong = (subscription.currentPeriodEnd?.getTime() ?? now.getTime()) < now.getTime() - UNANSWERED_MS;

    if (credentials && event && (event.action !== "renewed" || renewedPastNow)) {
      // The gateway's own answer: renewed into a new period, failed, cancelled, or ended.
      await applyPaymentEvent(subscription.siteId, credentials, event);
      changed += 1;
    } else if (overdueLong && credentials) {
      // No renewal and no answer a day later: treat it as a failed renewal.
      await applyPaymentEvent(subscription.siteId, credentials, { ...(event ?? {}), action: "payment_failed", type: "sync", externalId: subscription.externalId } as PaymentEvent);
      changed += 1;
    } else if (overdueLong) {
      // The gateway is gone (keys removed): end it after the grace period.
      const { graceDays } = await loadPaymentSettings(subscription.siteId);
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "past_due", gracePeriodEndsAt: subscription.gracePeriodEndsAt ?? new Date(now.getTime() + graceDays * DAY_MS) },
      });
      await recomputeMember(subscription.siteId, subscription.memberId);
      changed += 1;
    }
  }
  return changed;
}

export async function sweepExpired(now: Date = new Date()): Promise<number> {
  // First the plans a missed webhook left "active" past their period end.
  await reconcileOverdue(now).catch((error: unknown) => {
    log(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  const expired = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: "canceling", currentPeriodEnd: { lt: now } },
        { status: "past_due", gracePeriodEndsAt: { lt: now } },
      ],
    },
    select: { id: true, siteId: true, memberId: true },
  });

  for (const subscription of expired) {
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "ended", endedAt: now } });
    await recomputeMember(subscription.siteId, subscription.memberId);
  }

  await prisma.checkout.updateMany({
    where: { state: "open", createdAt: { lt: new Date(now.getTime() - DAY_MS) } },
    data: { state: "expired" },
  });

  return expired.length;
}

/**
 * Switching a site to live ends every test purchase, so test buyers lose the
 * tier they got with a test card. FP-16 section 11.
 */
export async function endTestSubscriptions(siteId: string): Promise<number> {
  const running = await prisma.subscription.findMany({
    where: { siteId, mode: "test", status: { in: [...RUNNING] } },
    select: { id: true, memberId: true },
  });

  for (const subscription of running) {
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "ended", endedAt: new Date() } });
  }
  for (const memberId of new Set(running.map((entry) => entry.memberId))) {
    await recomputeMember(siteId, memberId);
  }
  return running.length;
}
