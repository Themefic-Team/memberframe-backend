/**
 * MemberFrame Global Route Shield.
 *
 * Serves a small, dependency-free script that creators paste into Framer's
 * `Site Settings > Custom Code > <head>`. Loaded there it runs before the page
 * paints, which is the only place a page-level lock can stop content flashing.
 *
 * It guards two kinds of page:
 *
 *   1. LOCKED pages, from the Page Locks rules. The page is hidden, the
 *      session is checked, and the page is shown only to an entitled member.
 *      Everyone else is sent to the rule's redirect. A slow or failed check
 *      never reveals the page: it fails closed, to the redirect.
 *
 *   2. GUEST pages, the sign in and sign up pages. A signed-in member is sent
 *      to the After sign in page before the form paints. These fail open: a
 *      slow check shows the form, because a sign in form is not a secret.
 *      They are hidden only when this browser has signed in here before (a
 *      hint the MemberFrame components keep in localStorage), so a first-time
 *      visitor never waits on a request to see a sign in form.
 *
 * ## In-site navigation
 *
 * Framer sites switch pages with the History API, so a head script that only
 * looks at the first URL is bypassed by any link. The shield therefore also:
 *
 *   - hides the page on a click to a guarded path, in the capture phase,
 *     before Framer's router renders it
 *   - re-checks after every pushState, replaceState, and popstate
 *
 * Each check carries a sequence number, so a slow answer for a page the
 * visitor already left cannot redirect them from the page they are on now.
 */

import type { Request, Response } from "express";
import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { loadSiteSettings } from "../services/settingsService.js";
import { loadTierLadder } from "../services/sessionService.js";
import { isSafeSitePath, type GatedPageRule } from "../lib/siteSettings.js";
import type { TierLadderEntry } from "../lib/entitlement.js";

export interface ShieldScriptConfig {
  siteKey: string;
  apiBase: string;
  loginPath: string;
  /** Where a signed-in member on a guest page is sent. */
  afterLoginPath?: string;
  /** Sign in and sign up pages. A signed-in member is moved off them. */
  guestPaths?: string[];
  rules: GatedPageRule[];
  tiers: TierLadderEntry[];
}

/**
 * The guest pages for a site: its sign in and sign up paths, each once, never
 * the home page. A creator who put sign in on `/` did not mean to send every
 * signed-in member away from their home page.
 */
