/**
 * The connect handshake. How a Framer project becomes a tenant.
 *
 * This is the first thing a creator does and nothing else in the plugin works
 * until it succeeds: the Builder tab has no site key to bake into a component,
 * the Manage tab has no site to list members of, and the Settings tab has no
 * document to write.
 *
 *   GET  /api/connect/handoff        the panel's poll while the creator signs in
 *                                    on the hosted account page
 *   POST /api/connect/attach-project a site for this project, by `siteId`
 *   GET  /api/connect/session        who am I, and which sites are mine
 *   POST /api/connect/disconnect     revoke this panel's token
 *
 * Nothing from Framer reaches this server (Marketplace review, 2026-10-28,
 * memberframe/docs/development-docs/35-marketplace-review-report.md): no
 * Framer user, no project id or name, no published domain. The panel keeps the
 * site's id in the project's own plugin data and sends only that. The panel's
 * old code form (`/start` and `/verify`, which took a project id, a project
 * name, and the Framer user's name) is gone; sign in is the hosted page.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { ok, okEmpty, route } from "../middleware/errors.js";
import { bearerToken, creatorAuth, requireCreator } from "../middleware/creator.js";
import { attachProject, revokeCreatorSession } from "../services/creatorAuthService.js";
import { claimHandoff, isValidSessionId } from "../services/creatorHandoffService.js";
import { resolveLicense } from "../services/license/licenseService.js";
import { startTrialIfEligible } from "../services/license/trialService.js";
import { trialStartedMail } from "../services/license/licenseMail.js";
import { sendMail } from "../lib/mailer.js";
import { withDefaults } from "../lib/siteSettings.js";
import { withoutSecrets } from "../services/integrationSecrets.js";

export const connectRouter = Router();

// ============================================================================
// GET /api/connect/handoff  (F19, 19-pro-lock-and-trial.md 2.1)
// ============================================================================
// The panel's poll while the creator signs in on the hosted page in a new
// tab. "pending" until they do; then the session token, once.

connectRouter.get(
  "/handoff",
  route(async (req, res) => {
    const id = req.query["sessionId"];
    if (!isValidSessionId(id)) {
      ok(res, { status: "pending" });
      return;
    }
    const claimed = await claimHandoff(id, { userAgent: req.header("user-agent") });
    if (!claimed) {
      ok(res, { status: "pending" });
      return;
    }
    ok(res, {
      status: "ready",
      token: claimed.token,
      expiresAt: claimed.expiresAt.toISOString(),
      creator: claimed.creator,
    });
  })
);

// ============================================================================
// POST /api/connect/attach-project  (F19)
// ============================================================================
// After the hand-off: a site for this Framer project, its 7-day trial started
// if the creator never had one, and its license.
//
// The panel sends the site id it keeps in the project's plugin data, or
// nothing for a project that never had a site, or a copy of one (the panel
// tells a copy apart itself, inside Framer). That id is the only thing about
// the project this server learns. Unknown keys an older panel may still send
// (a project id, its name, the Framer user, domains) are dropped by the schema
// and never stored.

const attachSchema = z.object({
  siteId: z.string().trim().min(1).max(36).optional(),
});

connectRouter.post(
  "/attach-project",
  creatorAuth,
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = attachSchema.parse(req.body);

    const site = await attachProject(creator.userId, input);

    let license = await resolveLicense(site.siteId);
    if (license.state === "none") {
      const trial = await startTrialIfEligible({
        userId: creator.userId,
        email: creator.email,
        siteId: site.siteId,
      });
      if (trial.started) {
        void sendMail(trialStartedMail(creator.email, site.siteName, trial.endsAt, creator.name));
      }
      license = await resolveLicense(site.siteId);
    }

    const settings = await prisma.siteSettings.findUnique({
      where: { siteId: site.siteId },
      select: { settings: true, version: true },
    });

    ok(res, {
      creator: { email: creator.email, name: creator.name },
      site,
      settings: withoutSecrets(withDefaults(settings?.settings)),
      settingsVersion: settings?.version ?? 1,
      license,
    });
  })
);

// ============================================================================
// GET /api/connect/session
// ============================================================================
// What the panel calls on open, to find out whether the stored token still
// works. A 401 here is the ordinary answer for a panel that has never been
// connected, and it renders the connect form rather than an error.

connectRouter.get(
  "/session",
  creatorAuth,
  route(async (req, res) => {
    const creator = requireCreator(req);

    const sites = await prisma.site.findMany({
      where: { userId: creator.userId },
      select: {
        id: true,
        siteKey: true,
        siteName: true,
        allowedOrigins: true,
        settings: { select: { settings: true, version: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    ok(res, {
      creator: { email: creator.email, name: creator.name },
      sites: sites.map((site) => ({
        siteId: site.id,
        siteKey: site.siteKey,
        siteName: site.siteName,
        allowedOrigins: Array.isArray(site.allowedOrigins) ? site.allowedOrigins : [],
        memberCount: site._count.members,
        settings: withoutSecrets(withDefaults(site.settings?.settings)),
        settingsVersion: site.settings?.version ?? 1,
      })),
    });
  })
);

// ============================================================================
// POST /api/connect/disconnect
// ============================================================================
// Revokes this panel's token and nothing else. It does NOT delete the site,
// the members, or the settings, and the copy in the panel says so: a creator
// who expected "disconnect" to mean "remove MemberFrame from this project"
// would otherwise find their member list intact and be unsure what happened.

connectRouter.post(
  "/disconnect",
  route(async (req, res) => {
    await revokeCreatorSession(bearerToken(req));
    okEmpty(res);
  })
);
