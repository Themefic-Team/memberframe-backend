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

// ============================================================================
// PLAN CHANGES (memberframe/docs/development-docs/30-plan-changes.md)
// ============================================================================

const INTERVAL_LENGTH: Record<string, number> = { month: 0, year: 1, lifetime: 2 };

/**
 * The unpaid-for share of what was paid for a period: what a member has not
 * used yet. Zero for lifetime, a period already over, or nothing paid.
 */
export function unusedCredit(paidMinor: number, interval: string, periodEnd: Date | null, now: Date = new Date()): number {
  if (!periodEnd || paidMinor <= 0 || (interval !== "month" && interval !== "year")) return 0;
  const start = new Date(periodEnd);
  if (interval === "month") start.setUTCMonth(start.getUTCMonth() - 1);
  else start.setUTCFullYear(start.getUTCFullYear() - 1);
  const length = periodEnd.getTime() - start.getTime();
  const left = periodEnd.getTime() - now.getTime();
  if (length <= 0 || left <= 0) return 0;
  return Math.floor(paidMinor * Math.min(1, left / length));
}

/**
 * Is moving from one plan to another an upgrade? A higher level is; the same
 * level on a longer period is. Anything else is a downgrade, which waits for
 * the end of the paid period.
 */
export function isUpgrade(current: { rank: number; interval: string }, next: { rank: number; interval: string }): boolean {
  if (next.rank !== current.rank) return next.rank > current.rank;
  return (INTERVAL_LENGTH[next.interval] ?? 0) > (INTERVAL_LENGTH[current.interval] ?? 0);
}

/** The smallest amount an upgrade still charges, so a gateway never sees a zero or near-zero charge. */
export const MIN_DUE_MINOR = 100;

/**
 * The credit an upgrade gets: the unused part of the current period, in the
 * same currency only, and never so much that less than MIN_DUE_MINOR is left
 * to pay.
 */
export function planChangeCredit(input: {
  paidMinor: number;
  interval: string;
  periodEnd: Date | null;
  currency: string;
  newCurrency: string;
  newPriceMinor: number;
  now?: Date;
}): number {
  if (input.currency.toUpperCase() !== input.newCurrency.toUpperCase()) return 0;
  const credit = unusedCredit(input.paidMinor, input.interval, input.periodEnd, input.now);
  return Math.max(0, Math.min(credit, input.newPriceMinor - MIN_DUE_MINOR));
}
