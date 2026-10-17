/**
 * The protected file vault. FP-12, PRD F10.
 *
 * A creator uploads a file, or links one they host elsewhere, and gets an
 * opaque asset id to paste into `<ProtectedDownload>`. A visitor asks for a
 * download; the server checks the session and the asset's tier, and answers
 * with a link that works for `ASSET_LINK_SECONDS` (60). The link streams the
 * file through this server, so the storage key, the bucket, and a linked
 * file's real address never reach the browser.
 *
 * The tier rule lives on the asset, not on the component. A rule in published
 * page code is a rule any visitor can edit, so the component only displays
 * what the server decides.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import { badRequest, forbidden, notFound, unauthorized } from "../../middleware/errors.js";
import { isEntitled, type MemberSessionData, type TierLadderEntry } from "../../lib/entitlement.js";
import { loadTierLadder } from "../sessionService.js";
import { createLinkToken, readLinkToken } from "./downloadLink.js";
import { RemoteUrlError, assertPublicUrl, checkRemoteUrlShape } from "./remoteUrl.js";
import { StorageError, openFile, putFile, removeFile } from "./storage.js";

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** `ast_` plus 20 characters from an unambiguous alphabet: about 100 bits. */
export function newAssetId(): string {
  const bytes = randomBytes(20);
  let id = "ast_";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

export const ASSET_ID_PATTERN = /^ast_[a-z0-9]{20}$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".zip": "application/zip",
  ".pdf": "application/pdf",
  ".fig": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".epub": "application/epub+zip",
  ".psd": "image/vnd.adobe.photoshop",
  ".ai": "application/postscript",
  ".sketch": "application/octet-stream",
  ".xd": "application/octet-stream",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".key": "application/vnd.apple.keynote",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
};

