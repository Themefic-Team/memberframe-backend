/**
 * FP-16 payments: the parts that decide whether money turns into access.
 *
 * Signature checks, because a forged webhook would hand out tiers for free.
 * Event parsing, because each gateway names the same thing differently and a
 * misread event is a member charged with no access, or access with no charge.
 * Routing, because the gateway choice has tax consequences. And a scan that
 * keeps PRD F03's promise: no platform fee anywhere in the payment code.
 */

import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env["PAYMENTS_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");

const { formEncode, parseStripeEvent, stripeKeyMode, verifyStripeSignature } = await import("../src/services/payments/stripe.js");
const { parseRazorpayEvent, razorpayKeyMode, verifyRazorpaySignature } = await import("../src/services/payments/razorpay.js");
const { parseLemonEvent, verifyLemonSignature } = await import("../src/services/payments/lemonsqueezy.js");
const { chooseGateway, countryFrom, countryFromIp, resolveCountry } = await import("../src/services/payments/gatewayRouter.js");
const { currencyFor, preferredCurrency, tierAmount } = await import("../src/services/payments/prices.js");
const { unusedCredit } = await import("../src/services/payments/apply.js");
const { razorpayAdapter } = await import("../src/services/payments/razorpay.js");
const { lemonSqueezyAdapter } = await import("../src/services/payments/lemonsqueezy.js");
const { open, openJson, seal, sealJson } = await import("../src/lib/secretBox.js");

const credentials = (gateway: "stripe" | "razorpay" | "lemonsqueezy", options: Record<string, unknown> = {}) => ({
  gateway,
  mode: "test" as const,
  publicId: null,
  secrets: {},
  webhookSecret: null,
  options,
});

