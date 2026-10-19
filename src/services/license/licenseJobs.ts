/**
 * The hourly license job. F19, 19-pro-lock-and-trial.md 2.4.
 *
 *   trials past their end          expired, "trial ended" email (once)
 *   trials ending within 2 days    "trial ends soon" email (once)
 *   plans renewing soon            reminder 7 days before yearly, 3 before monthly (once per period)
 *   cancelled plans past their end expired, "plan ended" email (once)
 *
 * Each email is recorded on its row before it is sent, so two servers or a
 * restart mid-run cannot send it twice. BEAF ran the same sweep hourly at boot.
 */

import { prisma } from "../../config/db.js";
import { sendMail } from "../../lib/mailer.js";
import { invalidateLicense } from "./licenseService.js";
import {
  planExpiredMail,
  renewalReminderMail,
  teamNotice,
  trialEndedMail,
  trialEndingMail,
} from "./licenseMail.js";

const DAY = 86_400_000;
export const TRIAL_ENDING_NOTICE_MS = 2 * DAY;
export const RENEWAL_NOTICE_MS: Record<string, number> = { yearly: 7 * DAY, monthly: 3 * DAY };
const BATCH = 100;

/** Claim a row for one email: true only for the run that set the stamp. */
async function claim(update: () => Promise<{ count: number }>): Promise<boolean> {
  return (await update()).count === 1;
}

async function emailOf(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user?.email ?? null;
}

async function projectNameOf(siteId: string, fallback = "your project"): Promise<string> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { siteName: true } });
  return site?.siteName ?? fallback;
}

export async function runLicenseJob(now: Date = new Date()): Promise<{ trialsEnded: number; trialsWarned: number; renewalsWarned: number; plansExpired: number }> {
  const counts = { trialsEnded: 0, trialsWarned: 0, renewalsWarned: 0, plansExpired: 0 };

  // ---- trials that have ended ----
  const ended = await prisma.pluginTrial.findMany({
    where: { status: "trialing", endsAt: { lte: now } },
    take: BATCH,
    select: { id: true, siteId: true, userId: true, email: true, projectName: true, startedAt: true, endsAt: true },
  });
  for (const trial of ended) {
    const mine = await claim(() =>
      prisma.pluginTrial.updateMany({ where: { id: trial.id, status: "trialing" }, data: { status: "expired", endedNotifiedAt: now } })
    );
    if (!mine) continue;
    invalidateLicense(trial.siteId);
    const name = (await prisma.user.findUnique({ where: { id: trial.userId }, select: { name: true } }))?.name ?? "there";
    void sendMail(trialEndedMail(trial.email, trial.projectName || "your project", name));
    const notice = teamNotice("trial_ended", { name, email: trial.email, projectName: trial.projectName, siteId: trial.siteId }, { trialStart: trial.startedAt, trialEnd: trial.endsAt });
    if (notice) void sendMail(notice);
    counts.trialsEnded += 1;
  }

  // ---- trials ending soon ----
  const ending = await prisma.pluginTrial.findMany({
    where: { status: "trialing", endingNotifiedAt: null, endsAt: { gt: now, lte: new Date(now.getTime() + TRIAL_ENDING_NOTICE_MS) } },
    take: BATCH,
    select: { id: true, email: true, projectName: true, endsAt: true },
  });
  for (const trial of ending) {
    const mine = await claim(() =>
      prisma.pluginTrial.updateMany({ where: { id: trial.id, endingNotifiedAt: null }, data: { endingNotifiedAt: now } })
    );
    if (!mine) continue;
    void sendMail(trialEndingMail(trial.email, trial.projectName || "your project", trial.endsAt));
    counts.trialsWarned += 1;
  }

  // ---- renewals coming up ----
  const renewing = await prisma.pluginSubscription.findMany({
    where: {
      status: "active",
      cancelAtPeriodEnd: false,
      plan: { in: ["monthly", "yearly"] },
      currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + RENEWAL_NOTICE_MS["yearly"]!) },
    },
    take: BATCH,
    select: { id: true, siteId: true, userId: true, plan: true, amountMinor: true, currency: true, currentPeriodEnd: true, renewalNotifiedFor: true },
  });
  for (const row of renewing) {
    const end = row.currentPeriodEnd!;
    if (end.getTime() - now.getTime() > (RENEWAL_NOTICE_MS[row.plan] ?? 0)) continue;
    if (row.renewalNotifiedFor && row.renewalNotifiedFor.getTime() === end.getTime()) continue;
    const mine = await claim(() =>
      prisma.pluginSubscription.updateMany({
        where: { id: row.id, OR: [{ renewalNotifiedFor: null }, { renewalNotifiedFor: { not: end } }] },
        data: { renewalNotifiedFor: end },
      })
    );
    if (!mine) continue;
    const email = await emailOf(row.userId);
    if (email) {
      void sendMail(renewalReminderMail(email, { projectName: await projectNameOf(row.siteId), plan: row.plan, amountMinor: row.amountMinor, currency: row.currency, renewsAt: end }));
      counts.renewalsWarned += 1;
    }
  }

  // ---- cancelled plans whose paid time is over ----
  const lapsed = await prisma.pluginSubscription.findMany({
    where: { status: "canceling", currentPeriodEnd: { lte: now } },
    take: BATCH,
    select: { id: true, siteId: true, userId: true, expiredNotifiedAt: true },
  });
  for (const row of lapsed) {
    const mine = await claim(() =>
      prisma.pluginSubscription.updateMany({ where: { id: row.id, status: "canceling" }, data: { status: "expired" } })
    );
    if (!mine) continue;
    invalidateLicense(row.siteId);
    counts.plansExpired += 1;
    const notify = await claim(() =>
      prisma.pluginSubscription.updateMany({ where: { id: row.id, expiredNotifiedAt: null }, data: { expiredNotifiedAt: now } })
    );
    const email = notify ? await emailOf(row.userId) : null;
    if (email) void sendMail(planExpiredMail(email, { projectName: await projectNameOf(row.siteId) }));
  }

  return counts;
}
