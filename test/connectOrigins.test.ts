/**
 * Origin handling for the connect flow.
 *
 * `normalizeOrigins` decides what goes into a site's allowlist, and that list
 * is the only thing standing between a site key, which is public and baked into
 * every published component, and a request from anywhere. The site key
 * identifies; the origin allowlist is what verifies. Backend PRD section 3.2.
 *
 * So a bug here is not a formatting bug. An entry that can never match means a
 * creator's own site is refused in production after working in preview, and an
 * entry that matches too much means the key stops being tied to one site.
 */

import { describe, expect, it } from "vitest";
import { mergeOrigins, normalizeOrigins } from "../src/services/creatorAuthService.js";

describe("normalizeOrigins", () => {
  it("keeps scheme, host, and port, and drops everything else", () => {
    // An `Origin` header is never sent with a path, a query, or a trailing
    // slash, so a stored value carrying one could not match anything.
    expect(normalizeOrigins(["https://acme.framer.website/login?x=1"])).toEqual([
      "https://acme.framer.website",
    ]);

    expect(normalizeOrigins(["https://acme.com/"])).toEqual(["https://acme.com"]);
    expect(normalizeOrigins(["https://acme.com:8443/a/b"])).toEqual(["https://acme.com:8443"]);
  });

  it("refuses plain http for a real host", () => {
    // The session cookie is Secure. An http origin could never carry it, so
    // storing one promises a creator something that cannot work, and it is the
    // configuration a network attacker would most like to find.
    expect(normalizeOrigins(["http://acme.com"])).toEqual([]);
    expect(normalizeOrigins(["http://acme.framer.website"])).toEqual([]);
  });

  it("allows http on loopback, which is the one legitimate case", () => {
    expect(normalizeOrigins(["http://localhost:3000"])).toEqual(["http://localhost:3000"]);
    expect(normalizeOrigins(["http://127.0.0.1:5173"])).toEqual(["http://127.0.0.1:5173"]);
  });

  it("refuses a scheme that is not http or https", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "chrome-extension://abc",
    ]) {
      expect(normalizeOrigins([value])).toEqual([]);
    }
  });

  it("refuses what is not a URL at all", () => {
    // The most common creator mistake: typing a bare domain. Refusing it is
    // right, and `POST /api/site/origins` answers `no_valid_origins` so they
    // are told rather than left with a silently empty list.
    for (const value of ["acme.com", "", "   ", "not a url", "//acme.com"]) {
      expect(normalizeOrigins([value])).toEqual([]);
    }
  });

  it("deduplicates, including after normalisation", () => {
    expect(
      normalizeOrigins(["https://acme.com", "https://acme.com/", "https://acme.com/login"])
    ).toEqual(["https://acme.com"]);
  });

  it("is case correct on the host and keeps the port distinct", () => {
    // A host is case insensitive and a browser lowercases it in the header, so
    // the stored form has to be lowercase or an exact match never fires.
    expect(normalizeOrigins(["https://ACME.com"])).toEqual(["https://acme.com"]);

    // A port is part of the origin. These are two different origins and must
    // not collapse into one.
    expect(normalizeOrigins(["https://acme.com:443", "https://acme.com:8443"])).toEqual([
      // :443 is the default for https and the URL parser drops it, which is
      // also what a browser does when it builds the header.
      "https://acme.com",
      "https://acme.com:8443",
    ]);
  });

  it("bounds the list", () => {
    const many = Array.from({ length: 60 }, (_, index) => `https://site-${index}.test`);
    expect(normalizeOrigins(many)).toHaveLength(25);
  });

  it("skips a non-string without throwing", () => {
    const input = ["https://acme.com", 7, null, undefined] as unknown as string[];
    expect(normalizeOrigins(input)).toEqual(["https://acme.com"]);
  });
});

describe("mergeOrigins", () => {
  it("adds without losing what is there", () => {
    // The case that matters: a creator reconnects from a Framer preview URL,
    // and the custom domain they added last week must survive it.
    expect(mergeOrigins(["https://acme.com"], ["https://preview.framer.website"])).toEqual([
      "https://acme.com",
      "https://preview.framer.website",
    ]);
  });

  it("does not duplicate", () => {
    expect(mergeOrigins(["https://acme.com"], ["https://acme.com"])).toEqual(["https://acme.com"]);
  });

  it("treats a corrupt stored value as empty rather than throwing", () => {
    // The column is JSON and Prisma types it as JsonValue, so the compiler
    // cannot promise it is an array of strings. A row edited by hand in Prisma
    // Studio is exactly how it stops being one.
    expect(mergeOrigins(null, ["https://acme.com"])).toEqual(["https://acme.com"]);
    expect(mergeOrigins("oops", ["https://acme.com"])).toEqual(["https://acme.com"]);
    expect(mergeOrigins([1, "https://acme.com", null], ["https://b.test"])).toEqual([
      "https://acme.com",
      "https://b.test",
    ]);
  });

  it("bounds the merged list", () => {
    const stored = Array.from({ length: 24 }, (_, index) => `https://s${index}.test`);
    const added = Array.from({ length: 10 }, (_, index) => `https://n${index}.test`);

    expect(mergeOrigins(stored, added)).toHaveLength(25);
  });
});
