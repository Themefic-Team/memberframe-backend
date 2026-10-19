/**
 * The seal the Builder puts on every component it inserts (27-instance-seal.md).
 *
 * `s1.<nonce>.<signature>`, where the signature is an HMAC of the site id and
 * the nonce. Valid only for the site it was issued to, so a component pasted
 * into another project, or one that never came from the Builder, fails the
 * check and renders locked.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

const VERSION = "s1";
const SEAL_PATTERN = /^s1\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/;

function sign(siteId: string, nonce: string): string {
  return createHmac("sha256", env.billing.instanceSealSecret).update(`${siteId}.${nonce}`).digest("base64url");
}

export function issueSeal(siteId: string): string {
  const nonce = randomBytes(18).toString("base64url");
  return `${VERSION}.${nonce}.${sign(siteId, nonce)}`;
}

export function verifySeal(siteId: string, seal: string | null | undefined): boolean {
  if (!seal || !env.billing.instanceSealSecret) return false;
  const match = SEAL_PATTERN.exec(seal.trim());
  if (!match) return false;
  const expected = Buffer.from(sign(siteId, match[1]!));
  const given = Buffer.from(match[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
