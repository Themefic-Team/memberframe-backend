/**
 * Framefic's email designs, as MemberFrame sends them (F19). The layouts are
 * BEAF's; what is pinned here is that every value is escaped, the images are
 * attached by cid, and each email says what it is for.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {} }));

import { env } from "../src/config/env.js";
import { customerMailHtml, teamMailHtml } from "../src/lib/frameficMail.js";
import { accountCodeMail } from "../src/lib/mailer.js";
import { planReceiptMail, teamNotice, trialEndedMail } from "../src/services/license/licenseMail.js";

const HOSTILE = `Evil <script>alert(1)</script> & "Co"`;

describe("the customer design", () => {
  it("escapes every value and keeps the brand highlight", () => {
    const html = customerMailHtml({
      heading: HOSTILE,
      subheading: HOSTILE,
      greetingName: HOSTILE,
      paragraphs: [`Your project **${HOSTILE}** is ready.`],
      footnote: HOSTILE,
    });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<strong style="color: #8aa2ff; font-weight: 700;">');
  });

  it("draws the code box and attaches the Framefic logo and the wave by cid", () => {
    const mail = accountCodeMail("me@example.com", "123456", "signup", "Sam");
    expect(mail.html).toContain(">123456</span>");
    expect(mail.html).toContain("cid:framefic-logo");
    expect(mail.html).toContain("cid:wave-image");
    expect(mail.attachments?.map((file) => file.cid)).toEqual(["framefic-logo", "wave-image"]);
    expect(mail.text).toContain("123456");
  });

  it("words the three code emails as BEAF does", () => {
    expect(accountCodeMail("a@b.co", "1", "signup").subject).toBe("Verify your MemberFrame account email");
    expect(accountCodeMail("a@b.co", "1", "reset").subject).toBe("Reset your MemberFrame password");
    expect(accountCodeMail("a@b.co", "1", "signin").subject).toBe("Your MemberFrame sign-in code");
    expect(accountCodeMail("a@b.co", "1", "reset").html).toContain("your account remains unchanged");
  });

  it("sends receipts and trial notices in the same design", () => {
    const receipt = planReceiptMail("a@b.co", { projectName: "Portfolio", plan: "yearly", amountMinor: 4666, creditMinor: 333, currency: "usd", periodEnd: null, kind: "upgrade" }, "Sam");
    expect(receipt.html).toContain("$46.66");
    expect(receipt.html).toContain("$3.33");
    expect(receipt.html).toContain("Hi Sam,");
    expect(trialEndedMail("a@b.co", "Portfolio").subject).toBe("Your MemberFrame trial has ended");
  });
});

describe("the team design", () => {
  it("is sent only when a team address is set", () => {
    (env.billing as { teamEmail: string }).teamEmail = "";
    expect(teamNotice("signup", { name: "Sam", email: "sam@x.co" })).toBeNull();
    (env.billing as { teamEmail: string }).teamEmail = "team@framefic.com";
    const mail = teamNotice("purchase", { name: "Sam", email: "sam@x.co", projectName: "Portfolio", siteId: "site_1" }, { plan: "monthly", amountMinor: 499, currency: "usd", transactionId: "in_1" });
    expect(mail?.to).toBe("team@framefic.com");
    expect(mail?.html).toContain("Subscription Order");
    expect(mail?.html).toContain("4.99 <span");
    expect(mail?.html).toContain("Pro Monthly");
    (env.billing as { teamEmail: string }).teamEmail = "";
  });

  it("escapes what a customer typed", () => {
    const html = teamMailHtml(
      { title: "t", badge: "b", tone: "red", heading: "h", intro: "i", summaryLabel: "s", summaryValue: HOSTILE, rows: [{ label: "Feedback", value: HOSTILE }] },
      "team@framefic.com"
    );
    expect(html).not.toContain("<script>alert(1)");
  });
});
