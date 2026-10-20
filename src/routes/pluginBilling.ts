/**
 * The panel's billing routes, /api/plugin. F19, 19-pro-lock-and-trial.md 5.
 *
 * Every route needs the creator's token and checks they own the project.
 * BEAF's billing endpoints trusted any `siteId` they were sent, so anyone
 * could cancel anyone's plan; that is the first thing not copied.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { ApiError, ok, rateLimited, route } from "../middleware/errors.js";
import { creatorAuth, requireCreator } from "../middleware/creator.js";
import { hit } from "../middleware/rateLimit.js";
import { requireOwnedSite } from "../services/creatorAuthService.js";
import { PlatformBillingError } from "../lib/stripeRest.js";
import { invalidateLicense, resolveLicense } from "../services/license/licenseService.js";
import { onLicenseChanged } from "../services/license/licenseEvents.js";
import { startTrialIfEligible } from "../services/license/trialService.js";
import { trialStartedMail } from "../services/license/licenseMail.js";
import { sendMail } from "../lib/mailer.js";
import { prisma } from "../config/db.js";
import { issueSeal, verifySeal } from "../lib/instanceSeal.js";
import {
  applyCoupon,
  billingPortalUrl,
  cancelAtPeriodEnd,
  confirmCheckout,
  plansView,
  resume,
  startCheckout,
  upgrade,
  upgradePreview,
} from "../services/license/billingService.js";

export const pluginBillingRouter = Router();
pluginBillingRouter.use(creatorAuth);

const siteId = z.string().trim().min(1).max(36);
const plan = z.enum(["monthly", "yearly", "lifetime"]);

/** A Stripe refusal becomes a 4xx the panel can show, with Stripe's own words. */
async function billing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PlatformBillingError) {
      throw new ApiError(error.status, error.code ?? "billing_failed", error.message, { message: error.message });
    }
    throw error;
  }
}

async function ownedProject(req: Request, id: string) {
  const creator = requireCreator(req);
  const site = await requireOwnedSite(creator.userId, id);
  return {
    owner: { id: creator.userId, email: creator.email, name: creator.name },
    project: { siteId: site.id, siteName: site.siteName },
  };
}

/** Each creator may start a few payments a minute: each one is a Stripe call. */
function guardPayments(req: Request): void {
  const decision = hit(`plugin-billing:${requireCreator(req).userId}`, 10, 60);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

pluginBillingRouter.get(
  "/license",
  route(async (req, res) => {
    const input = z.object({ siteId }).parse(req.query);
    const { project } = await ownedProject(req, input.siteId);
    ok(res, { license: await resolveLicense(project.siteId) });
  })
);

/** Streams one creator may hold open: a panel per open project, with room for a reconnect overlap. */
export const MAX_STREAMS_PER_CREATOR = 5;
/** A ping comment this often keeps proxies from closing a quiet stream. */
export const STREAM_PING_MS = 25_000;
/**
 * Each open stream also reads the license itself this often, and sends it only
 * when it changed: a trial ends by date before the hourly license job runs,
 * and a row edited outside this process (a script, the database) calls nothing.
 * One small read a minute per open panel, and no request from the panel.
 */
export const STREAM_RECHECK_MS = 60_000;
/** A stream ends after this long and the panel opens a fresh one, so none outlives its token check. */
export const STREAM_LIFETIME_MS = 60 * 60 * 1000;
const openStreams = new Map<string, number>();

/** One server-sent event frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The license, pushed (19-pro-lock-and-trial.md 5.1). The panel holds this
 * open while it is open: the license now, then again whenever it changes (a
 * trial ends, a plan is bought, renewed, or expires). The panel rewrites the
 * components' baked lines, so the canvas locks at once and nothing polls.
 */
pluginBillingRouter.get(
  "/events",
  route(async (req, res) => {
    const input = z.object({ siteId }).parse(req.query);
    const { owner, project } = await ownedProject(req, input.siteId);
    const held = openStreams.get(owner.id) ?? 0;
    if (held >= MAX_STREAMS_PER_CREATOR) throw rateLimited(60);
    openStreams.set(owner.id, held + 1);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx and similar proxies buffer responses unless told not to.
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 5000\n\n");

    let closed = false;
    let lastSent = "";
    let sending = false;
    let again = false;
    // Changes that arrive while one is being sent collapse into one more send.
    const send = async (): Promise<void> => {
      if (closed) return;
      if (sending) {
        again = true;
        return;
      }
      sending = true;
      try {
        do {
          again = false;
          const frame = sseFrame("license", { license: await resolveLicense(project.siteId) });
          // Unchanged since the last frame: nothing to tell the panel.
          if (!closed && frame !== lastSent) {
            lastSent = frame;
            res.write(frame);
          }
        } while (again && !closed);
      } catch {
        // A failed read sends nothing; the next change, or the next stream, tries again.
      } finally {
        sending = false;
      }
    };

    const unsubscribe = onLicenseChanged(project.siteId, () => void send());
    const ping = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, STREAM_PING_MS);
    const recheck = setInterval(() => void send(), STREAM_RECHECK_MS);
    const lifetime = setTimeout(() => res.end(), STREAM_LIFETIME_MS);

    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(ping);
      clearInterval(recheck);
      clearTimeout(lifetime);
      const left = (openStreams.get(owner.id) ?? 1) - 1;
      if (left > 0) openStreams.set(owner.id, left);
      else openStreams.delete(owner.id);
    };
    req.on("close", close);
    res.on("close", close);

    await send();
  })
);

