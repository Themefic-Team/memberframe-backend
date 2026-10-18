/**
 * Reports for the creator's panel. Development doc:
 * memberframe/docs/development-docs/24-reports.md
 *
 * Everything here reads what the site already records: members,
 * subscriptions, payments, bookmarks, and downloads. Nothing is collected for
 * it. The arithmetic is in small pure functions at the top, so it is tested
 * without a database; the queries below only gather rows for them.
 *
 * Money is never added across currencies. A site has one currency now, but
 * older payments may be in another, so every total is a list per currency.
 */

import { prisma } from "../config/db.js";

export type ReportMode = "live" | "test";
export type ReportPeriod = "30d" | "90d" | "12m" | "all";
export type BillingInterval = "month" | "year" | "lifetime";

/** A subscription that is paid for now: running, retrying a failed payment, or canceled at period end. */
export const PAYING_STATUSES = ["active", "past_due", "canceling"] as const;

const DAY_MS = 86_400_000;

// ============================================================================
// PURE ARITHMETIC
// ============================================================================

/** The start of a period, or null for all time. */
export function periodStart(period: ReportPeriod, now: Date = new Date()): Date | null {
  if (period === "all") return null;
  if (period === "12m") return new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
  return new Date(now.getTime() - (period === "30d" ? 30 : 90) * DAY_MS);
}

/** "2026-10" for a date, in UTC. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last twelve month keys, oldest first, ending with the current month. */
export function lastTwelveMonths(now: Date = new Date()): string[] {
  const months: string[] = [];
  for (let back = 11; back >= 0; back--) {
    months.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))));
  }
  return months;
}

export interface Money {
  currency: string;
  amountMinor: number;
}

/** Add amounts into a per-currency list, in first-seen order. */
function addTo(list: Money[], currency: string, amountMinor: number): void {
  const entry = list.find((item) => item.currency === currency);
  if (entry) entry.amountMinor += amountMinor;
  else list.push({ currency, amountMinor });
}

/**
 * Monthly recurring revenue, per currency: a monthly price as is, a yearly one
 * over 12. Lifetime purchases are revenue, not recurring, so they are left out.
 */
export function monthlyRecurring(subscriptions: ReadonlyArray<{ interval: string; amountMinor: number; currency: string }>): Money[] {
  const totals: Money[] = [];
  for (const sub of subscriptions) {
    if (sub.interval === "month") addTo(totals, sub.currency, sub.amountMinor);
    else if (sub.interval === "year") addTo(totals, sub.currency, Math.round(sub.amountMinor / 12));
  }
  return totals;
}

export interface RevenueTotals {
  currency: string;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
  payments: number;
}

/** Gross is every payment, refunded the ones marked refunded, net the difference. Per currency. */
export function revenueTotals(payments: ReadonlyArray<{ amountMinor: number; currency: string; status: string }>): RevenueTotals[] {
  const totals: RevenueTotals[] = [];
  for (const payment of payments) {
    let entry = totals.find((item) => item.currency === payment.currency);
    if (!entry) {
      entry = { currency: payment.currency, grossMinor: 0, refundedMinor: 0, netMinor: 0, payments: 0 };
      totals.push(entry);
    }
    entry.grossMinor += payment.amountMinor;
    entry.payments += 1;
    if (payment.status === "refunded") entry.refundedMinor += payment.amountMinor;
    entry.netMinor = entry.grossMinor - entry.refundedMinor;
  }
  return totals;
}

/** A payment's net contribution: nothing once refunded. */
function netOf(payment: { amountMinor: number; status: string }): number {
  return payment.status === "refunded" ? 0 : payment.amountMinor;
}

export interface GroupedRevenue {
  key: string;
  currency: string;
  netMinor: number;
  payments: number;
}

/** Net revenue grouped by a key (a tier, a gateway, a month) and currency. */
export function revenueBy<T extends { amountMinor: number; currency: string; status: string }>(
  payments: ReadonlyArray<T>,
  keyOf: (payment: T) => string
): GroupedRevenue[] {
  const groups: GroupedRevenue[] = [];
  for (const payment of payments) {
    const key = keyOf(payment);
    let entry = groups.find((item) => item.key === key && item.currency === payment.currency);
    if (!entry) {
      entry = { key, currency: payment.currency, netMinor: 0, payments: 0 };
      groups.push(entry);
    }
    entry.netMinor += netOf(payment);
    entry.payments += 1;
  }
  return groups;
}

