/**
 * GET /api/preview: what components show on the Framer canvas.
 *
 * The property that matters is what it does not send. It is public and has a
 * wildcard CORS policy, so it must answer only with what the published site
 * already shows any visitor, and it must find the site by its public key and
 * nothing else.
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const findUnique = vi.fn();
vi.mock("../src/config/db.js", () => ({ prisma: { site: { findUnique } } }));
vi.mock("../src/services/payments/checkoutService.js", () => ({
  publicPricing: vi.fn(async () => ({
    mode: "test",
    pricingPath: "/pricing",
    afterPurchasePath: "/dashboard",
    tiers: [{ key: "tier_gold", name: "Gold", rank: 1, currency: "USD", prices: { month: 0, year: 9900, lifetime: 24900 }, purchasable: { month: false, year: true, lifetime: true } }],
  })),
}));
vi.mock("../src/services/assets/assetService.js", () => ({
  publicAsset: vi.fn(async (_site: string, id: string) => {
    if (id !== "asset_1") throw new Error("asset_not_found");
    return { asset: { id, name: "Figma kit", fileName: "kit.zip", mimeType: "application/zip", sizeBytes: 42, requiredTier: "tier_gold", requiredTierName: "Gold" }, access: "sign_in" };
  }),
}));
vi.mock("../src/services/settingsService.js", () => ({
  loadSiteSettings: vi.fn(async () => ({
    customFields: [{ key: "role", label: "Your role", type: "text", required: true, options: [], placeholder: "", order: 0, showWhen: null }],
  })),
}));

const { previewRouter } = await import("../src/routes/preview.js");

/** Run the router's GET / with a query, and read what it answered. */
async function call(query: Record<string, string>) {
  let status = 200;
  let body: unknown = null;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    end: () => res,
  } as unknown as Response;
  const req = { method: "GET", url: "/", path: "/", query, ip: `10.0.0.${Math.floor(Math.random() * 250)}`, header: () => undefined, headers: {} } as unknown as Request;

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    (res as unknown as { json: (value: unknown) => unknown }).json = (value: unknown) => {
      body = value;
      done();
      return res;
    };
    previewRouter(req, res, (error?: unknown) => {
      const e = error as { status?: number; reason?: string } | undefined;
      status = e?.status ?? 500;
      body = { error: e?.reason };
      done();
    });
  });
  return { status, body: body as Record<string, unknown>, headers };
}

describe("the canvas preview", () => {
  it("answers a known site key with its pricing, its profile questions, and nothing private", async () => {
    findUnique.mockResolvedValueOnce({ id: "site_1" });
    const { status, body, headers } = await call({ site: "pk_live_abc" });

    expect(status).toBe(200);
    expect(findUnique).toHaveBeenLastCalledWith({ where: { siteKey: "pk_live_abc" }, select: { id: true } });
    expect((body["pricing"] as { tiers: Array<{ name: string }> }).tiers.map((tier) => tier.name)).toEqual(["Gold"]);
    expect(body["profileFields"]).toEqual([
      { key: "role", label: "Your role", type: "text", required: true, options: [], placeholder: "", showWhen: null },
    ]);
    expect(body["asset"]).toBeNull();
    expect(headers["cache-control"]).toBe("public, max-age=15");
    expect(JSON.stringify(body)).not.toMatch(/secret|token|member|email|gateway/i);
  });

  it("includes one file's label and plan when asked", async () => {
    findUnique.mockResolvedValueOnce({ id: "site_1" });
    const { body } = await call({ site: "pk_live_abc", asset: "asset_1" });
    expect(body["asset"]).toMatchObject({ name: "Figma kit", requiredTierName: "Gold" });
  });

  it("answers an unknown file with no file, not an error", async () => {
    findUnique.mockResolvedValueOnce({ id: "site_1" });
    const { status, body } = await call({ site: "pk_live_abc", asset: "nope" });
    expect(status).toBe(200);
    expect(body["asset"]).toBeNull();
  });

  it("refuses an unknown or missing site key", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect((await call({ site: "pk_live_unknown" })).status).toBe(404);
    expect((await call({})).status).toBe(404);
  });
});
