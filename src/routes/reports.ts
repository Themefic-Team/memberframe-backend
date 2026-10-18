/**
 * The creator's reports. Development doc:
 * memberframe/docs/development-docs/24-reports.md
 *
 *   GET /api/site/reports/overview?siteId&mode&period
 *   GET /api/site/reports/subscriptions?siteId&mode&status&tier&page&pageSize
 *   GET /api/site/reports/payments?siteId&mode&period&tier&memberId&page&pageSize
 *   GET /api/site/reports/members/:memberId?siteId&mode
 *
 * Creator only, like the rest of /api/site: the panel's bearer token, checked
 * against the site's owner. Read only.
 */

import { Router } from "express";
import { z } from "zod";
import { badRequest, ok, route } from "../middleware/errors.js";
import { creatorAuth, requireCreator } from "../middleware/creator.js";
import { requireOwnedSite } from "../services/creatorAuthService.js";
import {
  REPORT_EXPORT_MAX,
  REPORT_PAGE_SIZE,
  memberHistory,
  overviewReport,
  paymentList,
  subscriptionList,
} from "../services/reportService.js";

export const reportsRouter = Router();
reportsRouter.use(creatorAuth);

const base = z.object({
  siteId: z.string().trim().min(1).max(36),
  mode: z.enum(["live", "test"]).default("live"),
});
const period = z.enum(["30d", "90d", "12m", "all"]).default("30d");
const paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(REPORT_EXPORT_MAX).default(REPORT_PAGE_SIZE),
};
const tierKey = z.string().trim().max(50).regex(/^[a-z0-9_]*$/).default("");

reportsRouter.get(
  "/overview",
  route(async (req, res) => {
    const input = base.extend({ period }).parse(req.query);
    const site = await requireOwnedSite(requireCreator(req).userId, input.siteId);
    ok(res, await overviewReport(site.id, input.mode, input.period));
  })
);

reportsRouter.get(
  "/subscriptions",
  route(async (req, res) => {
    const input = base
      .extend({
        status: z.enum(["all", "paying", "active", "past_due", "canceling", "ended"]).default("all"),
        tier: tierKey,
        ...paging,
      })
      .parse(req.query);
    const site = await requireOwnedSite(requireCreator(req).userId, input.siteId);
    ok(res, await subscriptionList(site.id, input));
  })
);

reportsRouter.get(
  "/payments",
  route(async (req, res) => {
    const input = base
      .extend({ period, tier: tierKey, memberId: z.string().trim().max(36).default(""), ...paging })
      .parse(req.query);
    const site = await requireOwnedSite(requireCreator(req).userId, input.siteId);
    ok(res, await paymentList(site.id, input));
  })
);

reportsRouter.get(
  "/members/:memberId",
  route(async (req, res) => {
    const input = base.parse(req.query);
    const site = await requireOwnedSite(requireCreator(req).userId, input.siteId);
    const history = await memberHistory(site.id, String(req.params["memberId"] ?? ""), input.mode);
    if (!history) throw badRequest("member_not_found");
    ok(res, history);
  })
);
