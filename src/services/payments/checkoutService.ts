/**
 * Pricing, checkout, and the member's own billing. FP-16 sections 4.2, 6, 8.2, 9.
 *
 * The browser names a tier and an interval and nothing else. The amount, the
 * currency, the gateway, and the member all come from the server: the member
 * from the session cookie, the price from the tier table, the currency from
 * the buyer's country. A request cannot buy a cheaper price or put a purchase
 * on someone else's account.
 *
 * ## Switching plans
 *
 * A member on a running recurring plan who picks another one is switching,
 * not buying a second plan:
 *
 *   - where the gateway can change a subscription in place (Stripe), it does,
 *     prorated by the gateway: an upgrade charges the difference now, a
 *     downgrade becomes credit on the next invoice. No checkout page at all.
 *   - otherwise a new checkout runs, and when it completes the old plan is
 *     ended and refunded for the time it had left (`apply.ts`).
 */

import { prisma } from "../../config/db.js";
import { badRequest, notFound, ApiError } from "../../middleware/errors.js";
import { isSafeSitePath } from "../../lib/siteSettings.js";
import { ADAPTERS, connectedGateways, loadCredentials, loadPaymentSettings } from "./gatewayStore.js";
import { chooseGateway } from "./gatewayRouter.js";
import { RUNNING, applyPaymentEvent, governingSubscription, recomputeMember } from "./apply.js";
import { tierAmount, type PricedTier } from "./prices.js";
import {
  GatewayError,
  INTERVALS,
  isGatewayId,
  isInterval,
  isPaymentMode,
  type BillingInterval,
  type CheckoutEmbed,
  type GatewayId,
  type KnownPrice,
  type PaymentMode,
} from "./types.js";
import { readTierFeatures, type TierFeature } from "../../lib/tierFeatures.js";

type TierRow = PricedTier & { key: string; name: string; rank: number };

const TIER_WITH_PRICES = { extraPrices: { select: { currency: true, interval: true, amountMinor: true } } } as const;

/** A tier's base price for one interval. Kept for callers that only know the base list. */
export function tierPrice(tier: TierRow, interval: BillingInterval): number | null {
  return tierAmount(tier, interval, tier.currency);
}

// ============================================================================
// PUBLIC PRICING
// ============================================================================

export interface PublicTier {
  key: string;
  name: string;
  rank: number;
  /** The currency this buyer is shown, which is the one they will be charged in. */
  currency: string;
  prices: Record<BillingInterval, number | null>;
  /** Whether a connected gateway can actually sell each price right now. */
  purchasable: Record<BillingInterval, boolean>;
  /** The tier's pricing card lines, in order (28-tier-features.md). */
  features: TierFeature[];
}

export interface PublicPricing {
  mode: PaymentMode;
  pricingPath: string;
  afterPurchasePath: string;
  tiers: PublicTier[];
}

/** What `<MemberPricing>` renders. No gateway id, no key, nothing private. */
export async function publicPricing(siteId: string, country: string | null): Promise<PublicPricing> {
  const settings = await loadPaymentSettings(siteId);
  const [tiers, connected] = await Promise.all([
    prisma.tier.findMany({ where: { siteId, isActive: true }, orderBy: { rank: "asc" }, include: TIER_WITH_PRICES }),
    connectedGateways(siteId, settings.mode),
  ]);
  // One site currency (23-dynamic-tiers.md): every buyer sees the tier's own
  // price, wherever they are. `country` still routes the gateway.
  void country;

  return {
    mode: settings.mode,
    pricingPath: settings.pricingPath,
    afterPurchasePath: settings.afterPurchasePath,
    tiers: tiers.map((tier) => {
      const currency = tier.currency;
      const prices = {} as Record<BillingInterval, number | null>;
      const purchasable = {} as Record<BillingInterval, boolean>;
      for (const interval of INTERVALS) {
        prices[interval] = tierAmount(tier, interval, currency);
        purchasable[interval] =
          prices[interval] !== null &&
          connected.some((credentials) => ADAPTERS[credentials.gateway].canSell(credentials, interval, currency));
      }
      return { key: tier.key, name: tier.name, rank: tier.rank, currency, prices, purchasable, features: readTierFeatures(tier.features) };
    }),
  };
}

