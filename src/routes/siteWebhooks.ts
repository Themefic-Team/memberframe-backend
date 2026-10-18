/**
 * /api/site/webhooks: the creator's webhooks. Development doc:
 * memberframe/docs/development-docs/20-webhooks.md
 *
 * Mounted under the creator router, so creator authentication has already run.
 * Every lookup is scoped by site id in the same query, for the reason
 * routes/site.ts gives: a webhook of another creator's site is simply not found.
 */

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { badRequest, notFound, ok, route } from "../middleware/errors.js";
import { requireCreator } from "../middleware/creator.js";
import { requireOwnedSite } from "../services/creatorAuthService.js";
import { sendTestEvent } from "../services/webhookService.js";
import {
  FIELD_SOURCES,
  MAX_FIELD_MAP,
  MAX_WEBHOOKS_PER_SITE,
  WEBHOOK_EVENTS,
  fieldMapProblem,
  generateWebhookSecret,
  webhookUrlProblem,
  type FieldMapping,
} from "../lib/webhooks.js";

export const webhookRouter = Router();

const siteIdSchema = z.string().trim().min(1).max(36);
const TIER_KEY = /^[a-z][a-z0-9_]{1,49}$/;

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(1000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  tiers: z.array(z.string().trim().regex(TIER_KEY)).max(50).default([]),
  enabled: z.boolean().default(true),
  /** Null or empty sends the standard payload. */
  fieldMap: z
    .array(z.object({ source: z.string().trim().max(60), key: z.string().trim().max(64) }))
    .max(MAX_FIELD_MAP)
    .nullable()
    .default(null),
});

const createSchema = fieldsSchema.extend({ siteId: siteIdSchema });
const updateSchema = fieldsSchema.partial().extend({ siteId: siteIdSchema });

/** Refuse a mapping that is not well formed, with a sentence the panel can show. */
function checkFieldMap(map: ReadonlyArray<FieldMapping> | null | undefined): void {
  if (!map) return;
  const problem = fieldMapProblem(map);
  if (problem) throw badRequest("invalid_field_map", { message: problem });
}

/** Refuse a URL our server must not call, with a sentence the panel can show. */
function checkUrl(url: string): void {
  const problem = webhookUrlProblem(url, env.isProduction);
  if (problem) throw badRequest("invalid_webhook_url", { message: problem });
}

const WEBHOOK_SELECT = {
  id: true,
  name: true,
  url: true,
  events: true,
  tiers: true,
  enabled: true,
  fieldMap: true,
  secret: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The latest delivery per webhook, for the status shown on each card. */
async function lastDeliveries(webhookIds: string[]) {
  const latest = await Promise.all(
    webhookIds.map((id) =>
      prisma.outboundDelivery.findFirst({
        where: { webhookId: id },
        orderBy: { createdAt: "desc" },
        select: { webhookId: true, event: true, status: true, lastStatus: true, lastError: true, createdAt: true },
      })
    )
  );
  return new Map(latest.filter((entry) => entry !== null).map((entry) => [entry!.webhookId, entry!]));
}

webhookRouter.get(
  "/",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdSchema.parse(req.query["siteId"]));

    const hooks = await prisma.outboundWebhook.findMany({
      where: { siteId: site.id },
      orderBy: { createdAt: "asc" },
      select: WEBHOOK_SELECT,
    });
    const latest = await lastDeliveries(hooks.map((hook) => hook.id));

    ok(res, {
      webhooks: hooks.map((hook) => ({ ...hook, lastDelivery: latest.get(hook.id) ?? null })),
      events: WEBHOOK_EVENTS,
      fieldSources: FIELD_SOURCES,
      limit: MAX_WEBHOOKS_PER_SITE,
    });
  })
);

webhookRouter.post(
  "/",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = createSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);
    checkUrl(input.url);
    checkFieldMap(input.fieldMap);

    const count = await prisma.outboundWebhook.count({ where: { siteId: site.id } });
    if (count >= MAX_WEBHOOKS_PER_SITE) throw badRequest("webhook_limit", { limit: MAX_WEBHOOKS_PER_SITE });

    const webhook = await prisma.outboundWebhook.create({
      data: {
        siteId: site.id,
        name: input.name,
        url: input.url,
        events: input.events,
        tiers: input.tiers,
        enabled: input.enabled,
        fieldMap: input.fieldMap && input.fieldMap.length > 0 ? input.fieldMap : Prisma.DbNull,
        secret: generateWebhookSecret(),
      },
      select: WEBHOOK_SELECT,
    });

    ok(res, { webhook: { ...webhook, lastDelivery: null } });
  })
);

webhookRouter.patch(
  "/:id",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = updateSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);
    if (input.url !== undefined) checkUrl(input.url);
    checkFieldMap(input.fieldMap);

    const existing = await prisma.outboundWebhook.findFirst({
      where: { id: String(req.params["id"] ?? ""), siteId: site.id },
      select: { id: true },
    });
    if (!existing) throw notFound("webhook_not_found");

    const webhook = await prisma.outboundWebhook.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(input.tiers !== undefined ? { tiers: input.tiers } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.fieldMap !== undefined
          ? { fieldMap: input.fieldMap && input.fieldMap.length > 0 ? input.fieldMap : Prisma.DbNull }
          : {}),
      },
      select: WEBHOOK_SELECT,
    });
    const latest = await lastDeliveries([webhook.id]);

    ok(res, { webhook: { ...webhook, lastDelivery: latest.get(webhook.id) ?? null } });
  })
);

webhookRouter.delete(
  "/:id",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdSchema.parse(req.query["siteId"]));

    const deleted = await prisma.outboundWebhook.deleteMany({
      where: { id: String(req.params["id"] ?? ""), siteId: site.id },
    });
    if (deleted.count === 0) throw notFound("webhook_not_found");

    ok(res, { deleted: true });
  })
);

webhookRouter.post(
  "/:id/test",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdSchema.parse(req.body?.["siteId"]));

    const result = await sendTestEvent(String(req.params["id"] ?? ""), site.id);
    if (!result) throw notFound("webhook_not_found");

    ok(res, { result });
  })
);

webhookRouter.get(
  "/:id/deliveries",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdSchema.parse(req.query["siteId"]));

    const deliveries = await prisma.outboundDelivery.findMany({
      where: { webhookId: String(req.params["id"] ?? ""), siteId: site.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        lastStatus: true,
        lastError: true,
        nextAttemptAt: true,
        createdAt: true,
        deliveredAt: true,
      },
    });

    ok(res, { deliveries });
  })
);
