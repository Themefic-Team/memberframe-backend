/**
 * Dynamic tiers and one site currency. Development doc:
 * memberframe/docs/development-docs/23-dynamic-tiers.md
 *
 * The Free tier is the rank 0 tier and has no prices; a paid tier has one.
 * Changing the site currency keeps every tier's numbers.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();
const update = vi.fn((args: unknown) => args);
const deleteMany = vi.fn((args: unknown) => args);
const transaction = vi.fn(async (ops: unknown[]) => ops);
vi.mock("../src/config/db.js", () => ({
  prisma: { tier: { findFirst, findMany, update }, tierPrice: { deleteMany }, $transaction: transaction },
}));

const { freeTierKey, switchTierCurrency, tierPriceProblem, LEGACY_FREE_TIER_KEY } = await import("../src/lib/tiers.js");
const { currencyExponent, rescaleMinor, SUPPORTED_CURRENCIES } = await import("../src/lib/currencies.js");

const none = { monthlyPriceMinor: null, annualPriceMinor: null, lifetimePriceMinor: null };

describe("the Free tier", () => {
  it("is found by rank, so a renamed or newly keyed Free tier is still the one", async () => {
    findFirst.mockResolvedValueOnce({ key: "free" });
    expect(await freeTierKey("site_1")).toBe("free");
    expect(findFirst).toHaveBeenLastCalledWith({ where: { siteId: "site_1", rank: 0 }, select: { key: true } });
  });

  it("falls back to the legacy key on a site with no rank 0 tier", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await freeTierKey("site_1")).toBe(LEGACY_FREE_TIER_KEY);
  });

  it("has no prices, and a paid tier has at least one", () => {
    expect(tierPriceProblem(0, none)).toBeNull();
    expect(tierPriceProblem(0, { ...none, monthlyPriceMinor: 999 })).toBe("free_tier_has_no_prices");
    expect(tierPriceProblem(1, none)).toBe("paid_tier_needs_a_price");
    expect(tierPriceProblem(3, { ...none, lifetimePriceMinor: 24900 })).toBeNull();
  });
});

describe("one site currency", () => {
  it("keeps the numbers when the currency changes", () => {
    expect(rescaleMinor(999, "USD", "EUR")).toBe(999); // 9.99 stays 9.99
    expect(rescaleMinor(999, "USD", "JPY")).toBe(10); // 9.99 becomes 10
    expect(rescaleMinor(1500, "JPY", "USD")).toBe(150000); // 1500 stays 1500.00
    expect(rescaleMinor(999, "USD", "KWD")).toBe(9990); // 9.99 becomes 9.990
    expect(rescaleMinor(1, "USD", "JPY")).toBe(1); // never rounds a price away to zero
  });

  it("moves every tier and drops prices in other currencies", async () => {
    findMany.mockResolvedValueOnce([
      { id: "t0", currency: "USD", monthlyPriceMinor: null, annualPriceMinor: null, lifetimePriceMinor: null },
      { id: "t1", currency: "USD", monthlyPriceMinor: 999, annualPriceMinor: 9900, lifetimePriceMinor: null },
    ]);
    await switchTierCurrency("site_1", "JPY");

    expect(update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { currency: "JPY", monthlyPriceMinor: 10, annualPriceMinor: 99, lifetimePriceMinor: null },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "t0" },
      data: { currency: "JPY", monthlyPriceMinor: null, annualPriceMinor: null, lifetimePriceMinor: null },
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { tierId: { in: ["t0", "t1"] } } });
  });

  // The plugin parses typed prices with its own exponents. Checked when the
  // two repositories sit side by side, as they do in development.
  const pluginList = path.join(process.cwd(), "..", "memberframe", "src", "utils", "currencies.ts");
  it.skipIf(!existsSync(pluginList))("agrees with the plugin on every currency's decimals", () => {
    const source = readFileSync(pluginList, "utf-8");
    const set = (name: string) =>
      new Set([...(source.match(new RegExp(String.raw`const ${name} = new Set\(\[([^\]]*)\]`))?.[1] ?? "").matchAll(/"([A-Z]{3})"/g)].map((m) => m[1]));
    const zero = set("ZERO_DECIMAL");
    const three = set("THREE_DECIMAL");
    for (const code of SUPPORTED_CURRENCIES) {
      expect(`${code} ${currencyExponent(code)}`).toBe(`${code} ${zero.has(code) ? 0 : three.has(code) ? 3 : 2}`);
    }
  });
});