/** A file name a browser can save: no folders, no control characters, no quotes. */
export function safeFileName(value: string, fallback = "download"): string {
  const base = path.basename(value.replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? fallback : cleaned;
}

export function mimeFor(fileName: string, declared?: string | null): string {
  const given = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (given && given !== "application/octet-stream" && /^[a-z]+\/[a-z0-9.+-]+$/.test(given)) return given;
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Share links that open a preview page, turned into the file itself. A Google
 * Drive or Dropbox share link otherwise downloads an HTML page.
 */
export function directDownloadUrl(value: string): string {
  const url = new URL(value);
  const drive = /^\/file\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  if (url.hostname === "drive.google.com" && drive?.[1]) {
    return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  }
  if (url.hostname === "www.dropbox.com" || url.hostname === "dropbox.com") {
    url.searchParams.set("dl", "1");
    return url.toString();
  }
  return url.toString();
}

/** `signed_in`, or one of the site's tier keys. */
async function checkTier(siteId: string, requiredTier: string): Promise<string> {
  if (requiredTier === "signed_in") return requiredTier;
  const tier = await prisma.tier.findFirst({ where: { siteId, key: requiredTier }, select: { key: true } });
  if (!tier) throw badRequest("unknown_tier");
  return tier.key;
}

type AssetRow = NonNullable<Awaited<ReturnType<typeof prisma.asset.findFirst>>>;

/** The creator's view. The storage key stays server side even here. */
function creatorShape(asset: AssetRow) {
  return {
    id: asset.id,
    name: asset.name,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    sizeBytes: Number(asset.sizeBytes),
    source: asset.source,
    remoteUrl: asset.source === "url" ? asset.remoteUrl : null,
    requiredTier: asset.requiredTier,
    downloadCount: asset.downloadCount,
    lastDownloadAt: asset.lastDownloadAt?.toISOString() ?? null,
    createdAt: asset.createdAt.toISOString(),
  };
}

export type CreatorAsset = ReturnType<typeof creatorShape>;

const MAX_ASSETS_PER_SITE = 500;

async function assertRoom(siteId: string): Promise<void> {
  const count = await prisma.asset.count({ where: { siteId } });
  if (count >= MAX_ASSETS_PER_SITE) throw badRequest("too_many_assets");
}

// ============================================================================
// CREATOR
// ============================================================================

export async function listAssets(siteId: string): Promise<CreatorAsset[]> {
  const rows = await prisma.asset.findMany({ where: { siteId }, orderBy: { createdAt: "desc" } });
  return rows.map(creatorShape);
}

export interface UploadMeta {
  name: string;
  fileName: string;
  mimeType: string | null;
  requiredTier: string;
}

export async function createUploadedAsset(siteId: string, body: Readable, meta: UploadMeta): Promise<CreatorAsset> {
  await assertRoom(siteId);
  const requiredTier = await checkTier(siteId, meta.requiredTier);
  const fileName = safeFileName(meta.fileName);

  let stored;
  try {
    stored = await putFile(siteId, body);
  } catch (error) {
    if (error instanceof StorageError) throw badRequest(error.reason === "too_large" ? "file_too_large" : "upload_failed", { message: error.message });
    throw error;
  }

  const asset = await prisma.asset.create({
    data: {
      id: newAssetId(),
      siteId,
      name: meta.name.trim().slice(0, 200) || fileName,
      fileName,
      mimeType: mimeFor(fileName, meta.mimeType),
      sizeBytes: BigInt(stored.sizeBytes),
      source: "upload",
      storageKey: stored.storageKey,
      requiredTier,
    },
  });
  return creatorShape(asset);
}

/** Best effort: the size a linked file reports, for the button's "ZIP, 42 MB". */
async function remoteSize(url: string): Promise<number> {
  try {
    const target = await assertPublicUrl(url);
    const response = await fetch(target, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5000) });
    const length = Number(response.headers.get("content-length"));
    return response.ok && Number.isFinite(length) && length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

export interface LinkInput {
  name: string;
  url: string;
  fileName?: string;
  requiredTier: string;
}

export async function createLinkedAsset(siteId: string, input: LinkInput): Promise<CreatorAsset> {
  await assertRoom(siteId);
  const requiredTier = await checkTier(siteId, input.requiredTier);

  let remoteUrl: string;
  try {
    remoteUrl = directDownloadUrl(checkRemoteUrlShape(input.url));
  } catch (error) {
    throw badRequest("invalid_link", { message: error instanceof RemoteUrlError ? error.message : "That link is not valid." });
  }

  const fromPath = decodeURIComponent(new URL(remoteUrl).pathname.split("/").pop() ?? "");
  const fileName = safeFileName(input.fileName || fromPath || input.name);

  const asset = await prisma.asset.create({
    data: {
      id: newAssetId(),
      siteId,
      name: input.name.trim().slice(0, 200) || fileName,
      fileName,
      mimeType: mimeFor(fileName),
      sizeBytes: BigInt(await remoteSize(remoteUrl)),
      source: "url",
      remoteUrl,
      requiredTier,
    },
  });
  return creatorShape(asset);
}

export interface AssetPatch {
  name?: string;
  fileName?: string;
  requiredTier?: string;
  url?: string;
}

export async function updateAsset(siteId: string, assetId: string, patch: AssetPatch): Promise<CreatorAsset> {
  const asset = await prisma.asset.findFirst({ where: { id: assetId, siteId } });
  if (!asset) throw notFound("asset_not_found");

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data["name"] = patch.name.trim().slice(0, 200) || asset.name;
  if (patch.fileName !== undefined) {
    data["fileName"] = safeFileName(patch.fileName, asset.fileName);
    data["mimeType"] = mimeFor(data["fileName"] as string, asset.source === "upload" ? asset.mimeType : null);
  }
  if (patch.requiredTier !== undefined) data["requiredTier"] = await checkTier(siteId, patch.requiredTier);
  if (patch.url !== undefined) {
    if (asset.source !== "url") throw badRequest("not_a_link");
    try {
      data["remoteUrl"] = directDownloadUrl(checkRemoteUrlShape(patch.url));
    } catch (error) {
      throw badRequest("invalid_link", { message: error instanceof RemoteUrlError ? error.message : "That link is not valid." });
    }
    data["sizeBytes"] = BigInt(await remoteSize(data["remoteUrl"] as string));
  }

  const updated = await prisma.asset.update({ where: { id: asset.id }, data });
  return creatorShape(updated);
}

export async function deleteAsset(siteId: string, assetId: string): Promise<void> {
  const asset = await prisma.asset.findFirst({ where: { id: assetId, siteId } });
  if (!asset) return;
  await prisma.asset.delete({ where: { id: asset.id } });
  if (asset.storageKey) await removeFile(asset.storageKey);
}

// ============================================================================
// VISITOR
// ============================================================================

export interface MemberContext {
  member: MemberSessionData;
  tiers: ReadonlyArray<TierLadderEntry>;
}

function tierName(tiers: ReadonlyArray<TierLadderEntry>, key: string): string {
  if (key === "signed_in") return "Member";
  return tiers.find((tier) => tier.key === key)?.name ?? key;
}

/**
 * What `<ProtectedDownload>` shows: the file's name and size, which plan it
 * needs, and whether this visitor can download it now. No storage detail.
 */
export async function publicAsset(siteId: string, assetId: string, context: MemberContext | null) {
  const asset = ASSET_ID_PATTERN.test(assetId) ? await prisma.asset.findFirst({ where: { id: assetId, siteId } }) : null;
  if (!asset) throw notFound("asset_not_found");

  const tiers = context?.tiers ?? (await loadTierLadder(siteId));
  const access = !context
    ? "sign_in"
    : isEntitled(context.member, asset.requiredTier as never, tiers)
      ? "granted"
      : "upgrade";

  return {
    asset: {
      id: asset.id,
      name: asset.name,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sizeBytes: Number(asset.sizeBytes),
      requiredTier: asset.requiredTier,
      requiredTierName: tierName(tiers, asset.requiredTier),
    },
    access,
  };
}

/**
 * Check and sign. 401 for a visitor who is not signed in, 404 for an asset
 * that is not this site's, 403 for a member below the asset's tier, and never
 * a link in any of those three.
 */
export async function signDownload(siteId: string, assetId: string, context: MemberContext | null, apiBase: string) {
  if (!context) throw unauthorized("unauthenticated");

  const asset = ASSET_ID_PATTERN.test(assetId) ? await prisma.asset.findFirst({ where: { id: assetId, siteId } }) : null;
  if (!asset) throw notFound("asset_not_found");

  if (!isEntitled(context.member, asset.requiredTier as never, context.tiers)) {
    throw forbidden("tier_upgrade_required", {
      requiredTier: asset.requiredTier,
      requiredTierName: tierName(context.tiers, asset.requiredTier),
    });
  }

  const expiresInSeconds = env.assets.linkSeconds;
  const token = createLinkToken({
    assetId: asset.id,
    siteId,
    memberId: context.member.memberId,
    expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });

  await prisma.asset.update({
    where: { id: asset.id },
    data: { downloadCount: { increment: 1 }, lastDownloadAt: new Date() },
  });

  return {
    signedUrl: `${apiBase}/api/assets/download/${token}`,
    filename: asset.fileName,
    expiresInSeconds,
  };
}

/** Follow up to three redirects by hand, checking each hop is a public address. */
async function fetchRemote(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const target = await assertPublicUrl(current);
    const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, target).toString();
      continue;
    }
    return response;
  }
  throw new RemoteUrlError("The link redirects too many times.");
}

