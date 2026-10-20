/**
 * Fair plan changes (memberframe/docs/development-docs/30-plan-changes.md):
 * the upgrade credit, how each gateway takes it off the first charge, and the
 * downgrade waiting for the period end.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env["PAYMENTS_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");

const { isUpgrade, planChangeCredit, unusedCredit, MIN_DUE_MINOR } = await import("../src/services/payments/prices.js");
const { stripeAdapter } = await import("../src/services/payments/stripe.js");
const { lemonSqueezyAdapter } = await import("../src/services/payments/lemonsqueezy.js");
const { razorpayAdapter } = await import("../src/services/payments/razorpay.js");

const DAY = 86_400_000;

function credentials(gateway: "stripe" | "razorpay" | "lemonsqueezy", extra: Record<string, unknown> = {}) {
  return { gateway, mode: "test" as const, publicId: null, secrets: {}, webhookSecret: null, options: {}, ...extra };
}

/** Record every gateway call; answer each with `body`. */
function capture(body: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the upgrade credit", () => {
  const end = new Date("2027-10-20T00:00:00Z");

  it("is the unused share of the period: 100 a year with 360 days left is about 98.63", () => {
    const now = new Date(end.getTime() - 360 * DAY);
    // In minor units: 10000 (100.00) with 360 of 365 days left.
    expect(unusedCredit(10000, "year", end, now)).toBe(9863);
  });

  it("only upgrades get credit: a higher level, or the same level on a longer period", () => {
    expect(isUpgrade({ rank: 1, interval: "year" }, { rank: 2, interval: "year" })).toBe(true);
    expect(isUpgrade({ rank: 1, interval: "month" }, { rank: 1, interval: "year" })).toBe(true);
    expect(isUpgrade({ rank: 2, interval: "year" }, { rank: 1, interval: "year" })).toBe(false);
    expect(isUpgrade({ rank: 1, interval: "year" }, { rank: 1, interval: "month" })).toBe(false);
  });

  it("never leaves less than the minimum to pay, and is zero across currencies", () => {
    const now = new Date(end.getTime() - 360 * DAY);
    const base = { paidMinor: 10000, interval: "year", periodEnd: end, currency: "BDT", now };
    expect(planChangeCredit({ ...base, newCurrency: "BDT", newPriceMinor: 50000 })).toBe(9863);
    expect(planChangeCredit({ ...base, newCurrency: "BDT", newPriceMinor: 5000 })).toBe(5000 - MIN_DUE_MINOR);
    expect(planChangeCredit({ ...base, newCurrency: "USD", newPriceMinor: 50000 })).toBe(0);
  });
});

const spec = {
  siteId: "site",
  siteName: "Site",
  tierKey: "premium",
  tierName: "Premium",
  interval: "year" as const,
  amountMinor: 50000,
  currency: "BDT",
  checkoutId: "chk_0123456789abcdef",
  member: { id: "m1", email: "buyer@example.com", name: null },
  successUrl: "https://site.example/pricing",
  cancelUrl: "https://site.example/pricing",
  price: { externalId: "price_premium", externalProductId: null },
  customerId: null,
};

describe("Stripe", () => {
  const stripe = credentials("stripe", { secrets: { secretKey: "sk_test_x" } });

  it("takes the credit off the first charge with a one-time coupon, not promotion codes", async () => {
    const calls = capture({ id: "cpn_1", url: "https://checkout.stripe.com/x" });
    const result = await stripeAdapter.createCheckout(stripe, { ...spec, discountMinor: 9863 });
    expect(calls[0]!.url).toContain("/coupons");
    expect(decodeURIComponent(calls[0]!.body)).toContain("duration=once");
    expect(decodeURIComponent(calls[1]!.body)).toContain("discounts[0][coupon]=cpn_1");
    expect(calls[1]!.body).not.toContain("allow_promotion_codes");
    expect(result.discountApplied).toBe(9863);
  });

  it("starts the new period today on an in-place upgrade", async () => {
    const calls = capture({ items: { data: [{ id: "si_1" }] } });
    await stripeAdapter.changePlan!(stripe, "sub_1", { externalId: "price_premium", externalProductId: null }, true);
    expect(calls[1]!.body).toContain("billing_cycle_anchor=now");
    expect(calls[1]!.body).toContain("proration_behavior=always_invoice");
  });

  it("schedules a downgrade on the next invoice, with nothing charged now", async () => {
    const calls = capture({ items: { data: [{ id: "si_1" }] } });
    await stripeAdapter.scheduleChange!(stripe, "sub_1", { externalId: "price_standard", externalProductId: null });
    expect(calls[1]!.body).toContain("proration_behavior=none");
    expect(decodeURIComponent(calls[1]!.body)).toContain("items[0][price]=price_standard");
  });
});

