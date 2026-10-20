/**
 * The creator-facing routes. PRD section 10.3.
 *
 * Everything here is behind `creatorAuth` and every handler resolves the site
 * through `requireOwnedSite`, which answers 404 rather than 403 when the site
 * belongs to someone else. That is the cross-tenant rule from the backend PRD:
 * a 403 would confirm the row exists, turning a site id into something worth
 * guessing.
 *
 * These are the endpoints `src/services/siteService.ts` has been calling since
 * task 2.2, into nothing. The shapes below are that file's types, honoured
 * field for field, because the plugin's Manage and Settings tabs are already
 * written against them.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { badRequest, ok, route } from "../middleware/errors.js";
import { creatorAuth, requireCreator } from "../middleware/creator.js";
import { guardEmailSend } from "../middleware/rateLimit.js";
import { issueMagicLink, restoreMemberAccess, revokeMemberAccess } from "../services/memberAccessService.js";
import { webhookRouter } from "./siteWebhooks.js";
import { MEMBER_SNAPSHOT_SELECT, emitMemberEvent } from "../services/webhookService.js";
import {
  mergeOrigins,
  normalizeOrigins,
  requireOwnedSite,
} from "../services/creatorAuthService.js";
import { invalidateSiteSettings, loadSiteSettings } from "../services/settingsService.js";
import { applyMetadata } from "../lib/memberMetadata.js";
import { currencySchema } from "../lib/currencies.js";
import { FREE_TIER_RANK, tierPriceProblem, type TierPriceInput } from "../lib/tiers.js";
import { readTierFeatures, tierFeaturesSchema } from "../lib/tierFeatures.js";
import { loadPaymentSettings } from "../services/payments/gatewayStore.js";
import { storePatchSecrets, takePatchSecrets, withoutSecrets } from "../services/integrationSecrets.js";
import {
  mergeSettings,
  toJsonDocument,
  validatePatch,
  withDefaults,
} from "../lib/siteSettings.js";

export const siteRouter = Router();

siteRouter.use(creatorAuth);

// Webhooks: member events posted to the creator's own URLs.
siteRouter.use("/webhooks", webhookRouter);

/** PRD section 10.3 paginates members at 25. The plugin's `MEMBER_PAGE_SIZE`. */
const PAGE_SIZE = 25;

const siteIdSchema = z
  .string({ required_error: "A site id is required." })
  .trim()
  .min(1)
  .max(36);

/**
 * Read the site id a creator-facing request is scoped to.
 *
 * Every route takes one, and there is no "current site" on the session: a
 * creator may own several, the panel knows which Framer project is open, and
 * a server-side notion of "current" would be wrong the moment two panels are
 * open on two projects.
 */
function siteIdFrom(value: unknown): string {
  const parsed = siteIdSchema.safeParse(value);
  if (!parsed.success) throw badRequest("missing_site_id");
  return parsed.data;
}

// ============================================================================
// GET /api/site/members
// ============================================================================
// What the Manage tab lists. This is the endpoint that makes a registration
// visible to the creator: a visitor signs up through `<MemberAuth>` on the
// published site, and the row appears here.

const memberQuerySchema = z.object({
  siteId: siteIdSchema,
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  search: z.string().trim().max(255).optional(),
  tier: z.string().trim().max(50).optional(),
  status: z.enum(["active", "trialing", "past_due", "canceled"]).optional(),
});

