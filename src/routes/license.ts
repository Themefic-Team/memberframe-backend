/**
 * GET /api/license?site=<siteKey>. F19, 19-pro-lock-and-trial.md section 3.
 *
 * What a canvas component reads to decide between the trial watermark, no
 * mark, and the blurred lock. Public and read-only, like /api/preview: the
 * site key is already baked into every published component, and the answer is
 * one word that a visitor can see on the page anyway. A creator who strips the
 * lock out of the code file gains nothing: the member API refuses an
 * unlicensed site on its own (`middleware/license.ts`).
 */

import { Router, type Request } from "express";
import { prisma } from "../config/db.js";
import { notFound, ok, rateLimited, route } from "../middleware/errors.js";
import { clientIp, hit } from "../middleware/rateLimit.js";
import { siteLicense } from "../services/license/licenseService.js";

export const licenseRouter = Router();

const LICENSE_LIMIT_PER_MINUTE = 240;

function limit(req: Request): void {
  const decision = hit(`license:${clientIp(req)}`, LICENSE_LIMIT_PER_MINUTE, 60);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

/** The three states a component draws. Everything that is not licensed is locked. */
export function publicLicenseState(state: string): "trial" | "active" | "expired" {
  return state === "active" ? "active" : state === "trial" ? "trial" : "expired";
}

licenseRouter.get(
  "/",
  route(async (req, res) => {
    limit(req);
    const siteKey = typeof req.query["site"] === "string" ? req.query["site"].trim() : "";
    const site = siteKey ? await prisma.site.findUnique({ where: { siteKey }, select: { id: true } }) : null;
    if (!site) throw notFound("site_not_found");

    const license = await siteLicense(site.id);
    res.setHeader("Cache-Control", "public, max-age=60");
    ok(res, { state: publicLicenseState(license.state) });
  })
);