export function shieldGuestPaths(paths: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const path = raw.trim().replace(/\/+$/, "") || "/";
    if (path === "/" || !isSafeSitePath(path) || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Generate client-side executable JavaScript for the shield.
 * An IIFE in ES5, with zero dependencies: it runs before anything else loads.
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
  var AFTER_LOGIN_PATH = ${JSON.stringify(config.afterLoginPath || "")};
  var GUEST_PATHS = ${JSON.stringify(config.guestPaths || [])};
  var RULES = ${JSON.stringify(activeRules)};
  var TIERS = ${JSON.stringify(config.tiers || [])};

  // Shared with the MemberFrame components. Change them together.
  var CACHE_KEY = "__mf_session_" + SITE_KEY;
  var HINT_KEY = "memberframe:signed-in:" + SITE_KEY;
  var DENIED_KEY = "memberframe:denied:" + SITE_KEY;

  var CACHE_MS = 30000;
  var DENIED_MS = 60000;
  var LOCKED_TIMEOUT_MS = 10000;
  var GUEST_TIMEOUT_MS = 4000;
  var CLICK_GRACE_MS = 1500;

  function norm(path) {
    return (path || "/").replace(/\\/+$/, "") || "/";
  }

  function ruleFor(path) {
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (!r || !r.enabled) continue;
      var rulePath = norm((r.path || "").trim());
      if (path === rulePath || (rulePath !== "/" && path.indexOf(rulePath + "/") === 0)) return r;
    }
    return null;
  }

  function isGuestPath(path) {
    for (var i = 0; i < GUEST_PATHS.length; i++) if (GUEST_PATHS[i] === path) return true;
    return false;
  }

  /* ---- Storage. Every access can throw in a private window. ---- */

  function hasHint() {
    try { return window.localStorage.getItem(HINT_KEY) === "1"; } catch (e) { return false; }
  }

  function setHint(on) {
    try {
      if (on) window.localStorage.setItem(HINT_KEY, "1");
      else window.localStorage.removeItem(HINT_KEY);
    } catch (e) {}
  }

  function readCache() {
    try {
      var raw = window.sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || !cached.session || Date.now() - cached.ts > CACHE_MS) return null;
      return { member: cached.session, ladder: cached.tiers || TIERS };
    } catch (e) { return null; }
  }

  function writeCache(member, ladder) {
    try {
      window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), session: member, tiers: ladder }));
    } catch (e) {}
  }

  function clearCache() {
    try { window.sessionStorage.removeItem(CACHE_KEY); } catch (e) {}
  }

  /** The path a signed-in member was just turned away from, so nothing sends them straight back. */
  function recentlyDenied(path) {
    try {
      var raw = window.sessionStorage.getItem(DENIED_KEY);
      if (!raw) return false;
      var denied = JSON.parse(raw);
      return denied && denied.path === path && Date.now() - denied.ts < DENIED_MS;
    } catch (e) { return false; }
  }

  function markDenied(path) {
    try { window.sessionStorage.setItem(DENIED_KEY, JSON.stringify({ path: path, ts: Date.now() })); } catch (e) {}
  }

  /* ---- The veil ---- */

  var veil = null;

  function hide() {
    if (veil) return;
    veil = document.createElement("style");
    veil.id = "memberframe-shield-veil";
    veil.textContent = "html { visibility: hidden !important; opacity: 0 !important; }";
    (document.head || document.documentElement).appendChild(veil);
  }

  function show() {
    if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    veil = null;
  }

  /* ---- Session ---- */

  function checkEntitled(session, requiredTier, ladder) {
    if (requiredTier === "anyone") return true;
    if (!session) return false;
    // PRD 11.3, the same rule as isEntitled: a past_due member keeps access
    // through the grace window, a canceled one until the period they paid for ends.
    var nowSeconds = Date.now() / 1000;
    var statusOk =
      session.status === "active" ||
      session.status === "trialing" ||
      (session.status === "past_due" && nowSeconds < (session.gracePeriodEndsAt || 0)) ||
      (session.status === "canceled" && nowSeconds < (session.currentPeriodEnd || 0));
    if (!statusOk) return false;
    if (requiredTier === "signed_in") return true;

    var heldRank = -1;
    var reqRank = 999;
    for (var j = 0; j < ladder.length; j++) {
      if (ladder[j].key === session.activeTier) heldRank = ladder[j].rank;
      if (ladder[j].key === requiredTier) reqRank = ladder[j].rank;
    }
    return heldRank >= reqRank;
  }

  /** One request at a time, shared by every check that is waiting on it. */
  var inFlight = null;

  function fetchSession() {
    if (inFlight) return inFlight;

    inFlight = fetch(API_BASE + "/api/member/session", {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/json",
        "X-MemberFrame-Site": SITE_KEY
      }
    })
    .then(function(res) {
      if (res.status === 401 || res.status === 403) {
        return res.json().catch(function() { return {}; }).then(function(body) {
          return { member: null, ladder: (body && body.tiers) || TIERS };
        });
      }
      if (!res.ok) throw new Error("session check failed");
      return res.json().then(function(body) {
        return { member: (body && body.member) || null, ladder: (body && body.tiers) || TIERS };
      });
    })
    .then(function(result) {
      inFlight = null;
      if (result.member) {
        writeCache(result.member, result.ladder);
        setHint(true);
      } else {
        clearCache();
        setHint(false);
      }
      return result;
    }, function(error) {
      inFlight = null;
      throw error;
    });

    return inFlight;
  }

  /* ---- Outcomes ---- */

  function deny(rule, path, member) {
    var dest = norm(rule.redirectPath || LOGIN_PATH || "/");
    if (dest === path) {
      // A rule that redirects to itself is a misconfiguration, and hiding the
      // page forever would be worse than showing it.
      show();
      return;
    }
    if (member) markDenied(path);
    window.location.replace(dest);
  }

  /**
   * A signed-in member on a sign in page. Send them on, unless the After sign
   * in page would turn them away again, which would loop.
   */
  function leaveGuestPage(member, ladder, path) {
    var dest = norm(AFTER_LOGIN_PATH || "/");
    if (dest === path) return false;
    var destRule = ruleFor(dest);
    if (destRule && !checkEntitled(member, destRule.requiredTier, ladder)) return false;
    if (recentlyDenied(dest)) return false;
    window.location.replace(dest);
    return true;
  }

  function handoffInProgress() {
    // The social sign in tab coming back with its one-time code. MemberAuth
    // on this page finishes it; moving the tab now would lose the code.
    return (window.location.hash || "").indexOf("mf_oauth") !== -1;
  }

  /** Does this path need a check before it may be shown? */
  function needsCheck(path) {
    var rule = ruleFor(path);
    if (rule) {
      var cached = readCache();
      return !(cached && checkEntitled(cached.member, rule.requiredTier, cached.ladder));
    }
    return isGuestPath(path) && (hasHint() || readCache() !== null);
  }

  /* ---- The guard ---- */

  var seq = 0;
  var guardedPath = null;

  function guard(rawPath) {
    var path = norm(rawPath);
    if (path === guardedPath && veil) return;
    guardedPath = path;
    var id = ++seq;

    var rule = ruleFor(path);

    if (rule) {
      var cached = readCache();
      if (cached) {
        if (checkEntitled(cached.member, rule.requiredTier, cached.ladder)) show();
        else deny(rule, path, cached.member);
        return;
      }

      hide();
      var lockedTimer = setTimeout(function() {
        if (id === seq) deny(rule, path, null);
      }, LOCKED_TIMEOUT_MS);

      fetchSession().then(function(result) {
        clearTimeout(lockedTimer);
        if (id !== seq) return;
        if (checkEntitled(result.member, rule.requiredTier, result.ladder)) show();
        else deny(rule, path, result.member);
      }, function() {
        clearTimeout(lockedTimer);
        if (id === seq) deny(rule, path, null);
      });
      return;
    }

    if (isGuestPath(path) && !handoffInProgress()) {
      var known = readCache();
      if (known) {
        if (!leaveGuestPage(known.member, known.ladder, path)) show();
        return;
      }
      if (!hasHint()) {
        show();
        return;
      }

      hide();
      var guestTimer = setTimeout(function() {
        if (id === seq) show();
      }, GUEST_TIMEOUT_MS);

      fetchSession().then(function(result) {
        clearTimeout(guestTimer);
        if (id !== seq) return;
        if (!(result.member && leaveGuestPage(result.member, result.ladder, path))) show();
      }, function() {
        clearTimeout(guestTimer);
        if (id === seq) show();
      });
      return;
    }

    show();
  }

  function recheck() {
    guardedPath = null;
    guard(window.location.pathname);
  }

  guard(window.location.pathname);

  /* ---- In-site navigation ---- */

  function wrapHistory(name) {
    var original = window.history && window.history[name];
    if (typeof original !== "function") return;
    window.history[name] = function() {
      var before = window.location.pathname;
      var result = original.apply(this, arguments);
      if (window.location.pathname !== before) recheck();
      return result;
    };
  }

  wrapHistory("pushState");
  wrapHistory("replaceState");
  window.addEventListener("popstate", recheck);

  // Capture phase, so this runs before Framer's router renders the next page.
  document.addEventListener("click", function(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    var el = event.target;
    while (el && el.nodeName !== "A") el = el.parentNode;
    if (!el || !el.href || el.hasAttribute("download")) return;
    if (el.target && el.target !== "_self") return;

    var url;
    try { url = new URL(el.href, window.location.href); } catch (e) { return; }
    if (url.origin !== window.location.origin) return;

    var path = norm(url.pathname);
    if (path === norm(window.location.pathname) || !needsCheck(path)) return;

    hide();
    var clickSeq = seq;
    // The router normally changes the URL at once and the history hook takes
    // over. If it never does, settle on the page that is actually showing.
    setTimeout(function() {
      if (seq === clickSeq) recheck();
    }, CLICK_GRACE_MS);
  }, true);

  // The MemberFrame components announce sign in and sign out on this page.
  window.addEventListener("memberframe:session-updated", function(event) {
    clearCache();
    setHint(!!(event && event.detail && event.detail.signedIn));
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
    afterLoginPath: settings.auth?.afterLoginPath || "/",
    guestPaths: shieldGuestPaths([settings.auth?.loginPath, settings.auth?.signupPath]),
    rules,
    tiers,
  });

  res.send(js);
}