describe("Lemon Squeezy", () => {
  it("gives the credit as a one-time discount code for this variant, keeping the full custom price", async () => {
    const store = credentials("lemonsqueezy", {
      publicId: "77",
      secrets: { apiKey: "key" },
      options: { yearlyVariantId: "555", storeCurrency: "BDT" },
    });
    const calls = capture({ data: { id: "co_1", attributes: { url: "https://store.lemonsqueezy.com/checkout/x" } } });
    const result = await lemonSqueezyAdapter.createCheckout(store, { ...spec, discountMinor: 9863 });
    const discount = JSON.parse(calls[0]!.body);
    expect(calls[0]!.url).toContain("/discounts");
    expect(discount.data.attributes).toMatchObject({ amount: 9863, amount_type: "fixed", duration: "once", max_redemptions: 1 });
    const checkout = JSON.parse(calls[1]!.body);
    expect(checkout.data.attributes.custom_price).toBe(50000);
    expect(checkout.data.attributes.checkout_data.discount_code).toBe(discount.data.attributes.code);
    expect(result.discountApplied).toBe(9863);
  });
});

describe("Razorpay", () => {
  it("schedules a downgrade at the cycle end", async () => {
    const calls = capture({});
    const keys = credentials("razorpay", { publicId: "rzp_test_1", secrets: { keySecret: "s" } });
    await razorpayAdapter.scheduleChange!(keys, "sub_1", { externalId: "plan_standard", externalProductId: null });
    expect(calls[0]!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ plan_id: "plan_standard", schedule_change_at: "cycle_end" });
  });
});

describe("after payment", () => {
  const apply = readFileSync(new URL("../src/services/payments/apply.ts", import.meta.url), "utf8");

  it("does not refund a credit already given as a discount, and switches a scheduled downgrade on renewal", () => {
    expect(apply).toContain("if ((checkout.creditMinor ?? 0) > 0) {");
    expect(apply).toContain("if (subscription.scheduledTierKey) {");
    expect(apply).toContain("scheduledTierKey: null,");
  });
});

describe("an active plan past its period end (a missed webhook)", () => {
  const future = Math.floor(Date.now() / 1000) + 30 * 86_400;

  it("asks Stripe and turns its answer into the webhook's event", async () => {
    const stripe = credentials("stripe", { secrets: { secretKey: "sk_test_x" } });
    capture({ status: "active", current_period_end: future });
    expect((await stripeAdapter.syncStatus!(stripe, "sub_1"))?.action).toBe("renewed");
    capture({ status: "past_due" });
    expect((await stripeAdapter.syncStatus!(stripe, "sub_1"))?.action).toBe("payment_failed");
    capture({ status: "canceled" });
    expect((await stripeAdapter.syncStatus!(stripe, "sub_1"))?.action).toBe("ended");
  });

  it("asks Lemon Squeezy and Razorpay the same way", async () => {
    const store = credentials("lemonsqueezy", { secrets: { apiKey: "key" } });
    capture({ data: { attributes: { status: "expired" } } });
    expect((await lemonSqueezyAdapter.syncStatus!(store, "77"))?.action).toBe("ended");
    capture({ data: { attributes: { status: "cancelled", ends_at: "2027-10-20T00:00:00Z" } } });
    expect((await lemonSqueezyAdapter.syncStatus!(store, "77"))?.action).toBe("cancel_scheduled");

    const keys = credentials("razorpay", { publicId: "rzp_test_1", secrets: { keySecret: "s" } });
    capture({ status: "halted" });
    expect((await razorpayAdapter.syncStatus!(keys, "sub_1"))?.action).toBe("ended");
    capture({ status: "pending" });
    expect((await razorpayAdapter.syncStatus!(keys, "sub_1"))?.action).toBe("payment_failed");
  });

  it("is checked by the sweep, applies only a renewal into a new period, and fails it after a day unanswered", () => {
    const apply = readFileSync(new URL("../src/services/payments/apply.ts", import.meta.url), "utf8");
    expect(apply).toContain("await reconcileOverdue(now)");
    expect(apply).toContain('if (credentials && event && (event.action !== "renewed" || renewedPastNow)) {');
    expect(apply).toContain('action: "payment_failed", type: "sync"');
  });
});
