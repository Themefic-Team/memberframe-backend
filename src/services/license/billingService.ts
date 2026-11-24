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
  /** The Stripe product the price belongs to: a coupon's `applies_to` names products. */
  productId: string;
  amountMinor: number;
  currency: string;
  interval: "month" | "year" | null;
}

const PLAN_IDS: ReadonlyArray<PlanId> = ["monthly", "yearly", "lifetime"];

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
      productId: asString(price["product"]) ?? "",
      amountMinor: asNumber(price["unit_amount"]) ?? 0,
      currency: asString(price["currency"]) ?? "usd",
      interval: interval === "month" || interval === "year" ? interval : null,
    };
  };
  // A plan switched off (ENABLE_<PLAN>_PLAN=no) may have no price: it stands at 0 and is never sold (assertSold).
  const readOrOff = async (id: PlanId): Promise<PlanPrice> => {
    if (env.billing.enabled[id]) return read(id);
    return read(id).catch(() => ({ id, priceId: "", productId: "", amountMinor: 0, currency: "usd", interval: id === "monthly" ? "month" : id === "yearly" ? "year" : null }));
  };

  const [monthly, yearly, lifetime] = await Promise.all(PLAN_IDS.map(readOrOff));
  const prices = { monthly: monthly!, yearly: yearly!, lifetime: lifetime! };
  priceCache = { at: Date.now(), prices };
  return prices;
}

/** A plan switched off in env is not sold: not bought, not upgraded to. */
export function assertSold(plan: PlanId): void {
  if (!env.billing.enabled[plan]) throw new PlatformBillingError(400, "This plan is not currently available.", "plan_unavailable");
}

/** Lifetime is sold `LIFETIME_MAX` times, then closes (BEAF's "spots left"). */
export async function lifetimeAvailability(): Promise<{ total: number; remaining: number }> {
  const taken = await prisma.pluginSubscription.count({ where: { plan: "lifetime", status: "paid" } });
  return { total: env.billing.lifetimeMax, remaining: Math.max(env.billing.lifetimeMax - taken, 0) };
}

export async function plansView() {
  const prices = await planPrices();
  const plans = [];
  for (const price of [prices.monthly, prices.yearly, prices.lifetime]) {
    const { id, amountMinor, currency, interval } = price;
    // The plan's own discount (env), with the price it leaves, so the cards show both.
    const discount = env.billing.enabled[id] ? await defaultDiscount(id, price) : null;
    plans.push({
      id,
      enabled: env.billing.enabled[id],
      amountMinor,
      currency,
      interval,
      discount: discount ? { code: discount.code, percentOff: discount.percentOff, amountOffMinor: discount.amountOffMinor, amountMinor: discountedMinor(amountMinor, discount) } : null,
    });
  }
  return {
    plans,
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

/**
 * Whether a stored customer id still exists on the Stripe account this server
 * now uses. False when Stripe does not know it (`resource_missing`: the keys
 * moved between test and live mode, or to another account) or it was deleted.
 * Any other failure is thrown, so a Stripe outage never replaces a good customer.
 */
async function customerExists(id: string): Promise<boolean> {
  try {
    const customer = await platformStripe("GET", `/customers/${encodeURIComponent(id)}`);
    return customer["deleted"] !== true;
  } catch (error) {
    if (error instanceof PlatformBillingError && error.code === "resource_missing") return false;
    throw error;
  }
}

/**
 * One Stripe customer per creator, made on their first checkout. A stored id
 * Stripe no longer knows ("No such customer", after the platform keys changed
 * mode or account) is replaced by a fresh customer instead of failing every
 * checkout, upgrade, coupon, and portal call.
 */
async function ensureCustomer(owner: Owner): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: owner.id }, select: { stripeCustomerId: true } });
  const stale = user?.stripeCustomerId ?? null;
  if (stale && (await customerExists(stale))) return stale;

  const customer = await platformStripe(
    "POST",
    "/customers",
    { email: owner.email, name: owner.name, metadata: { app: APP, user_id: owner.id } },
    // A replacement gets its own key: the first one may still be cached by Stripe for 24 hours.
    stale ? `customer-${owner.id}-replaces-${stale}` : `customer-${owner.id}`
  );
  const id = asString(customer["id"])!;
  await prisma.user.update({ where: { id: owner.id }, data: { stripeCustomerId: id } });
  if (stale) console.warn(`[billing] replaced a Stripe customer this account does not know, for user ${owner.id}`);
  return id;
}

/** An active Stripe promotion code, as the plans and checkout use it. */
export interface Promo {
  id: string;
  /** The customer facing code, as Stripe stores it. */
  code: string;
  percentOff: number | null;
  amountOffMinor: number | null;
  /** The products its coupon is limited to; null or empty: every product. */
  products: string[] | null;
}

