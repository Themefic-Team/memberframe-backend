/**
 * The currency list the routes accept, the country map buyers are shown
 * prices by, and Stripe's two-decimal exceptions for ISK and UGX.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_CURRENCIES,
  countryCurrency,
  currencySchema,
  fromStripeAmount,
  toStripeAmount,
} from "../src/lib/currencies.js";

describe("supported currencies", () => {
  it("accepts every circulating currency and refuses anything else", () => {
    for (const code of ["USD", "EUR", "GBP", "INR", "JPY", "KWD", "BDT", "BRL"]) {
      expect(currencySchema.safeParse(code).success).toBe(true);
    }
    for (const code of ["usd", "HRK", "XAU", "ABC", ""]) {
      expect(currencySchema.safeParse(code).success).toBe(false);
    }
  });

  it("maps every country only to a currency it accepts", () => {
    for (const country of ["US", "IN", "JP", "BD", "NG", "BR", "PR", "GL", "KW"]) {
      const currency = countryCurrency(country);
      expect(currency && SUPPORTED_CURRENCIES.has(currency)).toBe(true);
    }
    expect(countryCurrency("ZZ")).toBeNull();
  });

  // The plugin holds the same list with exponents. Checked when both
  // repositories sit side by side, as they do in development.
  const pluginList = path.join(process.cwd(), "..", "memberframe", "src", "utils", "currencies.ts");
  it.skipIf(!existsSync(pluginList))("holds the same codes as the plugin", () => {
    const codes = [...readFileSync(pluginList, "utf-8").matchAll(/^\s*\["([A-Z]{3})", "/gm)].map((match) => match[1]);
    expect(codes.sort()).toEqual([...SUPPORTED_CURRENCIES].sort());
  });
});

describe("Stripe amounts", () => {
  it("sends ISK and UGX as two-decimal values, and reads them back", () => {
    expect(toStripeAmount(5, "ISK")).toBe(500);
    expect(toStripeAmount(1500, "UGX")).toBe(150000);
    expect(fromStripeAmount(500, "isk")).toBe(5);
  });

  it("leaves every other currency as stored", () => {
    expect(toStripeAmount(999, "USD")).toBe(999);
    expect(toStripeAmount(500, "JPY")).toBe(500);
    expect(toStripeAmount(1234, "KWD")).toBe(1234);
    expect(fromStripeAmount(999, "usd")).toBe(999);
  });
});
