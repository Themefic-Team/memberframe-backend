/**
 * The session cookie.
 *
 * Isolated in one file because this is the riskiest configuration in the
 * system, and it should be changed in exactly one place by someone who has
 * read backend PRD section 4.1.
 *
 * THE PROBLEM, in short. A canvas component runs on the creator's domain and
 * calls this API, so from the browser's point of view this cookie is a
 * third-party cookie. Safari has blocked those by default since 2020 and
 * Firefox partitions them. Chrome kept them after abandoning deprecation. That
 * means the design works in Chrome, probably works in Firefox, and is blocked
 * on iOS until something changes.
 *
 * WHAT THIS FILE DOES ABOUT IT. Emits `Partitioned` alongside
 * `SameSite=None; Secure` when cross-site mode is on. A partitioned cookie is
 * keyed to the top-level site, which Chrome and Firefox honour, and which is
 * the semantics this product wants anyway: a member of site A should not share
 * a session with site B, and PRD section 11.2 already makes member email
 * unique per site rather than globally.
 *
 * WHAT IT CANNOT DO. Make Safari accept it. That needs the first-party
 * subdomain route in backend PRD section 4.1, option 2, and the spike in
 * section 2.3 is what decides whether you need it.
 */

import type { Response } from "express";
import { env } from "../config/env.js";

export interface SessionCookieOptions {
  /** Seconds. Pass 0 for a session cookie with no explicit expiry. */
  maxAgeSeconds: number;
}

/**
 * Set the session cookie.
 *
 * Built by hand rather than with `res.cookie`, for one reason: Express 4's
 * cookie serializer has no `Partitioned` option, so it would silently drop the
 * attribute that makes cross-site work in Chrome. Composing the header string
 * means what this function says is what the browser receives.
 */
export function setSessionCookie(
  res: Response,
  token: string,
  options: SessionCookieOptions
): void {
  const parts = [
    `${env.session.cookieName}=${token}`,
    "Path=/",
    // No `Domain`. Omitting it scopes the cookie to this exact host, which is
    // what we want: setting `Domain=.memberframe.com` would share it with every
    // subdomain, including anything else ever hosted there.
    "HttpOnly",
  ];

  if (options.maxAgeSeconds > 0) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
    // Max-Age alone is correct per RFC 6265 and ignored by some older clients,
    // so Expires is sent too. Where both appear, Max-Age wins.
    parts.push(`Expires=${new Date(Date.now() + options.maxAgeSeconds * 1000).toUTCString()}`);
  }

  if (env.session.crossSite) {
    // SameSite=None without Secure is rejected outright by every current
    // browser, so these three travel together or not at all.
    parts.push("SameSite=None", "Secure", "Partitioned");
  } else {
    parts.push("SameSite=Lax");
    // Still Secure on https, even same-site. Only plain-http local development
    // omits it, because a browser will not store a Secure cookie from http.
    if (env.apiBaseUrl.startsWith("https://")) parts.push("Secure");
  }

  appendSetCookie(res, parts.join("; "));
}

/**
 * Clear it.
 *
 * Every attribute except `Max-Age` must match what was set, or the browser
 * treats it as a different cookie and the original survives. That is the
 * classic "logout did nothing" bug, and it is why this calls the same builder
 * rather than composing its own header.
 */
export function clearSessionCookie(res: Response): void {
  const parts = [`${env.session.cookieName}=`, "Path=/", "HttpOnly", "Max-Age=0"];

  if (env.session.crossSite) {
    parts.push("SameSite=None", "Secure", "Partitioned");
  } else {
    parts.push("SameSite=Lax");
    if (env.apiBaseUrl.startsWith("https://")) parts.push("Secure");
  }

  appendSetCookie(res, parts.join("; "));
}

/** Append without clobbering a `Set-Cookie` another handler already wrote. */
function appendSetCookie(res: Response, value: string): void {
  const existing = res.getHeader("Set-Cookie");

  if (existing === undefined) {
    res.setHeader("Set-Cookie", value);
    return;
  }

  const list = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader("Set-Cookie", [...list, value]);
}

/**
 * How long a new session should last.
 *
 * FP-02 section 2.2 offers "Remember me for 30 days". The component sends the
 * flag and the lifetime is decided here, which is the right split: the client
 * cannot read an HttpOnly cookie and so cannot be the authority on its life.
 */
export function sessionLifetimeSeconds(rememberMe: boolean): number {
  return rememberMe ? env.session.rememberTtlSeconds : env.session.ttlSeconds;
}
