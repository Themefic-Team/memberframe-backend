/**
 * Rate limit arithmetic and origin matching.
 *
 * Both are pure functions with no database, and both are places where an
 * off-by-one is invisible until it matters: a limit that allows one too many,
 * or an origin check that accepts a hostname it should not.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { hit, resetRateLimits } from "../src/middleware/rateLimit.js";
import { originAllowed } from "../src/middleware/site.js";

beforeEach(() => {
  resetRateLimits();
});

describe("hit", () => {
  it("allows exactly the limit and refuses the next", () => {
    const now = 1_000_000;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(hit("key", 5, 900, now).allowed).toBe(true);
    }

    expect(hit("key", 5, 900, now).allowed).toBe(false);
  });

  it("reports how long to wait, and the number is usable", () => {
    const now = 1_000_000;

    for (let attempt = 0; attempt < 6; attempt += 1) hit("key", 5, 900, now);

    const decision = hit("key", 5, 900, now + 300_000);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it("never reports a zero wait while refusing", () => {
    // "Try again in 0 seconds" is the defect the frontend's parseRetryAfter
    // had, and it reads as broken rather than as a limit.
    const now = 1_000_000;
    for (let attempt = 0; attempt < 6; attempt += 1) hit("key", 5, 900, now);

    const decision = hit("key", 5, 900, now + 899_999);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("starts a fresh window once the old one passes", () => {
    const now = 1_000_000;
    for (let attempt = 0; attempt < 6; attempt += 1) hit("key", 5, 900, now);

    expect(hit("key", 5, 900, now + 900_001).allowed).toBe(true);
  });

  it("keeps separate keys separate", () => {
    const now = 1_000_000;
    for (let attempt = 0; attempt < 6; attempt += 1) hit("email:a@example.com", 5, 900, now);

    // The whole point of scoping by key: exhausting one address must not
    // refuse another, or one attacker locks out every member at once.
    expect(hit("email:b@example.com", 5, 900, now).allowed).toBe(true);
  });

  it("allows a limit of one exactly once", () => {
    const now = 1_000_000;

    expect(hit("single", 1, 60, now).allowed).toBe(true);
    expect(hit("single", 1, 60, now).allowed).toBe(false);
  });
});

describe("originAllowed", () => {
  const allowed = ["https://creator.example.com", "https://preview.framer.website"];

  it("accepts an exact match", () => {
    expect(originAllowed("https://creator.example.com", allowed)).toBe(true);
  });

  it("ignores a trailing slash, which browsers and humans disagree about", () => {
    expect(originAllowed("https://creator.example.com/", allowed)).toBe(true);
  });

  it("refuses a different scheme", () => {
    // http and https are different origins. Accepting the first would let a
    // network attacker on a cafe wifi read the session cookie.
    expect(originAllowed("http://creator.example.com", allowed)).toBe(false);
  });

  it("refuses a different port", () => {
    expect(originAllowed("https://creator.example.com:8443", allowed)).toBe(false);
  });

  it("refuses a subdomain that was not listed", () => {
    // No wildcard support, deliberately. A subdomain wildcard on a host that
    // serves any user content is an open door.
    expect(originAllowed("https://evil.creator.example.com", allowed)).toBe(false);
  });

  it("refuses a suffix attack", () => {
    // The classic: a loosened check using endsWith or includes would accept
    // this. It is a completely different domain that happens to end the same
    // way.
    expect(originAllowed("https://creator.example.com.attacker.test", allowed)).toBe(false);
    expect(originAllowed("https://notcreator.example.com", allowed)).toBe(false);
  });

  it("refuses a missing or empty origin", () => {
    expect(originAllowed(undefined, allowed)).toBe(false);
    expect(originAllowed("", allowed)).toBe(false);
  });

  it("refuses everything when the allowlist is empty", () => {
    // A site with no configured origins serves no browser. That is the correct
    // default for a row created before anyone set it up.
    expect(originAllowed("https://creator.example.com", [])).toBe(false);
  });

  it("refuses a literal wildcard even if someone puts one in the list", () => {
    // `Allow-Origin: *` cannot coexist with `Allow-Credentials: true`, so a
    // wildcard in the database would not do what whoever typed it expected. It
    // matches nothing here, which is the safe reading.
    expect(originAllowed("https://anything.test", ["*"])).toBe(false);
  });
});