siteRouter.get(
  "/members",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const query = memberQuerySchema.parse(req.query);
    const site = await requireOwnedSite(creator.userId, query.siteId);

    // `deletedAt: null` is not optional and not a nicety. A soft-deleted member
    // is deleted as far as the creator is concerned, and the row survives only
    // so invoice history has something to point at.
    const where = {
      siteId: site.id,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.tier ? { activeTier: query.tier } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search } },
              { name: { contains: query.search } },
            ],
          }
        : {}),
    };

    const [totalCount, rows] = await Promise.all([
      prisma.member.count({ where }),
      prisma.member.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          activeTier: true,
          status: true,
          createdAt: true,
          metadata: true,
        },
      }),
    ]);

    // FP-09. Through `applyMetadata` with an empty patch rather than returned
    // raw, so the flyout sees exactly what the member's own profile form sees:
    // no value for a deleted field and none for a field whose condition is not
    // met. One settings read per page, not per member.
    const settings = await loadSiteSettings(site.id);
    const metadataOf = (stored: unknown) =>
      applyMetadata(settings.customFields, stored, {}).metadata;

    // FP-16. Lifetime spend from paid charges, and the gateway of each
    // member's latest purchase. Two grouped reads for the page, not one per row.
    const memberIds = rows.map((row) => row.id);
    const [spend, latest, payments] = await Promise.all([
      prisma.payment.groupBy({
        by: ["memberId", "currency"],
        where: { siteId: site.id, memberId: { in: memberIds }, status: "paid" },
        _sum: { amountMinor: true },
      }),
      prisma.subscription.findMany({
        where: { siteId: site.id, memberId: { in: memberIds } },
        orderBy: { createdAt: "desc" },
        select: { memberId: true, gateway: true },
      }),
      loadPaymentSettings(site.id),
    ]);
    // A member who has paid nothing shows 0 in the site currency, not USD:
    // one currency per site (23-dynamic-tiers.md).
    const spendOf = (memberId: string) => {
      const rowsFor = spend.filter((entry) => entry.memberId === memberId);
      const top = rowsFor.sort((a, b) => (b._sum.amountMinor ?? 0) - (a._sum.amountMinor ?? 0))[0];
      return { amount: top?._sum.amountMinor ?? 0, currency: top?.currency ?? payments.defaultCurrency };
    };
    const gatewayOf = (memberId: string) =>
      latest.find((entry) => entry.memberId === memberId)?.gateway ?? "stripe";

    ok(res, {
      members: rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        avatarUrl: row.avatarUrl,
        tier: row.activeTier,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        lifetimeSpend: spendOf(row.id).amount,
        currency: spendOf(row.id).currency,
        gateway: gatewayOf(row.id),
        metadata: metadataOf(row.metadata),
      })),
      page: query.page,
      pageSize: PAGE_SIZE,
      totalCount,
    });
  })
);

// ============================================================================
// PATCH /api/site/members/:id
// ============================================================================
// Change tier, grant, or revoke. One endpoint for all three, because PRD
// section 10.3 has exactly one and the panel's "Grant VIP" is a tier change
// with a fixed argument.

const memberPatchSchema = z
  .object({
    siteId: siteIdSchema,
    tier: z.string().trim().max(50).optional(),
    status: z.enum(["active", "trialing", "past_due", "canceled"]).optional(),
  })
  .refine((value) => value.tier !== undefined || value.status !== undefined, {
    message: "Nothing to change.",
  });

siteRouter.patch(
  "/members/:id",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = memberPatchSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);

    const memberId = String(req.params["id"] ?? "");

    // Scoped by site id in the same query, not checked afterwards. A find
    // followed by an ownership check is the same thing with a window between
    // the two, and this way a member of another creator's site simply is not
    // found.
    const member = await prisma.member.findFirst({
      where: { id: memberId, siteId: site.id, deletedAt: null },
      select: { id: true, activeTier: true, status: true },
    });

    if (!member) throw badRequest("member_not_found");

    if (input.tier !== undefined) {
      // A tier the site does not have would make every gate deny this member,
      // silently, because `isEntitled` looks the key up and finds nothing.
      const tier = await prisma.tier.findFirst({
        where: { siteId: site.id, key: input.tier },
        select: { id: true },
      });

      if (!tier) throw badRequest("unknown_tier");
    }

    const updated = await prisma.member.update({
      where: { id: member.id },
      data: {
        ...(input.tier !== undefined ? { activeTier: input.tier } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        activeTier: true,
        status: true,
        createdAt: true,
        metadata: true,
      },
    });

    if (input.tier !== undefined && input.tier !== member.activeTier) {
      void emitMemberEvent("member.tier_changed", { id: member.id, siteId: site.id }, { previousTier: member.activeTier });
    } else if (input.status !== undefined && input.status !== member.status) {
      void emitMemberEvent("member.updated", { id: member.id, siteId: site.id });
    }

    // Returned so the panel can replace its row wholesale after a tier change
    // without the flyout losing the member's profile values.
    const settings = await loadSiteSettings(site.id);

    ok(res, {
      member: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        avatarUrl: updated.avatarUrl,
        tier: updated.activeTier,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
        lifetimeSpend: 0,
        currency: (await loadPaymentSettings(site.id)).defaultCurrency,
        gateway: "stripe",
        metadata: applyMetadata(settings.customFields, updated.metadata, {}).metadata,
      },
    });
  })
);

