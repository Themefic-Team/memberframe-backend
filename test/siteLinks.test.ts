/**
 * Where an emailed link sends a member.
 *
 * The reset link used to open a placeholder host from the server config. It
 * must open the site the member was on, at the creator's reset page, and it
 * must never open a host the site has not allowlisted: a reset token mailed to
 * someone else's page is an account takeover.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {} }));

import { passwordResetUrl, pickSiteOrigin } from "../src/lib/siteLinks.js";

const ALLOWED = [
  "https://project-abc.framercanvas.com",
  "http://localhost:5173",
  "https://forgiving-mountain-216251.framer.app",
  "https://members.example.com",
];

describe("pickSiteOrigin", () => {
  it("uses the site the member is on when it is allowlisted", () => {
    expect(pickSiteOrigin("https://members.example.com", ALLOWED)).toBe("https://members.example.com");
    expect(pickSiteOrigin("https://members.example.com/", ALLOWED)).toBe("https://members.example.com");
  });

  it("never trusts an origin the site has not allowlisted", () => {
    expect(pickSiteOrigin("https://attacker.example", ALLOWED)).toBe("https://forgiving-mountain-216251.framer.app");
  });

  it("never sends a member to the Framer editor, and prefers a public host over localhost", () => {
    expect(pickSiteOrigin("https://project-abc.framercanvas.com", ALLOWED)).toBe(
      "https://forgiving-mountain-216251.framer.app"
    );
    expect(pickSiteOrigin(undefined, ["http://localhost:5173"])).toBe("http://localhost:5173");
    expect(pickSiteOrigin(undefined, ["https://framer.com"])).toBeNull();
    expect(pickSiteOrigin(undefined, [])).toBeNull();
  });
});

describe("passwordResetUrl", () => {
  it("opens the creator's reset page on the site, with the token", () => {
    expect(
      passwordResetUrl("abc123", { origin: "https://forgiving-mountain-216251.framer.app", resetPath: "/reset-password" })
    ).toBe("https://forgiving-mountain-216251.framer.app/reset-password?token=abc123");
    expect(passwordResetUrl("a b", { origin: "https://x.example", resetPath: "/members/reset" })).toBe(
      "https://x.example/members/reset?token=a+b"
    );
  });

  it("refuses a reset path that would leave the site", () => {
    expect(passwordResetUrl("t", { origin: "https://x.example", resetPath: "//evil.example/x" })).toBe(
      "https://x.example/reset-password?token=t"
    );
  });

  it("falls back to the server template only when no origin is known", () => {
    expect(passwordResetUrl("t", { origin: null, resetPath: "/reset-password" })).toContain("t");
  });
});