export type DownloadOutcome =
  | { ok: true; fileName: string; mimeType: string; sizeBytes: number | null; stream: Readable }
  | { ok: false; status: 404 | 410 | 502; reason: string };

/** Open the file a link names, if the link is genuine and in time. */
export async function openDownload(token: string): Promise<DownloadOutcome> {
  const check = readLinkToken(token);
  if (!check.ok) return { ok: false, status: check.reason === "link_expired" ? 410 : 404, reason: check.reason };

  const { assetId, siteId, memberId } = check.claims;
  const [asset, member] = await Promise.all([
    prisma.asset.findFirst({ where: { id: assetId, siteId } }),
    prisma.member.findFirst({ where: { id: memberId, siteId, deletedAt: null }, select: { id: true } }),
  ]);
  if (!asset || !member) return { ok: false, status: 404, reason: "asset_not_found" };

  try {
    if (asset.source === "upload" && asset.storageKey) {
      const file = await openFile(asset.storageKey);
      return { ok: true, fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: file.sizeBytes, stream: file.stream };
    }

    if (asset.source === "url" && asset.remoteUrl) {
      const response = await fetchRemote(asset.remoteUrl);
      if (!response.ok || !response.body) return { ok: false, status: 502, reason: "source_unavailable" };
      const length = Number(response.headers.get("content-length"));
      return {
        ok: true,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        sizeBytes: Number.isFinite(length) && length > 0 ? length : null,
        stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      };
    }
  } catch (error) {
    process.stderr.write(`[assets] could not open ${asset.id}: ${error instanceof Error ? error.message : String(error)}\n`);
    return { ok: false, status: 502, reason: "source_unavailable" };
  }

  return { ok: false, status: 404, reason: "asset_not_found" };
}