/** A promotion code, active, or a clear refusal. */
async function promotionCode(code: string): Promise<Promo> {
  const list = await platformStripe("GET", "/promotion_codes", { code, active: true, limit: 1, expand: ["data.coupon.applies_to"] });
  const found = asRecord(Array.isArray(list["data"]) ? list["data"][0] : null);
  const id = asString(found["id"]);
  if (!id) throw new PlatformBillingError(400, "That coupon code is not valid.", "invalid_coupon");
  const coupon = asRecord(found["coupon"]);
  const products = asRecord(coupon["applies_to"])["products"];
  return {
    id,
    code: asString(found["code"]) ?? code,
    percentOff: asNumber(coupon["percent_off"]),
    amountOffMinor: asNumber(coupon["amount_off"]),
    products: Array.isArray(products) ? products.filter((entry): entry is string => typeof entry === "string") : null,
  };
}

/** Whether Stripe would take this promotion code on this plan's price (its coupon's products). */
export function promoFits(promo: Pick<Promo, "products">, price: Pick<PlanPrice, "productId">): boolean {
  const only = promo.products ?? [];
  return only.length === 0 || only.includes(price.productId);
}

/** What a price comes to with a discount, never below zero. */
export function discountedMinor(amountMinor: number, discount: Pick<Promo, "percentOff" | "amountOffMinor"> | null): number {
  if (!discount) return amountMinor;
  if (discount.percentOff !== null) return Math.max(Math.round(amountMinor * (1 - discount.percentOff / 100)), 0);
  return Math.max(amountMinor - (discount.amountOffMinor ?? 0), 0);
}

const discountCache = new Map<PlanId, { at: number; promo: Promo | null }>();

/**
 * The plan's own discount (<PLAN>_DISCOUNT_CODE): the promotion code set in env
 * for it, when Stripe has it active and it applies to the plan's product. A code
 * Stripe refuses, or one for another product, is left out, never an error: the
 * plan then sells at its price.
 */
export async function defaultDiscount(plan: PlanId, price: PlanPrice): Promise<Promo | null> {
  const code = env.billing.discounts[plan];
  if (!code) return null;
  const cached = discountCache.get(plan);
  let promo: Promo | null;
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) promo = cached.promo;
  else {
    promo = await promotionCode(code).catch(() => null);
    discountCache.set(plan, { at: Date.now(), promo });
  }
  return promo && promoFits(promo, price) ? promo : null;
}

/** Test only. */
export function resetBillingCaches(): void {
  priceCache = null;
  discountCache.clear();
}

/** A typed code that would not apply to this plan: said plainly, before Stripe is asked. */
function assertFits(promo: Promo, price: PlanPrice): Promo {
  if (!promoFits(promo, price)) throw new PlatformBillingError(400, "That code does not apply to this plan.", "coupon_not_eligible");
  return promo;
}

/** The code the creator typed (checked for this plan), else the plan's own discount. */
async function chosenPromo(plan: PlanId, coupon: string | undefined, price: PlanPrice): Promise<Promo | null> {
  if (coupon) return assertFits(await promotionCode(coupon), price);
  return defaultDiscount(plan, price);
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
  /** The promotion code on this checkout (typed, or the plan's own), or null. */
  couponCode?: string | null;
}

const clientSecretOf = (invoice: StripeObject): string | null =>
  asString(asRecord(invoice["payment_intent"])["client_secret"]);

/**
 * A first plan for a project with none. A project already on a plan upgrades instead.
 * `noDiscount`: the creator removed the code, so not even the plan's own discount applies.
 */
