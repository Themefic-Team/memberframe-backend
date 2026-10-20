/**
 * Stripe. FP-16 section 5.
 *
 * Talks to the REST API with `fetch` rather than the SDK: four resources,
 * form-encoded bodies, and a signature check that is twenty lines. The SDK
 * would add a dependency that pins an API version for every creator at once.
 *
 * The creator's own secret key charges the buyer directly. No Connect, no
 * application fee: the money never passes through Framefic (FP-16 section 12).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { maskedSuffix } from "../../lib/secretBox.js";
import { fromStripeAmount, toStripeAmount } from "../../lib/currencies.js";
import {
  GatewayError,
  asNumber,
  asRecord,
  asString,
  fromUnix,
  header,
  paymentEvent,
  type BillingInterval,
  type CheckoutResult,
  type CheckoutSpec,
  type ConnectInput,
  type ConnectResult,
  type GatewayAdapter,
  type GatewayCredentials,
  type KnownPrice,
  type ParsedWebhook,
  type PaymentEvent,
  type PriceSpec,
} from "./types.js";

const API = "https://api.stripe.com/v1";

/** Pinned, so webhook payloads keep the shape `parseWebhook` reads. */
const API_VERSION = "2024-06-20";

/** Every event `parseWebhook` acts on, and nothing else, so the endpoint stays quiet. */
export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
] as const;

/** Signatures older than this are refused, so a captured request cannot be replayed later. */
const TOLERANCE_SECONDS = 300;

type Params = Record<string, unknown>;

