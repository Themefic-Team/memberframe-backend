/**
 * Is this project licensed, and how? F19, development doc 19-pro-lock-and-trial.md.
 *
 * One answer for every caller: the plugin panel, the public `/api/license`
 * the canvas components read, and `requireActiveLicense` on the member API.
 * BEAF answered differently in the plugin and on the live site (`past_due`
 * was paid in one and locked in the other); here there is one decision.
 *
 * `decideLicense` is pure, so the whole matrix is testable without a
 * database. `resolveLicense` only gathers the rows it needs.
 */

import { prisma } from "../../config/db.js";

export type LicenseState = "trial" | "active" | "expired" | "trial_claimed_other_site" | "none";
export type PlanId = "monthly" | "yearly" | "lifetime";

/** Statuses that pay for the project, whatever the date (Stripe owns renewal). */
const PAYING = new Set(["active", "past_due", "paid"]);

/** Higher wins when a project holds more than one licensed row. */
const PLAN_RANK: Record<PlanId, number> = { monthly: 1, yearly: 2, lifetime: 3 };

export interface TrialRow {
  siteId: string;
  status: string;
  startedAt: Date;
  endsAt: Date;
  projectName: string;
}

export interface SubscriptionRow {
  id: string;
  plan: string;
  status: string;
  amountMinor: number;
  currency: string;
  startedAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
}

export interface LicenseView {
  state: LicenseState;
  /** "trial" while trialing; the plan while one is held; null otherwise. */
  plan: PlanId | "trial" | null;
  /** The subscription's own status: active, past_due, canceling, paid, ... */
  status: string | null;
  trialEndsAt: string | null;
  startedAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  amountMinor: number | null;
  currency: string | null;
  /** When the owner's trial is bound to another project: that project's name. */
  claimedProjectName: string | null;
  /** The subscription row behind `active`, for the billing routes. */
  subscriptionId: string | null;
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

const isPlan = (value: string): value is PlanId => value === "monthly" || value === "yearly" || value === "lifetime";

/** Does this row pay for the project right now? */
export function subscriptionLicenses(row: SubscriptionRow, now: Date): boolean {
  if (!isPlan(row.plan)) return false;
  if (PAYING.has(row.status)) return true;
  // Cancelled at period end: paid for until then.
  return row.status === "canceling" && row.currentPeriodEnd !== null && row.currentPeriodEnd > now;
}

/**
 * The decision.
 *
 *   a licensed plan                          active
 *   this project's trial, before its end     trial
 *   this project's trial, after it           expired
 *   any plan ever, none licensed now         expired
 *   the owner's trial bound to another one   trial_claimed_other_site
 *   nothing                                  none
 */
export function decideLicense(input: {
  siteId: string;
  now: Date;
  /** The owner's trial, wherever it is bound. */
  trial: TrialRow | null;
  subscriptions: ReadonlyArray<SubscriptionRow>;
}): LicenseView {
  const { siteId, now, trial, subscriptions } = input;
  const empty: LicenseView = {
    state: "none",
    plan: null,
    status: null,
    trialEndsAt: null,
    startedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    amountMinor: null,
    currency: null,
    claimedProjectName: null,
    subscriptionId: null,
  };

  const licensed = subscriptions
    .filter((row) => subscriptionLicenses(row, now))
    .sort((a, b) => PLAN_RANK[b.plan as PlanId] - PLAN_RANK[a.plan as PlanId] || b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (licensed) {
    return {
      ...empty,
      state: "active",
      plan: licensed.plan as PlanId,
      status: licensed.status,
      startedAt: iso(licensed.startedAt),
      currentPeriodStart: iso(licensed.currentPeriodStart),
      currentPeriodEnd: iso(licensed.currentPeriodEnd),
      cancelAtPeriodEnd: licensed.cancelAtPeriodEnd,
      amountMinor: licensed.amountMinor,
      currency: licensed.currency,
      subscriptionId: licensed.id,
    };
  }

  if (trial && trial.siteId === siteId) {
    const running = trial.status === "trialing" && trial.endsAt > now;
    return {
      ...empty,
      state: running ? "trial" : "expired",
      plan: running ? "trial" : null,
      status: running ? "trialing" : "expired",
      trialEndsAt: iso(trial.endsAt),
      startedAt: iso(trial.startedAt),
    };
  }

  const latest = [...subscriptions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (latest && latest.status !== "incomplete") {
    return {
      ...empty,
      state: "expired",
      plan: isPlan(latest.plan) ? latest.plan : null,
      status: latest.status,
      startedAt: iso(latest.startedAt),
      currentPeriodEnd: iso(latest.currentPeriodEnd),
    };
  }

  if (trial) {
    return { ...empty, state: "trial_claimed_other_site", claimedProjectName: trial.projectName || "another project" };
  }

  return empty;
}

const SUBSCRIPTION_FIELDS = {
  id: true,
  plan: true,
  status: true,
  amountMinor: true,
  currency: true,
  startedAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  createdAt: true,
} as const;

/** The license of one project, from its rows. */
export async function resolveLicense(siteId: string, now: Date = new Date()): Promise<LicenseView> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { userId: true } });
  if (!site) return decideLicense({ siteId, now, trial: null, subscriptions: [] });

  const [trial, subscriptions] = await Promise.all([
    prisma.pluginTrial.findFirst({
      // The owner's trial; or this project's, if it was started before the
      // project changed hands (first claim wins, so this is rare).
      where: { OR: [{ userId: site.userId }, { siteId }] },
      orderBy: { createdAt: "asc" },
      select: { siteId: true, status: true, startedAt: true, endsAt: true, projectName: true },
    }),
    prisma.pluginSubscription.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: SUBSCRIPTION_FIELDS,
    }),
  ]);

  return decideLicense({ siteId, now, trial, subscriptions });
}

// ============================================================================
// A SHORT CACHE, FOR THE MEMBER API
// ============================================================================
// `requireActiveLicense` runs on every member request, and the answer changes
// a few times in a project's life. Thirty seconds of staleness is invisible to
// a member and saves three queries per request. Anything that changes the
// license calls `invalidateLicense`.

const CACHE_MS = 30_000;
const cache = new Map<string, { licensed: boolean; state: LicenseState; at: number }>();

export async function siteLicense(siteId: string): Promise<{ licensed: boolean; state: LicenseState }> {
  const now = Date.now();
  const hit = cache.get(siteId);
  if (hit && now - hit.at < CACHE_MS) return hit;

  const view = await resolveLicense(siteId, new Date(now));
  const entry = { licensed: view.state === "active" || view.state === "trial", state: view.state, at: now };
  cache.set(siteId, entry);
  if (cache.size > 5_000) cache.delete(cache.keys().next().value as string);
  return entry;
}

export function invalidateLicense(siteId?: string): void {
  if (siteId) cache.delete(siteId);
  else cache.clear();
}