describe("secretBox", () => {
  it("round-trips, and two seals of one value differ", () => {
    const a = seal("sk_test_123");
    const b = seal("sk_test_123");
    expect(a).not.toBe(b);
    expect(open(a)).toBe("sk_test_123");
    expect(openJson(sealJson({ secretKey: "x" }))).toEqual({ secretKey: "x" });
  });

  it("refuses a tampered value rather than decrypting it to something else", () => {
    const parts = seal("sk_test_123").split(".");
    const flipped = Buffer.from(parts[3]!, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    parts[3] = flipped.toString("base64");
    expect(() => open(parts.join("."))).toThrow();
  });
});

describe("Stripe", () => {
  const secret = "whsec_test";
  const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "invoice.paid" }));
  const sign = (payload: Buffer, timestamp: number, key = secret) =>
    `t=${timestamp},v1=${createHmac("sha256", key).update(`${timestamp}.${payload.toString()}`).digest("hex")}`;

  it("accepts a correct signature from any of the candidate secrets", () => {
    const now = 1_700_000_000;
    expect(verifyStripeSignature(body, sign(body, now), [secret], now)).toBe(true);
    expect(verifyStripeSignature(body, sign(body, now, "whsec_cli"), ["whsec_other", "whsec_cli"], now)).toBe(true);
  });

  it("refuses a wrong secret, an edited body, and an old signature", () => {
    const now = 1_700_000_000;
    expect(verifyStripeSignature(body, sign(body, now, "whsec_wrong"), [secret], now)).toBe(false);
    expect(verifyStripeSignature(Buffer.from(body.toString() + " "), sign(body, now), [secret], now)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, now - 301), [secret], now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, [secret], now)).toBe(false);
  });

  it("knows a test key from a live one and from a publishable one", () => {
    expect(stripeKeyMode("sk_test_abc")).toBe("test");
    expect(stripeKeyMode("rk_live_abc")).toBe("live");
    expect(stripeKeyMode("pk_test_abc")).toBeNull();
  });

  it("form-encodes nested params the way Stripe reads them", () => {
    const encoded = formEncode({ line_items: [{ price: "price_1", quantity: 1 }], metadata: { a: "b" }, events: ["x", "y"] });
    expect(encoded).toContain("line_items%5B0%5D%5Bprice%5D=price_1");
    expect(encoded).toContain("metadata%5Ba%5D=b");
    expect(encoded).toContain("events%5B%5D=x");
  });

  it("activates a paid subscription checkout, and ignores an unpaid one", () => {
    const paid = parseStripeEvent({
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: "chk_1", subscription: "sub_1", customer: "cus_1" } },
    });
    expect(paid).toEqual([expect.objectContaining({ action: "activate", checkoutId: "chk_1", externalId: "sub_1", onlyFor: "recurring" })]);

    const unpaid = parseStripeEvent({
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", payment_status: "unpaid", client_reference_id: "chk_1", subscription: "sub_1" } },
    });
    expect(unpaid).toEqual([]);
  });

  it("activates a one-time purchase keyed by its payment intent, with the payment", () => {
    const [event] = parseStripeEvent({
      type: "checkout.session.completed",
      data: { object: { mode: "payment", payment_status: "paid", client_reference_id: "chk_2", payment_intent: "pi_1", amount_total: 29900, currency: "usd" } },
    });
    expect(event).toMatchObject({ action: "activate", externalId: "pi_1", onlyFor: "lifetime" });
    expect(event?.payment).toMatchObject({ amountMinor: 29900, currency: "USD" });
  });

  it("reads the subscription off an invoice in both API shapes", () => {
    const old = parseStripeEvent({ type: "invoice.paid", data: { object: { id: "in_1", subscription: "sub_1", amount_paid: 900, currency: "usd" } } });
    const basil = parseStripeEvent({
      type: "invoice.paid",
      data: { object: { id: "in_2", parent: { subscription_details: { subscription: "sub_2" } }, amount_paid: 900, currency: "usd" } },
    });
    expect(old[0]).toMatchObject({ action: "renewed", externalId: "sub_1" });
    expect(basil[0]).toMatchObject({ action: "renewed", externalId: "sub_2" });
  });

  it("maps subscription updates to scheduled cancel, failure, resume, and end", () => {
    const sub = (fields: Record<string, unknown>) =>
      parseStripeEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1", ...fields } } })[0]?.action;
    expect(sub({ status: "active", cancel_at_period_end: true })).toBe("cancel_scheduled");
    expect(sub({ status: "past_due" })).toBe("payment_failed");
    expect(sub({ status: "active", cancel_at_period_end: false })).toBe("resumed");
    expect(sub({ status: "canceled" })).toBe("ended");
  });

  it("ends a lifetime purchase only on a full refund", () => {
    expect(parseStripeEvent({ type: "charge.refunded", data: { object: { refunded: true, payment_intent: "pi_1" } } })[0]?.action).toBe("refunded");
    expect(parseStripeEvent({ type: "charge.refunded", data: { object: { refunded: false, payment_intent: "pi_1" } } })).toEqual([]);
  });
});

describe("Razorpay", () => {
  const body = Buffer.from(JSON.stringify({ event: "order.paid" }));

  it("verifies the hex HMAC of the raw body", () => {
    const signature = createHmac("sha256", "rzp_hook").update(body).digest("hex");
    expect(verifyRazorpaySignature(body, signature, ["rzp_hook"])).toBe(true);
    expect(verifyRazorpaySignature(body, signature, ["other"])).toBe(false);
    expect(verifyRazorpaySignature(body, "zz", ["rzp_hook"])).toBe(false);
  });

  it("knows its key modes", () => {
    expect(razorpayKeyMode("rzp_test_1")).toBe("test");
    expect(razorpayKeyMode("rzp_live_1")).toBe("live");
    expect(razorpayKeyMode("key")).toBeNull();
  });

  it("activates a subscription from its notes, and a lifetime order from its own", () => {
    const [sub] = parseRazorpayEvent({
      event: "subscription.activated",
      payload: { subscription: { entity: { id: "sub_r1", current_end: 1_800_000_000, notes: { mf_checkout_id: "chk_r" }, short_url: "https://rzp.io/x" } } },
    });
    expect(sub).toMatchObject({ action: "activate", checkoutId: "chk_r", externalId: "sub_r1", onlyFor: "recurring", manageUrl: "https://rzp.io/x" });

    const [order] = parseRazorpayEvent({
      event: "order.paid",
      payload: { order: { entity: { id: "order_1", notes: { mf_checkout_id: "chk_o" } } }, payment: { entity: { id: "pay_1", amount: 99900, currency: "INR" } } },
    });
    expect(order).toMatchObject({ action: "activate", externalId: "order_1", onlyFor: "lifetime" });
    expect(order?.payment).toMatchObject({ externalId: "pay_1", amountMinor: 99900, currency: "INR" });
  });

  it("treats a halted subscription as ended and a pending one as a failed payment", () => {
    const of = (event: string) => parseRazorpayEvent({ event, payload: { subscription: { entity: { id: "sub_r1" } } } })[0]?.action;
    expect(of("subscription.pending")).toBe("payment_failed");
    expect(of("subscription.halted")).toBe("ended");
    expect(of("subscription.cancelled")).toBe("ended");
  });
});

