/**
 * Upgrades and the credit for unused time. F19, 19-pro-lock-and-trial.md 2.3.
 *
 * Moving up a plan credits what is left of the current one:
 *
 *   credit = paid × unused time / period length
 *   due    = new price − credit
 *
 * Monthly $4.99 upgraded to yearly on day 10 of a 30-day month: credit
 * 4.99 × 20/30 = $3.33, due $46.66. Monthly to yearly is charged by Stripe's
 * own proration (`always_invoice`), which this mirrors for the preview check;
 * a lifetime upgrade is a one-off payment, so its amount is computed here.
 *
 * Downgrades are not offered (product owner, 2026-10-18, as BEAF).
 */

import type { PlanId } from "./licenseService.js";

export const PLAN_RANK: Record<PlanId, number> = { monthly: 1, yearly: 2, lifetime: 3 };

/** Stripe refuses a charge below this (USD 50 cents). */
export const MIN_CHARGE_MINOR = 50;

export function isUpgrade(from: PlanId, to: PlanId): boolean {
  return PLAN_RANK[to] > PLAN_RANK[from];
}

/** The unused part of a paid period, in minor units, rounded to the nearest unit. */
export function unusedCreditMinor(paidMinor: number, periodStart: Date, periodEnd: Date, now: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (paidMinor <= 0 || total <= 0) return 0;
  const left = Math.min(Math.max(periodEnd.getTime() - now.getTime(), 0), total);
  return Math.round((paidMinor * left) / total);
}

export interface UpgradeQuote {
  allowed: boolean;
  reason?: "downgrade_not_allowed" | "same_plan";
  creditMinor: number;
  amountDueMinor: number;
}

export function upgradeQuote(input: {
  from: PlanId;
  to: PlanId;
  paidMinor: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  targetPriceMinor: number;
  now: Date;
}): UpgradeQuote {
  if (input.from === input.to) return { allowed: false, reason: "same_plan", creditMinor: 0, amountDueMinor: 0 };
  if (!isUpgrade(input.from, input.to)) {
    return { allowed: false, reason: "downgrade_not_allowed", creditMinor: 0, amountDueMinor: 0 };
  }

  // A lifetime plan has no period to credit; neither does a row with no dates.
  const credit =
    input.from !== "lifetime" && input.periodStart && input.periodEnd
      ? unusedCreditMinor(input.paidMinor, input.periodStart, input.periodEnd, input.now)
      : 0;
  const due = Math.max(input.targetPriceMinor - credit, MIN_CHARGE_MINOR);
  return { allowed: true, creditMinor: input.targetPriceMinor - due, amountDueMinor: due };
}

/** "Save 17%": what a year costs against twelve months, rounded. */
export function yearlySavingPercent(monthlyMinor: number, yearlyMinor: number): number {
  const twelve = monthlyMinor * 12;
  if (twelve <= 0 || yearlyMinor >= twelve) return 0;
  return Math.round(((twelve - yearlyMinor) / twelve) * 100);
}
