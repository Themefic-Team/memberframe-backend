/**
 * Content features on the published site and in the plugin. FP-07, FP-10, FP-12.
 *
 *   PATCH /api/member/bookmarks                 save or remove one item     member
 *   GET   /api/member/bookmarks                 the member's saved items    member
 *   POST  /api/member/meter                     count one article read      member
 *   GET   /api/assets/:assetId                  a file's label and access   visitor
 *   POST  /api/assets/sign-download-url         a 60 second download link   member
 *   GET   /api/assets/download/:token           the file itself             the link
 *   /api/site/assets                            upload, link, edit, delete  creator
 *
 * The member routes sit behind `resolveSite` like every other member route:
 * the tenant is the site key, and the origin is checked against it. The
 * download link is a plain navigation with neither, so its token is what
 * scopes it.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { badRequest, ok, okEmpty, rateLimited, route, unauthorized } from "../middleware/errors.js";
import { requireSite } from "../middleware/site.js";
import { creatorAuth, requireCreator } from "../middleware/creator.js";
import { clientIp, hit } from "../middleware/rateLimit.js";
import { requireOwnedSite } from "../services/creatorAuthService.js";
import { loadSession } from "../services/sessionService.js";
import { addBookmark, listBookmarks, removeBookmark } from "../services/bookmarkService.js";
import { meterRead } from "../services/meterService.js";
import {
  ASSET_ID_PATTERN,
  createLinkedAsset,
  createUploadedAsset,
  deleteAsset,
  listAssets,
  openDownload,
  publicAsset,
  signDownload,
  updateAsset,
} from "../services/assets/assetService.js";
import { publicApiBase } from "../lib/publicApiBase.js";

function limit(key: string, max: number, windowSeconds = 3600): void {
  const decision = hit(key, max, windowSeconds);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

/** The signed-in member, or null. Never throws for a visitor who is simply signed out. */
async function memberContext(req: Request) {
  const site = requireSite(req);
  const token = req.cookies?.[env.session.cookieName] as string | undefined;
  const session = await loadSession(token, site.id);
  return { site, session };
}

async function requireMember(req: Request) {
  const { site, session } = await memberContext(req);
  if (!session) throw unauthorized("unauthenticated");
  return { site, session };
}

// ============================================================================
// BOOKMARKS, FP-10
// ============================================================================

export const bookmarksRouter = Router();

bookmarksRouter.get(
  "/",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    res.setHeader("Cache-Control", "private, no-store");
    const bookmarks = await listBookmarks(site.id, session.member.memberId);
    ok(res, { bookmarks, totalCount: bookmarks.length });
  })
);

const bookmarkSchema = z.object({
  action: z.enum(["add", "remove"]),
  item: z.object({
    itemSlug: z.string().trim().min(1).max(191),
    title: z.string().max(500).default(""),
    url: z.string().max(1000).default(""),
  }),
});

bookmarksRouter.patch(
  "/",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    const memberId = session.member.memberId;
    limit(`bookmarks:${memberId}`, 240);

    const input = bookmarkSchema.parse(req.body);
    if (input.action === "add") await addBookmark(site.id, memberId, input.item);
    else await removeBookmark(site.id, memberId, input.item.itemSlug);

    const bookmarks = await listBookmarks(site.id, memberId);
    ok(res, { bookmarks, totalCount: bookmarks.length });
  })
);

// ============================================================================
// THE METER, FP-07
// ============================================================================

export const meterRouter = Router();

const meterSchema = z.object({
  slug: z.string().trim().min(1).max(191),
  // The plugin's FREE_ARTICLES_MAX and the component's METER_MAX_QUOTA.
  limit: z.number().int().min(1).max(100),
  period: z.enum(["weekly", "monthly"]),
  deviceReads: z.array(z.string().trim().min(1).max(191)).max(100).default([]),
});

meterRouter.post(
  "/",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    limit(`meter:${session.member.memberId}`, 600);
    const input = meterSchema.parse(req.body);
    res.setHeader("Cache-Control", "private, no-store");
    ok(res, { ...(await meterRead(site.id, session.member.memberId, input)) });
  })
);

// ============================================================================
// PROTECTED DOWNLOADS, FP-12
// ============================================================================

export const assetsRouter = Router();

const signSchema = z.object({
  assetId: z.string().trim().min(1).max(40),
  /** Optional, from the plan's contract. When sent it must be this site. */
  siteId: z.string().trim().max(64).optional(),
  /** For a password file (32-canvas-downloads.md). Never logged or stored. */
  password: z.string().max(200).optional(),
});

assetsRouter.post(
  "/sign-download-url",
  route(async (req, res) => {
    const { site, session } = await memberContext(req);
    const input = signSchema.parse(req.body);
    // Cross-site isolation, PRD F10: a link is only ever signed for the site
    // the request authenticated as, whatever the body claims.
    if (input.siteId && input.siteId !== site.id) throw badRequest("site_mismatch");
    limit(`assets-sign:${session?.member.memberId ?? clientIp(req)}`, 60);
    // Guessing a file's password: ten tries a minute from one address.
    if (input.password !== undefined) limit(`assets-password:${clientIp(req)}:${input.assetId}`, 10);

    res.setHeader("Cache-Control", "private, no-store");
    const context = session ? { member: session.member, tiers: session.tiers } : null;
    ok(res, await signDownload(site.id, input.assetId, context, publicApiBase(req), input.password));
  })
);