// ============================================================================
// OVERVIEW
// ============================================================================

interface TierRow {
  key: string;
  name: string;
  rank: number;
}

function tierName(tiers: ReadonlyArray<TierRow>, key: string): string {
  return tiers.find((tier) => tier.key === key)?.name ?? (key === "" ? "Unknown" : key);
}

export async function overviewReport(siteId: string, mode: ReportMode, period: ReportPeriod, now: Date = new Date()) {
  const from = periodStart(period, now);
  const yearAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const months = lastTwelveMonths(now);
  const memberWhere = { siteId, deletedAt: null };

  const [tiers, settings, totalMembers, newMembers, byTierRows, byStatusRows, recentSignups, paying, started, ended, periodPayments, yearPayments, bookmarkRows, downloads] =
    await Promise.all([
      prisma.tier.findMany({ where: { siteId }, select: { key: true, name: true, rank: true }, orderBy: { rank: "asc" } }),
      prisma.paymentSettings.findUnique({ where: { siteId }, select: { defaultCurrency: true } }),
      prisma.member.count({ where: memberWhere }),
      prisma.member.count({ where: { ...memberWhere, ...(from ? { createdAt: { gte: from } } : {}) } }),
      prisma.member.groupBy({ by: ["activeTier"], where: memberWhere, _count: { _all: true } }),
      prisma.member.groupBy({ by: ["status"], where: memberWhere, _count: { _all: true } }),
      prisma.member.findMany({ where: { ...memberWhere, createdAt: { gte: yearAgo } }, select: { createdAt: true } }),
      prisma.subscription.findMany({
        where: { siteId, mode, OR: [{ status: { in: [...PAYING_STATUSES] } }, { interval: "lifetime", status: { not: "ended" } }] },
        select: { memberId: true, tierKey: true, interval: true, amountMinor: true, currency: true, status: true },
      }),
      prisma.subscription.count({ where: { siteId, mode, ...(from ? { createdAt: { gte: from } } : {}) } }),
      prisma.subscription.count({ where: { siteId, mode, status: "ended", ...(from ? { endedAt: { gte: from } } : {}) } }),
      prisma.payment.findMany({
        where: { siteId, mode, ...(from ? { paidAt: { gte: from } } : {}) },
        select: { amountMinor: true, currency: true, status: true, gateway: true, subscriptionId: true },
      }),
      prisma.payment.findMany({
        where: { siteId, mode, paidAt: { gte: yearAgo } },
        select: { amountMinor: true, currency: true, status: true, paidAt: true },
      }),
      prisma.bookmark.groupBy({
        by: ["itemSlug"],
        where: { siteId },
        _count: { _all: true },
        orderBy: { _count: { itemSlug: "desc" } },
        take: 5,
      }),
      prisma.asset.findMany({
        where: { siteId, downloadCount: { gt: 0 } },
        select: { id: true, name: true, downloadCount: true, lastDownloadAt: true },
        orderBy: { downloadCount: "desc" },
        take: 5,
      }),
    ]);

  // A payment's tier is the tier of the subscription it paid for.
  const subscriptionIds = [...new Set(periodPayments.map((payment) => payment.subscriptionId).filter((id): id is string => id !== null))];
  const subscriptionTiers = subscriptionIds.length
    ? await prisma.subscription.findMany({ where: { id: { in: subscriptionIds } }, select: { id: true, tierKey: true } })
    : [];
  const tierOfSubscription = new Map(subscriptionTiers.map((row) => [row.id, row.tierKey]));

  const bookmarkTitles = bookmarkRows.length
    ? await prisma.bookmark.findMany({
        where: { siteId, itemSlug: { in: bookmarkRows.map((row) => row.itemSlug) } },
        select: { itemSlug: true, title: true, url: true },
        distinct: ["itemSlug"],
      })
    : [];

  const countByTier = (rows: ReadonlyArray<{ key: string }>) =>
    tiers.map((tier) => ({ key: tier.key, name: tier.name, rank: tier.rank, count: rows.filter((row) => row.key === tier.key).length }));

  const signups = new Map(months.map((month) => [month, 0]));
  for (const member of recentSignups) {
    const key = monthKey(member.createdAt);
    if (signups.has(key)) signups.set(key, (signups.get(key) ?? 0) + 1);
  }

  const byMonth = revenueBy(yearPayments, (payment) => monthKey(payment.paidAt));
  const recurring = paying.filter((sub) => sub.interval !== "lifetime" && PAYING_STATUSES.includes(sub.status as never));

  return {
    mode,
    period,
    from: from ? from.toISOString() : null,
    siteCurrency: settings?.defaultCurrency ?? "USD",
    members: {
      total: totalMembers,
      newInPeriod: newMembers,
      paying: new Set(paying.map((sub) => sub.memberId)).size,
      byTier: tiers.map((tier) => ({
        key: tier.key,
        name: tier.name,
        rank: tier.rank,
        count: byTierRows.find((row) => row.activeTier === tier.key)?._count._all ?? 0,
      })),
      byStatus: Object.fromEntries(byStatusRows.map((row) => [row.status, row._count._all])),
      signupsByMonth: months.map((month) => ({ month, count: signups.get(month) ?? 0 })),
    },
    subscriptions: {
      active: paying.filter((sub) => sub.status === "active").length,
      pastDue: paying.filter((sub) => sub.status === "past_due").length,
      canceling: paying.filter((sub) => sub.status === "canceling").length,
      startedInPeriod: started,
      endedInPeriod: ended,
      byInterval: {
        month: paying.filter((sub) => sub.interval === "month").length,
        year: paying.filter((sub) => sub.interval === "year").length,
        lifetime: paying.filter((sub) => sub.interval === "lifetime").length,
      },
      byTier: countByTier(paying.map((sub) => ({ key: sub.tierKey }))),
    },
    revenue: {
      totals: revenueTotals(periodPayments),
      mrr: monthlyRecurring(recurring),
      byMonth: months.flatMap((month) => {
        const rows = byMonth.filter((row) => row.key === month);
        return rows.length ? rows.map((row) => ({ month, currency: row.currency, netMinor: row.netMinor, payments: row.payments })) : [];
      }),
      months,
      byTier: revenueBy(periodPayments, (payment) => (payment.subscriptionId ? tierOfSubscription.get(payment.subscriptionId) ?? "" : "")).map(
        (row) => ({ ...row, name: tierName(tiers, row.key) })
      ),
      byGateway: revenueBy(periodPayments, (payment) => payment.gateway),
    },
    content: {
      topBookmarks: bookmarkRows.map((row) => {
        const meta = bookmarkTitles.find((entry) => entry.itemSlug === row.itemSlug);
        return { itemSlug: row.itemSlug, title: meta?.title || row.itemSlug, url: meta?.url ?? "", count: row._count._all };
      }),
      topDownloads: downloads.map((asset) => ({
        id: asset.id,
        name: asset.name,
        downloadCount: asset.downloadCount,
        lastDownloadAt: asset.lastDownloadAt ? asset.lastDownloadAt.toISOString() : null,
      })),
    },
  };
}

