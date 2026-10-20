/**
 * Razorpay. FP-16 section 5. UPI, UPI Autopay, cards, net banking for India.
 *
 * Three differences from Stripe shape this file:
 *
 *   1. Webhooks cannot be registered through the API for a standard account.
 *      The creator adds MemberFrame's URL in the Razorpay dashboard and pastes
 *      the secret they chose. The plugin shows the URL and the event list.
 *   2. There is no hosted page that returns a subscriber to the site. So the
 *      buyer goes to MemberFrame's bridge page (`routes/payBridge.ts`), which
 *      opens Razorpay Checkout, UPI QR included, and sends them back on success.
 *   3. A scheduled cancel cannot be undone, so `resume` is null.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { maskedSuffix } from "../../lib/secretBox.js";
import {
  GatewayError,
  asNumber,
  asRecord,
  asString,
  fromUnix,
  header,
  paymentEvent,
  type CheckoutEmbed,
  type CheckoutSpec,
  type ConnectInput,
  type ConnectResult,
  type GatewayAdapter,
  type GatewayCredentials,
  type ParsedWebhook,
  type PaymentEvent,
} from "./types.js";

const API = "https://api.razorpay.com/v1";

/** The events the creator must tick in the Razorpay dashboard. */
export const RAZORPAY_EVENTS = [
  "subscription.activated",
  "subscription.charged",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  "subscription.completed",
  "subscription.resumed",
  "order.paid",
  "refund.processed",
] as const;

/**
 * How many cycles a subscription runs before Razorpay ends it. Razorpay
 * requires a count; ten years is "until cancelled" in practice.
 */
const TOTAL_COUNT = { month: 120, year: 10 } as const;

/** Set in a connection's options when the account cannot make plans. */
const SUBSCRIPTIONS_OFF = "subscriptionsOff";

async function razorpay(
  credentials: { keyId: string; keySecret: string },
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const error = asRecord(json["error"]);
    throw new GatewayError("razorpay", response.status, asString(error["description"]) ?? `Razorpay answered ${response.status}.`);
  }
  return json;
}

function keysOf(credentials: GatewayCredentials): { keyId: string; keySecret: string } {
  const keyId = credentials.publicId ?? "";
  const keySecret = credentials.secrets["keySecret"] ?? "";
  if (!keyId || !keySecret) throw new GatewayError("razorpay", 400, "Razorpay is not connected.");
  return { keyId, keySecret };
}

export function razorpayKeyMode(keyId: string): "test" | "live" | null {
  if (keyId.startsWith("rzp_test_")) return "test";
  if (keyId.startsWith("rzp_live_")) return "live";
  return null;
}

