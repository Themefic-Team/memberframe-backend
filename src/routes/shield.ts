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
import { isSafeSitePath, sectionLockSlug, type GatedPageRule, type SectionLockRule } from "../lib/siteSettings.js";
import type { TierLadderEntry } from "../lib/entitlement.js";
import { loadPaymentSettings } from "../services/payments/gatewayStore.js";

export interface ShieldScriptConfig {
  siteKey: string;
  apiBase: string;
  loginPath: string;
  /** The pricing page, where a section lock's "See plans" card goes. */
  pricingPath?: string;
  /** Where a signed-in member on a guest page is sent. */
  afterLoginPath?: string;
  /** Sign in, sign up, and reset pages. A signed-in member is moved off them. */
  guestPaths?: string[];
  /** The reset page: a guest page, except when it carries a reset token. */
  resetPath?: string;
  rules: GatedPageRule[];
  tiers: TierLadderEntry[];
  /** Section locks: layers named "Lock: <rule name>". */
  sectionRules?: SectionLockRule[];
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
  const sectionRules = (config.sectionRules || []).map((r) => ({
    name: r.name,
    slug: sectionLockSlug(r.name),
    enabled: r.enabled,
    audience: r.audience,
    requiredTier: r.requiredTier,
    lockedAction: r.lockedAction,
  }));

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
  var PRICING_PATH = ${JSON.stringify(config.pricingPath || "/pricing")};
  var AFTER_LOGIN_PATH = ${JSON.stringify(config.afterLoginPath || "")};
  var GUEST_PATHS = ${JSON.stringify(config.guestPaths || [])};
  var RESET_PATH = ${JSON.stringify(config.resetPath || "")};
  var RULES = ${JSON.stringify(activeRules)};
  var TIERS = ${JSON.stringify(config.tiers || [])};
  var SECTION_RULES = ${JSON.stringify(sectionRules)};

  // Shared with the MemberFrame components. Change them together.
  var CACHE_KEY = "__mf_session_" + SITE_KEY;
  var HINT_KEY = "memberframe:signed-in:" + SITE_KEY;
  var DENIED_KEY = "memberframe:denied:" + SITE_KEY;

  var CACHE_MS = 30000;
  var DENIED_MS = 60000;
  var LOCKED_TIMEOUT_MS = 10000;
  var GUEST_TIMEOUT_MS = 4000;
  var CLICK_GRACE_MS = 1500;
  var REDIRECT_SETTLE_MS = 400;

  function norm(path) {
    return (path || "/").replace(/\\/+$/, "") || "/";
  }

  /*
    A rule path covers itself and every page under it. A ":name" segment is a
    Framer CMS page's item slot and matches any one segment, so "/blog/:slug"
    locks every post and leaves "/blog" itself open. Compared literally it
    would match nothing, since no real URL contains ":slug".
  */
  function pathMatches(path, rulePath) {
    if (rulePath === "/") return path === "/";
    var want = rulePath.split("/");
    var have = path.split("/");
    if (have.length < want.length) return false;
    for (var i = 0; i < want.length; i++) {
      if (want[i].charAt(0) === ":") {
        if (!have[i]) return false;
      } else if (want[i] !== have[i]) {
        return false;
      }
    }
    return true;
  }

