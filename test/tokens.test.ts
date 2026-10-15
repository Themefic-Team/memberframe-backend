/**
 * Tokens: sessions, reset links, OTP codes.
 *
 * The invariant running through all of it is that the plaintext exists once,
 * in a response or an email, and only the hash is stored. These tests check
 * the properties that make that worth anything.
 */

import { describe, expect, it } from "vitest";
import {
  expiryFrom,
  generateOtpCode,
  generateSiteKey,
  generateToken,
  hashToken,
  isExpired,
  tokensMatch,
} from "../src/lib/tokens.js";

describe("generateToken", () => {
  it("is URL safe, because the reset token travels in a query string", () => {
    // Plain base64 would be wrong here: a `+` becomes a space when the URL is
    // parsed and a `/` reads as a path separator, so some fraction of reset
    // links would silently fail to match.
    for (let index = 0; index < 200; index += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("carries 256 bits by default", () => {
    // 32 bytes in base64url is 43 characters with no padding.
    expect(generateToken()).toHaveLength(43);
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index += 1) seen.add(generateToken());

    expect(seen.size).toBe(1000);
  });
});

describe("hashToken", () => {
  it("is stable for the same input", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("differs for different inputs", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });

  it("is lowercase hex, which survives any column collation", () => {
    // Base64 would be ambiguous under a case-insensitive collation, so two
    // different hashes could collide on a unique index. Hex cannot.
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not contain the input", () => {
    expect(hashToken("secret-token-value")).not.toContain("secret");
  });
});

describe("tokensMatch", () => {
  it("matches identical strings", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, and an uncaught throw
    // here would be a 500 on a wrong OTP.
    expect(() => tokensMatch("short", "a-much-longer-value")).not.toThrow();
    expect(tokensMatch("short", "a-much-longer-value")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(tokensMatch("", "")).toBe(true);
    expect(tokensMatch("", "x")).toBe(false);
  });
});

describe("generateOtpCode", () => {
  it("is always six digits", () => {
    for (let index = 0; index < 500; index += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it("can produce a code with leading zeros", () => {
    // Padding rather than ranging from 100000 keeps 000042 reachable. Starting
    // at 100000 would quietly discard a tenth of the space, and a six-digit
    // code has little enough to spare.
    let sawLeadingZero = false;

    for (let index = 0; index < 20_000 && !sawLeadingZero; index += 1) {
      if (generateOtpCode().startsWith("0")) sawLeadingZero = true;
    }

    expect(sawLeadingZero).toBe(true);
  });

  it("spreads across the range rather than clustering", () => {
    // A weak generator that always returned the same prefix would pass the
    // shape check above. This is a smoke test, not a statistical one.
    const firstDigits = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      firstDigits.add(generateOtpCode()[0]!);
    }

    expect(firstDigits.size).toBeGreaterThanOrEqual(8);
  });
});

describe("expiry helpers", () => {
  it("expiryFrom adds seconds to the given moment", () => {
    const base = new Date("2026-01-01T00:00:00.000Z");
    expect(expiryFrom(900, base).toISOString()).toBe("2026-01-01T00:15:00.000Z");
  });

  it("isExpired is true at the boundary, not just past it", () => {
    // A code that expires at exactly now is expired. The alternative lets a
    // request arriving on the same millisecond through, which is a race nobody
    // needs to reason about.
    const at = new Date("2026-01-01T00:00:00.000Z");

    expect(isExpired(at, new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
    expect(isExpired(at, new Date("2025-12-31T23:59:59.999Z"))).toBe(false);
    expect(isExpired(at, new Date("2026-01-01T00:00:00.001Z"))).toBe(true);
  });

  it("isExpired treats a missing date as expired, which fails closed", () => {
    expect(isExpired(null)).toBe(true);
  });
});

describe("generateSiteKey", () => {
  it("is prefixed so it is recognisable in a log or a bug report", () => {
    expect(generateSiteKey()).toMatch(/^mf_site_[0-9a-f]{32}$/);
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) seen.add(generateSiteKey());

    expect(seen.size).toBe(500);
  });
});
