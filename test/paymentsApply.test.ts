/**
 * FP-16: what a payment event does to a member, run end to end against an
 * in-memory stand-in for the tables `apply.ts` touches.
 *
 * The rule under test, from `apply.ts`: a member holds the highest-ranked
 * tier among their running subscriptions in the site's current mode, a tier
 * granted by hand survives, and a test purchase grants nothing once live.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
const tables: Record<string, Row[]> = {};
let sequence = 0;

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Record<string, unknown>[]).some((option) => matches(row, option))) return false;
      continue;
    }
    if (key.includes("_") && condition && typeof condition === "object" && !("in" in condition) && !("not" in condition) && !("lt" in condition)) {
      if (!matches(row, condition as Record<string, unknown>)) return false;
      continue;
    }
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ("in" in c && !(c["in"] as unknown[]).includes(value)) return false;
      if ("not" in c && value === c["not"]) return false;
      if ("lt" in c && !(value instanceof Date && value < (c["lt"] as Date))) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function table(name: string) {
  tables[name] ??= [];
  const rows = () => tables[name]!;
  return {
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((row) => matches(row, where))),
    findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => rows().find((row) => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows().find((row) => matches(row, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${name}_${++sequence}`, createdAt: new Date(Date.now() + sequence), cancelAtPeriodEnd: false, gracePeriodEndsAt: null, endedAt: null, ...data } as Row;
      rows().push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows().find((entry) => matches(entry, where));
      if (!row) throw new Error(`no ${name} row`);
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows().filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const row = rows().find((entry) => matches(entry, where));
      if (row) return Object.assign(row, update);
      const created = { id: `${name}_${++sequence}`, ...create } as Row;
      rows().push(created);
      return created;
    }),
  };
}

const prisma = {
  subscription: table("subscription"),
  member: table("member"),
  tier: table("tier"),
  checkout: table("checkout"),
  payment: table("payment"),
  paymentSettings: table("paymentSettings"),
};

vi.mock("../src/config/db.js", () => ({ prisma }));

const cancelNow = vi.fn(async () => undefined);
const refund = vi.fn(async () => undefined);
vi.mock("../src/services/payments/gatewayStore.js", () => ({
  ADAPTERS: { stripe: { cancelNow, refund, periodEnd: async () => new Date("2026-12-01T00:00:00Z") } },
  loadCredentials: async () => null,
  loadPaymentSettings: async () => ({ mode: tables["paymentSettings"]?.[0]?.["mode"] ?? "test", graceDays: 3 }),
}));

const { applyPaymentEvent, endTestSubscriptions, sweepExpired } = await import("../src/services/payments/apply.js");
const { paymentEvent } = await import("../src/services/payments/types.js");

const SITE = "site_1";
const stripe = { gateway: "stripe" as const, mode: "test" as const, publicId: null, secrets: {}, webhookSecret: null, options: {} };

function member() {
  return tables["member"]!.find((row) => row.id === "member_1")!;
}

function checkout(id: string, tierKey: string, interval = "month") {
  tables["checkout"]!.push({ id, siteId: SITE, memberId: "member_1", tierKey, interval, gateway: "stripe", mode: "test", state: "open", externalId: null } as Row);
}

beforeEach(() => {
  for (const name of Object.keys(tables)) tables[name] = [];
  sequence = 0;
  cancelNow.mockClear();
  refund.mockClear();
  tables["member"] = [{ id: "member_1", siteId: SITE, activeTier: "free_member", status: "active" }];
  tables["tier"] = [
    { id: "t0", siteId: SITE, key: "free_member", name: "Free", rank: 0, currency: "USD", monthlyPriceMinor: null, annualPriceMinor: null, lifetimePriceMinor: null },
    { id: "t1", siteId: SITE, key: "tier_1", name: "Silver", rank: 1, currency: "USD", monthlyPriceMinor: 900, annualPriceMinor: 9000, lifetimePriceMinor: null },
    { id: "t2", siteId: SITE, key: "tier_2", name: "Gold", rank: 2, currency: "USD", monthlyPriceMinor: 1900, annualPriceMinor: 19000, lifetimePriceMinor: null },
    { id: "t3", siteId: SITE, key: "vip", name: "VIP", rank: 3, currency: "USD", monthlyPriceMinor: null, annualPriceMinor: null, lifetimePriceMinor: 29900 },
  ];
});

const activate = (checkoutId: string, externalId: string, onlyFor: "recurring" | "lifetime" = "recurring") =>
  applyPaymentEvent(SITE, stripe, paymentEvent("activate", "checkout.session.completed", { checkoutId, externalId, onlyFor }));

describe("buying", () => {
  it("moves the member to the tier they paid for, and completes the checkout", async () => {
    checkout("chk_1", "tier_2");
    await activate("chk_1", "sub_1");

    expect(member()).toMatchObject({ activeTier: "tier_2", status: "active" });
    expect(tables["checkout"]![0]).toMatchObject({ state: "complete" });
    expect(tables["subscription"]![0]).toMatchObject({ tierKey: "tier_2", status: "active", amountMinor: 1900 });
    // The period end was fetched from the gateway, since the event had none.
    expect((tables["subscription"]![0]!["currentPeriodEnd"] as Date).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("applies the same activation twice as once", async () => {
    checkout("chk_1", "tier_2");
    await activate("chk_1", "sub_1");
    await activate("chk_1", "sub_1");
    expect(tables["subscription"]).toHaveLength(1);
  });

  it("ignores an event for a checkout this site never started", async () => {
    await activate("chk_unknown", "sub_x");
    expect(member()).toMatchObject({ activeTier: "free_member" });
    expect(tables["subscription"]).toHaveLength(0);
  });

  it("activates from a renewal that arrives before the checkout's own event", async () => {
    checkout("chk_1", "tier_1");
    await applyPaymentEvent(SITE, stripe, paymentEvent("renewed", "invoice.paid", { checkoutId: "chk_1", externalId: "sub_1" }));
    expect(member()).toMatchObject({ activeTier: "tier_1" });
  });

  it("treats a new tier as a switch: the old recurring plan ends, a lifetime one does not", async () => {
    checkout("chk_1", "tier_1");
    await activate("chk_1", "sub_silver");
    checkout("chk_2", "tier_2");
    await activate("chk_2", "sub_gold");

    expect(member()).toMatchObject({ activeTier: "tier_2" });
    // Same gateway and mode: the old plan is cancelled at Stripe so it stops billing.
    expect(cancelNow).toHaveBeenCalledWith(stripe, "sub_silver");
    expect(tables["subscription"]!.find((row) => row["externalId"] === "sub_silver")).toMatchObject({ status: "ended" });

    checkout("chk_3", "vip", "lifetime");
    await activate("chk_3", "pi_vip", "lifetime");
    checkout("chk_4", "tier_1");
    await activate("chk_4", "sub_silver_2");
    // VIP outranks Silver and the lifetime purchase was not ended by the switch.
    expect(member()).toMatchObject({ activeTier: "vip" });
  });
});

describe("switching plans", () => {
  it("refunds the unused time on the plan being left", async () => {
    checkout("chk_1", "tier_1");
    await applyPaymentEvent(
      SITE,
      stripe,
      paymentEvent("activate", "checkout.session.completed", {
        checkoutId: "chk_1",
        externalId: "sub_silver",
        onlyFor: "recurring",
        currentPeriodEnd: new Date(Date.now() + 15 * 86_400_000),
      })
    );
    const silver = tables["subscription"]!.find((row) => row["externalId"] === "sub_silver")!;
    tables["payment"]!.push({ id: "pay_1", subscriptionId: silver.id, status: "paid", amountMinor: 3000, currency: "USD", externalId: "in_1", paidAt: new Date() } as never);

    checkout("chk_2", "tier_2");
    await activate("chk_2", "sub_gold");

    expect(refund).toHaveBeenCalledTimes(1);
    const [, paymentId, amount] = refund.mock.calls[0] as unknown as [unknown, string, number];
    expect(paymentId).toBe("in_1");
    // About half of a month left on a 30 unit payment.
    expect(amount).toBeGreaterThan(1200);
    expect(amount).toBeLessThan(1800);
    expect(member()).toMatchObject({ activeTier: "tier_2" });
  });
});

describe("after buying", () => {
  beforeEach(async () => {
    checkout("chk_1", "tier_2");
    await activate("chk_1", "sub_1");
  });

  it("starts the grace window on a failed renewal and keeps the tier", async () => {
    await applyPaymentEvent(SITE, stripe, paymentEvent("payment_failed", "invoice.payment_failed", { externalId: "sub_1" }));
    expect(member()).toMatchObject({ activeTier: "tier_2", status: "past_due" });
    const grace = tables["subscription"]![0]!["gracePeriodEndsAt"] as Date;
    expect(grace.getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
  });

  it("clears past_due when the retry is paid", async () => {
    await applyPaymentEvent(SITE, stripe, paymentEvent("payment_failed", "invoice.payment_failed", { externalId: "sub_1" }));
    await applyPaymentEvent(SITE, stripe, paymentEvent("renewed", "invoice.paid", { externalId: "sub_1" }));
    expect(member()).toMatchObject({ status: "active" });
    expect(tables["subscription"]![0]).toMatchObject({ status: "active", gracePeriodEndsAt: null });
  });

  it("keeps access through a scheduled cancel, then drops to Free when it ends", async () => {
    await applyPaymentEvent(SITE, stripe, paymentEvent("cancel_scheduled", "customer.subscription.updated", { externalId: "sub_1" }));
    expect(member()).toMatchObject({ activeTier: "tier_2", status: "canceled" });

    await applyPaymentEvent(SITE, stripe, paymentEvent("ended", "customer.subscription.deleted", { externalId: "sub_1" }));
    expect(member()).toMatchObject({ activeTier: "free_member", status: "active" });
  });

  it("ends past the period on the sweep, without waiting for the gateway", async () => {
    Object.assign(tables["subscription"]![0]!, { status: "canceling", currentPeriodEnd: new Date(Date.now() - 1000) });
    expect(await sweepExpired()).toBe(1);
    expect(member()).toMatchObject({ activeTier: "free_member" });
  });

  it("ends test purchases when the site goes live", async () => {
    expect(await endTestSubscriptions(SITE)).toBe(1);
    expect(member()).toMatchObject({ activeTier: "free_member" });
  });

  it("keeps a revoked member revoked when the gateway's late events arrive (doc 26)", async () => {
    // What revokeMemberAccess leaves behind: the plan ended, the member on Free and canceled.
    Object.assign(tables["subscription"]![0]!, { status: "ended", endedAt: new Date() });
    Object.assign(member(), { activeTier: "free_member", status: "canceled" });

    await applyPaymentEvent(SITE, stripe, paymentEvent("ended", "customer.subscription.deleted", { externalId: "sub_1" }));
    await applyPaymentEvent(SITE, stripe, paymentEvent("renewed", "invoice.paid", { externalId: "sub_1" }));
    await applyPaymentEvent(SITE, stripe, paymentEvent("cancel_scheduled", "customer.subscription.updated", { externalId: "sub_1" }));
    await sweepExpired();

    expect(member()).toMatchObject({ activeTier: "free_member", status: "canceled" });
    expect(tables["subscription"]![0]).toMatchObject({ status: "ended" });
  });

  it("leaves a tier granted by hand alone", async () => {
    await applyPaymentEvent(SITE, stripe, paymentEvent("ended", "customer.subscription.deleted", { externalId: "sub_1" }));
    Object.assign(member(), { activeTier: "vip" }); // the creator granted VIP in the Manage tab
    await sweepExpired();
    await endTestSubscriptions(SITE);
    expect(member()).toMatchObject({ activeTier: "vip" });
  });
});

describe("lifetime", () => {
  it("is granted with no period end and taken back by a refund", async () => {
    checkout("chk_v", "vip", "lifetime");
    await activate("chk_v", "pi_1", "lifetime");
    expect(member()).toMatchObject({ activeTier: "vip" });
    expect(tables["subscription"]![0]).toMatchObject({ interval: "lifetime", currentPeriodEnd: null });

    await applyPaymentEvent(SITE, stripe, paymentEvent("refunded", "charge.refunded", { externalId: "pi_1" }));
    expect(member()).toMatchObject({ activeTier: "free_member" });
  });

  it("is not activated by a subscription-only event", async () => {
    checkout("chk_v", "vip", "lifetime");
    await activate("chk_v", "sub_odd", "recurring");
    expect(member()).toMatchObject({ activeTier: "free_member" });
  });
});
