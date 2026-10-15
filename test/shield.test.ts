import { describe, expect, it } from "vitest";
import { generateShieldJs, handleShieldScript } from "../src/routes/shield.js";
import type { GatedPageRule } from "../src/lib/siteSettings.js";
import type { Request, Response } from "express";

describe("generateShieldJs", () => {
  const sampleRules: GatedPageRule[] = [
    {
      path: "/dashboard",
      enabled: true,
      requiredTier: "signed_in",
      fallbackAction: "redirect",
      redirectPath: "/login",
    },
    {
      path: "/vip-lounge",
      enabled: true,
      requiredTier: "vip",
      fallbackAction: "redirect",
      redirectPath: "/pricing",
    },
    {
      path: "/draft-page",
      enabled: false,
      requiredTier: "signed_in",
      fallbackAction: "redirect",
      redirectPath: "/",
    },
  ];

  const sampleTiers = [
    { key: "free_member" as const, rank: 0, name: "Free" },
    { key: "tier_1" as const, rank: 1, name: "Silver" },
    { key: "tier_2" as const, rank: 2, name: "Gold" },
    { key: "vip" as const, rank: 3, name: "VIP" },
  ];

  it("generates an IIFE containing siteKey, apiBase, and active rules", () => {
    const js = generateShieldJs({
      siteKey: "pk_test_12345",
      apiBase: "https://api.memberframe.framefic.com",
      loginPath: "/login",
      rules: sampleRules,
      tiers: sampleTiers,
    });

    expect(js).toContain("var SITE_KEY = \"pk_test_12345\"");
    expect(js).toContain("var API_BASE = \"https://api.memberframe.framefic.com\"");
    expect(js).toContain("var LOGIN_PATH = \"/login\"");
    // Active rules are included
    expect(js).toContain("/dashboard");
    expect(js).toContain("/vip-lounge");
    // Disabled rule is filtered out
    expect(js).not.toContain("/draft-page");
  });

  it("embeds anti-FOUC veil style and timeout safety", () => {
    const js = generateShieldJs({
      siteKey: "pk_test_xyz",
      apiBase: "https://api.memberframe.framefic.com",
      loginPath: "/login",
      rules: sampleRules,
      tiers: sampleTiers,
    });

    expect(js).toContain("memberframe-shield-veil");
    expect(js).toContain("html { visibility: hidden !important; opacity: 0 !important; }");
    expect(js).toContain("unhideTimer = setTimeout");
    expect(js).toContain("window.location.replace");
  });

  it("includes entitlement resolution and tier ranking checks", () => {
    const js = generateShieldJs({
      siteKey: "pk_test_xyz",
      apiBase: "https://api.memberframe.framefic.com",
      loginPath: "/login",
      rules: sampleRules,
      tiers: sampleTiers,
    });

    expect(js).toContain("function checkEntitled");
    expect(js).toContain("heldRank >= reqRank");
    expect(js).toContain("credentials: \"include\"");
  });
});

describe("handleShieldScript HTTP response", () => {
  it("returns no-site script when no siteKey or siteId is provided", async () => {
    let responseBody = "";
    const headers: Record<string, string> = {};

    const req = {
      query: {},
      headers: {},
    } as unknown as Request;

    const res = {
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
      send(body: string) {
        responseBody = body;
      },
    } as unknown as Response;

    await handleShieldScript(req, res);

    expect(headers["Content-Type"]).toBe("application/javascript; charset=utf-8");
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(responseBody).toContain("No site identified or configured");
  });
});
