/**
 * The connect handshake. How a Framer project becomes a tenant.
 *
 * This is the first thing a creator does and nothing else in the plugin works
 * until it succeeds: the Builder tab has no site key to bake into a component,
 * the Manage tab has no site to list members of, and the Settings tab has no
 * document to write.
 *
 * Four endpoints, and only `/session` and `/disconnect` need a token:
 *
 *   POST /api/connect/start      send a six-digit code to a typed address
 *   POST /api/connect/verify     check it, claim the project, return a token
 *   GET  /api/connect/session    who am I, and which site is this
 *   POST /api/connect/disconnect revoke this panel's token
 *
 * The reasoning for two steps rather than one is in `creatorAuthService.ts`.
 * In short: the plugin cannot learn the creator's email from the Framer SDK
 * (blocker B7), so the address is typed, and a typed address is a claim. The
 * code is what turns it into a fact.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { ok, okEmpty, route } from "../middleware/errors.js";
import { bearerToken, creatorAuth, requireCreator } from "../middleware/creator.js";
import { guardEmailSend } from "../middleware/rateLimit.js";
import {
  attachProject,
  revokeCreatorSession,
  startConnect,
  verifyConnect,
} from "../services/creatorAuthService.js";
import { claimHandoff, isValidSessionId } from "../services/creatorHandoffService.js";
import { resolveLicense } from "../services/license/licenseService.js";
import { startTrialIfEligible } from "../services/license/trialService.js";
import { trialStartedMail } from "../services/license/licenseMail.js";
import { sendMail } from "../lib/mailer.js";
import { withDefaults } from "../lib/siteSettings.js";
import { withoutSecrets } from "../services/integrationSecrets.js";

export const connectRouter = Router();

/**
 * A Framer project id.
 *
 * Opaque to us: whatever `framer.getProjectInfo()` reports. Bounded and
 * restricted to characters that can appear in an identifier, so it cannot be
 * used to smuggle anything into a log line or a query.
 */
const framerProjectId = z
  .string({ required_error: "A Framer project id is required." })
  .trim()
  .min(1, "A Framer project id is required.")
  .max(255, "That project id is too long.")
  .regex(/^[A-Za-z0-9_-]+$/, "That does not look like a Framer project id.");

const email = z
  .string({ required_error: "An email address is required." })
  .trim()
  .min(3, "That is too short to be an email address.")
  .max(254, "That is longer than any real email address.")
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "That does not look like an email address.");

const startSchema = z.object({ email, framerProjectId });

const verifySchema = z.object({
  email,
  framerProjectId,
  code: z
    .string({ required_error: "A code is required." })
    .trim()
    .regex(/^\d{6}$/, "A code is six digits."),
  projectName: z.string().trim().max(255).default(""),
  creatorName: z.string().trim().max(255).nullish().transform((value) => value ?? null),
  // Where this site will be served from. The plugin reports what it can see,
  // and a creator adds the rest later from the Connect tab.
  origins: z.array(z.string().max(2048)).max(25).optional().default([]),
});

// ============================================================================
// POST /api/connect/start
// ============================================================================

connectRouter.post(
  "/start",
  route(async (req, res) => {
    const input = startSchema.parse(req.body);

    // Per address and per IP. This endpoint sends mail to an address the caller
    // chose, which makes it the one place in the API that could be turned into
    // a mail cannon pointed at a third party.
    guardEmailSend(req, "connect", input.email);

    await startConnect(input);

    // No body. There is nothing to say that would be the same for a creator who
    // mistyped their address and one who did not, and anything else would make
    // this endpoint an oracle for whether an account exists.
    okEmpty(res);
  })
);

// ============================================================================
// POST /api/connect/verify
// ============================================================================

connectRouter.post(
  "/verify",
  route(async (req, res) => {
    const input = verifySchema.parse(req.body);

    const result = await verifyConnect({
      ...input,
      userAgent: req.header("user-agent"),
      ipAddress: req.ip,
    });

    const settings = await prisma.siteSettings.findUnique({
      where: { siteId: result.site.siteId },
      select: { settings: true, version: true },
    });

    // The token is in the body, not a cookie. See `middleware/creator.ts`:
    // the panel is an iframe on an origin we do not control, and a cross-site
    // cookie there would meet the Safari blocking that backend PRD section 2.3
    // calls the project's largest risk.
    ok(res, {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      creator: { email: result.user.email, name: result.user.name },
      site: result.site,
      settings: withoutSecrets(withDefaults(settings?.settings)),
      settingsVersion: settings?.version ?? 1,
    });
  })
);

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
    const claimed = await claimHandoff(id, { userAgent: req.header("user-agent"), ipAddress: req.ip });
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
// After the hand-off: this Framer project, claimed for the signed-in creator
// (first claim wins, as /verify), its 7-day trial started if they have never
// had one, and its license.

const attachSchema = z.object({
  framerProjectId,
  framerUserId: z.string().trim().max(255).nullish().transform((value) => value || null),
  projectName: z.string().trim().max(255).default(""),
  origins: z.array(z.string().max(2048)).max(25).optional().default([]),
});

connectRouter.post(
  "/attach-project",
  creatorAuth,
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = attachSchema.parse(req.body);

    const site = await attachProject(creator.userId, input);

    if (input.framerUserId) {
      // Best effort, and only filled once: what Framer reports is a hint for
      // trial eligibility, never an identity (blocker B7).
      await prisma.user.updateMany({
        where: { id: creator.userId, framerUserId: null },
        data: { framerUserId: input.framerUserId },
      });
    }

    let license = await resolveLicense(site.siteId);
    if (license.state === "none") {
      const trial = await startTrialIfEligible({
        userId: creator.userId,
        email: creator.email,
        framerUserId: input.framerUserId,
        framerProjectId: input.framerProjectId,
        siteId: site.siteId,
        projectName: site.siteName,
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
        framerSiteId: true,
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
        framerProjectId: site.framerSiteId,
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
