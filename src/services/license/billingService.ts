/**
 * Plans, checkout, upgrades, cancel and resume, on MemberFrame's own Stripe
 * account. F19, 19-pro-lock-and-trial.md sections 2.1, 2.3 and 5.
 *
 * As BEAF: Stripe Elements in the panel confirms a PaymentIntent this service
 * creates (a subscription's first invoice, or a one-off lifetime payment).
 * Unlike BEAF, every entry point is reached through a route that has already
 * checked the creator owns the project, and Stripe is the source of truth:
 * `syncSubscription` copies what Stripe says, from the webhook and from the
 * panel's confirm call alike, so the two can arrive in any order.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import {
  PlatformBillingError,
  asNumber,
  asRecord,
  asString,
  fromUnix,
  platformStripe,
  type StripeObject,
} from "../../lib/stripeRest.js";
import { invalidateLicense, resolveLicense, type PlanId } from "./licenseService.js";
import { markTrialConverted } from "./trialService.js";
import { upgradeQuote, yearlySavingPercent } from "./proration.js";

const APP = "memberframe";

export interface PlanPrice {
  id: PlanId;
  priceId: string;
  amountMinor: number;
  currency: string;
  interval: "month" | "year" | null;
}

// ============================================================================
// PRICES
// ============================================================================

let priceCache: { at: number; prices: Record<PlanId, PlanPrice> } | null = null;
const PRICE_CACHE_MS = 10 * 60_000;

/** The three plans, read from Stripe so the panel shows what Stripe charges. */
export async function planPrices(): Promise<Record<PlanId, PlanPrice>> {
  if (priceCache && Date.now() - priceCache.at < PRICE_CACHE_MS) return priceCache.prices;

  const read = async (id: PlanId): Promise<PlanPrice> => {
    const priceId = env.billing.prices[id];
    if (!priceId) throw new PlatformBillingError(503, `No Stripe price is set for the ${id} plan.`, "billing_not_configured");
    const price = await platformStripe("GET", `/prices/${encodeURIComponent(priceId)}`);
    const recurring = asRecord(price["recurring"]);
    const interval = asString(recurring["interval"]);
    return {
      id,
      priceId,
      amountMinor: asNumber(price["unit_amount"]) ?? 0,
      currency: asString(price["currency"]) ?? "usd",
      interval: interval === "month" || interval === "year" ? interval : null,
    };
  };

  const [monthly, yearly, lifetime] = await Promise.all([read("monthly"), read("yearly"), read("lifetime")]);
  const prices = { monthly, yearly, lifetime };
  priceCache = { at: Date.now(), prices };
  return prices;
}

/** Lifetime is sold `LIFETIME_MAX` times, then closes (BEAF's "spots left"). */
export async function lifetimeAvailability(): Promise<{ total: number; remaining: number }> {
  const taken = await prisma.pluginSubscription.count({ where: { plan: "lifetime", status: "paid" } });
  return { total: env.billing.lifetimeMax, remaining: Math.max(env.billing.lifetimeMax - taken, 0) };
}

export async function plansView() {
  const prices = await planPrices();
  return {
    plans: [prices.monthly, prices.yearly, prices.lifetime].map(({ id, amountMinor, currency, interval }) => ({ id, amountMinor, currency, interval })),
    yearlySavingPercent: yearlySavingPercent(prices.monthly.amountMinor, prices.yearly.amountMinor),
    lifetime: await lifetimeAvailability(),
    publishableKey: env.billing.stripePublishableKey,
  };
}

// ============================================================================
// CUSTOMERS
// ============================================================================

interface Owner {
  id: string;
  email: string;
  name: string;
}

interface Project {
  siteId: string;
  siteName: string;
}

/** One Stripe customer per creator, made on their first checkout. */
async function ensureCustomer(owner: Owner): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: owner.id }, select: { stripeCustomerId: true } });
  if (user?.stripeCustomerId) return user.stripeCustomerId;

  const customer = await platformStripe(
    "POST",
    "/customers",
    { email: owner.email, name: owner.name, metadata: { app: APP, user_id: owner.id } },
    `customer-${owner.id}`
  );
  const id = asString(customer["id"])!;
  await prisma.user.update({ where: { id: owner.id }, data: { stripeCustomerId: id } });
  return id;
}