// ============================================================================
// LISTS
// ============================================================================

export const REPORT_PAGE_SIZE = 25;
/** Export CSV asks for everything at once, up to this. */
export const REPORT_EXPORT_MAX = 5000;

const MEMBER_SUMMARY = { select: { id: true, email: true, name: true } } as const;

export async function subscriptionList(
  siteId: string,
  input: { mode: ReportMode; status: string; tier: string; page: number; pageSize: number }
) {
  const where = {
    siteId,
    mode: input.mode,
    ...(input.status === "paying"
      ? { status: { in: [...PAYING_STATUSES] } }
      : input.status !== "all"
        ? { status: input.status }
        : {}),
    ...(input.tier ? { tierKey: input.tier } : {}),
  };
  const [tiers, total, rows] = await Promise.all([
    prisma.tier.findMany({ where: { siteId }, select: { key: true, name: true, rank: true } }),
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: { member: MEMBER_SUMMARY },
    }),
  ]);

  return {
    total,
    page: input.page,
    pageSize: input.pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      member: row.member,
      tierKey: row.tierKey,
      tierName: tierName(tiers, row.tierKey),
      interval: row.interval,
      status: row.status,
      gateway: row.gateway,
      amountMinor: row.amountMinor,
      currency: row.currency,
      startedAt: row.createdAt.toISOString(),
      currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    })),
  };
}

