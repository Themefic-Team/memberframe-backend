/**
 * A code typed in the payment dialog replaces the code already on a lifetime
 * payment (the plan's own, or an earlier one): worked out from the plan's
 * price, never stacked on the already lowered amount.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const row = { id: "row_1", plan: "lifetime", status: "incomplete", stripeSubscriptionId: null as string | null, stripePaymentIntentId: "pi_1", amountMinor: 5000, currency: "usd" };
const updates: Array<Record<string, unknown>> = [];

vi.mock("../src/config/db.js", () => ({
  prisma: {
    pluginSubscription: {
      findFirst: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
      count: async () => 0,
    },
  },
}));

const { env } = await import("../src/config/env.js");
const { applyCoupon, resetBillingCaches } = await import("../src/services/license/billingService.js");

const billing = env.billing as unknown as { stripeSecretKey: string; prices: Record<string, string>; enabled: Record<string, boolean> };
const owner = { id: "user_1", email: "creator@example.com", name: "Creator" };
const project = { siteId: "site_1", siteName: "Site" };

function stripe(intentMetadata: Record<string, string> = {}) {
  const posted: Array<{ path: string; body: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "POST") {
      posted.push({ path: u.pathname, body: decodeURIComponent(String(init?.body ?? "")) });
      return reply({ id: "pi_1", client_secret: "pi_1_secret_new" });
    }
    if (u.pathname.startsWith("/v1/prices/")) {
      const id = u.pathname.split("/").pop();
      return reply({ unit_amount: id === "price_l" ? 9999 : 499, currency: "usd", product: id === "price_l" ? "prod_l" : "prod_x", recurring: id === "price_l" ? null : { interval: "month" } });
    }
    if (u.pathname === "/v1/promotion_codes") {
      return reply({ data: [{ id: "promo_20", code: "TWENTY", coupon: { percent_off: 20, amount_off: null, applies_to: { products: ["prod_l"] } } }] });
    }
    if (u.pathname === "/v1/payment_intents/pi_1") return reply({ id: "pi_1", amount: 5000, metadata: intentMetadata });
    return reply({}, 404);
  });
  return posted;
}

beforeEach(() => {
  billing.stripeSecretKey = "sk_test_x";
  billing.prices = { monthly: "price_m", yearly: "price_y", lifetime: "price_l" };
  billing.enabled = { monthly: true, yearly: true, lifetime: true };
  updates.length = 0;
  resetBillingCaches();
});
afterEach(() => vi.unstubAllGlobals());

describe("a code typed on a lifetime payment", () => {
  it("takes its discount off the plan's price, replacing the 50% already on the payment", async () => {
    const posted = stripe();
    const result = await applyCoupon(owner, project, "TWENTY");
    // 20% off $99.99 is $79.99, not 20% off the $50.00 the plan's own code left.
    expect(result).toMatchObject({ amountDueMinor: 7999, complete: false, couponCode: "TWENTY" });
    expect(posted[0]!.path).toBe("/v1/payment_intents/pi_1");
    expect(posted[0]!.body).toContain("amount=7999");
    expect(updates).toEqual([{ amountMinor: 7999 }]);
  });

  it("keeps an upgrade's unused time credit off the new price", async () => {
    stripe({ credit_minor: "2000" });
    const result = await applyCoupon(owner, project, "TWENTY");
    expect(result.amountDueMinor).toBe(7999 - 2000);
  });
});
