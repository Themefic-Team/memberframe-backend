/**
 * Site Domains, typed by the creator since 2026-10-28 (Marketplace review):
 * the check on add (lib/domainCheck.ts) and the sightings that show whether a
 * domain is really this site (lib/originSightings.ts). Nothing from Framer.
 */

import { describe, expect, it } from "vitest";
import { isPublicAddress, statusVerdict } from "../src/lib/domainCheck.js";
import { MAX_SIGHTINGS, readSightings, recordableOrigin, sightingViews, withSighting } from "../src/lib/originSightings.js";

describe("isPublicAddress", () => {
  it("accepts public addresses", () => {
    expect(isPublicAddress("104.18.20.1")).toBe(true);
    expect(isPublicAddress("2606:4700::6810:1401")).toBe(true);
  });

  it("refuses every address inside a network, so the check cannot reach one", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not an ip"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("statusVerdict", () => {
  it("reads a Framer 404 as nothing published there, which is how a typo shows", () => {
    expect(statusVerdict(404)).toEqual({ ok: false, reason: "not_published" });
    expect(statusVerdict(410)).toEqual({ ok: false, reason: "not_published" });
  });

  it("accepts a page, a redirect, and a password protected site", () => {
    for (const status of [200, 301, 308, 401, 403]) expect(statusVerdict(status), String(status)).toEqual({ ok: true });
  });

  it("reads a server error or no answer as unreachable", () => {
    expect(statusVerdict(503)).toEqual({ ok: false, reason: "unreachable" });
    expect(statusVerdict(undefined)).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("sightings", () => {
  const now = new Date("2026-10-28T12:00:00Z");

  it("records a published site, never the Framer editor", () => {
    expect(recordableOrigin("https://acme.com/")).toBe("https://acme.com");
    expect(recordableOrigin("https://project-abc.framercanvas.com")).toBeNull();
    expect(recordableOrigin("https://framer.com")).toBeNull();
    expect(recordableOrigin(undefined)).toBeNull();
    expect(recordableOrigin("not a url")).toBeNull();
  });

  it("keeps the newest, at most the cap", () => {
    let stored: unknown = null;
    for (let i = 0; i < MAX_SIGHTINGS + 5; i += 1) {
      stored = withSighting(stored, `https://s${i}.framer.app`, new Date(now.getTime() + i * 1000));
    }
    const kept = Object.keys(readSightings(stored));
    expect(kept).toHaveLength(MAX_SIGHTINGS);
    expect(kept).toContain(`https://s${MAX_SIGHTINGS + 4}.framer.app`);
    expect(kept).not.toContain("https://s0.framer.app");
  });

  it("drops anything malformed rather than trusting it", () => {
    expect(readSightings({ "https://a.com": { lastSeenAt: "nope" }, "https://b.com": 5, "https://c.com": { lastSeenAt: now.toISOString() } })).toEqual({
      "https://c.com": { lastSeenAt: now.toISOString() },
    });
    expect(readSightings([1, 2])).toEqual({});
  });

  it("reads the column when the driver hands it back as text", () => {
    const at = now.toISOString();
    expect(readSightings(JSON.stringify({ "https://acme.com": { lastSeenAt: at } }))).toEqual({ "https://acme.com": { lastSeenAt: at } });
    expect(readSightings("not json")).toEqual({});
  });

  it("marks which sightings are listed, newest first, so Profile can suggest the rest", () => {
    const stored = withSighting(withSighting(null, "https://old.framer.app", now), "https://acme.com", new Date(now.getTime() + 60_000));
    expect(sightingViews(stored, ["https://old.framer.app"])).toEqual([
      { origin: "https://acme.com", lastSeenAt: new Date(now.getTime() + 60_000).toISOString(), allowed: false },
      { origin: "https://old.framer.app", lastSeenAt: now.toISOString(), allowed: true },
    ]);
  });
});