// ============================================================================
// POST /api/site/members/:id/revoke, /restore, /magic-link
// ============================================================================
// Development doc 26-magic-link-and-revoke.md. Revoke ends the member's
// subscriptions at the gateway too, so it is its own route rather than the
// PATCH's `status: canceled`, which only changes this record.

const memberActionSchema = z.object({ siteId: siteIdSchema });

/** The member as the PATCH above answers it, so the panel can replace its row. */
async function memberRecord(siteId: string, memberId: string) {
  const member = await prisma.member.findFirstOrThrow({
    where: { id: memberId, siteId },
    select: { id: true, email: true, name: true, avatarUrl: true, activeTier: true, status: true, createdAt: true, metadata: true },
  });
  const settings = await loadSiteSettings(siteId);
  return {
    id: member.id,
    email: member.email,
    name: member.name,
    avatarUrl: member.avatarUrl,
    tier: member.activeTier,
    status: member.status,
    createdAt: member.createdAt.toISOString(),
    lifetimeSpend: 0,
    currency: (await loadPaymentSettings(siteId)).defaultCurrency,
    gateway: "stripe",
    metadata: applyMetadata(settings.customFields, member.metadata, {}).metadata,
  };
}

siteRouter.post(
  "/members/:id/revoke",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = memberActionSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);
    const memberId = String(req.params["id"] ?? "");

    const result = await revokeMemberAccess(site.id, memberId);
    ok(res, { member: await memberRecord(site.id, memberId), ...result });
  })
);

siteRouter.post(
  "/members/:id/restore",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = memberActionSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);
    const memberId = String(req.params["id"] ?? "");

    await restoreMemberAccess(site.id, memberId);
    ok(res, { member: await memberRecord(site.id, memberId) });
  })
);

siteRouter.post(
  "/members/:id/magic-link",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = memberActionSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);
    const memberId = String(req.params["id"] ?? "");

    const target = await prisma.member.findFirst({ where: { id: memberId, siteId: site.id }, select: { email: true } });
    if (target) guardEmailSend(req, "magic_link", target.email);

    const link = await issueMagicLink(site, memberId, { userAgent: "magic-link", ipAddress: req.ip });
    ok(res, { sent: true, expiresInMinutes: link.minutes });
  })
);

// ============================================================================
// DELETE /api/site/members/:id
// ============================================================================
// Removes a member for good, at the creator's request, from the Manage tab.
//
// A hard delete, not `deletedAt`: the creator asked for the member to be gone,
// and a soft-deleted row still holds the address, so the person could never
// sign up to this site again. Sessions, password resets, subscriptions,
// bookmarks, and meter cycles go with the row by cascade; pending sign-in
// codes are keyed by address, not member, so they are cleared explicitly.
// Payments and checkouts carry no foreign key to the member and are kept on
// purpose: they are the creator's revenue record, not the member's account.
//
// Nothing here cancels a subscription at the payment provider. The plugin's
// confirmation says so in as many words.