/** A promotion code's id, or a clear refusal. */
async function promotionCode(code: string): Promise<{ id: string; percentOff: number | null; amountOffMinor: number | null }> {
  const list = await platformStripe("GET", "/promotion_codes", { code, active: true, limit: 1 });
  const found = asRecord(Array.isArray(list["data"]) ? list["data"][0] : null);
  const id = asString(found["id"]);
  if (!id) throw new PlatformBillingError(400, "That coupon code is not valid.", "invalid_coupon");
  const coupon = asRecord(found["coupon"]);
  return { id, percentOff: asNumber(coupon["percent_off"]), amountOffMinor: asNumber(coupon["amount_off"]) };
}

// ============================================================================
// CHECKOUT
// ============================================================================

export interface CheckoutResult {
  clientSecret: string | null;
  mode: "subscription" | "payment";
  amountDueMinor: number;
  creditMinor: number;
  currency: string;
  /** True when nothing is left to pay (a 100% coupon): the plan is already active. */
  complete: boolean;
}

const clientSecretOf = (invoice: StripeObject): string | null =>
  asString(asRecord(invoice["payment_intent"])["client_secret"]);

/** A first plan for a project with none. A project already on a plan upgrades instead. */
export async function startCheckout(owner: Owner, project: Project, plan: PlanId, coupon?: string): Promise<CheckoutResult> {
  const license = await resolveLicense(project.siteId);
  if (license.state === "active") throw new PlatformBillingError(400, "This project already has a plan. Upgrade it instead.", "already_subscribed");

  const prices = await planPrices();
  const price = prices[plan];
  const customer = await ensureCustomer(owner);
  const metadata = { app: APP, site_id: project.siteId, user_id: owner.id, plan, project_name: project.siteName.slice(0, 200) };
  const promo = coupon ? await promotionCode(coupon) : null;

  // Abandoned checkouts for this project: closed, so only one can ever complete.
  const stale = await prisma.pluginSubscription.findMany({
    where: { siteId: project.siteId, status: "incomplete" },
    select: { id: true, stripeSubscriptionId: true, stripePaymentIntentId: true },
  });
  for (const row of stale) {
    if (row.stripeSubscriptionId) await platformStripe("DELETE", `/subscriptions/${row.stripeSubscriptionId}`).catch(() => undefined);
    if (row.stripePaymentIntentId) await platformStripe("POST", `/payment_intents/${row.stripePaymentIntentId}/cancel`).catch(() => undefined);
  }
  if (stale.length > 0) await prisma.pluginSubscription.updateMany({ where: { id: { in: stale.map((row) => row.id) } }, data: { status: "expired" } });

  if (plan === "lifetime") {
    if ((await lifetimeAvailability()).remaining <= 0) throw new PlatformBillingError(400, "Lifetime access is sold out.", "lifetime_sold_out");
    const discount = promo
      ? promo.percentOff !== null
        ? Math.round((price.amountMinor * promo.percentOff) / 100)
        : promo.amountOffMinor ?? 0
      : 0;
    return createLifetimePayment(owner, project, customer, price, discount, 0, null, metadata, promo?.id ?? null);
  }

  const subscription = await platformStripe("POST", "/subscriptions", {
    customer,
    items: [{ price: price.priceId }],
    payment_behavior: "default_incomplete",
    payment_settings: { save_default_payment_method: "on_subscription" },
    expand: ["latest_invoice.payment_intent"],
    metadata,
    ...(promo ? { discounts: [{ promotion_code: promo.id }] } : {}),
  });
  const id = asString(subscription["id"])!;
  const invoice = asRecord(subscription["latest_invoice"]);
  const due = asNumber(invoice["amount_due"]) ?? price.amountMinor;

  await prisma.pluginSubscription.create({
    data: {
      siteId: project.siteId,
      userId: owner.id,
      plan,
      status: "incomplete",
      stripeSubscriptionId: id,
      stripePriceId: price.priceId,
      amountMinor: price.amountMinor,
      currency: price.currency,
    },
  });

  if (due === 0) {
    await syncSubscription(id);
    return { clientSecret: null, mode: "subscription", amountDueMinor: 0, creditMinor: 0, currency: price.currency, complete: true };
  }
  return { clientSecret: clientSecretOf(invoice), mode: "subscription", amountDueMinor: due, creditMinor: 0, currency: price.currency, complete: false };
}

