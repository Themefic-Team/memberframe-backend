/**
 * 27-instance-seal.md: a component works only when the Builder inserted it
 * for this site, and only on the editor or the site's own domains.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {} }));

import { issueSeal, verifySeal } from "../src/lib/instanceSeal.js";
import { componentState, licenseAnswer, originBelongs } from "../src/routes/license.js";

describe("the instance seal", () => {
  it("verifies for the site it was issued to, and no other", () => {
    const seal = issueSeal("site_a");
    expect(seal).toMatch(/^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifySeal("site_a", seal)).toBe(true);
    expect(verifySeal("site_b", seal)).toBe(false);
  });

  it("refuses a tampered, empty, or malformed seal", () => {
    const seal = issueSeal("site_a");
    const [version, nonce, signature] = seal.split(".");
    expect(verifySeal("site_a", `${version}.${nonce}x.${signature}`)).toBe(false);
    const flipped = signature!.endsWith("A") ? "B" : "A";
    expect(verifySeal("site_a", `${version}.${nonce}.${signature!.slice(0, -1)}${flipped}`)).toBe(false);
    expect(verifySeal("site_a", "")).toBe(false);
    expect(verifySeal("site_a", null)).toBe(false);
    expect(verifySeal("site_a", "s1.short.sig")).toBe(false);
  });

  it("makes a different seal every time", () => {
    expect(issueSeal("site_a")).not.toBe(issueSeal("site_a"));
  });
});

describe("what a component draws", () => {
  const allowed = ["https://tabfolio.framer.website"];

  it("runs on the editor, the site's own domains, or with no browser origin", () => {
    expect(originBelongs("https://abc.framercanvas.com", allowed)).toBe(true);
    expect(originBelongs("https://framer.com", allowed)).toBe(true);
    expect(originBelongs("null", allowed)).toBe(true);
    expect(originBelongs(undefined, allowed)).toBe(true);
    expect(originBelongs("https://tabfolio.framer.website", allowed)).toBe(true);
    expect(originBelongs("https://someone-else.framer.website", allowed)).toBe(false);
  });

  it("refuses a copy before reading the license, and holds a pre-seal component to the license alone", () => {
    expect(componentState({ license: "trial", seal: "", sealValid: false, originOk: true })).toBe("copied");
    expect(componentState({ license: "active", seal: "s1.x.y", sealValid: false, originOk: true })).toBe("copied");
    expect(componentState({ license: "active", seal: "s1.x.y", sealValid: true, originOk: false })).toBe("foreign");
    expect(componentState({ license: "trial", seal: "s1.x.y", sealValid: true, originOk: true })).toBe("trial");
    expect(componentState({ license: "expired", seal: "s1.x.y", sealValid: true, originOk: true })).toBe("expired");
    expect(componentState({ license: "trial_claimed_other_site", seal: undefined, sealValid: false, originOk: true })).toBe("expired");
    expect(componentState({ license: "active", seal: undefined, sealValid: false, originOk: true })).toBe("active");
  });

  it("sends a trial's end with a trial answer only, so the component can count down to it", () => {
    const end = "2026-11-01T10:00:00.000Z";
    expect(licenseAnswer("trial", end)).toEqual({ state: "trial", trialEndsAt: end });
    expect(licenseAnswer("active", end)).toEqual({ state: "active" });
    expect(licenseAnswer("expired", null)).toEqual({ state: "expired" });
    expect(licenseAnswer("copied", end)).toEqual({ state: "copied" });
    expect(licenseAnswer("trial", null)).toEqual({ state: "trial" });
  });
});