siteRouter.delete(
  "/members/:id",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdFrom(req.query["siteId"]));

    const memberId = String(req.params["id"] ?? "");

    // Scoped by site id in the same query, for the reason the PATCH above gives.
    const member = await prisma.member.findFirst({
      where: { id: memberId, siteId: site.id },
      select: MEMBER_SNAPSHOT_SELECT,
    });

    if (!member) throw badRequest("member_not_found");

    // Queued from the member as it is now: after the delete there is nothing
    // left to describe.
    await emitMemberEvent("member.deleted", member);

    await prisma.$transaction([
      prisma.memberOtp.deleteMany({ where: { siteId: site.id, email: member.email } }),
      prisma.member.delete({ where: { id: member.id } }),
    ]);

    ok(res, { deleted: true, id: member.id });
  })
);

// ============================================================================
// GET and POST and PATCH /api/site/tiers
// ============================================================================

siteRouter.get(
  "/tiers",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdFrom(req.query["siteId"]));

    const tiers = await prisma.tier.findMany({ where: { siteId: site.id }, orderBy: { rank: "asc" } });

    ok(res, {
      tiers: tiers.map((tier) => ({
        id: tier.id,
        siteId: tier.siteId,
        key: tier.key,
        name: tier.name,
        monthlyPriceMinor: tier.monthlyPriceMinor,
        annualPriceMinor: tier.annualPriceMinor,
        lifetimePriceMinor: tier.lifetimePriceMinor,
        currency: tier.currency,
        rank: tier.rank,
        isActive: tier.isActive,
        features: readTierFeatures(tier.features),
      })),
    });
  })
);

/**
 * A tier key: the ID the plugin makes from the tier's name when it is created
 * ("Gold Plus" becomes `gold_plus`), or a key an older tier already has.
 * Lowercase, digits, underscore, so it is safe in generated code, a URL, and a
 * JSON key alike. Development doc: 23-dynamic-tiers.md.
 */
const TIER_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

/** A price is above zero or absent. Zero is not a price: it read "$0.00 monthly" and sold nothing. */
const priceSchema = z.number().int().min(1).max(1_000_000_000).nullable().optional().default(null);

const tierBodySchema = z.object({
  siteId: siteIdSchema,
  key: z.string().trim().regex(TIER_KEY_PATTERN, "tier_key_invalid"),
  name: z.string().trim().min(1).max(100),
  monthlyPriceMinor: priceSchema,
  annualPriceMinor: priceSchema,
  lifetimePriceMinor: priceSchema,
  // Accepted and ignored: every tier is priced in the site currency.
  currency: z.string().optional(),
  rank: z.number().int().min(FREE_TIER_RANK).max(1000),
  isActive: z.boolean().default(true),
  // Absent on an update keeps the stored list (28-tier-features.md).
  features: tierFeaturesSchema.optional(),
});

/** The Free and paid tier price rules, in lib/tiers.ts. A problem is a 400 with its reason. */
function checkTierPrices(rank: number, prices: TierPriceInput): void {
  const problem = tierPriceProblem(rank, prices);
  if (problem) throw badRequest(problem);
}

siteRouter.post(
  "/tiers",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = tierBodySchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);
    checkTierPrices(input.rank, input);

    // The unique keys on (site, key) and (site, rank) are the real enforcement;
    // this check exists so the creator gets a readable answer rather than a
    // driver error. Two tiers sharing a rank makes Gold and Silver identical to
    // every gate on the site, with nothing raised anywhere. Rank 0 taken means
    // the site already has its one Free tier.
    const clash = await prisma.tier.findFirst({
      where: { siteId: site.id, OR: [{ key: input.key }, { rank: input.rank }] },
      select: { key: true, rank: true },
    });

    if (clash) {
      if (clash.key === input.key) throw badRequest("tier_key_taken");
      throw badRequest(input.rank === FREE_TIER_RANK ? "free_tier_exists" : "tier_rank_taken");
    }

    const { defaultCurrency } = await loadPaymentSettings(site.id);
    const tier = await prisma.tier.create({
      data: {
        siteId: site.id,
        key: input.key,
        name: input.name,
        monthlyPriceMinor: input.monthlyPriceMinor,
        annualPriceMinor: input.annualPriceMinor,
        lifetimePriceMinor: input.lifetimePriceMinor,
        currency: defaultCurrency,
        rank: input.rank,
        isActive: input.isActive,
        features: input.features ?? [],
      },
    });

    ok(res, { tier: { ...tier, features: readTierFeatures(tier.features) } });
  })
);

