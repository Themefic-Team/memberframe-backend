/**
 * Links in an email that point back at the creator's own published site.
 *
 * The password reset link used to come from one server-wide template,
 * `PASSWORD_RESET_URL_TEMPLATE`, so every site's members were sent to the same
 * placeholder host. A link that opens a 404 is a member who cannot get back
 * in. The right host is the site the member was on when they asked, and the
 * right path is the reset page the creator configured.
 */

import { env } from "../config/env.js";
import { isSafeSitePath } from "./siteSettings.js";

/** Hosts that are the Framer editor, never a published site. */
export function isEditorHost(hostname: string): boolean {
  return (
    hostname === "framer.com" ||
    hostname.endsWith(".framer.com") ||
    hostname === "framercanvas.com" ||
    hostname.endsWith(".framercanvas.com")
  );
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * The published site a member-facing link should open, or null.
 *
 * The request's own origin first, when it is on the site's allowlist: that is
 * the site the member is looking at, custom domain included. Otherwise the
 * best allowlisted origin, preferring a public host over a loopback one, and
 * never the Framer editor, which a member cannot open.
 *
 * Only ever an allowlisted origin. A link built from an unchecked `Origin`
 * header would let anyone have a reset token mailed to a page they control.
 */
export function pickSiteOrigin(requestOrigin: string | undefined, allowed: ReadonlyArray<string>): string | null {
  const normalized = allowed.map((origin) => origin.trim().replace(/\/+$/, "")).filter((origin) => origin !== "");
  const usable = normalized.filter((origin) => {
    const host = hostnameOf(origin);
    return host !== null && !isEditorHost(host);
  });

  const fromRequest = requestOrigin?.trim().replace(/\/+$/, "");
  if (fromRequest && usable.includes(fromRequest)) return fromRequest;

  return (
    usable.find((origin) => !isLoopbackHost(hostnameOf(origin) ?? "")) ??
    usable[0] ??
    null
  );
}

/**
 * The reset link for one token.
 *
 * `{origin}{resetPath}?token=...` when the site's origin is known, which is
 * the page holding `<MemberAuth>` that reads the `token` parameter. Falls back
 * to the server-wide template only when no origin is known, so an existing
 * deployment keeps working rather than sending a broken link.
 */
export function passwordResetUrl(token: string, site: { origin: string | null; resetPath: string }): string {
  if (site.origin) {
    const path = isSafeSitePath(site.resetPath) ? site.resetPath : "/reset-password";
    const url = new URL(path, `${site.origin}/`);
    url.searchParams.set("token", token);
    return url.toString();
  }

  return env.passwordReset.urlTemplate.replace("{token}", encodeURIComponent(token));
}
