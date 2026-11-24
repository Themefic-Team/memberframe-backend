/**
 * Which plans are sold (ENABLE_<PLAN>_PLAN) and each plan's own discount
 * (<PLAN>_DISCOUNT_CODE, a Stripe promotion code), as Hydra Booking reads them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: { pluginSubscription: { count: async () => 0 } } }));

const { env, planEnabledEnv, discountCodeEnv } = await import("../src/config/env.js");
const { plansView, assertSold, promoFits, discountedMinor, resetBillingCaches } = await import("../src/services/license/billingService.js");

const billing = env.billing as unknown as {
  stripeSecretKey: string;
  prices: Record<string, string>;
  enabled: Record<string, boolean>;
  discounts: Record<string, string | null>;
};

const PRICES: Record<string, Record<string, unknown>> = {
  price_m: { unit_amount: 499, currency: "usd", product: "prod_m", recurring: { interval: "month" } },
  price_y: { unit_amount: 4999, currency: "usd", product: "prod_y", recurring: { interval: "year" } },
  price_l: { unit_amount: 9999, currency: "usd", product: "prod_l", recurring: null },
};

/** Stripe: the three prices, and LTD50 as 50% off limited to the Lifetime product. */
function stripe() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    const price = u.pathname.match(/^\/v1\/prices\/(.+)$/);
    if (price) {
      const body = PRICES[decodeURIComponent(price[1]!)];
      return new Response(JSON.stringify(body ?? { error: { code: "resource_missing", message: "No such price" } }), { status: body ? 200 : 404 });
    }
    if (u.pathname === "/v1/promotion_codes") {
      const code = u.searchParams.get("code");
      const data = code === "LTD50" ? [{ id: "promo_1", code: "LTD50", coupon: { percent_off: 50, amount_off: null, applies_to: { products: ["prod_l"] } } }] : [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  return asked;
}

beforeEach(() => {
  billing.stripeSecretKey = "sk_test_x";
  billing.prices = { monthly: "price_m", yearly: "price_y", lifetime: "price_l" };
  billing.enabled = { monthly: true, yearly: true, lifetime: true };
  billing.discounts = { monthly: null, yearly: null, lifetime: null };
  resetBillingCaches();
});
afterEach(() => vi.unstubAllGlobals());

describe("the env switches", () => {
  it("sells a plan unless it is switched off, under any of the shared names", () => {
    expect(planEnabledEnv("YEARLY", {})).toBe(true);
    expect(planEnabledEnv("YEARLY", { ENABLE_YEARLY_PLAN: "" })).toBe(true);
    for (const on of ["yes", "TRUE", "1", "on", "enabled"]) expect(planEnabledEnv("YEARLY", { ENABLE_YEARLY_PLAN: on })).toBe(true);
    for (const off of ["no", "false", "0", "off", "maybe"]) expect(planEnabledEnv("YEARLY", { ENABLE_YEARLY_PLAN: off })).toBe(false);
    expect(planEnabledEnv("LIFETIME", { LIFETIME_PLAN_ENABLED: "no" })).toBe(false);
    expect(planEnabledEnv("MONTHLY", { PLAN_MONTHLY_ENABLED: "no" })).toBe(false);
  });

  it("reads a discount code, and treats empty, none, or false as none", () => {
    expect(discountCodeEnv("LIFETIME_DISCOUNT_CODE", { LIFETIME_DISCOUNT_CODE: " LTD50 " })).toBe("LTD50");
    for (const off of ["", "null", "none", "FALSE", "0", "undefined"]) expect(discountCodeEnv("LIFETIME_DISCOUNT_CODE", { LIFETIME_DISCOUNT_CODE: off })).toBeNull();
    expect(discountCodeEnv("LIFETIME_DISCOUNT_CODE", {})).toBeNull();
  });
});

describe("discount arithmetic", () => {
  it("takes a percent or an amount off, never below zero", () => {
    expect(discountedMinor(9999, { percentOff: 50, amountOffMinor: null })).toBe(5000);
    expect(discountedMinor(499, { percentOff: null, amountOffMinor: 100 })).toBe(399);
    expect(discountedMinor(499, { percentOff: null, amountOffMinor: 1000 })).toBe(0);
    expect(discountedMinor(499, null)).toBe(499);
  });

  it("fits a plan when the coupon names its product, or names none", () => {
    expect(promoFits({ products: ["prod_l"] }, { productId: "prod_l" })).toBe(true);
    expect(promoFits({ products: ["prod_l"] }, { productId: "prod_m" })).toBe(false);
    expect(promoFits({ products: null }, { productId: "prod_m" })).toBe(true);
    expect(promoFits({ products: [] }, { productId: "prod_m" })).toBe(true);
  });
});

describe("the plans the panel is sent", () => {
  it("marks a switched off plan, which needs no price, and refuses to sell it", async () => {
    billing.enabled.yearly = false;
    billing.prices.yearly = "";
    stripe();
    const view = await plansView();
    expect(view.plans.map((plan) => [plan.id, plan.enabled])).toEqual([
      ["monthly", true],
      ["yearly", false],
      ["lifetime", true],
    ]);
    expect(() => assertSold("yearly")).toThrow("This plan is not currently available.");
    expect(() => assertSold("monthly")).not.toThrow();
  });

  it("shows a plan's own discount with the price it leaves, only on the product it is for", async () => {
    billing.discounts.lifetime = "LTD50";
    billing.discounts.monthly = "LTD50"; // limited to Lifetime: left out of Monthly
    stripe();
    const view = await plansView();
    const byId = Object.fromEntries(view.plans.map((plan) => [plan.id, plan]));
    expect(byId["lifetime"]!.discount).toEqual({ code: "LTD50", percentOff: 50, amountOffMinor: null, amountMinor: 5000 });
    expect(byId["monthly"]!.discount).toBeNull();
    expect(byId["yearly"]!.discount).toBeNull();
  });

  it("leaves out a discount code Stripe does not know, instead of failing", async () => {
    billing.discounts.lifetime = "NOPE";
    stripe();
    const view = await plansView();
    expect(view.plans.find((plan) => plan.id === "lifetime")!.discount).toBeNull();
  });
});
