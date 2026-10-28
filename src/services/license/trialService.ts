/**
 * The 7-day trial. F19, development doc 19-pro-lock-and-trial.md.
 *
 * One trial per creator account, per email, and per site: a match on any one
 * of them means it was used. It starts the first time the plugin is used in a
 * project and stays bound to that site; every other site of the same creator
 * then reports `trial_claimed_other_site`.
 *
 * The Framer user and the Framer project used to count too. Since 2026-10-28
 * the plugin reads neither (Marketplace review), so they are no longer stored
 * or matched; older rows keep their values. The trade off: a new account with
 * a new address, on a new site, gets a new trial.
 *
 * BEAF fell through to a "direct insert" when its eligibility check failed,
 * so a second account on an already-trialled project got a second trial.
 * There is no such path here: ineligible is final.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import { invalidateLicense } from "./licenseService.js";

export function trialDurationMs(): number {
  return env.billing.trialMinutes > 0 ? env.billing.trialMinutes * 60_000 : env.billing.trialDays * 86_400_000;
}

export type TrialRefusal = "account" | "email" | "site";

export interface StartTrialInput {
  userId: string;
  email: string;
  siteId: string;
}

/** Which identifier, if any, has already had a trial. */
export function trialRefusal(
  existing: { userId: string; email: string },
  input: StartTrialInput
): TrialRefusal {
  if (existing.userId === input.userId) return "account";
  if (existing.email === input.email.toLowerCase()) return "email";
  return "site";
}

export async function startTrialIfEligible(
  input: StartTrialInput,
  now: Date = new Date()
): Promise<{ started: true; endsAt: Date } | { started: false; reason: TrialRefusal }> {
  const email = input.email.trim().toLowerCase();
  const or: Prisma.PluginTrialWhereInput[] = [{ userId: input.userId }, { email }, { siteId: input.siteId }];

  const existing = await prisma.pluginTrial.findFirst({
    where: { OR: or },
    select: { userId: true, email: true },
  });
  if (existing) return { started: false, reason: trialRefusal(existing, { ...input, email }) };

  const endsAt = new Date(now.getTime() + trialDurationMs());
  try {
    await prisma.pluginTrial.create({
      data: {
        userId: input.userId,
        email,
        siteId: input.siteId,
        startedAt: now,
        endsAt,
        status: "trialing",
      },
    });
  } catch (error) {
    // Two panels racing: the unique indexes decide, and the loser is refused.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { started: false, reason: "account" };
    }
    throw error;
  }

  invalidateLicense(input.siteId);
  return { started: true, endsAt };
}

/** A trial that became a paid plan stops being reminded about or expired. */
export async function markTrialConverted(siteId: string): Promise<void> {
  await prisma.pluginTrial.updateMany({ where: { siteId, status: "trialing" }, data: { status: "converted" } });
}