/** `X-Razorpay-Signature` is a hex HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyRazorpaySignature(rawBody: Buffer, signature: string | undefined, secrets: string[]): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature, "hex");
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

function entity(payload: Record<string, unknown>, name: string): Record<string, unknown> {
  return asRecord(asRecord(payload[name])["entity"]);
}

function paymentOf(payment: Record<string, unknown>) {
  const id = asString(payment["id"]);
  if (!id) return null;
  return {
    externalId: id,
    amountMinor: asNumber(payment["amount"]) ?? 0,
    currency: asString(payment["currency"]) ?? "INR",
    receiptUrl: null,
    paidAt: fromUnix(payment["created_at"]) ?? new Date(),
  };
}

export function parseRazorpayEvent(event: Record<string, unknown>): PaymentEvent[] {
  const type = asString(event["event"]) ?? "";
  const payload = asRecord(event["payload"]);
  const subscription = entity(payload, "subscription");
  const subscriptionId = asString(subscription["id"]);
  const notes = asRecord(subscription["notes"]);
  const periodEnd = fromUnix(subscription["current_end"]);

  switch (type) {
    case "subscription.activated":
      return subscriptionId
        ? [
            paymentEvent("activate", type, {
              checkoutId: asString(notes["mf_checkout_id"]),
              externalId: subscriptionId,
              customerId: asString(subscription["customer_id"]),
              currentPeriodEnd: periodEnd,
              onlyFor: "recurring",
              manageUrl: asString(subscription["short_url"]),
            }),
          ]
        : [];

    case "subscription.charged":
      return subscriptionId
        ? [
            paymentEvent("renewed", type, {
              checkoutId: asString(notes["mf_checkout_id"]),
              externalId: subscriptionId,
              currentPeriodEnd: periodEnd,
              payment: paymentOf(entity(payload, "payment")),
            }),
          ]
        : [];

    case "subscription.pending":
      return subscriptionId ? [paymentEvent("payment_failed", type, { externalId: subscriptionId })] : [];

    case "subscription.resumed":
      return subscriptionId
        ? [paymentEvent("resumed", type, { externalId: subscriptionId, currentPeriodEnd: periodEnd })]
        : [];

    case "subscription.halted":
    case "subscription.cancelled":
    case "subscription.completed":
      return subscriptionId ? [paymentEvent("ended", type, { externalId: subscriptionId })] : [];

    case "order.paid": {
      const order = entity(payload, "order");
      const orderId = asString(order["id"]);
      if (!orderId) return [];
      return [
        paymentEvent("activate", type, {
          checkoutId: asString(asRecord(order["notes"])["mf_checkout_id"]),
          externalId: orderId,
          onlyFor: "lifetime",
          payment: paymentOf(entity(payload, "payment")),
        }),
      ];
    }

    case "refund.processed": {
      // A lifetime purchase is keyed by its order; the refund names the payment,
      // and the payment names the order.
      const orderId = asString(entity(payload, "payment")["order_id"]);
      return orderId ? [paymentEvent("refunded", type, { externalId: orderId })] : [];
    }

    default:
      return [];
  }
}

export const razorpayAdapter: GatewayAdapter = {
  id: "razorpay",

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const keyId = (input.values["keyId"] ?? "").trim();
    const keySecret = (input.values["keySecret"] ?? "").trim();
    const webhookSecret = (input.values["webhookSecret"] ?? "").trim();

    const keyMode = razorpayKeyMode(keyId);
    if (keyMode === null) throw new GatewayError("razorpay", 400, "Paste the Key ID. It starts with rzp_test_ or rzp_live_.");
    if (keyMode !== input.mode) {
      throw new GatewayError(
        "razorpay",
        400,
        input.mode === "test" ? "That is a live key. Paste a test key, rzp_test_." : "That is a test key. Paste a live key, rzp_live_."
      );
    }
    if (!keySecret) throw new GatewayError("razorpay", 400, "Paste the Key Secret.");

    // Orders exist on every account, so they prove the keys. Plans belong to
    // the Subscriptions product, which many accounts have not turned on: a
    // refusal there says nothing about the keys.
    try {
      await razorpay({ keyId, keySecret }, "GET", "/orders?count=1");
    } catch (error) {
      if (error instanceof GatewayError && error.status === 401) {
        throw new GatewayError("razorpay", 400, "Razorpay did not accept that Key ID and Secret.");
      }
      throw error;
    }

    const subscriptions = await razorpay({ keyId, keySecret }, "GET", "/plans?count=1").then(
      () => true,
      () => false
    );

    const notices: string[] = [];
    if (!webhookSecret) {
      notices.push("Connected. Add the webhook in your Razorpay dashboard and paste its secret, or purchases will not unlock access.");
    }
    if (!subscriptions) {
      notices.push("Subscriptions is not enabled on this Razorpay account, so only lifetime prices can be sold. Enable it in the Razorpay dashboard, then click Update keys.");
    }

    return {
      publicId: keyId,
      secrets: { keySecret },
      webhookSecret: webhookSecret || null,
      webhookEndpointId: null,
      accountName: null,
      maskedSuffix: maskedSuffix(keyId),
      options: subscriptions ? {} : { [SUBSCRIPTIONS_OFF]: "1" },
      notice: notices.length > 0 ? notices.join(" ") : null,
    };
  },

  async disconnect() {
    // MemberFrame registered nothing; the creator's webhook stays in their dashboard.
  },

  async ensurePrice(credentials, spec) {
    if (spec.interval === "lifetime") {
      // A one-time purchase is an order made per checkout, not a stored price.
      return { externalId: "order", externalProductId: null };
    }

    const plan = await razorpay(keysOf(credentials), "POST", "/plans", {
      period: spec.interval === "month" ? "monthly" : "yearly",
      interval: 1,
      item: { name: spec.tierName, amount: spec.amountMinor, currency: spec.currency },
      notes: { mf_site_id: spec.siteId, mf_tier_key: spec.tierKey },
    });

    const planId = asString(plan["id"]);
    if (!planId) throw new GatewayError("razorpay", 502, "Razorpay did not return a plan.");
    return { externalId: planId, externalProductId: null };
  },

  canSell(credentials, interval) {
    // An account without Subscriptions cannot make plans, so a monthly or
    // yearly checkout is not offered rather than failing at Razorpay.
    if (interval !== "lifetime" && credentials.options[SUBSCRIPTIONS_OFF] === "1") return false;
    // Any currency (29-checkout-methods.md). UPI and net banking are rupees
    // only, but an account with International Payments on takes cards in USD
    // and others; Razorpay refuses a currency it cannot take, and the buyer is
    // told to choose another method.
    return true;
  },

  async createCheckout(credentials, spec: CheckoutSpec) {
    const keys = keysOf(credentials);
    const notes = { mf_checkout_id: spec.checkoutId, mf_member_id: spec.member.id, mf_site_id: spec.siteId };
    const bridge = `${env.apiBaseUrl}/api/pay/razorpay/${encodeURIComponent(spec.checkoutId)}`;

    if (spec.interval === "lifetime") {
      const order = await razorpay(keys, "POST", "/orders", {
        amount: spec.amountMinor,
        currency: spec.currency,
        receipt: spec.checkoutId.slice(0, 40),
        notes,
      });
      const orderId = asString(order["id"]);
      if (!orderId) throw new GatewayError("razorpay", 502, "Razorpay did not return an order.");
      return { url: bridge, externalId: orderId, embed: embedFor(keys.keyId, spec, { orderId }) };
    }

    if (!spec.price) throw new GatewayError("razorpay", 500, "No Razorpay plan for this checkout.");

    const subscription = await razorpay(keys, "POST", "/subscriptions", {
      plan_id: spec.price.externalId,
      total_count: TOTAL_COUNT[spec.interval],
      quantity: 1,
      customer_notify: 1,
      notes,
    });
    const id = asString(subscription["id"]);
    if (!id) throw new GatewayError("razorpay", 502, "Razorpay did not return a subscription.");
    return { url: bridge, externalId: id, embed: embedFor(keys.keyId, spec, { subscriptionId: id }) };
  },

  verifyWebhook(rawBody, headers, secrets) {
    return verifyRazorpaySignature(rawBody, header(headers, "x-razorpay-signature"), secrets);
  },

  parseWebhook(rawBody, headers): ParsedWebhook {
    const event = asRecord(JSON.parse(rawBody.toString("utf8")));
    const type = asString(event["event"]) ?? "unknown";
    // Razorpay names each delivery in a header. The body's own fields are the
    // fallback for a replayed request that lost it.
    const eventId =
      header(headers, "x-razorpay-event-id") ??
      `${type}:${asString(event["account_id"]) ?? ""}:${asString(event["created_at"]) ?? ""}`;
    return { eventId, type, events: parseRazorpayEvent(event) };
  },

  async periodEnd(credentials, externalId) {
    const subscription = await razorpay(keysOf(credentials), "GET", `/subscriptions/${encodeURIComponent(externalId)}`);
    return fromUnix(subscription["current_end"]);
  },

  async portalUrl(_credentials, subscription) {
    // No hosted portal. The subscription's own link is where a card is updated.
    return subscription.manageUrl;
  },

  async cancelAtPeriodEnd(credentials, externalId) {
    await razorpay(keysOf(credentials), "POST", `/subscriptions/${encodeURIComponent(externalId)}/cancel`, {
      cancel_at_cycle_end: 1,
    });
  },

  resume: null,

  async cancelNow(credentials, externalId) {
    await razorpay(keysOf(credentials), "POST", `/subscriptions/${encodeURIComponent(externalId)}/cancel`, {
      cancel_at_cycle_end: 0,
    });
  },

  async refund(credentials, paymentExternalId, amountMinor) {
    await razorpay(keysOf(credentials), "POST", `/payments/${encodeURIComponent(paymentExternalId)}/refund`, {
      amount: amountMinor,
      speed: "normal",
    });
  },

  /**
   * A one-time purchase is an order: paid once a payment on it is captured.
   * A subscription is active once its first charge goes through, and its
   * paid invoice carries that payment. Answered as `order.paid`, or as
   * `subscription.activated` plus `subscription.charged`.
   */
  async confirmCheckout(credentials, checkout) {
    const keys = keysOf(credentials);
    const externalId = checkout.externalId ?? "";

    if (externalId.startsWith("order_")) {
      const order = await razorpay(keys, "GET", `/orders/${encodeURIComponent(externalId)}`);
      if (asString(order["status"]) !== "paid") return [];
      const payments = await razorpay(keys, "GET", `/orders/${encodeURIComponent(externalId)}/payments`);
      const items = Array.isArray(payments["items"]) ? payments["items"].map(asRecord) : [];
      const captured = items.find((item) => asString(item["status"]) === "captured") ?? {};
      return parseRazorpayEvent({
        event: "order.paid",
        payload: { order: { entity: order }, payment: { entity: captured } },
      });
    }

    if (externalId.startsWith("sub_")) {
      const subscription = await razorpay(keys, "GET", `/subscriptions/${encodeURIComponent(externalId)}`);
      if (asString(subscription["status"]) !== "active") return [];
      const events = parseRazorpayEvent({
        event: "subscription.activated",
        payload: { subscription: { entity: subscription } },
      });

      const invoices = await razorpay(keys, "GET", `/invoices?subscription_id=${encodeURIComponent(externalId)}`).catch(
        () => ({}) as Record<string, unknown>
      );
      const list = Array.isArray(invoices["items"]) ? invoices["items"].map(asRecord) : [];
      const paid = list.find((invoice) => asString(invoice["status"]) === "paid" && asString(invoice["payment_id"]));
      if (paid) {
        const payment = {
          id: paid["payment_id"],
          amount: paid["amount_paid"] ?? paid["amount"],
          currency: paid["currency"],
          created_at: paid["paid_at"] ?? paid["issued_at"],
        };
        events.push(
          ...parseRazorpayEvent({
            event: "subscription.charged",
            payload: { subscription: { entity: subscription }, payment: { entity: payment } },
          })
        );
      }
      return events;
    }

    return [];
  },
};

/** What the published page needs to open Razorpay Checkout itself. All public. */
function embedFor(
  keyId: string,
  spec: CheckoutSpec,
  ids: { orderId?: string; subscriptionId?: string }
): CheckoutEmbed {
  return {
    kind: "razorpay",
    key: keyId,
    ...ids,
    name: spec.siteName,
    description: spec.tierName,
    prefill: { email: spec.member.email, name: spec.member.name ?? "" },
  };
}
