/**
 * Confirming a purchase by asking the gateway, for when no webhook arrives.
 *
 * The buyer's page polls checkout status after paying, and each poll asks the
 * gateway through `confirmCheckout`. These prove each gateway's answer turns
 * into the same events its webhooks would have sent, and that nothing unpaid
 * or unrelated activates anything.
 */

import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env["PAYMENTS_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");

const { stripeAdapter } = await import("../src/services/payments/stripe.js");
const { razorpayAdapter } = await import("../src/services/payments/razorpay.js");
const { lemonSqueezyAdapter } = await import("../src/services/payments/lemonsqueezy.js");
const { publicApiBase } = await import("../src/lib/publicApiBase.js");
const { env } = await import("../src/config/env.js");

type Routes = Record<string, unknown>;

/** Answer each request by the first route whose key the URL contains. */
function stubFetch(routes: Routes) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((candidate) => url.includes(candidate));
    const body = key ? routes[key] : { error: { message: "not stubbed" } };
    return new Response(JSON.stringify(body), { status: key ? 200 : 404 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const created = new Date("2026-10-16T04:50:00Z");

function pending(externalId: string, interval: "month" | "year" | "lifetime" = "month") {
  return { id: "chk_1", externalId, interval, createdAt: created, memberEmail: "buyer@example.com" };
}

function credentials(gateway: "stripe" | "razorpay" | "lemonsqueezy", extra: Partial<{ publicId: string; secrets: Record<string, string>; options: Record<string, unknown> }> = {}) {
  return {
    gateway,
    mode: "test" as const,
    publicId: extra.publicId ?? null,
    secrets: extra.secrets ?? {},
    webhookSecret: null,
    options: extra.options ?? {},
  };
}

describe("Stripe confirmCheckout", () => {
  const stripe = credentials("stripe", { secrets: { secretKey: "sk_test_x" } });

  it("activates a paid subscription session and records its first invoice", async () => {
    const calls = stubFetch({
      "/checkout/sessions/cs_test_1": {
        id: "cs_test_1",
        status: "complete",
        payment_status: "paid",
        mode: "subscription",
        client_reference_id: "chk_1",
        subscription: "sub_1",
        customer: "cus_1",
        invoice: {
          id: "in_1",
          status: "paid",
          subscription: "sub_1",
          amount_paid: 999,
          currency: "usd",
          status_transitions: { paid_at: 1_790_000_000 },
          lines: { data: [{ period: { end: 1_792_000_000 } }] },
        },
      },
    });

    const events = await stripeAdapter.confirmCheckout!(stripe, pending("cs_test_1"));

    expect(calls[0]).toContain("expand%5B%5D=invoice");
    expect(events.map((event) => event.action)).toEqual(["activate", "renewed"]);
    expect(events[0]).toMatchObject({ checkoutId: "chk_1", externalId: "sub_1", customerId: "cus_1" });
    expect(events[1]?.payment).toMatchObject({ externalId: "in_1", amountMinor: 999, currency: "USD" });
  });

  it("returns nothing while the session is open", async () => {
    stubFetch({ "/checkout/sessions/cs_test_2": { id: "cs_test_2", status: "open", payment_status: "unpaid", mode: "subscription" } });
    expect(await stripeAdapter.confirmCheckout!(stripe, pending("cs_test_2"))).toEqual([]);
  });

  it("returns nothing for a complete session that is not paid yet, such as a bank transfer", async () => {
    stubFetch({ "/checkout/sessions/cs_test_3": { id: "cs_test_3", status: "complete", payment_status: "unpaid", mode: "payment" } });
    expect(await stripeAdapter.confirmCheckout!(stripe, pending("cs_test_3", "lifetime"))).toEqual([]);
  });

  it("does not ask Stripe about an id that is not a session", async () => {
    const calls = stubFetch({});
    expect(await stripeAdapter.confirmCheckout!(stripe, pending("sub_1"))).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("Razorpay confirmCheckout", () => {
  const razorpay = credentials("razorpay", { publicId: "rzp_test_x", secrets: { keySecret: "s" } });

  it("activates a paid order with its captured payment", async () => {
    stubFetch({
      "/orders/order_1/payments": { items: [{ id: "pay_f", status: "failed" }, { id: "pay_1", status: "captured", amount: 49900, currency: "INR", created_at: 1_790_000_000 }] },
      "/orders/order_1": { id: "order_1", status: "paid", notes: { mf_checkout_id: "chk_1" } },
    });

    const events = await razorpayAdapter.confirmCheckout!(razorpay, pending("order_1", "lifetime"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "activate", checkoutId: "chk_1", externalId: "order_1", onlyFor: "lifetime" });
    expect(events[0]?.payment).toMatchObject({ externalId: "pay_1", amountMinor: 49900, currency: "INR" });
  });

  it("returns nothing for an order not yet paid", async () => {
    stubFetch({ "/orders/order_2": { id: "order_2", status: "attempted" } });
    expect(await razorpayAdapter.confirmCheckout!(razorpay, pending("order_2", "lifetime"))).toEqual([]);
  });

  it("activates an active subscription and records its paid invoice", async () => {
    stubFetch({
      "/invoices?subscription_id=sub_1": { items: [{ status: "paid", payment_id: "pay_9", amount_paid: 29900, currency: "INR", paid_at: 1_790_000_000 }] },
      "/subscriptions/sub_1": { id: "sub_1", status: "active", current_end: 1_792_000_000, notes: { mf_checkout_id: "chk_1" } },
    });

    const events = await razorpayAdapter.confirmCheckout!(razorpay, pending("sub_1"));

    expect(events.map((event) => event.action)).toEqual(["activate", "renewed"]);
    expect(events[0]).toMatchObject({ checkoutId: "chk_1", externalId: "sub_1" });
    expect(events[1]?.payment).toMatchObject({ externalId: "pay_9", amountMinor: 29900 });
  });

  it("does not activate a subscription that is only authenticated", async () => {
    stubFetch({ "/subscriptions/sub_2": { id: "sub_2", status: "authenticated", notes: { mf_checkout_id: "chk_1" } } });
    expect(await razorpayAdapter.confirmCheckout!(razorpay, pending("sub_2"))).toEqual([]);
  });
});

describe("Lemon Squeezy confirmCheckout", () => {
  const lemon = credentials("lemonsqueezy", {
    publicId: "1234",
    secrets: { apiKey: "k" },
    options: { monthlyVariantId: "11", oneTimeVariantId: "33" },
  });

  const order = (id: string, variant: string, at: string, status = "paid") => ({
    id,
    attributes: { status, created_at: at, total: 1500, currency: "USD", first_order_item: { variant_id: Number(variant) }, urls: { receipt: "https://r" } },
  });

  it("finds this buyer's paid order for the checkout's variant and activates a one-time purchase", async () => {
    const calls = stubFetch({
      "/orders?": {
        data: [
          order("o_old", "33", "2026-10-15T00:00:00Z"),
          order("o_other_variant", "11", "2026-10-16T04:51:00Z"),
          order("o_new", "33", "2026-10-16T04:51:30Z"),
        ],
      },
    });

    const events = await lemonSqueezyAdapter.confirmCheckout!(lemon, pending("lsc_1", "lifetime"));

    expect(decodeURIComponent(calls[0] ?? "")).toContain("filter[user_email]=buyer@example.com");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "activate", checkoutId: "chk_1", externalId: "o_new", onlyFor: "lifetime" });
  });

  it("ignores an order made before this checkout", async () => {
    stubFetch({ "/orders?": { data: [order("o_old", "33", "2026-10-15T00:00:00Z")] } });
    expect(await lemonSqueezyAdapter.confirmCheckout!(lemon, pending("lsc_1", "lifetime"))).toEqual([]);
  });

  it("ignores an order that is not paid", async () => {
    stubFetch({ "/orders?": { data: [order("o_p", "33", "2026-10-16T05:00:00Z", "pending")] } });
    expect(await lemonSqueezyAdapter.confirmCheckout!(lemon, pending("lsc_1", "lifetime"))).toEqual([]);
  });

  it("follows a subscription order to its subscription and first paid invoice", async () => {
    stubFetch({
      "/orders?": { data: [order("o_sub", "11", "2026-10-16T04:52:00Z")] },
      "/subscription-invoices?": { data: [{ id: "si_1", attributes: { status: "paid", subscription_id: 77, total: 1500, currency: "USD", created_at: "2026-10-16T04:52:00Z", urls: {} } }] },
      "/subscriptions?": { data: [{ id: "77", attributes: { renews_at: "2026-11-16T04:52:00Z", customer_id: 5, urls: { customer_portal: "https://p" } } }] },
    });

    const events = await lemonSqueezyAdapter.confirmCheckout!(lemon, pending("lsc_2", "month"));

    expect(events.map((event) => event.action)).toEqual(["activate", "renewed"]);
    expect(events[0]).toMatchObject({ checkoutId: "chk_1", externalId: "77", onlyFor: "recurring" });
    expect(events[1]?.payment).toMatchObject({ externalId: "si_1", amountMinor: 1500 });
  });
});

describe("publicApiBase, for webhook URLs while developing", () => {
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as Request;
  const local = /^https?:\/\/(127\.|localhost)/.test(env.apiBaseUrl);

  it.runIf(local)("uses the tunnel's https host when the API is configured on a loopback address", () => {
    expect(publicApiBase(request({ host: "abcd.ngrok-free.app", "x-forwarded-proto": "https" }))).toBe("https://abcd.ngrok-free.app");
  });

  it("keeps the configured address for a plain local request", () => {
    expect(publicApiBase(request({ host: "127.0.0.1:4001" }))).toBe(env.apiBaseUrl);
  });

  it("keeps the configured address when the request was not https", () => {
    expect(publicApiBase(request({ host: "abcd.ngrok-free.app", "x-forwarded-proto": "http" }))).toBe(env.apiBaseUrl);
  });

  it("refuses a host that is not a plain host name", () => {
    expect(publicApiBase(request({ host: "evil.example/path?x=", "x-forwarded-proto": "https" }))).toBe(env.apiBaseUrl);
  });
});