// ============================================================================
// CHECKOUT AND SWITCHING
// ============================================================================

async function ensureGatewayPrice(
  siteId: string,
  gateway: GatewayId,
  mode: PaymentMode,
  tier: TierRow,
  interval: BillingInterval,
  amountMinor: number,
  currency: string
): Promise<KnownPrice | null> {
  const adapter = ADAPTERS[gateway];
  if (!adapter.ensurePrice) return null;

  const lookup = { siteId, tierKey: tier.key, interval, amountMinor, currency, gateway, mode };
  const known = await prisma.gatewayPrice.findUnique({
    where: { siteId_tierKey_interval_amountMinor_currency_gateway_mode: lookup },
  });
  if (known) return { externalId: known.externalId, externalProductId: known.externalProductId };

  // One gateway product per tier, reused by every price it ever has.
  const sibling = await prisma.gatewayPrice.findFirst({
    where: { siteId, tierKey: tier.key, gateway, mode, externalProductId: { not: null } },
    select: { externalProductId: true },
  });

  const credentials = await loadCredentials(siteId, gateway, mode);
  if (!credentials) throw new ApiError(409, "no_gateway");

  const created = await adapter.ensurePrice(
    credentials,
    { siteId, tierKey: tier.key, tierName: tier.name, interval, amountMinor, currency },
    sibling?.externalProductId ?? null
  );

  await prisma.gatewayPrice.create({
    data: { ...lookup, externalId: created.externalId, externalProductId: created.externalProductId },
  });
  return created;
}

