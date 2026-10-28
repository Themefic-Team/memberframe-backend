/**
 * Where a site's own components have called from.
 *
 * Since 2026-10-28 the plugin no longer reads the published domains from
 * Framer (Marketplace review, memberframe/docs/development-docs/
 * 35-marketplace-review-report.md). The creator types them in Profile, Site
 * Domains. Two questions follow, and this answers both without reading
 * anything from Framer:
 *
 *   - Is a typed domain really this site? It is once a page on it has called
 *     this server with this site's key: the component is ours, the key is
 *     baked into it by the plugin, and the browser sets `Origin`. Profile shows
 *     such a domain as working.
 *   - Which domain did the creator forget? A custom domain, or a new
 *     `*.framer.app` address, calls with the right key from an origin not on the
 *     list. Profile suggests it, and only the creator can add it.
 *
 * A sighting is evidence, never permission: the allowlist alone decides
 * access, and a site key copied onto another domain only produces a
 * suggestion the creator can ignore.
 *
 * Writes are throttled per site and origin, so a busy page costs one update
 * every ten minutes, not one per request. Fire and forget: a failed write never
 * fails a member's request.
 */

import { prisma } from "../config/db.js";
import { isEditorHost } from "./siteLinks.js";

/** At most this many origins per site; the oldest go first. */
export const MAX_SIGHTINGS = 20;
/** A sighting is refreshed at most this often per site and origin. */
const WRITE_EVERY_MS = 10 * 60 * 1000;

export type Sightings = Record<string, { lastSeenAt: string }>;

export interface SightingView {
  origin: string;
  lastSeenAt: string;
  allowed: boolean;
}

const lastWrite = new Map<string, number>();

/** An origin worth recording: a published site, never the Framer editor. */
export function recordableOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (isEditorHost(url.hostname)) return null;
  return url.origin;
}

/**
 * The stored map, narrowed: anything malformed is dropped rather than trusted.
 * A JSON column can reach us as text (MariaDB keeps JSON as LONGTEXT, and a
 * driver may not parse it), so a string is parsed first.
 */
export function readSightings(stored: unknown): Sightings {
  if (typeof stored === "string") {
    try {
      stored = JSON.parse(stored) as unknown;
    } catch {
      return {};
    }
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const out: Sightings = {};
  for (const [origin, value] of Object.entries(stored as Record<string, unknown>)) {
    const at = (value as { lastSeenAt?: unknown } | null)?.lastSeenAt;
    if (typeof at === "string" && !Number.isNaN(Date.parse(at))) out[origin] = { lastSeenAt: at };
  }
  return out;
}

/** The map with `origin` seen at `now`, cut to the most recent `MAX_SIGHTINGS`. */
export function withSighting(stored: unknown, origin: string, now: Date): Sightings {
  const next = { ...readSightings(stored), [origin]: { lastSeenAt: now.toISOString() } };
  const recent = Object.entries(next)
    .sort((a, b) => Date.parse(b[1].lastSeenAt) - Date.parse(a[1].lastSeenAt))
    .slice(0, MAX_SIGHTINGS);
  return Object.fromEntries(recent);
}

/** Every sighting, newest first, marked with whether it is on the allowlist. */
export function sightingViews(stored: unknown, allowed: ReadonlyArray<string>): SightingView[] {
  return Object.entries(readSightings(stored))
    .map(([origin, value]) => ({ origin, lastSeenAt: value.lastSeenAt, allowed: allowed.includes(origin) }))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

/** Record that this site's component called from `origin`. Never throws, never awaits the write. */
export function noteOrigin(siteId: string, origin: string | undefined, now: Date = new Date()): void {
  const recordable = recordableOrigin(origin);
  if (!recordable) return;

  const key = `${siteId}|${recordable}`;
  const previous = lastWrite.get(key);
  if (previous !== undefined && now.getTime() - previous < WRITE_EVERY_MS) return;
  lastWrite.set(key, now.getTime());

  void (async () => {
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { seenOrigins: true } });
    if (!site) return;
    await prisma.site.update({
      where: { id: siteId },
      data: { seenOrigins: withSighting(site.seenOrigins, recordable, now) },
    });
  })().catch(() => {
    // A failed write only delays the sighting; let the next request retry it.
    lastWrite.delete(key);
  });
}

/** For tests: forget the throttle. */
export function resetSightingThrottle(): void {
  lastWrite.clear();
}
