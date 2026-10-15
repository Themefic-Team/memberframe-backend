/**
 * MemberFrame Global Route Shield.
 *
 * Serves an ultra-fast, zero-flash JavaScript snippet that creators paste into
 * Framer's `Site Settings > Custom Code > <head>`.
 *
 * When loaded in `<head>`:
 *   1. It immediately inspects `window.location.pathname`.
 *   2. If the current route is NOT locked, it terminates in < 0.1ms with zero DOM modification.
 *   3. If the current route IS locked:
 *      - It instantly injects an anti-FOUC style (`html { visibility: hidden !important; }`)
 *        preventing any 1ms leak of private content before the page paints.
 *      - It checks the member's session against `/api/member/session` (or fast session cache).
 *      - If not entitled, redirects immediately using `window.location.replace()`.
 *      - If entitled, removes the veil seamlessly so the page renders smoothly.
 */

import type { Request, Response } from "express";
import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { loadSiteSettings } from "../services/settingsService.js";
import { loadTierLadder } from "../services/sessionService.js";
import type { GatedPageRule } from "../lib/siteSettings.js";
import type { TierLadderEntry } from "../lib/entitlement.js";

export interface ShieldScriptConfig {
  siteKey: string;
  apiBase: string;
  loginPath: string;
  rules: GatedPageRule[];
  tiers: TierLadderEntry[];
}

/**
 * Generate client-side executable JavaScript for the shield.
 * Formatted as an immediately-invoked function expression (IIFE) with zero dependencies.
 */
export function generateShieldJs(config: ShieldScriptConfig): string {
  const activeRules = (config.rules || []).filter((r) => r.enabled);

  return `/**
 * MemberFrame Global Route Shield
 * Site Key: ${config.siteKey}
 */
(function() {
  if (typeof window === "undefined") return;
  if (window.__MEMBERFRAME_SHIELD_INITIALIZED__) return;
  window.__MEMBERFRAME_SHIELD_INITIALIZED__ = true;

  var SITE_KEY = ${JSON.stringify(config.siteKey)};
  var API_BASE = ${JSON.stringify(config.apiBase)};
  var LOGIN_PATH = ${JSON.stringify(config.loginPath || "/login")};
  var RULES = ${JSON.stringify(activeRules)};
  var TIERS = ${JSON.stringify(config.tiers || [])};

  var rawPath = window.location.pathname || "/";
  var currentPath = rawPath.replace(/\\/+$/, "") || "/";
  var matchedRule = null;

  for (var i = 0; i < RULES.length; i++) {
    var r = RULES[i];
    if (!r || !r.enabled) continue;
    var rulePath = (r.path || "").trim().replace(/\\/+$/, "") || "/";
    if (currentPath === rulePath || (rulePath !== "/" && currentPath.indexOf(rulePath + "/") === 0)) {
      matchedRule = r;
      break;
    }
  }

  // Current page is not locked - exit immediately
  if (!matchedRule) return;

  // Zero-flash anti-FOUC veil for protected route
  var veil = document.createElement("style");
  veil.id = "memberframe-shield-veil";
  veil.textContent = "html { visibility: hidden !important; opacity: 0 !important; }";
  (document.head || document.documentElement).appendChild(veil);

  var unhideTimer = setTimeout(function() {
    if (veil.parentNode) veil.parentNode.removeChild(veil);
  }, 3500);

  function reveal() {
    clearTimeout(unhideTimer);
    if (veil.parentNode) veil.parentNode.removeChild(veil);
  }

  function redirectAway() {
    clearTimeout(unhideTimer);
    var dest = matchedRule.redirectPath || LOGIN_PATH || "/";
    if (dest === currentPath) {
      reveal();
      return;
    }
    window.location.replace(dest);
  }

  function checkEntitled(session, requiredTier, ladder) {
    if (requiredTier === "anyone") return true;
    if (!session) return false;
    if (session.status !== "active" && session.status !== "trialing") return false;
    if (requiredTier === "signed_in") return true;

    var heldRank = -1;
    var reqRank = 999;
    for (var j = 0; j < ladder.length; j++) {
      if (ladder[j].key === session.activeTier) heldRank = ladder[j].rank;
      if (ladder[j].key === requiredTier) reqRank = ladder[j].rank;
    }
    return heldRank >= reqRank;
  }

  // Fast tab session cache check
  try {
    var rawCache = sessionStorage.getItem("__mf_session_" + SITE_KEY);
    if (rawCache) {
      var cached = JSON.parse(rawCache);
      if (Date.now() - cached.ts < 30000 && cached.session) {
        if (checkEntitled(cached.session, matchedRule.requiredTier, TIERS)) {
          reveal();
          return;
        } else {
          redirectAway();
          return;
        }
      }
    }
  } catch (e) {}

  // Verify session with server
  fetch(API_BASE + "/api/member/session", {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "X-MemberFrame-Site": SITE_KEY
    }
  })
  .then(function(res) {
    if (res.status === 401 || res.status === 403) {
      redirectAway();
      return null;
    }
    if (!res.ok) {
      redirectAway();
      return null;
    }
    return res.json();
  })
  .then(function(data) {
    if (!data) return;
    var member = data.member;
    var ladder = data.tiers || TIERS;
    if (checkEntitled(member, matchedRule.requiredTier, ladder)) {
      try {
        sessionStorage.setItem("__mf_session_" + SITE_KEY, JSON.stringify({
          ts: Date.now(),
          session: member
        }));
      } catch (e) {}
      reveal();
    } else {
      redirectAway();
    }
  })
  .catch(function() {
    redirectAway();
  });
})();
`;
}

/**
 * Handle GET /api/member/shield.js or /api/shield.js
 */
export async function handleShieldScript(req: Request, res: Response): Promise<void> {
  const queryKey =
    typeof req.query?.["siteKey"] === "string"
      ? req.query["siteKey"].trim()
      : typeof req.query?.["site"] === "string"
        ? req.query["site"].trim()
        : undefined;

  const siteId =
    typeof req.query?.["siteId"] === "string" ? req.query["siteId"].trim() : undefined;

  let site: { id: string; siteKey: string } | null = null;

  if (queryKey) {
    site = await prisma.site.findUnique({
      where: { siteKey: queryKey },
      select: { id: true, siteKey: true },
    });
  } else if (siteId) {
    site = await prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, siteKey: true },
    });
  } else if (req.headers.referer) {
    try {
      const refOrigin = new URL(req.headers.referer).origin.replace(/\/+$/, "");
      const allSites = await prisma.site.findMany({
        select: { id: true, siteKey: true, allowedOrigins: true },
      });
      for (const s of allSites) {
        if (Array.isArray(s.allowedOrigins) && s.allowedOrigins.includes(refOrigin)) {
          site = { id: s.id, siteKey: s.siteKey };
          break;
        }
      }
    } catch {
      // ignore invalid referer
    }
  }

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");

  if (!site) {
    res.send(`/** MemberFrame Global Route Shield: No site identified or configured */`);
    return;
  }

  const settings = await loadSiteSettings(site.id);
  const tiers = await loadTierLadder(site.id);
  const rules = settings.gatedPages || [];
  const loginPath = settings.auth?.loginPath || "/login";
  const apiBase = env.apiBaseUrl;

  const js = generateShieldJs({
    siteKey: site.siteKey,
    apiBase,
    loginPath,
    rules,
    tiers,
  });

  res.send(js);
}