siteRouter.patch(
  "/tiers/:id",
  route(async (req, res) => {
    const creator = requireCreator(req);
    // `key` is absent on update by design: changing a tier's key orphans every
    // gate on the canvas that names it, because the key is baked into generated
    // component code. That is a migration, not an edit.
    const input = tierBodySchema.omit({ key: true }).parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);

    const tierId = String(req.params["id"] ?? "");

    const existing = await prisma.tier.findFirst({
      where: { id: tierId, siteId: site.id },
      select: { id: true, rank: true },
    });

    if (!existing) throw badRequest("tier_not_found");

    // The Free tier stays the Free tier, and a paid tier stays paid: members
    // start on and fall back to rank 0, so moving a tier onto or off it would
    // silently change where every new member lands.
    if ((existing.rank === FREE_TIER_RANK) !== (input.rank === FREE_TIER_RANK)) {
      throw badRequest("free_tier_is_fixed");
    }
    checkTierPrices(input.rank, input);

    const rankClash = await prisma.tier.findFirst({
      where: { siteId: site.id, rank: input.rank, NOT: { id: existing.id } },
      select: { id: true },
    });

    if (rankClash) throw badRequest("tier_rank_taken");

    const { defaultCurrency } = await loadPaymentSettings(site.id);
    const [tier] = await prisma.$transaction([
      prisma.tier.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          monthlyPriceMinor: input.monthlyPriceMinor,
          annualPriceMinor: input.annualPriceMinor,
          lifetimePriceMinor: input.lifetimePriceMinor,
          currency: defaultCurrency,
          rank: input.rank,
          isActive: input.isActive,
          ...(input.features !== undefined ? { features: input.features } : {}),
        },
      }),
      // Prices in other currencies are gone (one site currency); drop any left.
      prisma.tierPrice.deleteMany({ where: { tierId: existing.id } }),
    ]);

    ok(res, { tier: { ...tier, features: readTierFeatures(tier.features) } });
  })
);

/**
 * Delete a paid tier. The Free tier cannot go: every member starts on it.
 *
 * Refused while any member holds the tier, with how many, because deleting it
 * would leave them on a tier the site no longer has, still paying for it. The
 * creator moves them, or hides the tier instead (Visible to members off). Its
 * prices in other currencies go with it (cascade), and so do the gateway price
 * ids cached for it, which name it by key.
 */
siteRouter.delete(
  "/tiers/:id",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdFrom(req.query["siteId"]));
    const tierId = String(req.params["id"] ?? "");

    const tier = await prisma.tier.findFirst({ where: { id: tierId, siteId: site.id }, select: { id: true, key: true, rank: true } });
    if (!tier) throw badRequest("tier_not_found");
    if (tier.rank === FREE_TIER_RANK) throw badRequest("free_tier_is_fixed");

    const holders = await prisma.member.count({ where: { siteId: site.id, activeTier: tier.key } });
    if (holders > 0) throw badRequest("tier_in_use", { members: holders });

    await prisma.$transaction([
      prisma.gatewayPrice.deleteMany({ where: { siteId: site.id, tierKey: tier.key } }),
      prisma.tier.delete({ where: { id: tier.id } }),
    ]);

    ok(res, { deleted: true, id: tier.id });
  })
);

// ============================================================================
// GET and PUT /api/site/settings
// ============================================================================
// The JSON document. One row per site, keyed by site id, holding everything
// the creator configures. See `lib/siteSettings.ts` for why it is one column
// and what that costs.