describe("Lemon Squeezy", () => {
  it("verifies X-Signature", () => {
    const body = Buffer.from("{}");
    const signature = createHmac("sha256", "lemon").update(body).digest("hex");
    expect(verifyLemonSignature(body, signature, ["lemon"])).toBe(true);
    expect(verifyLemonSignature(body, signature, ["nope"])).toBe(false);
  });

  it("activates a subscription with the checkout from custom data", () => {
    const [event] = parseLemonEvent({
      meta: { event_name: "subscription_created", custom_data: { mf_checkout_id: "chk_l" } },
      data: { id: "77", attributes: { renews_at: "2026-12-01T00:00:00Z", urls: { customer_portal: "https://portal" } } },
    });
    expect(event).toMatchObject({ action: "activate", checkoutId: "chk_l", externalId: "77", onlyFor: "recurring", manageUrl: "https://portal" });
    expect(event?.currentPeriodEnd?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("lets order_created activate only a one-time purchase", () => {
    const [event] = parseLemonEvent({
      meta: { event_name: "order_created", custom_data: { mf_checkout_id: "chk_l" } },
      data: { id: "900", attributes: { status: "paid", total: 4900, currency: "EUR" } },
    });
    expect(event).toMatchObject({ action: "activate", onlyFor: "lifetime", externalId: "900" });
  });

  it("reads a cancel as scheduled, with the date access ends", () => {
    const [event] = parseLemonEvent({
      meta: { event_name: "subscription_cancelled" },
      data: { id: "77", attributes: { status: "cancelled", ends_at: "2026-11-01T00:00:00Z" } },
    });
    expect(event).toMatchObject({ action: "cancel_scheduled", externalId: "77" });
  });
});

describe("routing", () => {
  const all = [credentials("stripe"), credentials("razorpay"), credentials("lemonsqueezy", { monthlyVariantId: "1" })];
  const route = (country: string | null, overrides: Partial<Parameters<typeof chooseGateway>[0]> = {}) =>
    chooseGateway({ connected: all, interval: "month", currency: "USD", country, autoDetectGeolocation: true, defaultGateway: "", ...overrides })?.gateway;

  it("sends India to Razorpay, the VAT region to Lemon Squeezy, everyone else to Stripe", () => {
    expect(route("IN", { currency: "INR" })).toBe("razorpay");
    expect(route("DE")).toBe("lemonsqueezy");
    expect(route("GB")).toBe("lemonsqueezy");
    expect(route("US")).toBe("stripe");
  });

  it("uses the default gateway when routing is off or the country is unknown", () => {
    expect(route("IN", { currency: "INR", autoDetectGeolocation: false, defaultGateway: "stripe" })).toBe("stripe");
    expect(route(null, { currency: "INR", defaultGateway: "razorpay" })).toBe("razorpay");
  });

  it("skips a gateway that cannot sell this interval", () => {
    // Lemon Squeezy has no yearly variant linked, so a yearly EU buyer falls back.
    expect(route("FR", { interval: "year" })).toBe("stripe");
  });

  it("answers null when nothing connected can sell", () => {
    expect(chooseGateway({ connected: [], interval: "month", currency: "USD", country: "US", autoDetectGeolocation: true, defaultGateway: "" })).toBeNull();
  });

  it("does not send an Indian buyer to Razorpay without a rupee price", () => {
    // Razorpay sells INR. A tier priced only in dollars goes to Stripe instead.
    expect(route("IN", { currency: "USD" })).toBe("stripe");
  });

  it("keeps a Lemon Squeezy store to its own currency", () => {
    const store = credentials("lemonsqueezy", { monthlyVariantId: "1", storeCurrency: "USD" });
    expect(lemonSqueezyAdapter.canSell(store, "month", "USD")).toBe(true);
    expect(lemonSqueezyAdapter.canSell(store, "month", "EUR")).toBe(false);
    expect(razorpayAdapter.canSell(credentials("razorpay"), "year", "INR")).toBe(true);
    expect(razorpayAdapter.canSell(credentials("razorpay"), "year", "USD")).toBe(false);
  });

  it("finds a country from the buyer's IP when there is no CDN header", () => {
    expect(countryFromIp("49.36.0.1")).toBe("IN");
    expect(countryFromIp("8.8.8.8")).toBe("US");
    expect(countryFromIp("127.0.0.1")).toBeNull();
    expect(countryFromIp("not an ip")).toBeNull();
    expect(countryFromIp("1".repeat(200))).toBeNull();
  });

  it("honours the test country header only in test mode", () => {
    const request = { ip: "8.8.8.8", headers: { "x-memberframe-test-country": "in" } };
    expect(resolveCountry(request, true)).toBe("IN");
    expect(resolveCountry(request, false)).toBe("US");
  });

  it("reads the country from CDN headers and ignores unknown and Tor", () => {
    expect(countryFrom({ "cf-ipcountry": "in" })).toBe("IN");
    expect(countryFrom({ "cf-ipcountry": "XX" })).toBeNull();
    expect(countryFrom({ "cf-ipcountry": "T1" })).toBeNull();
    expect(countryFrom({})).toBeNull();
  });
});

describe("currencies, FP-16 section 6.2", () => {
  const tier = {
    currency: "USD",
    monthlyPriceMinor: 900,
    annualPriceMinor: 9000,
    lifetimePriceMinor: null,
    extraPrices: [
      { currency: "INR", interval: "month", amountMinor: 49900 },
      { currency: "INR", interval: "year", amountMinor: 499900 },
    ],
  };

  it("maps a country to the currency its buyers expect", () => {
    expect(preferredCurrency("IN")).toBe("INR");
    expect(preferredCurrency("DE")).toBe("EUR");
    expect(preferredCurrency("GB")).toBe("GBP");
    expect(preferredCurrency("BD")).toBeNull();
  });

  it("shows a buyer their currency only when the creator priced the tier in it", () => {
    expect(currencyFor(tier, "INR")).toBe("INR");
    expect(currencyFor(tier, "EUR")).toBe("USD");
    expect(currencyFor(tier, null)).toBe("USD");
  });

  it("reads each interval in the chosen currency, never converted", () => {
    expect(tierAmount(tier, "month", "INR")).toBe(49900);
    expect(tierAmount(tier, "month", "USD")).toBe(900);
    expect(tierAmount(tier, "lifetime", "INR")).toBeNull();
    expect(tierAmount(tier, "month", "GBP")).toBeNull();
  });
});

describe("credit for unused time on a switch", () => {
  const end = new Date("2026-11-16T00:00:00Z");

  it("credits the share of the period left", () => {
    // Half of a 31 day month left.
    const half = unusedCredit(1000, "month", end, new Date(end.getTime() - 15.5 * 86_400_000));
    expect(half).toBe(500);
  });

  it("credits nothing once the period is over, and never more than was paid", () => {
    expect(unusedCredit(1000, "month", end, new Date(end.getTime() + 1000))).toBe(0);
    expect(unusedCredit(1000, "month", end, new Date("2020-01-01T00:00:00Z"))).toBe(1000);
    expect(unusedCredit(1000, "lifetime", null)).toBe(0);
  });
});

describe("zero platform fee, PRD F03", () => {
  const roots = ["src/services/payments", "src/routes/payments.ts"];
  const files = roots.flatMap((root) => {
    const full = path.resolve(root);
    return root.endsWith(".ts") ? [full] : readdirSync(full).map((name) => path.join(full, name));
  });

  it("has no fee, commission, or transfer anywhere in the payment code", () => {
    for (const file of files) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const pattern of [/application_fee/i, /platform_?fee/i, /commission/i, /transfer_data/i, /on_behalf_of/i]) {
        expect(code, `${path.basename(file)} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
