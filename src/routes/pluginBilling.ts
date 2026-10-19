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
import { resolveLicense } from "../services/license/licenseService.js";
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