export async function paymentList(
  siteId: string,
  input: { mode: ReportMode; period: ReportPeriod; tier: string; memberId: string; page: number; pageSize: number }
) {
  const from = periodStart(input.period);
  const tiers = await prisma.tier.findMany({ where: { siteId }, select: { key: true, name: true, rank: true } });

  // A tier filter is the payments for that tier's subscriptions.
  const tierSubscriptionIds = input.tier
    ? (await prisma.subscription.findMany({ where: { siteId, tierKey: input.tier }, select: { id: true } })).map((row) => row.id)
    : null;

  const where = {
    siteId,
    mode: input.mode,
    ...(from ? { paidAt: { gte: from } } : {}),
    ...(input.memberId ? { memberId: input.memberId } : {}),
    ...(tierSubscriptionIds ? { subscriptionId: { in: tierSubscriptionIds } } : {}),
  };

  const [total, rows, all] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, orderBy: { paidAt: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
    prisma.payment.findMany({ where, select: { amountMinor: true, currency: true, status: true } }),
  ]);

  const memberIds = [...new Set(rows.map((row) => row.memberId))];
  const subscriptionIds = [...new Set(rows.map((row) => row.subscriptionId).filter((id): id is string => id !== null))];
  const [members, subscriptions] = await Promise.all([
    memberIds.length ? prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, email: true, name: true } }) : [],
    subscriptionIds.length ? prisma.subscription.findMany({ where: { id: { in: subscriptionIds } }, select: { id: true, tierKey: true, interval: true } }) : [],
  ]);

  return {
    total,
    page: input.page,
    pageSize: input.pageSize,
    totals: revenueTotals(all),
    rows: rows.map((row) => {
      const subscription = subscriptions.find((entry) => entry.id === row.subscriptionId);
      return {
        id: row.id,
        member: members.find((member) => member.id === row.memberId) ?? { id: row.memberId, email: "Deleted member", name: null },
        tierKey: subscription?.tierKey ?? "",
        tierName: subscription ? tierName(tiers, subscription.tierKey) : "Unknown",
        interval: subscription?.interval ?? null,
        amountMinor: row.amountMinor,
        currency: row.currency,
        gateway: row.gateway,
        status: row.status,
        paidAt: row.paidAt.toISOString(),
        receiptUrl: row.receiptUrl,
      };
    }),
  };
}

/** One member's whole history: who they are, every subscription, every payment, and what they have spent. */
export async function memberHistory(siteId: string, memberId: string, mode: ReportMode) {
  const member = await prisma.member.findFirst({
    where: { id: memberId, siteId },
    select: { id: true, email: true, name: true, activeTier: true, status: true, createdAt: true, lastLoginAt: true },
  });
  if (!member) return null;

  const [tiers, subscriptions, payments] = await Promise.all([
    prisma.tier.findMany({ where: { siteId }, select: { key: true, name: true, rank: true } }),
    prisma.subscription.findMany({ where: { siteId, memberId, mode }, orderBy: { createdAt: "desc" } }),
    prisma.payment.findMany({ where: { siteId, memberId, mode }, orderBy: { paidAt: "desc" } }),
  ]);

  return {
    member: {
      ...member,
      tierName: tierName(tiers, member.activeTier),
      createdAt: member.createdAt.toISOString(),
      lastLoginAt: member.lastLoginAt ? member.lastLoginAt.toISOString() : null,
    },
    lifetimeSpend: revenueTotals(payments),
    subscriptions: subscriptions.map((row) => ({
      id: row.id,
      tierKey: row.tierKey,
      tierName: tierName(tiers, row.tierKey),
      interval: row.interval,
      status: row.status,
      gateway: row.gateway,
      amountMinor: row.amountMinor,
      currency: row.currency,
      startedAt: row.createdAt.toISOString(),
      currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    })),
    payments: payments.map((row) => ({
      id: row.id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      gateway: row.gateway,
      status: row.status,
      paidAt: row.paidAt.toISOString(),
      receiptUrl: row.receiptUrl,
      tierName: tierName(tiers, subscriptions.find((sub) => sub.id === row.subscriptionId)?.tierKey ?? ""),
    })),
  };
}
