/**
 * Reading the settings document from the member runtime.
 *
 * `lib/siteSettings.ts` owns the shape and knows nothing about the database, so
 * it stays testable without one. This is the thin part that touches Prisma.
 *
 * The member routes read settings on a visitor's request path, so this is on
 * the hot path in a way the creator routes are not. It is a single primary-key
 * lookup on a table with one row per site, which is cheap, and it is cached per
 * process for a few seconds so that a page with several gated elements does not
 * repeat it. A creator saving a setting therefore takes up to `CACHE_TTL_MS` to
 * take effect, which is the right trade for a value that changes rarely and is
 * read constantly.
 */

import { prisma } from "../config/db.js";
import {
  defaultSettings,
  withDefaults,
  type SiteSettingsDocument,
} from "../lib/siteSettings.js";

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  document: SiteSettingsDocument;
  readAt: number;
}

/**
 * Per process, and that is a stated limitation rather than an oversight.
 *
 * Behind more than one instance, a creator's saved setting takes effect on each
 * instance independently within the TTL. Nothing here is security critical:
 * `allowRegistration` is the strongest of them, and a five-second window where
 * one instance still accepts a registration is not the same kind of problem as
 * a stale permission. The same reasoning and the same caveat as the in-memory
 * rate limiter in `middleware/rateLimit.ts`.
 */
const cache = new Map<string, CacheEntry>();

export async function loadSiteSettings(siteId: string): Promise<SiteSettingsDocument> {
  const cached = cache.get(siteId);
  const now = Date.now();

  if (cached && now - cached.readAt < CACHE_TTL_MS) return cached.document;

  const row = await prisma.siteSettings.findUnique({
    where: { siteId },
    select: { settings: true },
  });

  // No row is legitimate: a site created by the seed script or before this
  // table existed has none, and a visitor must not be refused because of it.
  const document = row ? withDefaults(row.settings) : defaultSettings();

  cache.set(siteId, { document, readAt: now });
  return document;
}

/** Drop a site's cached document. Called after a creator writes one. */
export function invalidateSiteSettings(siteId: string): void {
  cache.delete(siteId);
}

/** Drop everything. Tests only. */
export function clearSettingsCache(): void {
  cache.clear();
}