/**
 * Profile's "Start Free Trial" (BEAF's button). Attaching a project already
 * starts the trial when it can; this is the same check, for a project that
 * was attached without one. One trial per account, email, Framer user, and
 * project, as always: a refusal answers the license as it stands.
 */
pluginBillingRouter.post(
  "/start-trial",
  route(async (req, res) => {
    const input = z.object({ siteId }).parse(req.body);
    const { owner, project } = await ownedProject(req, input.siteId);
    const before = await resolveLicense(project.siteId);
    if (before.state !== "none") {
      ok(res, { started: false, license: before });
      return;
    }
    const [user, site] = await Promise.all([
      prisma.user.findUnique({ where: { id: owner.id }, select: { framerUserId: true } }),
      prisma.site.findUnique({ where: { id: project.siteId }, select: { framerSiteId: true } }),
    ]);
    const trial = await startTrialIfEligible({
      userId: owner.id,
      email: owner.email,
      framerUserId: user?.framerUserId ?? null,
      framerProjectId: site?.framerSiteId ?? project.siteId,
      siteId: project.siteId,
      projectName: project.siteName,
    });
    if (trial.started) {
      invalidateLicense(project.siteId);
      void sendMail(trialStartedMail(owner.email, project.siteName, trial.endsAt, owner.name));
    }
    ok(res, { started: trial.started, license: await resolveLicense(project.siteId) });
  })
);

/**
 * A seal for the next component the Builder inserts (27-instance-seal.md).
 * Only the site's owner gets one, and only for their own site.
 */
pluginBillingRouter.post(
  "/instance-seal",
  route(async (req, res) => {
    const input = z.object({ siteId }).parse(req.body);
    const { project } = await ownedProject(req, input.siteId);
    const decision = hit(`instance-seal:${requireCreator(req).userId}`, 120, 60);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
    ok(res, { seal: issueSeal(project.siteId) });
  })
);

/**
 * Which of these seals were issued for this site. The plugin asks about a seal
 * it has no record of: valid ones are adopted, the rest belong to another
 * project and are cleared, which locks the pasted copy.
 */
pluginBillingRouter.post(
  "/instance-seal/verify",
  route(async (req, res) => {
    const input = z.object({ siteId, seals: z.array(z.string().max(200)).max(200) }).parse(req.body);
    const { project } = await ownedProject(req, input.siteId);
    ok(res, { valid: input.seals.filter((seal) => verifySeal(project.siteId, seal)) });
  })
);

pluginBillingRouter.get(
  "/plans",
  route(async (_req, res) => {
    ok(res, await billing(() => plansView()));
  })
);

pluginBillingRouter.post(
  "/checkout",
  route(async (req, res) => {
    const input = z.object({ siteId, plan, coupon: z.string().trim().max(60).optional() }).parse(req.body);
    const { owner, project } = await ownedProject(req, input.siteId);
    guardPayments(req);
    ok(res, { ...(await billing(() => startCheckout(owner, project, input.plan, input.coupon || undefined))) });
  })
);

pluginBillingRouter.post(
  "/apply-coupon",
  route(async (req, res) => {
    const input = z.object({ siteId, coupon: z.string().trim().min(1).max(60) }).parse(req.body);
    const { owner, project } = await ownedProject(req, input.siteId);
    guardPayments(req);
    ok(res, { ...(await billing(() => applyCoupon(owner, project, input.coupon))) });
  })
);

pluginBillingRouter.post(
  "/checkout/confirm",
  route(async (req, res) => {
    const input = z.object({ siteId, paymentIntentId: z.string().trim().regex(/^pi_[A-Za-z0-9]+$/) }).parse(req.body);
    const { project } = await ownedProject(req, input.siteId);
    await billing(() => confirmCheckout(project.siteId, input.paymentIntentId));
    ok(res, { license: await resolveLicense(project.siteId) });
  })
);

pluginBillingRouter.get(
  "/upgrade-preview",
  route(async (req, res) => {
    const input = z.object({ siteId, targetPlan: plan }).parse(req.query);
    const { project } = await ownedProject(req, input.siteId);
    ok(res, { preview: await billing(() => upgradePreview(project.siteId, input.targetPlan)) });
  })
);

pluginBillingRouter.post(
  "/upgrade",
  route(async (req, res) => {
    const input = z.object({ siteId, targetPlan: plan }).parse(req.body);
    const { owner, project } = await ownedProject(req, input.siteId);
    guardPayments(req);
    ok(res, { ...(await billing(() => upgrade(owner, project, input.targetPlan))) });
  })
);

pluginBillingRouter.post(
  "/cancel",
  route(async (req, res) => {
    const input = z.object({ siteId, reason: z.string().trim().max(500).default("") }).parse(req.body);
    const { project } = await ownedProject(req, input.siteId);
    const result = await billing(() => cancelAtPeriodEnd(project.siteId, input.reason));
    ok(res, { ...result, license: await resolveLicense(project.siteId) });
  })
);

pluginBillingRouter.post(
  "/resume",
  route(async (req, res) => {
    const input = z.object({ siteId }).parse(req.body);
    const { project } = await ownedProject(req, input.siteId);
    await billing(() => resume(project.siteId));
    ok(res, { license: await resolveLicense(project.siteId) });
  })
);

pluginBillingRouter.get(
  "/billing-portal",
  route(async (req, res) => {
    const input = z.object({ siteId }).parse(req.query);
    const { owner } = await ownedProject(req, input.siteId);
    ok(res, { url: await billing(() => billingPortalUrl(owner)) });
  })
);

