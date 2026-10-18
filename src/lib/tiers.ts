/**
 * The Free tier. Development doc:
 * memberframe/docs/development-docs/23-dynamic-tiers.md
 *
 * A site has exactly one, and it is the tier at rank 0: ranks are unique per
 * site, so the rank says which tier it is without a column for it. It is found
 * by rank, never by key, because its key is whatever it was created with:
 * `free_member` on sites made before tiers were dynamic, `free` after, and
 * keys never change once saved.
 *
 * Every sign-up starts on it, and a member whose paid plan ends returns to it.
 */

import { prisma } from "../config/db.js";
import { rescaleMinor } from "./currencies.js";

export const FREE_TIER_RANK = 0;

/** The key a site made before dynamic tiers gave its Free tier, and the answer when a site has none. */
export const LEGACY_FREE_TIER_KEY = "free_member";

/** The key new sites give their Free tier: the ID made from its name. */
export const NEW_FREE_TIER_KEY = "free";

/** The site's Free tier key. */
export async function freeTierKey(siteId: string): Promise<string> {
  const tier = await prisma.tier.findFirst({ where: { siteId, rank: FREE_TIER_RANK }, select: { key: true } });
  return tier?.key ?? LEGACY_FREE_TIER_KEY;
}

/**
 * Move every tier to the site's new currency, keeping its numbers: 9.99 USD
 * becomes 9.99 EUR, or 10 JPY where the new currency has no decimals. Prices
 * in other currencies are deleted, since a site has one currency. Called when
 * Payments saves a changed site currency; the panel warns before that save.
 */
export async function switchTierCurrency(siteId: string, to: string): Promise<void> {
  const tiers = await prisma.tier.findMany({
    where: { siteId },
    select: { id: true, currency: true, monthlyPriceMinor: true, annualPriceMinor: true, lifetimePriceMinor: true },
  });
  const rescale = (amount: number | null, from: string) => (amount === null ? null : rescaleMinor(amount, from, to));

  await prisma.$transaction([
    ...tiers.map((tier) =>
      prisma.tier.update({
        where: { id: tier.id },
        data: {
          currency: to,
          monthlyPriceMinor: rescale(tier.monthlyPriceMinor, tier.currency),
          annualPriceMinor: rescale(tier.annualPriceMinor, tier.currency),
          lifetimePriceMinor: rescale(tier.lifetimePriceMinor, tier.currency),
        },
      })
    ),
    prisma.tierPrice.deleteMany({ where: { tierId: { in: tiers.map((tier) => tier.id) } } }),
  ]);
}

export interface TierPriceInput {
  monthlyPriceMinor: number | null;
  annualPriceMinor: number | null;
  lifetimePriceMinor: number | null;
}

/**
 * The Free tier (rank 0) has no prices; a paid tier (rank 1 and up) has at
 * least one. A reason the creator can act on, or null.
 */
export function tierPriceProblem(rank: number, prices: TierPriceInput): string | null {
  const priced = [prices.monthlyPriceMinor, prices.annualPriceMinor, prices.lifetimePriceMinor].some((value) => value !== null);
  if (rank === FREE_TIER_RANK && priced) return "free_tier_has_no_prices";
  if (rank !== FREE_TIER_RANK && !priced) return "paid_tier_needs_a_price";
  return null;
}
