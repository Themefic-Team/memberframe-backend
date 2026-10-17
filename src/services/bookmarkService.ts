/**
 * Member bookmarks. FP-10, PRD F14.
 *
 * One row per member per item slug. Adding an item that is already saved
 * changes nothing and is not an error, and removing one that is not saved is
 * the same, so a double click, a retry after a timeout, or two tabs saving the
 * same card all end in one bookmark. The unique key is what guarantees it when
 * two requests race.
 */

import { prisma } from "../config/db.js";
import { badRequest } from "../middleware/errors.js";

export const MAX_BOOKMARKS = 500;

export interface BookmarkItem {
  itemSlug: string;
  title: string;
  url: string;
  /** Unix milliseconds. */
  savedAt: number;
}

/** Letters, digits, and `-_./:` so a CMS slug or a page path both fit. */
export const ITEM_SLUG_PATTERN = /^[A-Za-z0-9/][A-Za-z0-9\-_./:]{0,190}$/;

/**
 * Where a saved item links to: a site-relative path, or an absolute http(s)
 * address. Anything else, `javascript:` above all, is refused, because the
 * tray renders it as a link on the creator's site.
 */
export function safeBookmarkUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 1000) return null;
  if (/^\/(?!\/)/.test(trimmed)) return /[\s<>"]/.test(trimmed) ? null : trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function listBookmarks(siteId: string, memberId: string): Promise<BookmarkItem[]> {
  const rows = await prisma.bookmark.findMany({
    where: { siteId, memberId },
    orderBy: { createdAt: "desc" },
    take: MAX_BOOKMARKS,
  });
  return rows.map((row) => ({ itemSlug: row.itemSlug, title: row.title, url: row.url, savedAt: row.createdAt.getTime() }));
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

export async function addBookmark(
  siteId: string,
  memberId: string,
  item: { itemSlug: string; title: string; url: string }
): Promise<void> {
  if (!ITEM_SLUG_PATTERN.test(item.itemSlug)) throw badRequest("invalid_item_slug");
  const url = safeBookmarkUrl(item.url);
  if (!url) throw badRequest("invalid_item_url");
  const title = item.title.replace(/\s+/g, " ").trim().slice(0, 255) || item.itemSlug;

  const existing = await prisma.bookmark.findUnique({
    where: { memberId_itemSlug: { memberId, itemSlug: item.itemSlug } },
    select: { id: true },
  });
  if (existing) {
    // Saved already. The title and link may have changed since: keep them current.
    await prisma.bookmark.update({ where: { id: existing.id }, data: { title, url } });
    return;
  }

  const count = await prisma.bookmark.count({ where: { siteId, memberId } });
  if (count >= MAX_BOOKMARKS) throw badRequest("too_many_bookmarks", { max: MAX_BOOKMARKS });

  try {
    await prisma.bookmark.create({ data: { siteId, memberId, itemSlug: item.itemSlug, title, url } });
  } catch (error) {
    // The other half of a double click got there first. Same end state.
    if (!isUniqueViolation(error)) throw error;
  }
}

export async function removeBookmark(siteId: string, memberId: string, itemSlug: string): Promise<void> {
  await prisma.bookmark.deleteMany({ where: { siteId, memberId, itemSlug } });
}
