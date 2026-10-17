/**
 * The exact reading meter for a signed-in member. FP-07, PRD F07.
 *
 * A visitor who is not signed in is metered on their own device, which a
 * private window resets; that is accepted, as it is for every metered site.
 * Once they sign in, this row is the meter: the same count on every device.
 *
 * Rules, the same as the device meter's so the two never disagree:
 *   - An article already counted this cycle is free to open again.
 *   - A new article counts while the count is below the limit, then is refused.
 *   - The cycle ends exactly `periodDays` after it began, and the next request
 *     starts a fresh one. Changing the window also starts a fresh one.
 *   - The first contact after signing in folds in what the device counted in
 *     its own current cycle, so signing in never hands out extra free reads.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../config/db.js";

export type MeterPeriod = "weekly" | "monthly";

export const PERIOD_DAYS: Record<MeterPeriod, number> = { weekly: 7, monthly: 30 };
const DAY_MS = 86_400_000;
export const MAX_METERED_SLUGS = 500;

export interface MeterState {
  slugs: string[];
  cycleStart: number;
}

export interface MeterAnswer {
  allowed: boolean;
  alreadyRead: boolean;
  /** Articles counted this cycle. */
  count: number;
  limit: number;
  remaining: number;
  /** Where this article sits in the count, 1-based. Null when refused. */
  position: number | null;
  cycleStart: number;
  resetsAt: number;
}

/**
 * The meter's rule, with no storage in it. Exported for the tests, and kept
 * line for line in step with `meterDecision` in `MeteredPaywall.tsx`.
 */
export function decideMeter(
  state: MeterState | null,
  slug: string,
  limit: number,
  periodDays: number,
  now: number,
  deviceReads: ReadonlyArray<string> = []
): { state: MeterState; answer: MeterAnswer } {
  const windowMs = periodDays * DAY_MS;
  let current = state && now - state.cycleStart < windowMs && now >= state.cycleStart ? state : null;

  if (!current) {
    // A fresh cycle. What the device already counted comes with it.
    const carried = Array.from(new Set(deviceReads)).slice(0, limit);
    current = { slugs: carried, cycleStart: now };
  }

  const slugs = [...current.slugs];
  let index = slugs.indexOf(slug);
  const alreadyRead = index !== -1;

  if (!alreadyRead && slugs.length < limit) {
    slugs.push(slug);
    index = slugs.length - 1;
  }

  const allowed = index !== -1;
  const next = { slugs: slugs.slice(-MAX_METERED_SLUGS), cycleStart: current.cycleStart };

  return {
    state: next,
    answer: {
      allowed,
      alreadyRead,
      count: Math.min(next.slugs.length, limit),
      limit,
      remaining: Math.max(0, limit - next.slugs.length),
      position: allowed ? index + 1 : null,
      cycleStart: next.cycleStart,
      resetsAt: next.cycleStart + windowMs,
    },
  };
}

function readSlugs(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function meterRead(
  siteId: string,
  memberId: string,
  input: { slug: string; limit: number; period: MeterPeriod; deviceReads: string[] }
): Promise<MeterAnswer> {
  const periodDays = PERIOD_DAYS[input.period];
  const row = await prisma.meterCycle.findUnique({ where: { memberId } });
  const state = row && row.siteId === siteId && row.periodDays === periodDays
    ? { slugs: readSlugs(row.slugs), cycleStart: row.cycleStart.getTime() }
    : null;

  const { state: next, answer } = decideMeter(state, input.slug, input.limit, periodDays, Date.now(), input.deviceReads);

  await prisma.meterCycle.upsert({
    where: { memberId },
    create: { memberId, siteId, cycleStart: new Date(next.cycleStart), periodDays, slugs: next.slugs },
    update: { siteId, cycleStart: new Date(next.cycleStart), periodDays, slugs: next.slugs },
  });

  return answer;
}