async function createLifetimePayment(
  owner: Owner,
  project: Project,
  customer: string,
  price: PlanPrice,
  discountMinor: number,
  creditMinor: number,
  replacesSubscription: string | null,
  metadata: Record<string, string>,
  promotionCodeId: string | null
): Promise<CheckoutResult> {
  const amount = Math.max(price.amountMinor - discountMinor - creditMinor, 0);
  if (amount === 0) {
    await recordLifetime({ siteId: project.siteId, userId: owner.id, amountMinor: 0, creditMinor, currency: price.currency, paymentIntentId: null, replacesSubscription });
    return { clientSecret: null, mode: "payment", amountDueMinor: 0, creditMinor, currency: price.currency, complete: true };
  }

  const intent = await platformStripe("POST", "/payment_intents", {
    amount,
    currency: price.currency,
    customer,
    receipt_email: owner.email,
    description: (project.siteName ? `MemberFrame Lifetime for ${project.siteName}` : "MemberFrame Lifetime").slice(0, 250),
    automatic_payment_methods: { enabled: true },
    metadata: {
      ...metadata,
      plan: "lifetime",
      credit_minor: String(creditMinor),
      ...(replacesSubscription ? { replaces_subscription: replacesSubscription } : {}),
      ...(promotionCodeId ? { promotion_code: promotionCodeId } : {}),
    },
  });
  const id = asString(intent["id"])!;
  await prisma.pluginSubscription.create({
    data: {
      siteId: project.siteId,
      userId: owner.id,
      plan: "lifetime",
      status: "incomplete",
      stripePaymentIntentId: id,
      stripePriceId: price.priceId,
      amountMinor: amount,
      currency: price.currency,
    },
  });
  return { clientSecret: asString(intent["client_secret"]), mode: "payment", amountDueMinor: amount, creditMinor, currency: price.currency, complete: false };
}

/**
 * A coupon typed in the payment form, after checkout has started (BEAF's
 * "Have a coupon code?"). A subscription's unpaid first invoice cannot be
 * discounted in place, so the open subscription is replaced by one with the
 * discount; a lifetime payment's amount is lowered. Either may reach zero,
 * which activates the plan with no payment.
 */