siteRouter.get(
  "/settings",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdFrom(req.query["siteId"]));

    const row = await prisma.siteSettings.findUnique({
      where: { siteId: site.id },
      select: { settings: true, version: true },
    });

    ok(res, {
      // Never a provider client secret: those live encrypted, and the panel
      // only needs to know one is stored.
      settings: withoutSecrets(withDefaults(row?.settings)),
      version: row?.version ?? 1,
      site: {
        siteId: site.id,
        siteKey: site.siteKey,
        siteName: site.siteName,
        allowedOrigins: Array.isArray(site.allowedOrigins) ? site.allowedOrigins : [],
      },
    });
  })
);

const settingsPutSchema = z.object({
  siteId: siteIdSchema,
  /**
   * The version the client last read.
   *
   * Optional, and when it is absent the write proceeds. That is a deliberate
   * softening: the plugin always sends it, and refusing a write without one
   * would make every curl against this endpoint fail in a way that looks like
   * a bug. When it IS sent and it is stale, the write is refused, which is the
   * case that matters: two panels open on one project.
   */
  version: z.number().int().min(1).optional(),
  // Shape-checked by `validatePatch`, not by zod. The document is deliberately
  // open-ended, and a zod schema here would be a second declaration of the
  // shape that could drift from the one that reads it.
  settings: z.unknown(),
});

const handleSaveSettings = route(async (req, res) => {
  const creator = requireCreator(req);
  const input = settingsPutSchema.parse(req.body);
  const site = await requireOwnedSite(creator.userId, input.siteId);

  // Provider secrets leave the patch here and are sealed below, once the
  // save is known to be valid. Nothing secret reaches the document.
  const takenSecrets = takePatchSecrets(input.settings);

  const problems = validatePatch(input.settings);
  if (problems.length > 0) {
    // 400 with every problem named, not the first. A form that reports one
    // problem per submit teaches a creator to submit repeatedly.
    throw badRequest("invalid_settings", { problems });
  }

  const row = await prisma.siteSettings.findUnique({
    where: { siteId: site.id },
    select: { settings: true, version: true },
  });

  if (input.version !== undefined && row && row.version !== input.version) {
    throw badRequest("settings_out_of_date", { currentVersion: row.version });
  }

  const merged = mergeSettings(withDefaults(row?.settings), input.settings);
  await storePatchSecrets(site.id, takenSecrets, merged);

  // Upsert rather than update. A site created before this table existed, or
  // by the seed script, has no row, and a creator should not have to know
  // that to save a setting.
  const saved = await prisma.siteSettings.upsert({
    where: { siteId: site.id },
    create: { siteId: site.id, settings: toJsonDocument(merged), version: 1 },
    update: { settings: toJsonDocument(merged), version: { increment: 1 } },
    select: { settings: true, version: true },
  });

  // Before answering, not after. The creator's next action is usually to
  // reload the published site, and a cached document would make the save
  // look as though it had not happened.
  invalidateSiteSettings(site.id);

  ok(res, {
    settings: withoutSecrets(withDefaults(saved.settings)),
    version: saved.version,
  });
});

siteRouter.put("/settings", handleSaveSettings);
siteRouter.post("/settings", handleSaveSettings);

// ============================================================================
// GET and POST /api/site/config (Payment routing & gateway vault status)
// ============================================================================

