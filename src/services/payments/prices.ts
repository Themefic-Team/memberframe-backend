/**
 * Which currency a buyer sees, and what a tier costs in it. FP-16 section 6.2.
 *
 * A tier has a base price list (its three price columns, in `tier.currency`)
 * and optional lists in other currencies (`tier_prices`). A buyer is shown a
 * tier in their own country's currency when the creator set prices in it,
 * otherwise in the base currency. Never a converted amount: a creator decides
 * what a plan costs in rupees, not an exchange rate.
 *
 * One currency per tier per buyer, all intervals together, so a card never
 * mixes rupees and dollars.
 */

import type { BillingInterval } from "./types.js";
import { countryCurrency } from "../../lib/currencies.js";

/** The currency a buyer from this country would expect, or null when the country is unknown. */
export function preferredCurrency(country: string | null): string | null {
  return country ? countryCurrency(country) : null;
}

export interface PricedTier {
  currency: string;
  monthlyPriceMinor: number | null;
  annualPriceMinor: number | null;
  lifetimePriceMinor: number | null;
  extraPrices: ReadonlyArray<{ currency: string; interval: string; amountMinor: number }>;
}

/** A tier's price for one interval in one currency, or null when it is not sold that way. */
export function tierAmount(tier: PricedTier, interval: BillingInterval, currency: string): number | null {
  let amount: number | null;
  if (currency === tier.currency) {
    amount =
      interval === "month" ? tier.monthlyPriceMinor : interval === "year" ? tier.annualPriceMinor : tier.lifetimePriceMinor;
  } else {
    amount = tier.extraPrices.find((price) => price.currency === currency && price.interval === interval)?.amountMinor ?? null;
  }
  return amount !== null && amount > 0 ? amount : null;
}

/** The currencies this tier has any price in, base first. */
export function tierCurrencies(tier: PricedTier): string[] {
  const out = [tier.currency];
  for (const price of tier.extraPrices) if (!out.includes(price.currency)) out.push(price.currency);
  return out;
}

/** The currency to show this buyer: theirs when the tier is priced in it, else the base. */
export function currencyFor(tier: PricedTier, preferred: string | null): string {
  if (preferred && preferred !== tier.currency && tier.extraPrices.some((price) => price.currency === preferred)) {
    return preferred;
  }
  return tier.currency;
}