function withParam(origin: string, path: string, name: string, value: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${origin}${path}${separator}${name}=${encodeURIComponent(value)}`;
}

export interface CheckoutRequest {
  siteId: string;
  siteName: string;
  member: { id: string; email: string; name: string | null };
  tierKey: string;
  interval: BillingInterval;
  returnPath: string;
  origin: string;
  country: string | null;
}

export type CheckoutOutcome =
  | {
      kind: "checkout";
      url: string;
      checkoutId: string;
      gateway: GatewayId;
      mode: PaymentMode;
      embed: CheckoutEmbed | null;
    }
  | { kind: "changed"; tierName: string; interval: BillingInterval };

const INTERVAL_WEIGHT: Record<BillingInterval, number> = { month: 0, year: 1, lifetime: 2 };

/**
 * Change a running subscription in place, when its gateway can. Null when it
 * cannot, and the caller falls back to a checkout plus a refund.
 */
async function changeInPlace(
  siteId: string,
  mode: PaymentMode,
  current: NonNullable<Awaited<ReturnType<typeof governingSubscription>>>,
  tier: TierRow,
  interval: BillingInterval,
  ladder: ReadonlyArray<{ key: string; rank: number }>
): Promise<CheckoutOutcome | null> {
  if (current.interval === "lifetime" || interval === "lifetime") return null;

  const gateway = current.gateway as GatewayId;
  const adapter = ADAPTERS[gateway];
  if (!adapter.changePlan) return null;

  // A subscription keeps its currency for life. The new plan must be priced in it.
  const amountMinor = tierAmount(tier, interval, current.currency);
  if (amountMinor === null) return null;

  const credentials = await loadCredentials(siteId, gateway, mode);
  if (!credentials) return null;

  const price = await ensureGatewayPrice(siteId, gateway, mode, tier, interval, amountMinor, current.currency);
  if (!price) return null;

  const rank = (key: string) => ladder.find((entry) => entry.key === key)?.rank ?? -1;
  const upgrade =
    rank(tier.key) > rank(current.tierKey) ||
    (tier.key === current.tierKey && INTERVAL_WEIGHT[interval] > INTERVAL_WEIGHT[current.interval as BillingInterval]);

  let result: { currentPeriodEnd: Date | null };
  try {
    result = await adapter.changePlan(credentials, current.externalId, price, upgrade);
  } catch (error) {
    if (error instanceof GatewayError) {
      process.stderr.write(`[payments] ${gateway} plan change failed: ${error.message}\n`);
      throw new ApiError(502, "gateway_error");
    }
    throw error;
  }

  await prisma.subscription.update({
    where: { id: current.id },
    data: {
      tierKey: tier.key,
      interval,
      amountMinor,
      status: "active",
      cancelAtPeriodEnd: false,
      ...(result.currentPeriodEnd ? { currentPeriodEnd: result.currentPeriodEnd } : {}),
    },
  });
  await recomputeMember(siteId, current.memberId);

  process.stdout.write(
    `[payments] member ${current.memberId} switched ${current.tierKey}/${current.interval} to ${tier.key}/${interval} on ${gateway} (${upgrade ? "upgrade, charged now" : "downgrade, credit next bill"})\n`
  );
  return { kind: "changed", tierName: tier.name, interval };
}

export async function createCheckout(input: CheckoutRequest): Promise<CheckoutOutcome> {
  if (!isSafeSitePath(input.returnPath)) throw badRequest("unsafe_path");

  const settings = await loadPaymentSettings(input.siteId);
  const tier = await prisma.tier.findFirst({
    where: { siteId: input.siteId, key: input.tierKey, isActive: true },
    include: TIER_WITH_PRICES,
  });
  if (!tier) throw notFound("tier_not_found");

  const currency = tier.currency;
  const amountMinor = tierAmount(tier, input.interval, currency);
  if (amountMinor === null) throw badRequest("price_not_available");

  // Already holding this exact plan: nothing to buy.
  const current = await governingSubscription(input.siteId, input.member.id, settings.mode);
  if (current && current.tierKey === tier.key && (current.interval === input.interval || current.interval === "lifetime")) {
    throw badRequest("already_subscribed");
  }

  if (current) {
    const ladder = await prisma.tier.findMany({ where: { siteId: input.siteId }, select: { key: true, rank: true } });
    const changed = await changeInPlace(input.siteId, settings.mode, current, tier, input.interval, ladder);
    if (changed) return changed;
  }

  const connected = await connectedGateways(input.siteId, settings.mode);
  const decision = chooseGateway({
    connected,
    interval: input.interval,
    currency,
    country: input.country,
    autoDetectGeolocation: settings.autoDetectGeolocation,
    defaultGateway: settings.defaultGateway,
  });
  if (!decision) throw new ApiError(409, "no_gateway");

  process.stdout.write(
    `[payments] checkout ${tier.key}/${input.interval} in ${currency} on ${decision.gateway} (${decision.reason}, country ${input.country ?? "unknown"})\n`
  );

  const credentials = connected.find((entry) => entry.gateway === decision.gateway)!;

  const checkout = await prisma.checkout.create({
    data: {
      siteId: input.siteId,
      memberId: input.member.id,
      tierKey: tier.key,
      interval: input.interval,
      gateway: decision.gateway,
      mode: settings.mode,
      returnPath: input.returnPath,
      amountMinor,
      currency,
      // The plan this purchase replaces, ended and refunded for its unused
      // time once the new one is paid. A lifetime purchase is never replaced.
      replacesSubscriptionId: current && current.interval !== "lifetime" ? current.id : null,
    },
  });

  try {
    const price = await ensureGatewayPrice(input.siteId, decision.gateway, settings.mode, tier, input.interval, amountMinor, currency);

    const earlier = await prisma.subscription.findFirst({
      where: { siteId: input.siteId, memberId: input.member.id, gateway: decision.gateway, mode: settings.mode, externalCustomerId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { externalCustomerId: true },
    });

    const result = await ADAPTERS[decision.gateway].createCheckout(credentials, {
      siteId: input.siteId,
      siteName: input.siteName,
      tierKey: tier.key,
      tierName: tier.name,
      interval: input.interval,
      amountMinor,
      currency,
      checkoutId: checkout.id,
      member: input.member,
      successUrl: withParam(input.origin, input.returnPath, "mf_checkout", checkout.id),
      cancelUrl: withParam(input.origin, input.returnPath, "mf_checkout_cancelled", "1"),
      price,
      customerId: earlier?.externalCustomerId ?? null,
    });

    await prisma.checkout.update({ where: { id: checkout.id }, data: { externalId: result.externalId } });
    return {
      kind: "checkout",
      url: result.url,
      checkoutId: checkout.id,
      gateway: decision.gateway,
      mode: settings.mode,
      embed: result.embed ?? null,
    };
  } catch (error) {
    await prisma.checkout.update({ where: { id: checkout.id }, data: { state: "failed" } });
    if (error instanceof GatewayError) {
      process.stderr.write(`[payments] ${error.gateway} checkout failed: ${error.message}\n`);
      throw new ApiError(502, "gateway_error");
    }
    throw error;
  }
}

/** When each open checkout last asked its gateway, so a polling page asks at most this often. */
const lastPull = new Map<string, number>();
const PULL_EVERY_MS = 2_500;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

/**
 * Ask the gateway whether an open checkout was paid, and apply what it says.
 *
 * Webhooks stay the main path, since they also carry renewals, failures and
 * cancels. This covers the purchase itself whenever a webhook does not
 * arrive, so the buyer who just paid is never left waiting on one. Errors are
 * logged and swallowed: the page keeps polling, and a webhook can still land.
 */
async function pullConfirmation(siteId: string, checkout: {
  id: string;
  memberId: string;
  gateway: string;
  mode: string;
  externalId: string | null;
  interval: string;
  createdAt: Date;
}): Promise<void> {
  if (!checkout.externalId || !isGatewayId(checkout.gateway) || !isPaymentMode(checkout.mode) || !isInterval(checkout.interval)) return;
  const adapter = ADAPTERS[checkout.gateway];
  if (!adapter.confirmCheckout) return;

  const now = Date.now();
  if (now - (lastPull.get(checkout.id) ?? 0) < PULL_EVERY_MS) return;
  lastPull.set(checkout.id, now);
  if (lastPull.size > 500) {
    for (const [id, at] of lastPull) if (now - at > 60_000) lastPull.delete(id);
  }

  const credentials = await loadCredentials(siteId, checkout.gateway, checkout.mode);
  if (!credentials) return;
  const member = await prisma.member.findFirst({ where: { id: checkout.memberId, siteId }, select: { email: true } });

  try {
    const events = await adapter.confirmCheckout(credentials, {
      id: checkout.id,
      externalId: checkout.externalId,
      interval: checkout.interval,
      createdAt: checkout.createdAt,
      memberEmail: member?.email ?? "",
    });
    for (const event of events) {
      try {
        await applyPaymentEvent(siteId, credentials, event);
      } catch (error) {
        // A webhook applied the same purchase a moment earlier.
        if (!isUniqueViolation(error)) throw error;
      }
    }
  } catch (error) {
    process.stderr.write(
      `[payments] could not confirm checkout ${checkout.id} with ${checkout.gateway}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

export async function checkoutStatus(siteId: string, memberId: string, checkoutId: string) {
  let checkout = await prisma.checkout.findFirst({ where: { id: checkoutId, siteId, memberId } });
  if (!checkout) throw notFound("checkout_not_found");

  if (checkout.state === "open") {
    await pullConfirmation(siteId, checkout);
    checkout = (await prisma.checkout.findFirst({ where: { id: checkoutId, siteId, memberId } })) ?? checkout;
  }

  const tier = await prisma.tier.findFirst({ where: { siteId, key: checkout.tierKey }, select: { name: true } });
  return { state: checkout.state, tierKey: checkout.tierKey, tierName: tier?.name ?? checkout.tierKey, interval: checkout.interval };
}

// ============================================================================
// THE MEMBER'S OWN BILLING
// ============================================================================

export async function memberBilling(siteId: string, memberId: string) {
  const { pricingPath } = await loadPaymentSettings(siteId);
  const subscription = await governingSubscription(siteId, memberId);
  const payments = await prisma.payment.findMany({
    where: { siteId, memberId },
    orderBy: { paidAt: "desc" },
    take: 12,
    select: { id: true, amountMinor: true, currency: true, status: true, receiptUrl: true, paidAt: true },
  });

  if (!subscription) {
    return { subscription: null, payments: payments.map(paymentShape), pricingPath };
  }

  const tier = await prisma.tier.findFirst({ where: { siteId, key: subscription.tierKey }, select: { name: true } });
  const adapter = ADAPTERS[subscription.gateway as GatewayId];
  const recurring = subscription.interval !== "lifetime";

  return {
    subscription: {
      tierKey: subscription.tierKey,
      tierName: tier?.name ?? subscription.tierKey,
      interval: subscription.interval,
      status: subscription.status,
      amountMinor: subscription.amountMinor,
      currency: subscription.currency,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      gracePeriodEndsAt: subscription.gracePeriodEndsAt?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      mode: subscription.mode,
      canCancel: recurring && !subscription.cancelAtPeriodEnd,
      canResume: recurring && subscription.cancelAtPeriodEnd && adapter.resume !== null,
      canManage: recurring,
    },
    payments: payments.map(paymentShape),
    pricingPath,
  };
}

function paymentShape(payment: { id: string; amountMinor: number; currency: string; status: string; receiptUrl: string | null; paidAt: Date }) {
  return { ...payment, paidAt: payment.paidAt.toISOString() };
}

async function runningSubscription(siteId: string, memberId: string) {
  const subscription = await governingSubscription(siteId, memberId);
  if (!subscription || subscription.interval === "lifetime") throw notFound("no_subscription");

  const credentials = await loadCredentials(siteId, subscription.gateway as GatewayId, subscription.mode as PaymentMode);
  if (!credentials) throw new ApiError(409, "no_gateway");
  return { subscription, credentials, adapter: ADAPTERS[subscription.gateway as GatewayId] };
}

export async function billingPortal(siteId: string, memberId: string, returnUrl: string): Promise<string | null> {
  const { subscription, credentials, adapter } = await runningSubscription(siteId, memberId);
  return adapter.portalUrl(
    credentials,
    { externalId: subscription.externalId, customerId: subscription.externalCustomerId, manageUrl: subscription.manageUrl },
    returnUrl
  );
}

/** Cancel at period end. The gateway's own event confirms it; this answers the member at once. */
export async function cancelSubscription(siteId: string, memberId: string): Promise<void> {
  const { subscription, credentials, adapter } = await runningSubscription(siteId, memberId);
  try {
    await adapter.cancelAtPeriodEnd(credentials, subscription.externalId);
  } catch (error) {
    if (error instanceof GatewayError) throw new ApiError(502, "gateway_error");
    throw error;
  }
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: "canceling", cancelAtPeriodEnd: true },
  });
  await prisma.member.update({ where: { id: memberId }, data: { status: "canceled" } });
}

export async function resumeSubscription(siteId: string, memberId: string): Promise<void> {
  const { subscription, credentials, adapter } = await runningSubscription(siteId, memberId);
  if (!adapter.resume) throw badRequest("resume_not_supported");
  try {
    await adapter.resume(credentials, subscription.externalId);
  } catch (error) {
    if (error instanceof GatewayError) throw new ApiError(502, "gateway_error");
    throw error;
  }
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: subscription.gracePeriodEndsAt ? "past_due" : "active", cancelAtPeriodEnd: false },
  });
  await prisma.member.update({
    where: { id: memberId },
    data: { status: subscription.gracePeriodEndsAt ? "past_due" : "active" },
  });
}

export { RUNNING };