/** Stripe's bracketed form encoding: `line_items[0][price]=price_123`. */
export function formEncode(params: Params, prefix = ""): string[] {
  const out: string[] = [];
  for (const [rawKey, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const key = prefix ? `${prefix}[${rawKey}]` : rawKey;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object") out.push(...formEncode(item as Params, `${key}[${index}]`));
        else out.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === "object") {
      out.push(...formEncode(value as Params, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return out;
}

/** Put a subscription on another price from its next invoice, with no charge or credit now. */
async function setNextPrice(secretKey: string, externalId: string, priceId: string): Promise<void> {
  const current = await stripe(secretKey, "GET", `/subscriptions/${encodeURIComponent(externalId)}`);
  const items = asRecord(current["items"]);
  const itemId = asString(asRecord(Array.isArray(items["data"]) ? items["data"][0] : null)["id"]);
  if (!itemId) throw new GatewayError("stripe", 502, "Stripe returned a subscription with no item.");
  await stripe(secretKey, "POST", `/subscriptions/${encodeURIComponent(externalId)}`, {
    items: [{ id: itemId, price: priceId }],
    proration_behavior: "none",
  });
}

async function stripe(
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params = {}
): Promise<Record<string, unknown>> {
  const body = formEncode(params).join("&");
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": API_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
  });

  const json = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const error = asRecord(json["error"]);
    throw new GatewayError("stripe", response.status, asString(error["message"]) ?? `Stripe answered ${response.status}.`);
  }
  return json;
}

function secretKeyOf(credentials: GatewayCredentials): string {
  const key = credentials.secrets["secretKey"];
  if (!key) throw new GatewayError("stripe", 400, "Stripe is not connected.");
  return key;
}

/** test or live, from the key's own prefix. Null when it is not a secret key at all. */
export function stripeKeyMode(key: string): "test" | "live" | null {
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return null;
}

/**
 * Verify `Stripe-Signature: t=...,v1=...` against the raw body.
 *
 * Any one of the candidate secrets may match: the stored endpoint secret, and
 * in development the one `stripe listen` prints.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secrets: string[],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!signatureHeader) return false;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of signatureHeader.split(",")) {
    const [name, value] = part.split("=", 2);
    if (name === "t" && value) timestamp = Number(value);
    if (name === "v1" && value) signatures.push(value);
  }

  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;

  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);

  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(signedPayload).digest();
    for (const candidate of signatures) {
      const given = Buffer.from(candidate, "hex");
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
  }
  return false;
}

/** The period end from a subscription object, in either API generation's shape. */
function subscriptionPeriodEnd(subscription: Record<string, unknown>): Date | null {
  const direct = fromUnix(subscription["current_period_end"]);
  if (direct) return direct;

  const items = asRecord(subscription["items"]);
  const first = asRecord(Array.isArray(items["data"]) ? items["data"][0] : null);
  return fromUnix(first["current_period_end"]);
}

/** The subscription an invoice belongs to, in either API generation's shape. */
function invoiceSubscription(invoice: Record<string, unknown>): string | null {
  const direct = asString(invoice["subscription"]);
  if (direct) return direct;
  const parent = asRecord(invoice["parent"]);
  return asString(asRecord(parent["subscription_details"])["subscription"]);
}

function invoiceCheckoutId(invoice: Record<string, unknown>): string | null {
  const details = asRecord(invoice["subscription_details"]);
  const fromDetails = asString(asRecord(details["metadata"])["mf_checkout_id"]);
  if (fromDetails) return fromDetails;
  const parent = asRecord(asRecord(invoice["parent"])["subscription_details"]);
  return asString(asRecord(parent["metadata"])["mf_checkout_id"]);
}

function invoicePeriodEnd(invoice: Record<string, unknown>): Date | null {
  const lines = asRecord(invoice["lines"]);
  const first = asRecord(Array.isArray(lines["data"]) ? lines["data"][0] : null);
  return fromUnix(asRecord(first["period"])["end"]);
}

export function parseStripeEvent(event: Record<string, unknown>): PaymentEvent[] {
  const type = asString(event["type"]) ?? "";
  const object = asRecord(asRecord(event["data"])["object"]);
  const metadata = asRecord(object["metadata"]);

  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // A bank transfer completes the session unpaid and pays later, which
      // arrives as `async_payment_succeeded`. Only a paid session activates.
      const paymentStatus = asString(object["payment_status"]);
      if (paymentStatus !== "paid" && paymentStatus !== "no_payment_required") return [];

      const checkoutId = asString(object["client_reference_id"]) ?? asString(metadata["mf_checkout_id"]);
      const isSubscription = asString(object["mode"]) === "subscription";
      const externalId = isSubscription
        ? asString(object["subscription"])
        : asString(object["payment_intent"]) ?? asString(object["id"]);
      const currency = (asString(object["currency"]) ?? "usd").toUpperCase();

      return [
        paymentEvent("activate", type, {
          checkoutId,
          externalId,
          customerId: asString(object["customer"]),
          onlyFor: isSubscription ? "recurring" : "lifetime",
          // A subscription's first invoice is recorded by `invoice.paid`; a
          // one-time purchase has no invoice, so its payment is recorded here.
          payment: isSubscription
            ? null
            : {
                externalId: externalId ?? asString(object["id"]) ?? "",
                amountMinor: fromStripeAmount(asNumber(object["amount_total"]) ?? 0, currency),
                currency,
                receiptUrl: null,
                paidAt: fromUnix(object["created"]) ?? new Date(),
              },
        }),
      ];
    }

    case "invoice.paid": {
      const subscriptionId = invoiceSubscription(object);
      if (!subscriptionId) return [];
      const amount = asNumber(object["amount_paid"]) ?? 0;
      const currency = (asString(object["currency"]) ?? "usd").toUpperCase();
      return [
        paymentEvent("renewed", type, {
          externalId: subscriptionId,
          checkoutId: invoiceCheckoutId(object),
          customerId: asString(object["customer"]),
          currentPeriodEnd: invoicePeriodEnd(object),
          payment:
            amount > 0
              ? {
                  externalId: asString(object["id"]) ?? "",
                  amountMinor: fromStripeAmount(amount, currency),
                  currency,
                  receiptUrl: asString(object["hosted_invoice_url"]),
                  paidAt: fromUnix(asRecord(object["status_transitions"])["paid_at"]) ?? new Date(),
                }
              : null,
        }),
      ];
    }

    case "invoice.payment_failed": {
      const subscriptionId = invoiceSubscription(object);
      return subscriptionId ? [paymentEvent("payment_failed", type, { externalId: subscriptionId })] : [];
    }

    case "customer.subscription.updated": {
      const id = asString(object["id"]);
      if (!id) return [];
      const status = asString(object["status"]);
      const periodEnd = subscriptionPeriodEnd(object);

      if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
        return [paymentEvent("ended", type, { externalId: id })];
      }
      if (object["cancel_at_period_end"] === true) {
        return [paymentEvent("cancel_scheduled", type, { externalId: id, currentPeriodEnd: periodEnd })];
      }
      if (status === "past_due") return [paymentEvent("payment_failed", type, { externalId: id })];
      if (status === "active" || status === "trialing") {
        return [paymentEvent("resumed", type, { externalId: id, currentPeriodEnd: periodEnd })];
      }
      return [];
    }

    case "customer.subscription.deleted": {
      const id = asString(object["id"]);
      return id ? [paymentEvent("ended", type, { externalId: id })] : [];
    }

    case "charge.refunded": {
      // Only a full refund ends access. A partial refund is a goodwill gesture.
      if (object["refunded"] !== true) return [];
      const paymentIntent = asString(object["payment_intent"]);
      return paymentIntent ? [paymentEvent("refunded", type, { externalId: paymentIntent })] : [];
    }

    default:
      return [];
  }
}

