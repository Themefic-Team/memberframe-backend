/**
 * The 7-day trial. F19, development doc 19-pro-lock-and-trial.md.
 *
 * One trial per creator account, per email, per Framer user, and per Framer
 * project: a match on any one of them means it was used (F19's three
 * identifiers, plus the project). It starts the first time the plugin is used
 * in a project and stays bound to that project; every other project of the
 * same creator then reports `trial_claimed_other_site`.
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

export type TrialRefusal = "account" | "email" | "framer_user" | "project";

export interface StartTrialInput {
  userId: string;
  email: string;
  framerUserId: string | null;
  framerProjectId: string;
  siteId: string;
  projectName: string;
}

/** Which identifier, if any, has already had a trial. */
export function trialRefusal(
  existing: { userId: string; email: string; framerUserId: string | null; framerProjectId: string | null },
  input: StartTrialInput
): TrialRefusal {
  if (existing.userId === input.userId) return "account";
  if (existing.email === input.email.toLowerCase()) return "email";
  if (input.framerUserId && existing.framerUserId === input.framerUserId) return "framer_user";
  return "project";
}

export async function startTrialIfEligible(
  input: StartTrialInput,
  now: Date = new Date()
): Promise<{ started: true; endsAt: Date } | { started: false; reason: TrialRefusal }> {
  const email = input.email.trim().toLowerCase();
  const or: Prisma.PluginTrialWhereInput[] = [
    { userId: input.userId },
    { email },
    { framerProjectId: input.framerProjectId },
    { siteId: input.siteId },
  ];
  if (input.framerUserId) or.push({ framerUserId: input.framerUserId });

  const existing = await prisma.pluginTrial.findFirst({
    where: { OR: or },
    select: { userId: true, email: true, framerUserId: true, framerProjectId: true },
  });
  if (existing) return { started: false, reason: trialRefusal(existing, { ...input, email }) };

  const endsAt = new Date(now.getTime() + trialDurationMs());
  try {
    await prisma.pluginTrial.create({
      data: {
        userId: input.userId,
        email,
        framerUserId: input.framerUserId || null,
        framerProjectId: input.framerProjectId,
        siteId: input.siteId,
        projectName: input.projectName.slice(0, 255),
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