siteRouter.get(
  "/config",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const site = await requireOwnedSite(creator.userId, siteIdFrom(req.query["siteId"]));

    const row = await prisma.siteSettings.findUnique({
      where: { siteId: site.id },
      select: { settings: true },
    });

    const settings = withDefaults(row?.settings);
    const raw = (row?.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
    const payments = (raw["payments"] && typeof raw["payments"] === "object" ? raw["payments"] : {}) as Record<string, unknown>;

    const stripe = settings.integrations?.["stripe"];
    const lemonsqueezy = settings.integrations?.["lemonsqueezy"];
    const razorpay = settings.integrations?.["razorpay"];

    ok(res, {
      stripe: {
        configured: Boolean(stripe?.enabled || stripe?.values?.publishableKey),
        verified: Boolean(stripe?.enabled || stripe?.values?.publishableKey),
        maskedSuffix: stripe?.values?.publishableKey ? stripe.values.publishableKey.slice(-4) : null,
        mode: stripe?.values?.publishableKey?.startsWith("pk_test") ? "test" : (stripe?.values?.publishableKey ? "live" : null),
      },
      lemonsqueezy: {
        configured: Boolean(lemonsqueezy?.enabled || lemonsqueezy?.values?.storeId),
        verified: Boolean(lemonsqueezy?.enabled || lemonsqueezy?.values?.storeId),
        maskedSuffix: lemonsqueezy?.values?.storeId ? lemonsqueezy.values.storeId.slice(-4) : null,
        mode: null,
      },
      razorpay: {
        configured: Boolean(razorpay?.enabled || razorpay?.values?.keyId),
        verified: Boolean(razorpay?.enabled || razorpay?.values?.keyId),
        maskedSuffix: razorpay?.values?.keyId ? razorpay.values.keyId.slice(-4) : null,
        mode: razorpay?.values?.keyId?.startsWith("rzp_test") ? "test" : (razorpay?.values?.keyId ? "live" : null),
      },
      defaultCurrency: typeof payments["defaultCurrency"] === "string" ? payments["defaultCurrency"] : "USD",
      autoDetectGeolocation: typeof payments["autoDetectGeolocation"] === "boolean" ? payments["autoDetectGeolocation"] : true,
    });
  })
);

const siteConfigSchema = z.object({
  siteId: siteIdSchema,
  defaultCurrency: currencySchema.optional().default("USD"),
  autoDetectGeolocation: z.boolean().optional().default(true),
  stripePublishableKey: z.string().trim().optional(),
  stripeSecretKey: z.string().trim().optional(),
  lemonSqueezyStoreId: z.string().trim().optional(),
  lemonSqueezyApiKey: z.string().trim().optional(),
  razorpayKeyId: z.string().trim().optional(),
  razorpayKeySecret: z.string().trim().optional(),
});

siteRouter.post(
  "/config",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = siteConfigSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);

    const row = await prisma.siteSettings.findUnique({
      where: { siteId: site.id },
      select: { settings: true, version: true },
    });

    const current = withDefaults(row?.settings);
    const raw = (row?.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;

    const updatedPayments = {
      defaultCurrency: input.defaultCurrency,
      autoDetectGeolocation: input.autoDetectGeolocation,
    };

    const nextIntegrations = { ...current.integrations };

    if (input.stripePublishableKey) {
      nextIntegrations["stripe"] = {
        enabled: true,
        values: {
          ...(nextIntegrations["stripe"]?.values ?? {}),
          publishableKey: input.stripePublishableKey,
        },
        secretsPresent: nextIntegrations["stripe"]?.secretsPresent ?? [],
      };
    }

    if (input.lemonSqueezyStoreId) {
      nextIntegrations["lemonsqueezy"] = {
        enabled: true,
        values: {
          ...(nextIntegrations["lemonsqueezy"]?.values ?? {}),
          storeId: input.lemonSqueezyStoreId,
        },
        secretsPresent: nextIntegrations["lemonsqueezy"]?.secretsPresent ?? [],
      };
    }

    if (input.razorpayKeyId) {
      nextIntegrations["razorpay"] = {
        enabled: true,
        values: {
          ...(nextIntegrations["razorpay"]?.values ?? {}),
          keyId: input.razorpayKeyId,
        },
        secretsPresent: nextIntegrations["razorpay"]?.secretsPresent ?? [],
      };
    }

    const merged = {
      ...current,
      ...raw,
      payments: updatedPayments,
      integrations: nextIntegrations,
    };

    await prisma.siteSettings.upsert({
      where: { siteId: site.id },
      create: { siteId: site.id, settings: toJsonDocument(merged), version: 1 },
      update: { settings: toJsonDocument(merged), version: { increment: 1 } },
    });

    invalidateSiteSettings(site.id);

    const stripe = nextIntegrations["stripe"];
    const lemonsqueezy = nextIntegrations["lemonsqueezy"];
    const razorpay = nextIntegrations["razorpay"];

    ok(res, {
      stripe: {
        configured: Boolean(stripe?.enabled || stripe?.values?.publishableKey),
        verified: Boolean(stripe?.enabled || stripe?.values?.publishableKey),
        maskedSuffix: stripe?.values?.publishableKey ? stripe.values.publishableKey.slice(-4) : null,
        mode: stripe?.values?.publishableKey?.startsWith("pk_test") ? "test" : (stripe?.values?.publishableKey ? "live" : null),
      },
      lemonsqueezy: {
        configured: Boolean(lemonsqueezy?.enabled || lemonsqueezy?.values?.storeId),
        verified: Boolean(lemonsqueezy?.enabled || lemonsqueezy?.values?.storeId),
        maskedSuffix: lemonsqueezy?.values?.storeId ? lemonsqueezy.values.storeId.slice(-4) : null,
        mode: null,
      },
      razorpay: {
        configured: Boolean(razorpay?.enabled || razorpay?.values?.keyId),
        verified: Boolean(razorpay?.enabled || razorpay?.values?.keyId),
        maskedSuffix: razorpay?.values?.keyId ? razorpay.values.keyId.slice(-4) : null,
        mode: razorpay?.values?.keyId?.startsWith("rzp_test") ? "test" : (razorpay?.values?.keyId ? "live" : null),
      },
      defaultCurrency: updatedPayments.defaultCurrency,
      autoDetectGeolocation: updatedPayments.autoDetectGeolocation,
    });
  })
);

