/**
 * F19's decisions, with no database. Development doc: 19-pro-lock-and-trial.md.
 *
 * The license matrix every caller shares, the upgrade arithmetic the product
 * owner asked for (day 10 of a month, then yearly), Stripe's statuses in this
 * table's words, the one-word public answer, and the hosted account page.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {} }));

import { decideLicense, subscriptionLicenses, type SubscriptionRow, type TrialRow } from "../src/services/license/licenseService.js";
import { MIN_CHARGE_MINOR, isUpgrade, unusedCreditMinor, upgradeQuote, yearlySavingPercent } from "../src/services/license/proration.js";
import { ourStatus } from "../src/services/license/billingService.js";
import { publicLicenseState } from "../src/routes/license.js";
import { trialRefusal } from "../src/services/license/trialService.js";
import { renderAuthSuccessPage, renderCreatorAuthPage, renderMockGooglePage } from "../src/lib/creatorAuthPageHtml.js";
import { isValidSessionId } from "../src/services/creatorHandoffService.js";

const NOW = new Date("2026-10-18T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const trial = (overrides: Partial<TrialRow> = {}): TrialRow => ({
  siteId: "site_a",
  status: "trialing",
  startedAt: at(-2),
  endsAt: at(5),
  projectName: "Portfolio",
  ...overrides,
});

const sub = (overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: "sub_1",
  plan: "monthly",
  status: "active",
  amountMinor: 499,
  currency: "usd",
  startedAt: at(-10),
  currentPeriodStart: at(-10),
  currentPeriodEnd: at(20),
  cancelAtPeriodEnd: false,
  createdAt: at(-10),
  ...overrides,
});

const decide = (input: { siteId?: string; trial?: TrialRow | null; subscriptions?: SubscriptionRow[] }) =>
  decideLicense({ siteId: input.siteId ?? "site_a", now: NOW, trial: input.trial ?? null, subscriptions: input.subscriptions ?? [] });

describe("the license matrix", () => {
  it("is none for a project that never had a trial or a plan", () => {
    expect(decide({}).state).toBe("none");
  });

  it("is trial while this project's trial runs, then expired", () => {
    expect(decide({ trial: trial() })).toMatchObject({ state: "trial", plan: "trial", trialEndsAt: at(5).toISOString() });
    expect(decide({ trial: trial({ endsAt: at(-1) }) }).state).toBe("expired");
    expect(decide({ trial: trial({ status: "expired" }) }).state).toBe("expired");
  });

  it("names the other project when the owner's trial is bound elsewhere", () => {
    expect(decide({ siteId: "site_b", trial: trial() })).toMatchObject({ state: "trial_claimed_other_site", claimedProjectName: "Portfolio" });
  });

  it("is active on a paying plan, whatever the trial says", () => {
    expect(decide({ trial: trial({ endsAt: at(-1) }), subscriptions: [sub()] })).toMatchObject({ state: "active", plan: "monthly" });
    expect(decide({ siteId: "site_b", trial: trial(), subscriptions: [sub()] }).state).toBe("active");
  });

  it("keeps a failed renewal licensed while Stripe retries, the same in the panel and on the page", () => {
    expect(decide({ subscriptions: [sub({ status: "past_due" })] }).state).toBe("active");
  });

  it("keeps a cancelled plan until its period ends, then expires it", () => {
    expect(decide({ subscriptions: [sub({ status: "canceling", cancelAtPeriodEnd: true })] })).toMatchObject({ state: "active", cancelAtPeriodEnd: true });
    expect(decide({ subscriptions: [sub({ status: "canceling", currentPeriodEnd: at(-1) })] }).state).toBe("expired");
    expect(decide({ subscriptions: [sub({ status: "canceled" })] }).state).toBe("expired");
  });

  it("ignores an abandoned checkout", () => {
    expect(decide({ subscriptions: [sub({ status: "incomplete" })] }).state).toBe("none");
  });

  it("prefers lifetime over a recurring plan held at the same time", () => {
    const view = decide({ subscriptions: [sub(), sub({ id: "life", plan: "lifetime", status: "paid", currentPeriodEnd: null, createdAt: at(-1) })] });
    expect(view).toMatchObject({ state: "active", plan: "lifetime", subscriptionId: "life" });
  });

  it("licenses only real plans", () => {
    expect(subscriptionLicenses(sub({ plan: "team" }), NOW)).toBe(false);
  });
});

describe("upgrades", () => {
  it("credits 20 unused days of a $4.99 month against the yearly price", () => {
    // The product owner's example: monthly bought, upgraded to yearly on day 10.
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-10-31T00:00:00Z");
    const tenth = new Date("2026-10-11T00:00:00Z");
    expect(unusedCreditMinor(499, start, end, tenth)).toBe(333);
    expect(upgradeQuote({ from: "monthly", to: "yearly", paidMinor: 499, periodStart: start, periodEnd: end, targetPriceMinor: 4999, now: tenth })).toEqual({
      allowed: true,
      creditMinor: 333,
      amountDueMinor: 4666,
    });
    expect(upgradeQuote({ from: "monthly", to: "lifetime", paidMinor: 499, periodStart: start, periodEnd: end, targetPriceMinor: 9999, now: tenth }).amountDueMinor).toBe(9666);
  });

  it("refuses downgrades and the same plan, as BEAF", () => {
    expect(upgradeQuote({ from: "yearly", to: "monthly", paidMinor: 4999, periodStart: NOW, periodEnd: at(365), targetPriceMinor: 499, now: NOW })).toMatchObject({ allowed: false, reason: "downgrade_not_allowed" });
    expect(upgradeQuote({ from: "lifetime", to: "yearly", paidMinor: 9999, periodStart: null, periodEnd: null, targetPriceMinor: 4999, now: NOW }).reason).toBe("downgrade_not_allowed");
    expect(upgradeQuote({ from: "monthly", to: "monthly", paidMinor: 499, periodStart: NOW, periodEnd: at(30), targetPriceMinor: 499, now: NOW }).reason).toBe("same_plan");
    expect(isUpgrade("monthly", "yearly")).toBe(true);
    expect(isUpgrade("lifetime", "monthly")).toBe(false);
  });

  it("never charges below Stripe's minimum, and gives no credit for an ended period", () => {
    const quote = upgradeQuote({ from: "yearly", to: "lifetime", paidMinor: 9990, periodStart: at(-1), periodEnd: at(364), targetPriceMinor: 9999, now: NOW });
    expect(quote.amountDueMinor).toBe(MIN_CHARGE_MINOR);
    expect(quote.creditMinor).toBe(9999 - MIN_CHARGE_MINOR);
    expect(unusedCreditMinor(499, at(-40), at(-10), NOW)).toBe(0);
  });

  it("works out the yearly saving from the real prices: 17% for $4.99 and $49.99", () => {
    expect(yearlySavingPercent(499, 4999)).toBe(17);
    expect(yearlySavingPercent(500, 6000)).toBe(0);
  });
});

describe("Stripe's statuses", () => {
  it("map to this table's words", () => {
    expect(ourStatus("active", false)).toBe("active");
    expect(ourStatus("active", true)).toBe("canceling");
    expect(ourStatus("trialing", false)).toBe("active");
    expect(ourStatus("past_due", false)).toBe("past_due");
    expect(ourStatus("canceled", false)).toBe("canceled");
    expect(ourStatus("incomplete", false)).toBe("incomplete");
    expect(ourStatus("unpaid", false)).toBe("expired");
    expect(ourStatus("incomplete_expired", false)).toBe("expired");
  });
});

describe("the public answer", () => {
  it("is one of three words, and everything unlicensed is locked", () => {
    expect(publicLicenseState("active")).toBe("active");
    expect(publicLicenseState("trial")).toBe("trial");
    for (const state of ["expired", "none", "trial_claimed_other_site"]) expect(publicLicenseState(state)).toBe("expired");
  });
});

describe("trial refusals", () => {
  // Account, email, and site only: the Framer user and project are no longer
  // read (Marketplace review, 2026-10-28).
  const input = { userId: "u1", email: "me@x.com", siteId: "s1" };
  it("name the identifier that already had a trial", () => {
    expect(trialRefusal({ userId: "u1", email: "o@x.com" }, input)).toBe("account");
    expect(trialRefusal({ userId: "u2", email: "me@x.com" }, input)).toBe("email");
    expect(trialRefusal({ userId: "u2", email: "o@x.com" }, input)).toBe("site");
  });
});

describe("the hosted account page", () => {
  const page = (overrides: Partial<Parameters<typeof renderCreatorAuthPage>[0]> = {}) =>
    renderCreatorAuthPage({ mode: "login", sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", theme: "dark", googleEnabled: false, error: "", ...overrides });

  it("carries its settings as JSON that cannot close the script tag", () => {
    const html = page({ error: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("clones BEAF's page: theme, tabs, and the 7-day trial sign up", () => {
    expect(page({ theme: "light" })).toContain('<html lang="en" class="light-mode">');
    const register = page({ mode: "register" });
    expect(register).toContain(">Sign Up - Start 7 Days Free Trial</button>");
    expect(register).toContain('id="tab-register" class="tab active"');
    expect(page({})).toContain(">Continue with Email</button>");
    expect(page({})).toContain("Or sign in with password");
  });

  it("shows Google only when MemberFrame's own Google client is set", () => {
    expect(page({ googleEnabled: false })).not.toContain('id="google-auth-btn"');
    expect(page({ googleEnabled: true })).toContain('id="google-auth-btn"');
  });

  it("simulates Google on a server without keys, as BEAF does, posting to the dev-only route", () => {
    const html = renderMockGooglePage({ sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", theme: "light" });
    expect(html).toContain("Simulate Google Sign In");
    expect(html).toContain('action="/api/account/google/mock" method="POST"');
    expect(html).toContain('name="sessionId" value="a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"');
    expect(renderMockGooglePage({ sessionId: "\"><script>", theme: "dark" })).not.toContain("\"><script>");
  });

  it("says Authentication Successful, with the trial pill only when a trial is coming", () => {
    expect(renderAuthSuccessPage({ theme: "dark", trial: true })).toContain("7-Day Free Trial Activated");
    expect(renderAuthSuccessPage({ theme: "dark", trial: false })).not.toContain("7-Day Free Trial Activated");
  });

  it("accepts only session ids shaped like the plugin's", () => {
    expect(isValidSessionId("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")).toBe(true);
    expect(isValidSessionId("short")).toBe(false);
    expect(isValidSessionId("<script>alert(1)</script>xxxxxxxx")).toBe(false);
  });
});
