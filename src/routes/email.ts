/**
 * A site's own SMTP, from the panel. Development doc: 25-custom-smtp.md.
 *
 * The settings themselves are saved through the settings document like any
 * integration. These two routes are what the document cannot answer: whether
 * the last send through the site's server worked, and a test send.
 */

import { Router } from "express";
import { z } from "zod";
import { ok, rateLimited, route } from "../middleware/errors.js";
import { creatorAuth, requireCreator } from "../middleware/creator.js";
import { hit } from "../middleware/rateLimit.js";
import { requireOwnedSite } from "../services/creatorAuthService.js";
import { loadSiteSender, SITE_SMTP_DRIVER, sendWithSiteSmtp, smtpTestMail } from "../lib/mailer.js";
import { loadSiteSettings } from "../services/settingsService.js";
import { SITE_SMTP_ID } from "../lib/siteSmtp.js";
import { prisma } from "../config/db.js";

export const emailRouter = Router();
emailRouter.use(creatorAuth);

/** Test sends per site, per window. Each one opens a connection to a host the creator chose. */
export const TEST_SENDS_PER_WINDOW = 5;
const TEST_WINDOW_SECONDS = 600;

const siteId = z.string().trim().min(1).max(36);

emailRouter.get(
  "/status",
  route(async (req, res) => {
    const input = z.object({ siteId }).parse(req.query);
    const site = await requireOwnedSite(requireCreator(req).userId, input.siteId);

    const settings = await loadSiteSettings(site.id);
    const entry = settings.integrations[SITE_SMTP_ID];
    const last = await prisma.emailLog.findFirst({
      where: { siteId: site.id, driver: SITE_SMTP_DRIVER },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, sentAt: true, error: true },
    });

    ok(res, {
      enabled: entry?.enabled === true,
      configured: (await loadSiteSender(site.id)) !== null,
      last: last ? { at: last.createdAt.toISOString(), sent: last.sentAt !== null, error: last.error } : null,
    });
  })
);

emailRouter.post(
  "/test",
  route(async (req, res) => {
    const input = z.object({ siteId, to: z.string().trim().toLowerCase().email().max(254) }).parse(req.body);
    const site = await requireOwnedSite(requireCreator(req).userId, input.siteId);

    const decision = hit(`smtp-test:${site.id}`, TEST_SENDS_PER_WINDOW, TEST_WINDOW_SECONDS);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);

    const result = await sendWithSiteSmtp(site.id, smtpTestMail(input.to, site.siteName, site.id));
    ok(res, result.sent ? { sent: true } : { sent: false, error: result.error ?? "The email was not sent." });
  })
);
