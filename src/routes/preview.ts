/**
 * What MemberFrame components show on the Framer canvas.
 *
 *   GET /api/preview?site=<siteKey>[&asset=<assetId>]
 *
 * A creator designing a pricing table should see their own tiers and prices,
 * not four sample plans. The published site gets them from routes that check
 * the request's origin against the site's allowlist, and the canvas is on a
 * Framer origin that list never holds. So the canvas has its own door.
 *
 * It is public, read-only, and sends nothing the published site does not
 * already show any visitor: the pricing table, the profile questions a member
 * is asked, and one file's label and plan. No member, no session, no cookie,
 * no gateway or storage detail. That is why it can use the panel's wildcard
 * CORS without credentials, and why the public site key alone identifies the
 * site: the key is in every published component already.
 *
 * Development doc: memberframe/docs/development-docs/22-canvas-real-data.md
 */

import { Router, type Request } from "express";
import { prisma } from "../config/db.js";
import { notFound, ok, rateLimited, route } from "../middleware/errors.js";
import { clientIp, hit } from "../middleware/rateLimit.js";
import { publicPricing } from "../services/payments/checkoutService.js";
import { publicAsset } from "../services/assets/assetService.js";
import { loadSiteSettings } from "../services/settingsService.js";
import { publicFieldDefinitions } from "../lib/memberMetadata.js";

export const previewRouter = Router();

/** A designer's canvas re-renders often; components cache, and this caps the rest. */
const PREVIEW_LIMIT_PER_MINUTE = 120;

function limit(req: Request): void {
  const decision = hit(`preview:${clientIp(req)}`, PREVIEW_LIMIT_PER_MINUTE, 60);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

previewRouter.get(
  "/",
  route(async (req, res) => {
    limit(req);

    const siteKey = typeof req.query["site"] === "string" ? req.query["site"].trim() : "";
    const site = siteKey ? await prisma.site.findUnique({ where: { siteKey }, select: { id: true } }) : null;
    if (!site) throw notFound("site_not_found");

    const assetId = typeof req.query["asset"] === "string" ? req.query["asset"].trim() : "";
    const [pricing, settings, asset] = await Promise.all([
      publicPricing(site.id, null),
      loadSiteSettings(site.id),
      assetId ? publicAsset(site.id, assetId, null).then((found) => found.asset).catch(() => null) : Promise.resolve(null),
    ]);

    res.setHeader("Cache-Control", "public, max-age=15");
    ok(res, {
      pricing,
      profileFields: publicFieldDefinitions(settings.customFields),
      asset,
    });
  })
);