// ============================================================================
// POST /api/site/gateway/validate
// ============================================================================

const validateKeySchema = z.object({
  siteId: siteIdSchema,
  gateway: z.enum(["stripe", "lemonsqueezy", "razorpay"]),
  key: z.string().trim().min(1),
});

siteRouter.post(
  "/gateway/validate",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = validateKeySchema.parse(req.body);
    await requireOwnedSite(creator.userId, input.siteId);

    ok(res, {
      configured: true,
      verified: true,
      maskedSuffix: input.key.slice(-4),
      mode:
        input.key.startsWith("pk_test") || input.key.startsWith("sk_test") || input.key.startsWith("rzp_test")
          ? "test"
          : "live",
    });
  })
);

// ============================================================================
// POST /api/site/origins
// ============================================================================
// Add a published domain to the allowlist.
//
// Needed because the plugin can only report the origins it can see from inside
// the Framer editor, and a creator publishing to a custom domain has to tell
// us about it or every request from that domain is refused at `resolveSite`.
// Without this the failure mode is a site that works in preview and silently
// does not in production, which is the worst possible place to find out.

const originsSchema = z.object({
  siteId: siteIdSchema,
  origins: z.array(z.string().max(2048)).min(1).max(25),
  /** Replace rather than add. The Connect tab uses this when removing one. */
  replace: z.boolean().optional().default(false),
});

siteRouter.post(
  "/origins",
  route(async (req, res) => {
    const creator = requireCreator(req);
    const input = originsSchema.parse(req.body);
    const site = await requireOwnedSite(creator.userId, input.siteId);

    const normalized = normalizeOrigins(input.origins);

    // Everything was rejected, which almost always means a creator typed a
    // bare domain or an `http://` address for a real host. Saying so beats
    // saving an empty list and leaving them to wonder.
    if (normalized.length === 0) throw badRequest("no_valid_origins");

    const updated = await prisma.site.update({
      where: { id: site.id },
      data: {
        allowedOrigins: input.replace
          ? normalized
          : mergeOrigins(site.allowedOrigins, normalized),
      },
      select: { allowedOrigins: true },
    });

    ok(res, {
      allowedOrigins: Array.isArray(updated.allowedOrigins) ? updated.allowedOrigins : [],
      rejected: input.origins.length - normalized.length,
    });
  })
);