assetsRouter.get(
  "/:assetId",
  route(async (req, res) => {
    const { site, session } = await memberContext(req);
    limit(`assets-meta:${clientIp(req)}`, 600);
    res.setHeader("Cache-Control", "private, no-store");
    const context = session ? { member: session.member, tiers: session.tiers } : null;
    ok(res, await publicAsset(site.id, String(req.params["assetId"] ?? ""), context));
  })
);

/** RFC 6266: a plain ASCII fallback and the exact UTF-8 name. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

const EXPIRED_PAGE =
  "<!doctype html><meta charset=utf-8><title>Link expired</title>" +
  "<p>This download link has expired. Go back to the page and press Download again.</p>";

export const handleAssetDownload = route(async (req: Request, res: Response) => {
  limit(`assets-download:${clientIp(req)}`, 120);
  const outcome = await openDownload(String(req.params["token"] ?? ""));

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (!outcome.ok) {
    res.status(outcome.status).type("html").send(
      outcome.reason === "link_expired"
        ? EXPIRED_PAGE
        : "<!doctype html><meta charset=utf-8><title>Not available</title><p>This file is not available.</p>"
    );
    return;
  }

  res.setHeader("Content-Type", outcome.mimeType);
  res.setHeader("Content-Disposition", contentDisposition(outcome.fileName));
  if (outcome.sizeBytes !== null) res.setHeader("Content-Length", String(outcome.sizeBytes));

  outcome.stream.on("error", () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  res.on("close", () => outcome.stream.destroy());
  outcome.stream.pipe(res);
});

// ============================================================================
// CREATOR: /api/site/assets
// ============================================================================

export const assetsCreatorRouter = Router();
assetsCreatorRouter.use(creatorAuth);

const siteIdSchema = z.string().trim().min(1).max(36);

async function creatorSite(req: Request, siteId: unknown) {
  const creator = requireCreator(req);
  const parsed = siteIdSchema.safeParse(siteId);
  if (!parsed.success) throw badRequest("missing_site_id");
  return requireOwnedSite(creator.userId, parsed.data);
}

assetsCreatorRouter.get(
  "/",
  route(async (req, res) => {
    const site = await creatorSite(req, req.query["siteId"]);
    ok(res, { assets: await listAssets(site.id), maxBytes: env.assets.maxBytes, storage: env.assets.driver });
  })
);

const uploadQuery = z.object({
  siteId: siteIdSchema,
  name: z.string().max(200).default(""),
  fileName: z.string().trim().min(1).max(255),
  requiredTier: z.string().trim().min(1).max(50).default("signed_in"),
});

/**
 * The file is the raw request body, streamed to storage, never held in memory.
 * Metadata rides in the query string so the body can be the file alone.
 */
assetsCreatorRouter.post(
  "/upload",
  route(async (req, res) => {
    const input = uploadQuery.parse(req.query);
    const site = await creatorSite(req, input.siteId);
    limit(`assets-upload:${site.id}`, 60);

    const declared = Number(req.header("content-length"));
    if (Number.isFinite(declared) && declared > env.assets.maxBytes) {
      throw badRequest("file_too_large", { message: `Files can be up to ${Math.floor(env.assets.maxBytes / 1048576)} MB.` });
    }

    const asset = await createUploadedAsset(site.id, req, {
      name: input.name,
      fileName: input.fileName,
      mimeType: req.header("content-type") ?? null,
      requiredTier: input.requiredTier,
    });
    ok(res, { asset });
  })
);

const linkSchema = z.object({
  siteId: siteIdSchema,
  name: z.string().max(200).default(""),
  url: z.string().trim().min(1).max(2000),
  fileName: z.string().trim().max(255).optional(),
  requiredTier: z.string().trim().min(1).max(255).default("signed_in"),
  /** For requiredTier "password": any letters, numbers, or symbols. Hashed by the service; never stored as typed. */
  password: z.string().min(1).max(200).optional(),
});

assetsCreatorRouter.post(
  "/",
  route(async (req, res) => {
    const input = linkSchema.parse(req.body);
    const site = await creatorSite(req, input.siteId);
    limit(`assets-link:${site.id}`, 120);
    ok(res, { asset: await createLinkedAsset(site.id, input) });
  })
);

const patchSchema = z.object({
  siteId: siteIdSchema,
  name: z.string().max(200).optional(),
  fileName: z.string().trim().min(1).max(255).optional(),
  requiredTier: z.string().trim().min(1).max(255).optional(),
  url: z.string().trim().min(1).max(2000).optional(),
  password: z.string().min(1).max(200).optional(),
});

function assetIdParam(req: Request): string {
  const id = String(req.params["assetId"] ?? "");
  if (!ASSET_ID_PATTERN.test(id)) throw badRequest("invalid_asset_id");
  return id;
}

assetsCreatorRouter.patch(
  "/:assetId",
  route(async (req, res) => {
    const input = patchSchema.parse(req.body);
    const site = await creatorSite(req, input.siteId);
    ok(res, { asset: await updateAsset(site.id, assetIdParam(req), input) });
  })
);

assetsCreatorRouter.delete(
  "/:assetId",
  route(async (req, res) => {
    const site = await creatorSite(req, req.query["siteId"]);
    await deleteAsset(site.id, assetIdParam(req));
    okEmpty(res);
  })
);
