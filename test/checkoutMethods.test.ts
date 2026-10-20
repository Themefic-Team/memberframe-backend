/**
 * Checkout methods (memberframe/docs/development-docs/29-checkout-methods.md):
 * which methods a buyer is offered, which is preselected, and what each is
 * called. The checkout and the chooser read the same list, so a method the
 * chooser shows is one the checkout will accept.
 */

import { describe, expect, it } from "vitest";

process.env["PAYMENTS_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");

const { availableMethods } = await import("../src/services/payments/gatewayRouter.js");
const { DEFAULT_METHOD_LABELS, readMethodLabels, resolveMethodLabel, methodLabelsSchema } = await import("../src/lib/methodLabels.js");

const credentials = (gateway: "stripe" | "razorpay" | "lemonsqueezy", options: Record<string, unknown> = {}) => ({
  gateway,
  mode: "test" as const,
  publicId: null,
  secrets: {},
  webhookSecret: null,
  options,
});

// A USD Lemon Squeezy store: it sells only USD prices.
const all = [credentials("razorpay"), credentials("lemonsqueezy", { monthlyVariantId: "1", storeCurrency: "USD" }), credentials("stripe")];

describe("availableMethods", () => {
  it("lists every method that can sell the price, the location's one first", () => {
    expect(availableMethods({ connected: all, interval: "month", currency: "USD", country: "DE" })).toEqual({
      methods: ["lemonsqueezy", "stripe", "razorpay"],
      recommended: "lemonsqueezy",
    });
    expect(availableMethods({ connected: all, interval: "month", currency: "USD", country: "US" }).methods).toEqual([
      "stripe",
      "lemonsqueezy",
      "razorpay",
    ]);
  });

  it("preselects Razorpay in India, and leaves out a Lemon Squeezy store in another currency", () => {
    expect(availableMethods({ connected: all, interval: "month", currency: "INR", country: "IN" })).toEqual({
      methods: ["razorpay", "stripe"],
      recommended: "razorpay",
    });
  });

  it("leaves out a method that cannot sell this period", () => {
    // Lemon Squeezy has no yearly variant, and Razorpay without Subscriptions sells lifetime only.
    const limited = [credentials("lemonsqueezy", { monthlyVariantId: "1" }), credentials("razorpay", { subscriptionsOff: "1" })];
    expect(availableMethods({ connected: limited, interval: "year", currency: "INR", country: "IN" }).methods).toEqual([]);
    expect(availableMethods({ connected: limited, interval: "lifetime", currency: "INR", country: "IN" }).methods).toEqual([
      "razorpay",
    ]);
  });

  it("preselects the first in the fixed order when the location's method is missing, and nothing when none sells", () => {
    expect(availableMethods({ connected: [credentials("stripe")], interval: "month", currency: "USD", country: "IN" })).toEqual({
      methods: ["stripe"],
      recommended: "stripe",
    });
    expect(availableMethods({ connected: [], interval: "month", currency: "USD", country: null })).toEqual({
      methods: [],
      recommended: null,
    });
  });
});

describe("method labels", () => {
  it("uses the creator's title and description, else the defaults", () => {
    const labels = readMethodLabels({ stripe: { title: " Card ", description: "" }, razorpay: "junk", lemonsqueezy: {} });
    expect(labels).toEqual({ stripe: { title: "Card" } });
    expect(resolveMethodLabel("stripe", labels)).toEqual({ title: "Card", description: DEFAULT_METHOD_LABELS.stripe.description });
    expect(resolveMethodLabel("razorpay", labels)).toEqual(DEFAULT_METHOD_LABELS.razorpay);
  });

  it("refuses an overlong title or description", () => {
    expect(methodLabelsSchema.safeParse({ stripe: { title: "x".repeat(61) } }).success).toBe(false);
    expect(methodLabelsSchema.safeParse({ stripe: { description: "x".repeat(141) } }).success).toBe(false);
    expect(methodLabelsSchema.safeParse({ stripe: { title: "Card" } }).success).toBe(true);
  });
});

describe("checkout rate limits (2026-10-20)", () => {
  it("give the methods call its own allowance, and the checkout a 10 minute window", async () => {
    const { readFileSync } = await import("node:fs");
    const routes = readFileSync(new URL("../src/routes/payments.ts", import.meta.url), "utf8");
    expect(routes).toContain("limit(req, `checkout-options:${session.member.memberId}`, 120);");
    expect(routes).toContain('limit(req, `checkout:${session.member.memberId}`, mode === "test" ? 60 : 30, 600);');
  });
});
