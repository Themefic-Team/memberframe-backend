/**
 * Opaque tokens: session cookies, reset links, and OTP codes.
 *
 * One rule runs through all of it. **The plaintext exists exactly once, in the
 * response or the email, and only the hash is stored.** A database read, a
 * backup, or a leaked dump then yields nothing usable.
 *
 * That is why these are opaque random strings rather than JWTs. A JWT is
 * verifiable without a database lookup, which sounds like an advantage until
 * you need to revoke one: you cannot, short of a blocklist, which is a database
 * lookup with extra steps. A password reset has to invalidate every other
 * session (FP-02 section 2.3), and that is a DELETE here and impossible with a
 * stateless token.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * 32 bytes, base64url. 256 bits of entropy.
 *
 * base64url rather than hex so the string is shorter, and rather than plain
 * base64 so it survives a URL without encoding: the reset token travels in a
 * query string, where a `+` would become a space and a `/` a path separator.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * SHA-256, hex.
 *
 * Deliberately NOT a password hash. scrypt is slow by design, which is right
 * for a human-chosen eight-character secret and wrong for a 256-bit random
 * one: there is nothing to brute force, and every session lookup would pay
 * 80 ms. The threat a password hash defends against does not exist here.
 *
 * Hex rather than base64 because this value goes in a `VARCHAR` with a unique
 * index, and a case-insensitive collation would make two different base64
 * hashes collide. Hex is unambiguous under any collation.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hashes without leaking where they differ.
 *
 * Session lookup is by indexed hash, so this is belt and braces there. It
 * matters for the OTP, where the candidate is six digits and a timing signal
 * would narrow it fast.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual throws on a length mismatch, which is itself a signal. A
  // length check first is safe: the length of a hash is not a secret.
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

/**
 * A six-digit code, zero padded.
 *
 * `randomInt` rather than `Math.random`: the latter is a PRNG seeded per
 * process and is predictable from previous outputs, so a code generated for
 * one address could be computed from a code requested for another.
 *
 * Padded rather than ranged from 100000 so that 000042 is reachable. Starting
 * at 100000 would quietly discard a tenth of the space.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Now plus a number of seconds, as a Date. */
export function expiryFrom(seconds: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + seconds * 1000);
}

/** Has this moment passed? */
export function isExpired(at: Date | null, now: Date = new Date()): boolean {
  if (at === null) return true;
  return at.getTime() <= now.getTime();
}

/**
 * A public site key.
 *
 * Prefixed so it is recognisable in a log, a bug report, or a component's
 * baked config, the way `pk_live_` is for Stripe. It is not a secret: it
 * identifies a tenant and the `Origin` header is what authorizes. Backend PRD
 * section 3.2.
 */
export function generateSiteKey(): string {
  return `mf_site_${randomBytes(16).toString("hex")}`;
}

/** A per-site salt for F22 shared-password grants. Rotating it kills every grant. */
export function generateGrantSalt(): string {
  return randomBytes(32).toString("hex");
}
