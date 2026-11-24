/**
 * The Home promo campaign card's env (37-promo-campaign-card.md): explicit
 * switches, validated minutes, plain text, nothing invented; and the public
 * route that answers it, outside the creator token check.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {}, checkDatabase: async () => ({ connected: true, version: null, database: null, warnings: [], error: null }) }));

const { MAX_DURATION_MINUTES, announcementView, campaignView, parseMinutes, parseSwitch, plainText } = await import("../src/services/license/announcement.js");
type AnnouncementSource = import("../src/services/license/announcement.js").AnnouncementSource;
const { createApp } = await import("../src/app.js");
const { env } = await import("../src/config/env.js");

const source = (patch: Partial<AnnouncementSource> = {}): AnnouncementSource => ({
  enabled: "yes",
  campaignId: "bfcm26",
  couponCode: "50LTDBFCM26",
  countdownEnabled: "yes",
  durationMinutes: "3",
  countdownVisibleMinutes: "3",
  title: "Black Friday Offer 2026",
  subtitle: "Get Flat 50% Off on Lifetime Plan.",
  buttonText: "Grab the Deal Now",
  showTo: "",
  ...patch,
});

describe("announcement env parsing", () => {
  it("reads yes/no and true/false in any case, and nothing else", () => {
    expect(parseSwitch("yes", false)).toBe(true);
    expect(parseSwitch("TRUE", false)).toBe(true);
    expect(parseSwitch("No", true)).toBe(false);
    expect(parseSwitch("false", true)).toBe(false);
    expect(parseSwitch("", true)).toBe(true);
    expect(parseSwitch("1", true)).toBeUndefined();
    expect(parseSwitch("maybe", true)).toBeUndefined();
  });

  it("takes positive, finite minutes up to seven days", () => {
    expect(parseMinutes("3")).toBe(3);
    expect(parseMinutes("0.5")).toBe(0.5);
    expect(parseMinutes("")).toBeNull();
    for (const bad of ["0", "-3", "abc", "Infinity", "NaN", "1e3", "3 minutes", String(MAX_DURATION_MINUTES + 1)]) expect(parseMinutes(bad)).toBeUndefined();
    expect(parseMinutes(String(MAX_DURATION_MINUTES))).toBe(MAX_DURATION_MINUTES);
  });

  it("keeps text plain: control characters and runs of space out, cut on whole characters", () => {
    expect(plainText("  Black\nFriday\t\tOffer ", 80)).toBe("Black Friday Offer");
    expect(plainText("<img src=x onerror=alert(1)>", 80)).toBe("<img src=x onerror=alert(1)>");
    expect(plainText("abcdef", 3)).toBe("abc");
  });
});

describe("the campaign card", () => {
  it("normalizes the documented example", () => {
    expect(campaignView(source())).toEqual({
      campaign: {
        id: "bfcm26",
        title: "Black Friday Offer 2026",
        subtitle: "Get Flat 50% Off on Lifetime Plan.",
        buttonText: "Grab the Deal Now",
        couponCode: "50LTDBFCM26",
        showTo: "free",
        audience: ["free"],
        countdown: { enabled: true, durationMinutes: 3, visibleMinutes: 3 },
      },
      problems: [],
    });
  });

  it("is hidden when switched off", () => {
    for (const off of ["no", "false", "NO"]) expect(announcementView(source({ enabled: off })).campaign).toBeNull();
  });

  it("is hidden, and says why once, when a value does not parse", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const patch of [
      { enabled: "maybe" },
      { campaignId: "bf cm/26" },
      { title: "" },
      { buttonText: "  " },
      { couponCode: "50LTD BFCM26" },
      { countdownEnabled: "on" },
      { durationMinutes: "0" },
      { durationMinutes: "" },
      { durationMinutes: "Infinity" },
      { countdownVisibleMinutes: "-1" },
    ]) {
      expect(campaignView(source(patch)).campaign, JSON.stringify(patch)).toBeNull();
      expect(campaignView(source(patch)).problems.length, JSON.stringify(patch)).toBeGreaterThan(0);
    }
    announcementView(source({ durationMinutes: "x" }));
    announcementView(source({ durationMinutes: "x" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("50LTDBFCM26");
    warn.mockRestore();
  });

  it("has no card and no complaint without a campaign id", () => {
    expect(campaignView(source({ campaignId: "" }))).toEqual({ campaign: null, problems: [] });
  });

  it("caps the visible countdown at the duration, and shows it all when unset", () => {
    expect(campaignView(source({ durationMinutes: "3", countdownVisibleMinutes: "10" })).campaign?.countdown).toEqual({ enabled: true, durationMinutes: 3, visibleMinutes: 3 });
    expect(campaignView(source({ durationMinutes: "60", countdownVisibleMinutes: "" })).campaign?.countdown).toEqual({ enabled: true, durationMinutes: 60, visibleMinutes: 60 });
    expect(campaignView(source({ durationMinutes: "60", countdownVisibleMinutes: "5" })).campaign?.countdown).toEqual({ enabled: true, durationMinutes: 60, visibleMinutes: 5 });
  });

  it("drops the timer entirely when the countdown is off, ignoring its minutes", () => {
    expect(campaignView(source({ countdownEnabled: "no", durationMinutes: "junk" })).campaign?.countdown).toEqual({ enabled: false, durationMinutes: null, visibleMinutes: null });
    expect(campaignView(source({ countdownEnabled: "" })).campaign?.countdown.enabled).toBe(false);
  });

  it("invents nothing: no coupon is null, an empty subtitle stays empty", () => {
    const campaign = campaignView(source({ couponCode: "", subtitle: "" })).campaign!;
    expect(campaign.couponCode).toBeNull();
    expect(campaign.subtitle).toBe("");
    expect(campaignView(source({ couponCode: "none" })).campaign!.couponCode).toBeNull();
  });

  it("copies the coupon exactly as written, and lowercases the campaign id for storage", () => {
    const campaign = campaignView(source({ couponCode: "Ltd50", campaignId: "BFCM26" })).campaign!;
    expect(campaign.couponCode).toBe("Ltd50");
    expect(campaign.id).toBe("bfcm26");
  });

  it("answers only the public campaign fields, never a key or secret", () => {
    const view = announcementView(source({ showTo: "all" }));
    expect(Object.keys(view)).toEqual(["campaign"]);
    expect(Object.keys(view.campaign!).sort()).toEqual(["audience", "buttonText", "countdown", "couponCode", "id", "showTo", "subtitle", "title"]);
    expect(JSON.stringify(view)).not.toMatch(/STRIPE|DATABASE|SECRET|sk_|pk_|whsec_|price_/);
  });

  it("reads who sees it: free, a comma list of plans, or all", () => {
    expect(campaignView(source({ showTo: "free,monthly" })).campaign).toMatchObject({ audience: ["free", "monthly"], showTo: "free" });
    expect(campaignView(source({ showTo: " Monthly , FREE " })).campaign?.audience).toEqual(["free", "monthly"]);
    expect(campaignView(source({ showTo: "all" })).campaign).toMatchObject({ audience: ["free", "monthly", "yearly", "lifetime"], showTo: "all" });
    expect(campaignView(source({ showTo: "free monthly yearly lifetime" })).campaign?.showTo).toBe("all");
    expect(campaignView(source({ showTo: "" })).campaign?.audience).toEqual(["free"]);
    expect(campaignView(source({ showTo: "free,weekly" })).campaign).toBeNull();
  });
});

describe("GET /api/plugin/announcement", () => {
  let base = "";
  let close: () => void = () => undefined;

  beforeAll(async () => {
    Object.assign(env.announcement, source({ showTo: "free,monthly" }));
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("answers without a creator token, never cached, with CORS for the panel", async () => {
    const response = await fetch(`${base}/api/plugin/announcement`, { headers: { Origin: "https://framer.com" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as { campaign?: { id: string; couponCode: string; audience: string[] } };
    expect(body.campaign).toMatchObject({ id: "bfcm26", couponCode: "50LTDBFCM26", audience: ["free", "monthly"] });
  });

  it("leaves the billing routes behind the creator token", async () => {
    const response = await fetch(`${base}/api/plugin/license?siteId=x`);
    expect(response.status).toBe(401);
  });
});