export async function startCheckout(owner: Owner, project: Project, plan: PlanId, coupon?: string, noDiscount = false): Promise<CheckoutResult> {
  const license = await resolveLicense(project.siteId);
  if (license.state === "active") throw new PlatformBillingError(400, "This project already has a plan. Upgrade it instead.", "already_subscribed");
  assertSold(plan);

  const prices = await planPrices();
  const price = prices[plan];
  const customer = await ensureCustomer(owner);
  const metadata = { app: APP, site_id: project.siteId, user_id: owner.id, plan, project_name: project.siteName.slice(0, 200) };
  // A typed code must apply to this plan; without one, the plan's own discount (env) if any.
  const promo = noDiscount && !coupon ? null : await chosenPromo(plan, coupon, price);
  const couponCode = promo?.code ?? null;

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
    return { ...(await createLifetimePayment(owner, project, customer, price, discount, 0, null, metadata, promo?.id ?? null)), couponCode };
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
    return { clientSecret: null, mode: "subscription", amountDueMinor: 0, creditMinor: 0, currency: price.currency, complete: true, couponCode };
  }
  return { clientSecret: clientSecretOf(invoice), mode: "subscription", amountDueMinor: due, creditMinor: 0, currency: price.currency, complete: false, couponCode };
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
  const promo = assertFits(await promotionCode(code), (await planPrices())[row.plan as PlanId]);

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
      return { clientSecret: null, mode: "subscription", amountDueMinor: 0, creditMinor: 0, currency: price.currency, complete: true, couponCode: promo.code };
    }
    return { clientSecret: clientSecretOf(invoice), mode: "subscription", amountDueMinor: due, creditMinor: 0, currency: price.currency, complete: false, couponCode: promo.code };
  }

  if (!row.stripePaymentIntentId) throw new PlatformBillingError(400, "Start the payment again, then apply the coupon.", "no_checkout");
  const intent = await platformStripe("GET", `/payment_intents/${row.stripePaymentIntentId}`);
  const credit = Number(asRecord(intent["metadata"])["credit_minor"] ?? 0) || 0;
  // The typed code replaces any code already on the payment (the plan's own, or an
  // earlier one): worked out from the plan's price, never from the lowered amount.
  const list = (await planPrices()).lifetime.amountMinor;
  const next = Math.max(discountedMinor(list, promo) - credit, 0);

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
    return { clientSecret: null, mode: "payment", amountDueMinor: 0, creditMinor: credit, currency: row.currency, complete: true, couponCode: promo.code };
  }

  const updated = await platformStripe("POST", `/payment_intents/${row.stripePaymentIntentId}`, {
    amount: next,
    metadata: { promotion_code: promo.id, coupon: code },
  });
  await prisma.pluginSubscription.update({ where: { id: row.id }, data: { amountMinor: next } });
  return { clientSecret: asString(updated["client_secret"]), mode: "payment", amountDueMinor: next, creditMinor: credit, currency: row.currency, complete: false, couponCode: promo.code };
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
  /** The promotion code on the upgrade (typed, or the plan's own), and what it takes off the plan's price. */
  couponCode: string | null;
  discountMinor: number | null;
}

/** What an upgrade costs today, before the creator confirms it. */
export async function upgradePreview(siteId: string, target: PlanId, now: Date = new Date(), coupon?: string): Promise<UpgradePreview> {
  assertSold(target);
  const current = await currentPlan(siteId);
  const prices = await planPrices();
  // A typed code must apply to the target plan; without one, the plan's own discount (env) if any.
  const promo = await chosenPromo(target, coupon, prices[target]);
  const targetPriceMinor = discountedMinor(prices[target].amountMinor, promo);
  const couponCode = promo?.code ?? null;
  const discountMinor = promo ? prices[target].amountMinor - targetPriceMinor : null;
  const quote = upgradeQuote({
    from: current.plan,
    to: target,
    paidMinor: current.amountMinor,
    periodStart: current.periodStart,
    periodEnd: current.periodEnd,
    targetPriceMinor,
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
      ...(promo ? { discounts: [{ promotion_code: promo.id }] } : {}),
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
        couponCode,
        discountMinor,
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
    couponCode,
    discountMinor,
  };
}

/**
 * Move up a plan. Monthly to yearly is a Stripe subscription update with
 * immediate proration, charged to the saved card; to lifetime is a one-off
 * payment for the price less the credit, after which the old plan stops.
 */
export async function upgrade(owner: Owner, project: Project, target: PlanId, coupon?: string): Promise<CheckoutResult> {
  const preview = await upgradePreview(project.siteId, target, new Date(), coupon);
  const current = await currentPlan(project.siteId);
  const prices = await planPrices();
  const promo = await chosenPromo(target, coupon, prices[target]);
  const couponCode = promo?.code ?? null;

  if (target === "lifetime") {
    if ((await lifetimeAvailability()).remaining <= 0) throw new PlatformBillingError(400, "Lifetime access is sold out.", "lifetime_sold_out");
    const customer = await ensureCustomer(owner);
    const metadata = { app: APP, site_id: project.siteId, user_id: owner.id, plan: "lifetime", project_name: project.siteName.slice(0, 200) };
    return { ...(await createLifetimePayment(owner, project, customer, prices.lifetime, preview.discountMinor ?? 0, preview.creditMinor, current.stripeSubscriptionId, metadata, promo?.id ?? null)), couponCode };
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
    ...(promo ? { discounts: [{ promotion_code: promo.id }] } : {}),
  });
  await platformStripe("POST", `/subscriptions/${current.stripeSubscriptionId}`, { metadata: { plan: "yearly" } }).catch(() => undefined);

  const invoice = asRecord(updated["latest_invoice"]);
  const intent = asRecord(invoice["payment_intent"]);
  const intentStatus = asString(intent["status"]);
  if (intentStatus === "requires_action" || intentStatus === "requires_payment_method" || intentStatus === "requires_confirmation") {
    return { clientSecret: asString(intent["client_secret"]), mode: "subscription", amountDueMinor: preview.amountDueMinor, creditMinor: preview.creditMinor, currency: preview.currency, complete: false, couponCode };
  }

  await syncSubscription(current.stripeSubscriptionId);
  return { clientSecret: null, mode: "subscription", amountDueMinor: preview.amountDueMinor, creditMinor: preview.creditMinor, currency: preview.currency, complete: true, couponCode };
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