  function ruleFor(path) {
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (!r || !r.enabled) continue;
      if (pathMatches(path, norm((r.path || "").trim()))) return r;
    }
    return null;
  }

  function isGuestPath(path) {
    // A reset link (?token=) is for setting a password, signed in or not.
    if (path === RESET_PATH && /[?&]token=/.test(window.location.search || "")) return false;
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
  /** Set once the shield sends the visitor away. Nothing shows the page after that. */
  var redirecting = false;

  function hide() {
    if (veil) return;
    veil = document.createElement("style");
    veil.id = "memberframe-shield-veil";
    veil.textContent = "html { visibility: hidden !important; opacity: 0 !important; }";
    (document.head || document.documentElement).appendChild(veil);
  }

  function show() {
    if (redirecting) return;
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

  /**
   * Leave this page for dest with a real page load, the page hidden throughout.
   *
   * location.replace alone is not enough on a Framer site. Fired while
   * Framer's router is still moving to the locked page, the browser hands it to
   * the router as an in-page navigation: the address bar says dest and the
   * locked page stays rendered. Reproduced in Chrome against a published site.
   * So the veil stays up for good, and if this document is still here once the
   * URL reads dest, it is reloaded, which the router does not take over.
   */
  function hardRedirect(dest) {
    redirecting = true;
    hide();
    window.location.replace(dest);
    setTimeout(function() {
      if (norm(window.location.pathname) === norm(dest)) window.location.reload();
    }, REDIRECT_SETTLE_MS);
  }

  /**
   * Where a turned-away visitor goes.
   *
   * Signed out: the rule's Redirect to, usually the sign in page.
   *
   * Signed in without the plan: never a sign in page. Sending them there only
   * for the sign in page to send them on to the dashboard is two redirects and
   * a flash of a form they cannot use. They go to the After sign in page, or
   * the home page if that is locked to them too. A rule that redirects to any
   * other page, a pricing page say, is followed as written: that is where the
   * creator wants a member without the plan to land.
   */
  function denyDestination(rule, path, member, ladder) {
    var dest = norm(rule.redirectPath || LOGIN_PATH || "/");
    if (!member) return dest;
    if (!isGuestPath(dest) && dest !== norm(LOGIN_PATH)) return dest;

    var candidates = [AFTER_LOGIN_PATH || "/", "/"];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = norm(candidates[i]);
      if (candidate === path || isGuestPath(candidate)) continue;
      var candidateRule = ruleFor(candidate);
      if (candidateRule && !checkEntitled(member, candidateRule.requiredTier, ladder || TIERS)) continue;
      return candidate;
    }
    return dest;
  }

  function deny(rule, path, member, ladder) {
    var dest = denyDestination(rule, path, member, ladder);
    if (dest === path) {
      // A rule that redirects to itself is a misconfiguration, and hiding the
      // page forever would be worse than showing it.
      show();
      return;
    }
    if (member) markDenied(path);
    hardRedirect(dest);
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
    hardRedirect(dest);
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

  /* ---- Section locks ----
   *
   * A layer opts in through the code override the plugin writes into the
   * creator's project, MemberLocks, one per rule: it adds data-mf-lock and a
   * mf-lock-<slug> class to the layer. A layer named "Lock: <rule name>" opts
   * in the same way, through the data-framer-name Framer publishes. Every
   * tagged layer is hidden from the first paint by a stylesheet this script
   * writes before the body is parsed.
   * Once the session is known each rule shows, blurs, or keeps hiding its
   * layers. A style rule, not a DOM change, so it holds across Framer's page
   * changes and re-renders with nothing to re-apply.
   *
   * Rule names are limited to letters, digits, spaces, and - _ . by the
   * settings validator, so they sit in a quoted selector with no escaping.
   * A tagged layer whose rule does not exist stays hidden: fail closed. A
   * rule that is switched off is a lock that is off: its layers show.
   */

  var SECTION_TAGS = ['[data-framer-name^="Lock:" i]', "[data-mf-lock]", '[class*="mf-lock-"]'];
  var sectionStyle = null;

  function sectionSelector(rule) {
    return (
      '[data-framer-name="Lock: ' + rule.name + '" i],[data-framer-name="Lock:' + rule.name + '" i],' +
      '[data-mf-lock="' + rule.name + '" i],.mf-lock-' + rule.slug
    );
  }

  /** result: null while checking, "unavailable" when the API failed, else { member, ladder }. */
  function sectionCss(result) {
    var shown = [];
    var blurred = [];
    gateRules = [];
    for (var i = 0; i < SECTION_RULES.length; i++) {
      var r = SECTION_RULES[i];
      var visible;
      if (!r.enabled) visible = true;
      else if (result === null) visible = false;
      else if (result === "unavailable") visible = r.audience === "others";
      else {
        var entitled = checkEntitled(result.member, r.requiredTier, result.ladder || TIERS);
        visible = r.audience === "members" ? entitled : !entitled;
      }
      if (visible) shown.push(sectionSelector(r));
      else if (result !== null && r.lockedAction === "blur") {
        blurred.push(sectionSelector(r));
        // A members' lock gets the sign in or upgrade card over its blur.
        if (r.audience === "members") gateRules.push(r);
      }
    }

    var exempt = shown.concat(blurred);
    var not = exempt.length ? ":not(" + exempt.join(",") + ")" : "";
    var hide = [];
    for (var t = 0; t < SECTION_TAGS.length; t++) hide.push(SECTION_TAGS[t] + not);
    var css = hide.join(",") + "{display:none !important}";
    if (blurred.length) {
      css += blurred.join(",") + "{filter:blur(10px) !important;pointer-events:none !important;user-select:none !important}";
    }
    return css;
  }

  function applySections(result) {
    if (!sectionStyle) {
      sectionStyle = document.createElement("style");
      sectionStyle.id = "memberframe-section-locks";
      (document.head || document.documentElement).appendChild(sectionStyle);
    }
    sectionStyle.textContent = sectionCss(result);
    gateResult = result;
    resetGates();
  }

  /* ---- Section gates ----
   *
   * Over each blurred members' section, a centred card: "Sign in" for a
   * visitor, "See plans" for a member whose plan is too low. The card lives
   * in <body>, laid over the section's box, never inside it: the section is
   * React's, and a node added there before hydration is a mismatch React
   * removes. Placed again on every DOM change, resize, and load, in a frame.
   */

  var GATE_CSS =
    ".mf-section-gate{position:absolute;z-index:5;display:flex;flex-direction:column;align-items:center;box-sizing:border-box;padding:16px;pointer-events:auto}" +
    ".mf-section-gate-card{position:sticky;top:30vh;margin:auto 0;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:320px;padding:20px 22px;box-sizing:border-box;border-radius:14px;background:#ffffff;color:#111111;border:1px solid rgba(0,0,0,0.08);box-shadow:0 12px 32px -12px rgba(0,0,0,0.28);text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Helvetica,Arial,sans-serif}" +
    ".mf-section-gate.is-tall .mf-section-gate-card{margin-top:15vh}" +
    ".mf-section-gate-title{margin:0;font-size:16px;font-weight:700;line-height:1.3}" +
    ".mf-section-gate-text{margin:0;font-size:13px;line-height:1.5;color:#555555}" +
    ".mf-section-gate-button{display:inline-flex;align-items:center;justify-content:center;margin-top:4px;padding:10px 18px;border-radius:10px;background:#111111;color:#ffffff;font-size:14px;font-weight:600;line-height:1;text-decoration:none;cursor:pointer}" +
    ".mf-section-gate-button:hover{background:#333333}" +
    ".mf-section-gate-button:focus-visible{outline:2px solid #5271ff;outline-offset:2px}";

  var gateRules = [];
  var gateResult = null;
  var gates = [];
  var gateFrame = 0;
  var gateStyle = null;
  var gateObserver = null;

  function tierName(key, ladder) {
    for (var i = 0; i < (ladder || []).length; i++) if (ladder[i].key === key) return ladder[i].name || "";
    return "";
  }

  function gateCopy(rule) {
    var member = gateResult && gateResult !== "unavailable" ? gateResult.member : null;
    if (!member) return { title: "Members only", text: "Sign in to see this.", label: "Sign in", href: LOGIN_PATH, signIn: true };
    var name = tierName(rule.requiredTier, gateResult.ladder || TIERS);
    return {
      title: name ? name + " members only" : "Members only",
      text: "Upgrade your plan to see this.",
      label: "See plans",
      href: PRICING_PATH,
      signIn: false
    };
  }

  /** Back to this page after signing in: the key MemberAuth reads. */
  function rememberReturn() {
    try {
      window.sessionStorage.setItem(
        "memberframe:return-to:" + SITE_KEY,
        JSON.stringify({ path: window.location.pathname + window.location.search, ts: Date.now() })
      );
    } catch (e) {}
  }

  function makeGate(rule) {
    var copy = gateCopy(rule);
    var gate = document.createElement("div");
    gate.className = "mf-section-gate";
    gate.setAttribute("data-mf-section-gate", rule.slug);
    var card = document.createElement("div");
    card.className = "mf-section-gate-card";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", copy.title);
    var title = document.createElement("p");
    title.className = "mf-section-gate-title";
    title.textContent = copy.title;
    var text = document.createElement("p");
    text.className = "mf-section-gate-text";
    text.textContent = copy.text;
    var link = document.createElement("a");
    link.className = "mf-section-gate-button";
    link.href = copy.href;
    link.textContent = copy.label;
    if (copy.signIn) link.addEventListener("click", rememberReturn);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(link);
    gate.appendChild(card);
    return gate;
  }

  function resetGates() {
    for (var i = 0; i < gates.length; i++) if (gates[i].gate.parentNode) gates[i].gate.parentNode.removeChild(gates[i].gate);
    gates = [];
    scheduleGates();
  }

  function scheduleGates() {
    if (gateFrame || !document.body) return;
    gateFrame = 1;
    var frame = window.requestAnimationFrame || function(fn) { return setTimeout(fn, 16); };
    frame(function() {
      gateFrame = 0;
      placeGates();
    });
  }

  function placeGates() {
    if (!document.body) return;
    if (!gateStyle && gateRules.length) {
      gateStyle = document.createElement("style");
      gateStyle.id = "memberframe-section-gates";
      gateStyle.textContent = GATE_CSS;
      (document.head || document.documentElement).appendChild(gateStyle);
    }
    var next = [];
    for (var r = 0; r < gateRules.length; r++) {
      var found = document.querySelectorAll(sectionSelector(gateRules[r]));
      for (var f = 0; f < found.length; f++) {
        var el = found[f];
        var existing = null;
        for (var g = 0; g < gates.length; g++) if (gates[g].el === el) existing = gates[g];
        next.push(existing || { el: el, gate: makeGate(gateRules[r]), box: "" });
      }
    }
    // Gates whose section is gone, or no longer locked, go.
    for (var o = 0; o < gates.length; o++) {
      if (next.indexOf(gates[o]) === -1 && gates[o].gate.parentNode) gates[o].gate.parentNode.removeChild(gates[o].gate);
    }
    gates = next;
    for (var n = 0; n < gates.length; n++) {
      var entry = gates[n];
      if (!entry.gate.parentNode) document.body.appendChild(entry.gate);
      var rect = entry.el.getBoundingClientRect();
      var hidden = rect.width === 0 && rect.height === 0;
      var box = hidden
        ? "display:none"
        : "top:" + Math.round(rect.top + window.pageYOffset) + "px;left:" + Math.round(rect.left + window.pageXOffset) +
          "px;width:" + Math.round(rect.width) + "px;height:" + Math.round(rect.height) + "px";
      // Written only when it moved, so placing a gate never triggers another pass.
      if (box !== entry.box) {
        entry.box = box;
        entry.gate.setAttribute("style", box);
        entry.gate.className = "mf-section-gate" + (rect.height > window.innerHeight * 0.8 ? " is-tall" : "");
      }
    }
  }

  function watchGates() {
    if (gateObserver || typeof MutationObserver === "undefined") return;
    gateObserver = new MutationObserver(function(records) {
      if (!gateRules.length) return;
      for (var i = 0; i < records.length; i++) {
        var target = records[i].target;
        // Changes inside a gate are the gate's own.
        if (!(target && target.closest && target.closest(".mf-section-gate"))) {
          scheduleGates();
          return;
        }
      }
    });
    gateObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", scheduleGates);
    // Framer's scroll effects move layers without touching their attributes.
    window.addEventListener("scroll", scheduleGates, { passive: true });
    window.addEventListener("load", scheduleGates);
    // Its appear animations too: place again once they have run.
    setTimeout(scheduleGates, 600);
    setTimeout(scheduleGates, 1600);
    setTimeout(scheduleGates, 3200);
    scheduleGates();
  }

  if (document.body) watchGates();
  else document.addEventListener("DOMContentLoaded", watchGates);

  function resolveSections() {
    var anyEnabled = false;
    for (var i = 0; i < SECTION_RULES.length; i++) if (SECTION_RULES[i].enabled) anyEnabled = true;
    if (!anyEnabled) {
      // No session needed: show what the switched-off rules cover, hide the rest.
      if (SECTION_RULES.length) applySections("unavailable");
      return;
    }
    var cached = readCache();
    if (cached) {
      applySections(cached);
      return;
    }
    fetchSession().then(function(result) {
      applySections(result);
    }, function() {
      applySections("unavailable");
    });
  }

  // Before anything else, so no tagged layer is ever painted unchecked.
  applySections(null);
  resolveSections();

  /* ---- The guard ---- */

  var seq = 0;
  var guardedPath = null;

  function guard(rawPath) {
    if (redirecting) return;
    var path = norm(rawPath);
    if (path === guardedPath && veil) return;
    guardedPath = path;
    var id = ++seq;

    var rule = ruleFor(path);

    if (rule) {
      var cached = readCache();
      if (cached) {
        if (checkEntitled(cached.member, rule.requiredTier, cached.ladder)) show();
        else deny(rule, path, cached.member, cached.ladder);
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
        else deny(rule, path, result.member, result.ladder);
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

  var lastPath = norm(window.location.pathname);

  function recheck() {
    lastPath = norm(window.location.pathname);
    guardedPath = null;
    guard(window.location.pathname);
  }

  /** Re-guard only when the path actually moved. Every hook below funnels here. */
  function onPathMaybeChanged() {
    if (norm(window.location.pathname) !== lastPath) recheck();
  }

  guard(window.location.pathname);

  /* ---- In-site navigation ----
   *
   * Four hooks, because a published Framer site defeated the first two
   * versions of this on its own:
   *
   *   - Framer installs its own history.pushState that calls the BUILT-IN
   *     method, not whatever was on history.pushState before it. A wrapper on
   *     the history object is skipped; one on History.prototype is not.
   *   - Listeners on document set from the head did not survive Framer's
   *     startup, while listeners on window did. So the click hook is on window.
   *   - The Navigation API sees every same-document navigation in browsers
   *     that have it, however the router started it.
   *   - A path check every 250ms is the backstop for any router this does not
   *     know about. A string compare, so it costs nothing.
   */

  function wrapHistory(name) {
    var proto = window.History && window.History.prototype;
    var targets = [];
    if (proto && typeof proto[name] === "function") targets.push(proto);
    // An own property shadows the prototype, so wrap it too when there is one.
    if (window.history && (!proto || Object.prototype.hasOwnProperty.call(window.history, name))) {
      targets.push(window.history);
    }

    for (var i = 0; i < targets.length; i++) {
      (function(target) {
        var original = target[name];
        if (typeof original !== "function") return;
        target[name] = function() {
          var result = original.apply(this, arguments);
          onPathMaybeChanged();
          return result;
        };
      })(targets[i]);
    }
  }

  wrapHistory("pushState");
  wrapHistory("replaceState");
  window.addEventListener("popstate", onPathMaybeChanged);

  /** Hide before the router renders a guarded page, then settle once the URL moves. */
  function beforeNavigate(href) {
    var url;
    try { url = new URL(href, window.location.href); } catch (e) { return; }
    if (url.origin !== window.location.origin) return;

    var path = norm(url.pathname);
    if (path === norm(window.location.pathname) || !needsCheck(path)) return;

    hide();
    var clickSeq = seq;
    // The router normally changes the URL at once and a hook takes over. If it
    // never does, settle on the page that is actually showing.
    setTimeout(function() {
      if (seq === clickSeq) recheck();
    }, CLICK_GRACE_MS);
  }

  // Window, capture phase: runs before anything on document, Framer's router
  // included, and is not lost when the page boots.
  window.addEventListener("click", function(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    var el = event.target;
    while (el && String(el.nodeName).toUpperCase() !== "A") el = el.parentNode;
    if (!el || !el.href || el.hasAttribute("download")) return;
    if (el.target && el.target !== "_self") return;

    beforeNavigate(typeof el.href === "string" ? el.href : String(el.href.baseVal || ""));
  }, true);

  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigate", function(event) {
      if (event && event.destination && event.destination.url) beforeNavigate(event.destination.url);
    });
    window.navigation.addEventListener("navigatesuccess", onPathMaybeChanged);
  }

  (function poll() {
    onPathMaybeChanged();
    setTimeout(poll, 250);
  })();

  // The MemberFrame components announce sign in and sign out on this page.
  window.addEventListener("memberframe:session-updated", function(event) {
    clearCache();
    setHint(!!(event && event.detail && event.detail.signedIn));
    // Sign in or out on this page: re-check, keeping layers as they are until the answer.
    resolveSections();
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
  const { pricingPath } = await loadPaymentSettings(site.id);
  const apiBase = env.apiBaseUrl;

  const js = generateShieldJs({
    siteKey: site.siteKey,
    apiBase,
    loginPath,
    pricingPath,
    afterLoginPath: settings.auth?.afterLoginPath || "/",
    guestPaths: shieldGuestPaths([settings.auth?.loginPath, settings.auth?.signupPath, settings.auth?.resetPath]),
    resetPath: (settings.auth?.resetPath || "").trim().replace(/\/+$/, ""),
    rules,
    tiers,
    sectionRules: settings.sectionLocks || [],
  });

  res.send(js);
}
