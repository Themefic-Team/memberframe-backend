/**
 * The email layout and every template built on it.
 *
 * Two things are worth proving. The site name is typed by a creator and lands
 * in every member's inbox, so it must arrive escaped wherever it appears. And
 * every message must still say what it is for in plain text, because a
 * text-only client shows nothing else.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {} }));

import { escapeHtml, renderEmail } from "../src/lib/emailLayout.js";
import {
  creatorCodeMail,
  otpMail,
  passwordChangedMail,
  passwordResetMail,
  verifyEmailMail,
} from "../src/lib/mailer.js";

const HOSTILE = `Evil <script>alert(1)</script> & "Co"`;

describe("renderEmail", () => {
  const html = renderEmail({
    brand: HOSTILE,
    preheader: "Preview line",
    heading: "Heading",
    intro: ["Intro"],
    code: "143501",
    action: { label: "Go", url: `https://example.com/reset?token=a"b<c` },
    details: ["Details"],
    safety: "Safety",
  });

  it("escapes the brand everywhere it appears", () => {
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml(HOSTILE));
  });

  it("cannot be broken out of the button's href", () => {
    expect(html).not.toContain(`token=a"b`);
    expect(html).toContain("token=a&quot;b&lt;c");
  });

  it("is a whole document with the preheader and the code", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Preview line");
    expect(html).toContain("143501");
    expect(html).toContain("Sent by");
  });

  it("does not credit MemberFrame twice when MemberFrame is the sender", () => {
    const own = renderEmail({ brand: "MemberFrame", preheader: "", heading: "", intro: [], safety: "" });
    expect(own).toContain("Sent by MemberFrame.");
    expect(own).not.toContain("with MemberFrame");
  });
});

describe("every template", () => {
  const mails = {
    otp: otpMail("a@example.com", "111111", HOSTILE, "site_1"),
    verify: verifyEmailMail("a@example.com", "222222", HOSTILE, "site_1"),
    reset: passwordResetMail("a@example.com", "https://site.example/reset-password?token=tok", HOSTILE, "site_1"),
    changed: passwordChangedMail("a@example.com", HOSTILE, "site_1"),
    creator: creatorCodeMail("a@example.com", "333333"),
  };

  it.each(Object.entries(mails))("%s has designed HTML and a plain text part", (_name, mail) => {
    expect(mail.text.length).toBeGreaterThan(0);
    expect(mail.html).toBeDefined();
    expect(mail.html!.startsWith("<!doctype html>")).toBe(true);
    expect(mail.html).not.toContain("<script>");
  });

  it("puts each code in both parts", () => {
    expect(mails.otp.html).toContain("111111");
    expect(mails.otp.text).toContain("111111");
    expect(mails.verify.html).toContain("222222");
    expect(mails.creator.html).toContain("333333");
  });

  it("gives the reset email a button and the link in text", () => {
    expect(mails.reset.html).toContain("Choose a new password");
    expect(mails.reset.text).toContain("tok");
  });

  it("falls back to MemberFrame when a site has no name", () => {
    expect(passwordChangedMail("a@example.com", "", "site_1").subject).toBe("Your MemberFrame password was changed");
    expect(otpMail("a@example.com", "1", "  ", "site_1").subject).toBe("Your MemberFrame sign-in code");
  });
});
