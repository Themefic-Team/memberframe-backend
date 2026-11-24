/**
 * GET /api/plugin/announcement: the promo campaign card on the panel's Home
 * (37-promo-campaign-card.md).
 *
 * Public on purpose, and its own router: the card shows before sign in too
 * (as in Hydra Booking), so it must not sit behind `pluginBillingRouter`'s
 * creatorAuth. It answers only what env holds, the same for every caller, and
 * never cached so a changed campaign shows on the next Home visit.
 */

import { Router } from "express";
import { ok, route } from "../middleware/errors.js";
import { announcementView } from "../services/license/announcement.js";

export const pluginAnnouncementRouter = Router();

pluginAnnouncementRouter.get(
  "/announcement",
  route(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    ok(res, { ...announcementView() });
  })
);
