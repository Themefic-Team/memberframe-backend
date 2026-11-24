/**
 * The creator's platform Stripe customer (19-pro-lock-and-trial.md). A stored
 * id the current Stripe account does not know ("No such customer", after the
 * keys moved between test and live mode or to another account) is replaced by
 * a fresh customer instead of failing every checkout; a known one is kept; and
 * a Stripe outage never replaces a good customer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const user = { stripeCustomerId: null as string | null };
const updates: Array<Record<string, unknown>> = [];

vi.mock("../src/config/db.js", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ stripeCustomerId: user.stripeCustomerId }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        user.stripeCustomerId = String(data["stripeCustomerId"]);
        return {};
      },
    },
  },
}));

const { env } = await import("../src/config/env.js");
const { billingPortalUrl } = await import("../src/services/license/billingService.js");

const owner = { id: "user_1", email: "creator@example.com", name: "Creator" };

type Reply = { status: number; body: Record<string, unknown> };
function stripe(reply: (method: string, path: string) => Reply) {
  const calls: Array<{ method: string; path: string; idempotency: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, idempotency: headers["Idempotency-Key"] ?? null });
    const answer = reply(method, path);
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  return calls;
}

const missing: Reply = { status: 404, body: { error: { code: "resource_missing", message: "No such customer: 'cus_old'" } } };
const portal: Reply = { status: 200, body: { url: "https://billing.stripe.com/session/x" } };

beforeEach(() => {
  (env.billing as { stripeSecretKey: string }).stripeSecretKey = "sk_test_x";
  user.stripeCustomerId = null;
  updates.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("the creator's Stripe customer", () => {
  it("keeps a stored customer Stripe still knows", async () => {
    user.stripeCustomerId = "cus_good";
    const calls = stripe((method, path) => (path === "/customers/cus_good" ? { status: 200, body: { id: "cus_good" } } : portal));
    await billingPortalUrl(owner);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /customers/cus_good", "POST /billing_portal/sessions"]);
    expect(updates).toEqual([]);
  });

  it("replaces a stored customer Stripe does not know, and saves the new one", async () => {
    user.stripeCustomerId = "cus_old";
    const calls = stripe((method, path) => {
      if (path === "/customers/cus_old") return missing;
      if (method === "POST" && path === "/customers") return { status: 200, body: { id: "cus_new" } };
      return portal;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await billingPortalUrl(owner);
    warn.mockRestore();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /customers/cus_old", "POST /customers", "POST /billing_portal/sessions"]);
    expect(calls[1]!.idempotency).toBe("customer-user_1-replaces-cus_old");
    expect(updates).toEqual([{ stripeCustomerId: "cus_new" }]);
  });

  it("replaces a customer that was deleted in Stripe", async () => {
    user.stripeCustomerId = "cus_deleted";
    stripe((method, path) => {
      if (path === "/customers/cus_deleted") return { status: 200, body: { id: "cus_deleted", deleted: true } };
      if (method === "POST" && path === "/customers") return { status: 200, body: { id: "cus_fresh" } };
      return portal;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await billingPortalUrl(owner);
    warn.mockRestore();
    expect(updates).toEqual([{ stripeCustomerId: "cus_fresh" }]);
  });

  it("never replaces a customer when Stripe itself fails", async () => {
    user.stripeCustomerId = "cus_good";
    stripe(() => ({ status: 500, body: { error: { message: "Stripe is down" } } }));
    await expect(billingPortalUrl(owner)).rejects.toThrow("Stripe is down");
    expect(updates).toEqual([]);
  });

  it("makes the first customer with the plain key", async () => {
    const calls = stripe((method, path) => (method === "POST" && path === "/customers" ? { status: 200, body: { id: "cus_first" } } : portal));
    await billingPortalUrl(owner);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/customers", idempotency: "customer-user_1" });
    expect(updates).toEqual([{ stripeCustomerId: "cus_first" }]);
  });
});