export const stripeAdapter: GatewayAdapter = {
  id: "stripe",

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const secretKey = (input.values["secretKey"] ?? "").trim();
    const keyMode = stripeKeyMode(secretKey);

    if (keyMode === null) {
      throw new GatewayError("stripe", 400, "Paste a secret key. It starts with sk_ or rk_.");
    }
    if (keyMode !== input.mode) {
      throw new GatewayError(
        "stripe",
        400,
        input.mode === "test" ? "That is a live key. Paste a test key, sk_test_." : "That is a test key. Paste a live key, sk_live_."
      );
    }

    // The account name, so the creator can see which Stripe they connected.
    // A restricted key may not read the account; that is not a failure.
    let accountName: string | null = null;
    let accountId: string | null = null;
    try {
      const account = await stripe(secretKey, "GET", "/account");
      accountId = asString(account["id"]);
      const profile = asRecord(account["business_profile"]);
      const dashboard = asRecord(asRecord(account["settings"])["dashboard"]);
      accountName = asString(dashboard["display_name"]) ?? asString(profile["name"]) ?? accountId;
    } catch (error) {
      if (error instanceof GatewayError && error.status === 401) {
        throw new GatewayError("stripe", 400, "Stripe did not accept that key. Check it and paste it again.");
      }
      await stripe(secretKey, "GET", "/prices", { limit: 1 });
    }

    let webhookSecret: string | null = null;
    let webhookEndpointId: string | null = null;
    let notice: string | null = null;

    try {
      const endpoint = await stripe(secretKey, "POST", "/webhook_endpoints", {
        url: input.webhookUrl,
        enabled_events: [...STRIPE_EVENTS],
        api_version: API_VERSION,
        description: "MemberFrame",
      });
      webhookEndpointId = asString(endpoint["id"]);
      webhookSecret = asString(endpoint["secret"]);
    } catch (error) {
      // Stripe refuses an address it cannot reach, which is every local
      // address. Connected anyway: `stripe listen` covers development.
      notice =
        error instanceof GatewayError
          ? `Connected, but Stripe could not register the webhook: ${error.message} Set API_BASE_URL to a public https address, or use stripe listen while developing.`
          : "Connected, but the webhook could not be registered.";
    }

    return {
      publicId: accountId,
      secrets: { secretKey },
      webhookSecret,
      webhookEndpointId,
      accountName,
      maskedSuffix: maskedSuffix(secretKey),
      options: {},
      notice,
    };
  },

  async disconnect(credentials, webhookEndpointId) {
    if (!webhookEndpointId) return;
    try {
      await stripe(secretKeyOf(credentials), "DELETE", `/webhook_endpoints/${encodeURIComponent(webhookEndpointId)}`);
    } catch {
      // Already gone, or the key was revoked. Nothing to clean up either way.
    }
  },

  async ensurePrice(credentials, spec: PriceSpec, product: string | null): Promise<KnownPrice> {
    const secretKey = secretKeyOf(credentials);

    const productId =
      product ??
      asString(
        (
          await stripe(secretKey, "POST", "/products", {
            name: spec.tierName,
            metadata: { mf_site_id: spec.siteId, mf_tier_key: spec.tierKey },
          })
        )["id"]
      );

    if (!productId) throw new GatewayError("stripe", 502, "Stripe did not return a product.");

    const price = await stripe(secretKey, "POST", "/prices", {
      product: productId,
      unit_amount: toStripeAmount(spec.amountMinor, spec.currency),
      currency: spec.currency.toLowerCase(),
      ...(spec.interval === "lifetime" ? {} : { recurring: { interval: spec.interval } }),
      metadata: { mf_site_id: spec.siteId, mf_tier_key: spec.tierKey, mf_interval: spec.interval },
    });

    const priceId = asString(price["id"]);
    if (!priceId) throw new GatewayError("stripe", 502, "Stripe did not return a price.");
    return { externalId: priceId, externalProductId: productId };
  },

  canSell(_credentials, _interval: BillingInterval, _currency: string) {
    // Every currency MemberFrame offers, on every interval.
    return true;
  },

  async createCheckout(credentials, spec: CheckoutSpec): Promise<CheckoutResult> {
    if (!spec.price) throw new GatewayError("stripe", 500, "No Stripe price for this checkout.");
    const recurring = spec.interval !== "lifetime";
    const metadata = { mf_checkout_id: spec.checkoutId, mf_member_id: spec.member.id, mf_site_id: spec.siteId };

    // Unused credit from an upgrade, off the first charge only.
    let coupon: string | null = null;
    if (spec.discountMinor && spec.discountMinor > 0) {
      const created = await stripe(secretKeyOf(credentials), "POST", "/coupons", {
        amount_off: toStripeAmount(spec.discountMinor, spec.currency),
        currency: spec.currency.toLowerCase(),
        duration: "once",
        max_redemptions: 1,
        name: "Credit for unused time",
      });
      coupon = asString(created["id"]);
    }

    const session = await stripe(secretKeyOf(credentials), "POST", "/checkout/sessions", {
      mode: recurring ? "subscription" : "payment",
      line_items: [{ price: spec.price.externalId, quantity: 1 }],
      success_url: spec.successUrl,
      cancel_url: spec.cancelUrl,
      client_reference_id: spec.checkoutId,
      ...(spec.customerId ? { customer: spec.customerId } : { customer_email: spec.member.email }),
      metadata,
      ...(recurring
        ? { subscription_data: { metadata } }
        : { payment_intent_data: { metadata }, customer_creation: spec.customerId ? undefined : "always" }),
      // Stripe takes either a discount or promotion codes, not both.
      ...(coupon ? { discounts: [{ coupon }] } : { allow_promotion_codes: true }),
    });

    const url = asString(session["url"]);
    const id = asString(session["id"]);
    if (!url || !id) throw new GatewayError("stripe", 502, "Stripe did not return a checkout page.");
    return { url, externalId: id, ...(coupon ? { discountApplied: spec.discountMinor } : {}) };
  },

  verifyWebhook(rawBody, headers, secrets) {
    return verifyStripeSignature(rawBody, header(headers, "stripe-signature"), secrets);
  },

  parseWebhook(rawBody): ParsedWebhook {
    const event = asRecord(JSON.parse(rawBody.toString("utf8")));
    const type = asString(event["type"]) ?? "unknown";
    return { eventId: asString(event["id"]) ?? "", type, events: parseStripeEvent(event) };
  },

  async periodEnd(credentials, externalId) {
    const subscription = await stripe(secretKeyOf(credentials), "GET", `/subscriptions/${encodeURIComponent(externalId)}`);
    return subscriptionPeriodEnd(subscription);
  },

  async syncStatus(credentials, externalId) {
    const subscription = await stripe(secretKeyOf(credentials), "GET", `/subscriptions/${encodeURIComponent(externalId)}`);
    const status = asString(subscription["status"]);
    const currentPeriodEnd = subscriptionPeriodEnd(subscription);
    if (status === "canceled" || status === "incomplete_expired") return paymentEvent("ended", "sync", { externalId });
    if (status === "past_due" || status === "unpaid") return paymentEvent("payment_failed", "sync", { externalId });
    if (subscription["cancel_at_period_end"] === true) return paymentEvent("cancel_scheduled", "sync", { externalId, currentPeriodEnd });
    return paymentEvent("renewed", "sync", { externalId, currentPeriodEnd });
  },

  async portalUrl(credentials, subscription, returnUrl) {
    if (!subscription.customerId) return null;
    try {
      const session = await stripe(secretKeyOf(credentials), "POST", "/billing_portal/sessions", {
        customer: subscription.customerId,
        return_url: returnUrl,
      });
      return asString(session["url"]);
    } catch {
      // Stripe refuses until the creator has saved their customer portal
      // settings once. The dashboard falls back to its own cancel button.
      return null;
    }
  },

  async cancelAtPeriodEnd(credentials, externalId) {
    await stripe(secretKeyOf(credentials), "POST", `/subscriptions/${encodeURIComponent(externalId)}`, {
      cancel_at_period_end: true,
    });
  },

  resume: async (credentials, externalId) => {
    await stripe(secretKeyOf(credentials), "POST", `/subscriptions/${encodeURIComponent(externalId)}`, {
      cancel_at_period_end: false,
    });
  },

  async cancelNow(credentials, externalId) {
    await stripe(secretKeyOf(credentials), "DELETE", `/subscriptions/${encodeURIComponent(externalId)}`);
  },

  /**
   * Swap the subscription's one item to the new price. Stripe prorates: an
   * upgrade is invoiced and charged now for the rest of the period
   * (`always_invoice`), a downgrade becomes a credit on the next invoice
   * (`create_prorations`). Any scheduled cancel is lifted, because choosing a
   * new plan is choosing to stay.
   */
  async changePlan(credentials, externalId, price, upgrade) {
    const secretKey = secretKeyOf(credentials);
    const current = await stripe(secretKey, "GET", `/subscriptions/${encodeURIComponent(externalId)}`);
    const items = asRecord(current["items"]);
    const itemId = asString(asRecord(Array.isArray(items["data"]) ? items["data"][0] : null)["id"]);
    if (!itemId) throw new GatewayError("stripe", 502, "Stripe returned a subscription with no item.");

    const updated = await stripe(secretKey, "POST", `/subscriptions/${encodeURIComponent(externalId)}`, {
      items: [{ id: itemId, price: price.externalId }],
      proration_behavior: upgrade ? "always_invoice" : "create_prorations",
      // An upgrade starts the new period today, Stripe crediting the unused
      // time of the old one: new price minus credit, due now (30-plan-changes.md).
      ...(upgrade ? { billing_cycle_anchor: "now" } : {}),
      cancel_at_period_end: false,
    });
    return { currentPeriodEnd: subscriptionPeriodEnd(updated) };
  },

  /** A downgrade at period end: the next invoice is the new price, nothing is charged now. */
  async scheduleChange(credentials, externalId, price) {
    if (!price) throw new GatewayError("stripe", 500, "No Stripe price for this plan.");
    await setNextPrice(secretKeyOf(credentials), externalId, price.externalId);
  },

  async cancelScheduledChange(credentials, externalId, price) {
    if (!price) return;
    await setNextPrice(secretKeyOf(credentials), externalId, price.externalId);
  },

  /** A partial refund of an invoice (subscription) or a payment intent (one-time). */
  async refund(credentials, paymentExternalId, amountMinor, currency) {
    const secretKey = secretKeyOf(credentials);
    let paymentIntent = paymentExternalId;
    if (paymentExternalId.startsWith("in_")) {
      const invoice = await stripe(secretKey, "GET", `/invoices/${encodeURIComponent(paymentExternalId)}`);
      paymentIntent = asString(invoice["payment_intent"]) ?? "";
      if (!paymentIntent) {
        // An invoice paid from credit has no payment to refund.
        return;
      }
    }
    await stripe(secretKey, "POST", "/refunds", { payment_intent: paymentIntent, amount: toStripeAmount(amountMinor, currency) });
  },

  /**
   * Read the Checkout Session and answer as its webhooks would:
   * `checkout.session.completed` once it is complete and paid, and for a
   * subscription `invoice.paid` for its first invoice, which records the
   * payment and the period end.
   */
  async confirmCheckout(credentials, checkout) {
    if (!checkout.externalId?.startsWith("cs_")) return [];
    const session = await stripe(secretKeyOf(credentials), "GET", `/checkout/sessions/${encodeURIComponent(checkout.externalId)}`, {
      expand: ["invoice"],
    });
    if (asString(session["status"]) !== "complete") return [];

    const events = parseStripeEvent({ type: "checkout.session.completed", data: { object: session } });
    const invoice = asRecord(session["invoice"]);
    if (events.length > 0 && asString(invoice["status"]) === "paid") {
      events.push(...parseStripeEvent({ type: "invoice.paid", data: { object: invoice } }));
    }
    return events;
  },
};
