/**
 * The report arithmetic. Development doc:
 * memberframe/docs/development-docs/24-reports.md, section 1.3.
 *
 * MRR, net revenue, and grouping decide the numbers a creator runs their
 * business on, so each definition is pinned here: per currency, refunds out of
 * net, a yearly price over 12, lifetime not recurring.
 */

import { describe, expect, it } from "vitest";

const { lastTwelveMonths, monthKey, monthlyRecurring, periodStart, revenueBy, revenueTotals, PAYING_STATUSES } = await import(
  "../src/services/reportService.js"
);

const NOW = new Date("2026-10-18T12:00:00Z");

describe("periods", () => {
  it("starts 30 and 90 days back, a year back, or never", () => {
    expect(periodStart("30d", NOW)?.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect(periodStart("90d", NOW)?.toISOString()).toBe("2026-07-20T12:00:00.000Z");
    expect(periodStart("12m", NOW)?.toISOString()).toBe("2025-10-18T00:00:00.000Z");
    expect(periodStart("all", NOW)).toBeNull();
  });

  it("lists the last twelve months, oldest first, ending with this one", () => {
    const months = lastTwelveMonths(NOW);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2025-11");
    expect(months[11]).toBe("2026-10");
    expect(monthKey(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
  });
});

describe("MRR", () => {
  it("counts a monthly price as is and a yearly one over 12, and leaves lifetime out", () => {
    expect(
      monthlyRecurring([
        { interval: "month", amountMinor: 900, currency: "USD" },
        { interval: "year", amountMinor: 9900, currency: "USD" }, // 825 a month
        { interval: "lifetime", amountMinor: 29900, currency: "USD" },
      ])
    ).toEqual([{ currency: "USD", amountMinor: 1725 }]);
  });

  it("never adds two currencies together", () => {
    expect(
      monthlyRecurring([
        { interval: "month", amountMinor: 900, currency: "USD" },
        { interval: "month", amountMinor: 49900, currency: "INR" },
      ])
    ).toEqual([
      { currency: "USD", amountMinor: 900 },
      { currency: "INR", amountMinor: 49900 },
    ]);
  });

  it("counts running, retrying, and canceling-at-period-end subscriptions as paying", () => {
    expect([...PAYING_STATUSES]).toEqual(["active", "past_due", "canceling"]);
  });
});

describe("revenue", () => {
  const payments = [
    { amountMinor: 900, currency: "USD", status: "paid", gateway: "stripe", tier: "gold" },
    { amountMinor: 900, currency: "USD", status: "refunded", gateway: "stripe", tier: "gold" },
    { amountMinor: 9900, currency: "USD", status: "paid", gateway: "lemonsqueezy", tier: "pro" },
    { amountMinor: 49900, currency: "INR", status: "paid", gateway: "razorpay", tier: "gold" },
  ];

  it("takes refunds out of net, per currency", () => {
    expect(revenueTotals(payments)).toEqual([
      { currency: "USD", grossMinor: 11700, refundedMinor: 900, netMinor: 10800, payments: 3 },
      { currency: "INR", grossMinor: 49900, refundedMinor: 0, netMinor: 49900, payments: 1 },
    ]);
  });

  it("groups net revenue by any key, never across currencies", () => {
    expect(revenueBy(payments, (payment) => payment.tier)).toEqual([
      { key: "gold", currency: "USD", netMinor: 900, payments: 2 },
      { key: "pro", currency: "USD", netMinor: 9900, payments: 1 },
      { key: "gold", currency: "INR", netMinor: 49900, payments: 1 },
    ]);
  });
});
