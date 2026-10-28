/**
 * GET /api/license?site=<siteKey>. F19, 19-pro-lock-and-trial.md section 3.
 *
 * What a canvas component reads to decide between the trial watermark, no
 * mark, and the blurred lock. Public and read-only, like /api/preview: the
 * site key is already baked into every published component, and the answer is
 * one word that a visitor can see on the page anyway. A creator who strips the
 * lock out of the code file gains nothing: the member API refuses an
 * unlicensed site on its own (`middleware/license.ts`).
 *
 * A trial answer also carries `trialEndsAt`, so the component locks itself at
 * the second the trial ends, like BEAF's countdown, instead of at its next check.
 *
 * Since 27-instance-seal.md it also says whether this copy of the component
 * may run at all: `copied` when its seal is missing or was not signed for this
 * site (pasted, not inserted from the Builder), `foreign` when the page is on
 * a domain that is neither the Framer editor nor one of the site's own.
 */

import { Router, type Request } from "express";
import { prisma } from "../config/db.js";
import { notFound, ok, rateLimited, route } from "../middleware/errors.js";
import { clientIp, hit } from "../middleware/rateLimit.js";
import { siteLicense } from "../services/license/licenseService.js";
import { verifySeal } from "../lib/instanceSeal.js";
import { isEditorHost } from "../lib/siteLinks.js";
import { originAllowed, parseAllowedOrigins } from "../middleware/site.js";
import { noteOrigin } from "../lib/originSightings.js";

export const licenseRouter = Router();

const LICENSE_LIMIT_PER_MINUTE = 240;

function limit(req: Request): void {
  const decision = hit(`license:${clientIp(req)}`, LICENSE_LIMIT_PER_MINUTE, 60);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

/** The three license states a component draws. Everything that is not licensed is locked. */
export function publicLicenseState(state: string): "trial" | "active" | "expired" {
  return state === "active" ? "active" : state === "trial" ? "trial" : "expired";
}

export type ComponentState = "trial" | "active" | "expired" | "copied" | "foreign";

/**
 * Whether the page asking may run this site's components: no Origin (not a
 * browser page), an opaque one (a sandboxed canvas frame), a Framer editor
 * host, or one of the site's own domains.
 */
export function originBelongs(origin: string | undefined, allowedOrigins: unknown): boolean {
  if (origin === undefined || origin === "" || origin === "null") return true;
  try {
    if (isEditorHost(new URL(origin).hostname)) return true;
  } catch {
    return false;
  }
  return originAllowed(origin, parseAllowedOrigins(allowedOrigins));
}

/**
 * What one component instance draws. A copy is refused before the license is
 * read: "insert it from the plugin" is the message that applies, whatever the
 * plan. `seal` is undefined for a component built before seals existed, which
 * sends none; it is held to the license alone until the plugin seals it.
 */
export function componentState(input: {
  license: string;
  seal: string | undefined;
  sealValid: boolean;
  originOk: boolean;
}): ComponentState {
  if (!input.originOk) return "foreign";
  if (input.seal !== undefined && !input.sealValid) return "copied";
  return publicLicenseState(input.license);
}

/**
 * The body a component reads. A trial's end goes with a trial answer only: the
 * component counts down to it and locks at that second without a reload, as
 * BEAF's slider does. Every other answer is the state alone.
 */
export function licenseAnswer(state: ComponentState, trialEndsAt: string | null): { state: ComponentState; trialEndsAt?: string } {
  return state === "trial" && trialEndsAt ? { state, trialEndsAt } : { state };
}

licenseRouter.get(
  "/",
  route(async (req, res) => {
    limit(req);
    const siteKey = typeof req.query["site"] === "string" ? req.query["site"].trim() : "";
    const site = siteKey
      ? await prisma.site.findUnique({ where: { siteKey }, select: { id: true, allowedOrigins: true } })
      : null;
    if (!site) throw notFound("site_not_found");
    // Every component asks this on load: the clearest sign of where the site
    // is really published (Profile, Site Domains). Recorded, never trusted.
    noteOrigin(site.id, req.header("origin"));

    const seal = typeof req.query["seal"] === "string" ? req.query["seal"].trim() : undefined;
    const license = await siteLicense(site.id);
    // The answer depends on the page's origin, so a shared cache must key on it.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("Vary", "Origin");
    const state = componentState({
      license: license.state,
      seal,
      sealValid: seal !== undefined && verifySeal(site.id, seal),
      originOk: originBelongs(req.header("origin"), site.allowedOrigins),
    });
    ok(res, licenseAnswer(state, license.trialEndsAt));
  })
);