export async function applyCoupon(owner: Owner, project: Project, code: string): Promise<CheckoutResult> {
  const row = await prisma.pluginSubscription.findFirst({
    where: { siteId: project.siteId, status: "incomplete" },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new PlatformBillingError(400, "Start the payment again, then apply the coupon.", "no_checkout");
  const promo = await promotionCode(code);

  if (row.stripeSubscriptionId) {
    const prices = await planPrices();
    const price = prices[row.plan as PlanId];
    const customer = await ensureCustomer(owner);
    const subscription = await platformStripe("POST", "/subscriptions", {
      customer,
      items: [{ price: price.priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
      metadata: { app: APP, site_id: project.siteId, user_id: owner.id, plan: row.plan, project_name: project.siteName.slice(0, 200), coupon: code },
      discounts: [{ promotion_code: promo.id }],
    });
    await platformStripe("DELETE", `/subscriptions/${row.stripeSubscriptionId}`).catch(() => undefined);
    const id = asString(subscription["id"])!;
    await prisma.pluginSubscription.update({ where: { id: row.id }, data: { stripeSubscriptionId: id } });

    const invoice = asRecord(subscription["latest_invoice"]);
    const due = asNumber(invoice["amount_due"]) ?? price.amountMinor;
    if (due === 0) {
      await syncSubscription(id);
      return { clientSecret: null, mode: "subscription", amountDueMinor: 0, creditMinor: 0, currency: price.currency, complete: true };
    }
    return { clientSecret: clientSecretOf(invoice), mode: "subscription", amountDueMinor: due, creditMinor: 0, currency: price.currency, complete: false };
  }

  if (!row.stripePaymentIntentId) throw new PlatformBillingError(400, "Start the payment again, then apply the coupon.", "no_checkout");
  const intent = await platformStripe("GET", `/payment_intents/${row.stripePaymentIntentId}`);
  const amount = asNumber(intent["amount"]) ?? row.amountMinor;
  const discount = promo.percentOff !== null ? Math.round((amount * promo.percentOff) / 100) : promo.amountOffMinor ?? 0;
  const next = Math.max(amount - discount, 0);
  const credit = Number(asRecord(intent["metadata"])["credit_minor"] ?? 0) || 0;

  if (next === 0) {
    await platformStripe("POST", `/payment_intents/${row.stripePaymentIntentId}/cancel`).catch(() => undefined);
    await recordLifetime({
      siteId: project.siteId,
      userId: owner.id,
      amountMinor: 0,
      creditMinor: credit,
      currency: row.currency,
      paymentIntentId: row.stripePaymentIntentId,
      replacesSubscription: asString(asRecord(intent["metadata"])["replaces_subscription"]),
    });
    return { clientSecret: null, mode: "payment", amountDueMinor: 0, creditMinor: credit, currency: row.currency, complete: true };
  }

  const updated = await platformStripe("POST", `/payment_intents/${row.stripePaymentIntentId}`, {
    amount: next,
    metadata: { promotion_code: promo.id, coupon: code },
  });
  await prisma.pluginSubscription.update({ where: { id: row.id }, data: { amountMinor: next } });
  return { clientSecret: asString(updated["client_secret"]), mode: "payment", amountDueMinor: next, creditMinor: credit, currency: row.currency, complete: false };
}

// ============================================================================
// FROM STRIPE TO OUR ROWS
// ============================================================================

/** Stripe's subscription status, in this table's words. */
export function ourStatus(stripeStatus: string, cancelAtPeriodEnd: boolean): string {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return cancelAtPeriodEnd ? "canceling" : "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete":
      return "incomplete";
    default:
      // unpaid, incomplete_expired, paused: Stripe has given up.
      return "expired";
  }
}

function periodOf(subscription: StripeObject): { start: Date | null; end: Date | null } {
  const items = asRecord(subscription["items"]);
  const first = asRecord(Array.isArray(items["data"]) ? items["data"][0] : null);
  return {
    start: fromUnix(subscription["current_period_start"]) ?? fromUnix(first["current_period_start"]),
    end: fromUnix(subscription["current_period_end"]) ?? fromUnix(first["current_period_end"]),
  };
}

function planOfPrice(priceId: string | null): PlanId | null {
  if (!priceId) return null;
  if (priceId === env.billing.prices.monthly) return "monthly";
  if (priceId === env.billing.prices.yearly) return "yearly";
  if (priceId === env.billing.prices.lifetime) return "lifetime";
  return null;
}

/**
 * Copy one subscription from Stripe into its row. Returns the row's id and
 * what changed, or null when it is not one of ours.
 */
export async function syncSubscription(
  stripeSubscriptionId: string,
  given?: StripeObject
): Promise<{ id: string; siteId: string; userId: string; plan: string; previousStatus: string; status: string; currentPeriodEnd: Date | null } | null> {
  const subscription = given ?? (await platformStripe("GET", `/subscriptions/${stripeSubscriptionId}`));
  const metadata = asRecord(subscription["metadata"]);
  const existing = await prisma.pluginSubscription.findUnique({ where: { stripeSubscriptionId } });
  if (!existing && metadata["app"] !== APP) return null;

  const items = asRecord(subscription["items"]);
  const firstItem = asRecord(Array.isArray(items["data"]) ? items["data"][0] : null);
  const price = asRecord(firstItem["price"]);
  const priceId = asString(price["id"]);
  const plan = planOfPrice(priceId) ?? (asString(metadata["plan"]) as PlanId | null) ?? existing?.plan ?? "monthly";
  const cancelAtPeriodEnd = subscription["cancel_at_period_end"] === true;
  const status = ourStatus(asString(subscription["status"]) ?? "incomplete", cancelAtPeriodEnd);
  const { start, end } = periodOf(subscription);

  const data = {
    plan,
    status,
    stripePriceId: priceId,
    amountMinor: asNumber(price["unit_amount"]) ?? existing?.amountMinor ?? 0,
    currency: asString(price["currency"]) ?? existing?.currency ?? "usd",
    currentPeriodStart: start,
    currentPeriodEnd: end,
    cancelAtPeriodEnd,
    canceledAt: fromUnix(subscription["canceled_at"]),
    ...(status !== "incomplete" && !existing?.startedAt ? { startedAt: fromUnix(subscription["start_date"]) ?? new Date() } : {}),
  };

  const row = existing
    ? await prisma.pluginSubscription.update({ where: { id: existing.id }, data })
    : await prisma.pluginSubscription.create({
        data: {
          ...data,
          siteId: asString(metadata["site_id"])!,
          userId: asString(metadata["user_id"])!,
          stripeSubscriptionId,
        },
      });

  if (status === "active" || status === "past_due" || status === "canceling") await markTrialConverted(row.siteId);
  invalidateLicense(row.siteId);
  return {
    id: row.id,
    siteId: row.siteId,
    userId: row.userId,
    plan: row.plan,
    previousStatus: existing?.status ?? "incomplete",
    status,
    currentPeriodEnd: end,
  };
}

/** A paid lifetime plan. Idempotent on the payment intent. */
export async function recordLifetime(input: {
  siteId: string;
  userId: string;
  amountMinor: number;
  creditMinor: number;
  currency: string;
  paymentIntentId: string | null;
  replacesSubscription: string | null;
}): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const existing = input.paymentIntentId
    ? await prisma.pluginSubscription.findUnique({ where: { stripePaymentIntentId: input.paymentIntentId } })
    : null;
  if (existing?.status === "paid") return { id: existing.id, created: false };

  const row = existing
    ? await prisma.pluginSubscription.update({ where: { id: existing.id }, data: { status: "paid", startedAt: now } })
    : await prisma.pluginSubscription.create({
        data: {
          siteId: input.siteId,
          userId: input.userId,
          plan: "lifetime",
          status: "paid",
          stripePaymentIntentId: input.paymentIntentId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          startedAt: now,
        },
      });

  await recordPayment({
    subscriptionId: row.id,
    kind: "lifetime",
    amountMinor: input.amountMinor,
    creditMinor: input.creditMinor,
    currency: input.currency,
    stripePaymentIntentId: input.paymentIntentId,
    paidAt: now,
  });

  // The recurring plan it replaces stops now: its unused time was the credit.
  if (input.replacesSubscription) {
    await platformStripe("DELETE", `/subscriptions/${input.replacesSubscription}`, { prorate: false, invoice_now: false }).catch(() => undefined);
    await prisma.pluginSubscription.updateMany({
      where: { stripeSubscriptionId: input.replacesSubscription },
      data: { status: "canceled", canceledAt: now, cancelReason: "upgraded_to_lifetime", expiredNotifiedAt: now },
    });
  }

  await markTrialConverted(input.siteId);
  invalidateLicense(input.siteId);
  return { id: row.id, created: true };
}

/** One payment row. Idempotent on the Stripe id. */
export async function recordPayment(input: {
  subscriptionId: string;
  kind: "initial" | "renewal" | "upgrade" | "lifetime";
  amountMinor: number;
  creditMinor: number;
  currency: string;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  paidAt: Date;
}): Promise<boolean> {
  try {
    await prisma.pluginPayment.create({
      data: {
        subscriptionId: input.subscriptionId,
        kind: input.kind,
        amountMinor: input.amountMinor,
        creditMinor: input.creditMinor,
        currency: input.currency,
        stripeInvoiceId: input.stripeInvoiceId ?? null,
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
        paidAt: input.paidAt,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

/**
 * The panel's "I just paid": confirm with Stripe and write the rows now,
 * rather than wait for the webhook. Safe in either order with the webhook.
 */
export async function confirmCheckout(siteId: string, paymentIntentId: string): Promise<void> {
  const intent = await platformStripe("GET", `/payment_intents/${encodeURIComponent(paymentIntentId)}`, { expand: ["invoice"] });
  const metadata = asRecord(intent["metadata"]);
  if (asString(intent["status"]) !== "succeeded") throw new PlatformBillingError(400, "The payment has not gone through yet.", "payment_incomplete");

  if (metadata["plan"] === "lifetime" && metadata["app"] === APP) {
    if (metadata["site_id"] !== siteId) throw new PlatformBillingError(400, "That payment is for another project.", "wrong_project");
    await recordLifetime({
      siteId,
      userId: asString(metadata["user_id"])!,
      amountMinor: asNumber(intent["amount"]) ?? 0,
      creditMinor: Number(metadata["credit_minor"] ?? 0) || 0,
      currency: asString(intent["currency"]) ?? "usd",
      paymentIntentId,
      replacesSubscription: asString(metadata["replaces_subscription"]),
    });
    return;
  }

  const subscriptionId = asString(asRecord(intent["invoice"])["subscription"]);
  if (!subscriptionId) throw new PlatformBillingError(400, "That payment is not for a MemberFrame plan.", "unknown_payment");
  const synced = await syncSubscription(subscriptionId);
  if (!synced || synced.siteId !== siteId) throw new PlatformBillingError(400, "That payment is for another project.", "wrong_project");
}

// ============================================================================
// UPGRADES
// ============================================================================

interface CurrentPlan {
  subscriptionId: string;
  plan: PlanId;
  stripeSubscriptionId: string | null;
  amountMinor: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
}

async function currentPlan(siteId: string): Promise<CurrentPlan> {
  const license = await resolveLicense(siteId);
  if (license.state !== "active" || !license.subscriptionId) {
    throw new PlatformBillingError(400, "This project has no plan to upgrade. Choose one instead.", "no_plan");
  }
  const row = await prisma.pluginSubscription.findUnique({ where: { id: license.subscriptionId } });
  if (!row) throw new PlatformBillingError(400, "This project has no plan to upgrade.", "no_plan");
  return {
    subscriptionId: row.id,
    plan: row.plan as PlanId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    periodStart: row.currentPeriodStart,
    periodEnd: row.currentPeriodEnd,
  };
}

export interface UpgradePreview {
  from: PlanId;
  to: PlanId;
  creditMinor: number;
  amountDueMinor: number;
  currency: string;
  /** When the new plan next renews; null for lifetime. */
  nextRenewal: string | null;
}

/** What an upgrade costs today, before the creator confirms it. */
export async function upgradePreview(siteId: string, target: PlanId, now: Date = new Date()): Promise<UpgradePreview> {
  const current = await currentPlan(siteId);
  const prices = await planPrices();
  const quote = upgradeQuote({
    from: current.plan,
    to: target,
    paidMinor: current.amountMinor,
    periodStart: current.periodStart,
    periodEnd: current.periodEnd,
    targetPriceMinor: prices[target].amountMinor,
    now,
  });
  if (!quote.allowed) throw new PlatformBillingError(400, quote.reason === "same_plan" ? "This project is already on that plan." : "Moving to a smaller plan is not available.", quote.reason ?? "downgrade_not_allowed");

  if (target === "yearly" && current.stripeSubscriptionId) {
    // Stripe's own figure, so the preview is exactly what the invoice charges.
    const subscription = await platformStripe("GET", `/subscriptions/${current.stripeSubscriptionId}`);
    const itemId = asString(asRecord(Array.isArray(asRecord(subscription["items"])["data"]) ? (asRecord(subscription["items"])["data"] as unknown[])[0] : null)["id"]);
    const upcoming = await platformStripe("GET", "/invoices/upcoming", {
      customer: asString(subscription["customer"]),
      subscription: current.stripeSubscriptionId,
      subscription_items: [{ id: itemId, price: prices.yearly.priceId }],
      subscription_proration_behavior: "always_invoice",
      subscription_billing_cycle_anchor: "now",
      subscription_proration_date: Math.floor(now.getTime() / 1000),
    }).catch(() => null);

    if (upcoming) {
      const lines = asRecord(upcoming["lines"]);
      const credit = (Array.isArray(lines["data"]) ? lines["data"] : [])
        .map((line) => asNumber(asRecord(line)["amount"]) ?? 0)
        .filter((amount) => amount < 0)
        .reduce((sum, amount) => sum - amount, 0);
      return {
        from: current.plan,
        to: target,
        creditMinor: credit,
        amountDueMinor: asNumber(upcoming["amount_due"]) ?? quote.amountDueMinor,
        currency: asString(upcoming["currency"]) ?? current.currency,
        nextRenewal: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
      };
    }
  }

  return {
    from: current.plan,
    to: target,
    creditMinor: quote.creditMinor,
    amountDueMinor: quote.amountDueMinor,
    currency: prices[target].currency,
    nextRenewal: target === "lifetime" ? null : new Date(now.getTime() + 365 * 86_400_000).toISOString(),
  };
}

/**
 * Move up a plan. Monthly to yearly is a Stripe subscription update with
 * immediate proration, charged to the saved card; to lifetime is a one-off
 * payment for the price less the credit, after which the old plan stops.
 */
export async function upgrade(owner: Owner, project: Project, target: PlanId): Promise<CheckoutResult> {
  const preview = await upgradePreview(project.siteId, target);
  const current = await currentPlan(project.siteId);
  const prices = await planPrices();

  if (target === "lifetime") {
    if ((await lifetimeAvailability()).remaining <= 0) throw new PlatformBillingError(400, "Lifetime access is sold out.", "lifetime_sold_out");
    const customer = await ensureCustomer(owner);
    const metadata = { app: APP, site_id: project.siteId, user_id: owner.id, plan: "lifetime", project_name: project.siteName.slice(0, 200) };
    return createLifetimePayment(owner, project, customer, prices.lifetime, 0, preview.creditMinor, current.stripeSubscriptionId, metadata, null);
  }

  if (!current.stripeSubscriptionId) throw new PlatformBillingError(400, "This plan cannot be changed here.", "no_subscription");
  const subscription = await platformStripe("GET", `/subscriptions/${current.stripeSubscriptionId}`);
  const items = asRecord(subscription["items"]);
  const itemId = asString(asRecord(Array.isArray(items["data"]) ? items["data"][0] : null)["id"]);

  const updated = await platformStripe("POST", `/subscriptions/${current.stripeSubscriptionId}`, {
    items: [{ id: itemId, price: prices.yearly.priceId }],
    proration_behavior: "always_invoice",
    billing_cycle_anchor: "now",
    // Applied only once the prorated invoice is paid, so a declined card
    // leaves the creator on the plan they had.
    payment_behavior: "pending_if_incomplete",
    expand: ["latest_invoice.payment_intent"],
  });
  await platformStripe("POST", `/subscriptions/${current.stripeSubscriptionId}`, { metadata: { plan: "yearly" } }).catch(() => undefined);

  const invoice = asRecord(updated["latest_invoice"]);
  const intent = asRecord(invoice["payment_intent"]);
  const intentStatus = asString(intent["status"]);
  if (intentStatus === "requires_action" || intentStatus === "requires_payment_method" || intentStatus === "requires_confirmation") {
    return { clientSecret: asString(intent["client_secret"]), mode: "subscription", amountDueMinor: preview.amountDueMinor, creditMinor: preview.creditMinor, currency: preview.currency, complete: false };
  }

  await syncSubscription(current.stripeSubscriptionId);
  return { clientSecret: null, mode: "subscription", amountDueMinor: preview.amountDueMinor, creditMinor: preview.creditMinor, currency: preview.currency, complete: true };
}

// ============================================================================
// CANCEL, RESUME, PORTAL
// ============================================================================

async function recurringOf(siteId: string): Promise<string> {
  const current = await currentPlan(siteId);
  if (!current.stripeSubscriptionId) throw new PlatformBillingError(400, "Lifetime access does not renew, so there is nothing to cancel.", "not_recurring");
  return current.stripeSubscriptionId;
}

export async function cancelAtPeriodEnd(siteId: string, reason: string): Promise<{ endsAt: string | null }> {
  const id = await recurringOf(siteId);
  const subscription = await platformStripe("POST", `/subscriptions/${id}`, { cancel_at_period_end: true, metadata: { cancel_reason: reason.slice(0, 450) } });
  await prisma.pluginSubscription.updateMany({ where: { stripeSubscriptionId: id }, data: { cancelReason: reason.slice(0, 500) } });
  const synced = await syncSubscription(id, subscription);
  return { endsAt: synced?.currentPeriodEnd?.toISOString() ?? null };
}

export async function resume(siteId: string): Promise<void> {
  const id = await recurringOf(siteId);
  const subscription = await platformStripe("POST", `/subscriptions/${id}`, { cancel_at_period_end: false });
  await prisma.pluginSubscription.updateMany({ where: { stripeSubscriptionId: id }, data: { cancelReason: null } });
  await syncSubscription(id, subscription);
}

export async function billingPortalUrl(owner: Owner): Promise<string> {
  const customer = await ensureCustomer(owner);
  const session = await platformStripe("POST", "/billing_portal/sessions", { customer, return_url: env.billing.returnUrl });
  return asString(session["url"]) ?? env.billing.returnUrl;
}
