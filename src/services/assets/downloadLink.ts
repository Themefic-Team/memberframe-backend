/**
 * Download links that expire. FP-12, PRD F10 and S5.
 *
 * A link is `/api/assets/download/<token>`, where the token names one asset,
 * one site and one member, carries its expiry, and is signed with HMAC-SHA256.
 * Nothing about storage is in it: the server looks the asset up again when the
 * link is used and streams the file itself, so neither a bucket nor a path
 * reaches the visitor.
 *
 * Expiry is `ASSET_LINK_SECONDS`, 60 by default. A link replayed after that
 * is refused, and a link edited to extend it fails the signature.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

export interface LinkClaims {
  assetId: string;
  siteId: string;
  memberId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** A random secret when none is configured. Links only live a minute, so a restart costs nothing. */
const SECRET = env.assets.signingSecret !== "" ? env.assets.signingSecret : randomBytes(32).toString("hex");

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function createLinkToken(claims: LinkClaims, secret: string = SECRET): string {
  const payload = Buffer.from(
    JSON.stringify({ a: claims.assetId, s: claims.siteId, m: claims.memberId, e: claims.expiresAt }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export type LinkCheck = { ok: true; claims: LinkClaims } | { ok: false; reason: "invalid_link" | "link_expired" };

export function readLinkToken(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  secret: string = SECRET
): LinkCheck {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || token.length > 600) return { ok: false, reason: "invalid_link" };

  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid_link" };

  let parsed: { a?: unknown; s?: unknown; m?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    return { ok: false, reason: "invalid_link" };
  }

  if (typeof parsed.a !== "string" || typeof parsed.s !== "string" || typeof parsed.m !== "string" || typeof parsed.e !== "number") {
    return { ok: false, reason: "invalid_link" };
  }
  if (nowSeconds > parsed.e) return { ok: false, reason: "link_expired" };

  return { ok: true, claims: { assetId: parsed.a, siteId: parsed.s, memberId: parsed.m, expiresAt: parsed.e } };
}
