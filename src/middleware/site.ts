/**
 * Tenant resolution, and the CORS policy that depends on it.
 *
 * Backend PRD section 3.2. Three documents disagreed on how a request names
 * its site: FP-15 put `siteId` in every body, the built canvas components send
 * nothing and rely on the origin. Both are partly wrong.
 *
 *   A public `site_key` identifies. The `Origin` header verifies.
 *
 * The key is baked into each generated component exactly as `apiBaseUrl`
 * already is, and it is no more secret than a Stripe publishable key. What
 * makes it unusable from anywhere else is that the request origin must appear
 * in that site's own allowlist.
 *
 * Why not the origin alone, which is what the components do today: a creator's
 * site may be on a custom domain, on `*.framer.website`, or on a Framer preview
 * URL, so the backend needs a per-site origin allowlist for CORS regardless.
 * Once that registry exists, resolving the tenant from it is both simpler and
 * stricter than inferring it.
 *
 * Why not a bare `siteId`: a tenant identifier in a request body invites
 * substitution. Pairing a random key with an origin check means a key lifted
 * from a published site is useless anywhere but that site.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { prisma } from "../config/db.js";
import { badRequest, unauthorized } from "./errors.js";
import { verifyOAuthState } from "../lib/oauthState.js";

export const SITE_KEY_HEADER = "x-memberframe-site";

export interface ResolvedSite {
  id: string;
  siteName: string;
  siteKey: string;
  allowedOrigins: string[];
  defaultLocale: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      site?: ResolvedSite;
    }
  }
}

/** The site for this request, or a 500 if the middleware did not run. */
export function requireSite(req: Request): ResolvedSite {
  if (!req.site) {
    // Not an ApiError: this is a wiring mistake, not a client problem. A route
    // mounted without the middleware should fail loudly in development.
    throw new Error("requireSite called on a route without resolveSite middleware.");
  }
  return req.site;
}

/**
 * Read `allowed_origins` out of the JSON column.
 *
 * Defensive because the column is `Json` and Prisma types it as `JsonValue`,
 * so the compiler cannot promise it is an array of strings. A row edited by
 * hand in `prisma studio` is exactly how it stops being one.
 */
export function parseAllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry !== "");
}

/**
 * Is this origin allowed for this site?
 *
 * Exact match, after normalising a trailing slash. No wildcard support, and
 * that is a deliberate refusal rather than an omission:
 *
 *   `*` cannot be used here at all. The CORS specification makes
 *   `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Credentials:
 *   true` mutually exclusive, and this API is nothing but credentialed
 *   requests, so a wildcard would not merely be unwise, it would stop the
 *   cookie working.
 *
 *   `*.creatorsite.com` is not supported either. A subdomain wildcard on a
 *   site that hosts any user content is an open door, and Framer preview
 *   hostnames can be enumerated.
 */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (origin === undefined || origin === "") return false;

  const candidate = origin.trim().replace(/\/+$/, "");
  return allowed.includes(candidate);
}

/**
 * Resolve the tenant, then check the origin against it.
 *
 * Order matters. The site has to be found before its allowlist can be read, so
 * a bad key is a 400 and a good key from the wrong origin is a 401.
 */
export const resolveSite: RequestHandler = (req, res, next) => {
  void resolve(req, res).then(next, next);
};

async function resolve(req: Request, res: Response): Promise<void> {
  const origin = req.header("origin");
  const header = req.header(SITE_KEY_HEADER);
  const queryKey =
    typeof req.query?.["siteKey"] === "string"
      ? req.query["siteKey"]
      : typeof req.query?.["site"] === "string"
        ? req.query["site"]
        : undefined;
  const querySiteId = typeof req.query?.["siteId"] === "string" ? req.query["siteId"] : undefined;
  const queryState =
    typeof req.query?.["state"] === "string"
      ? req.query["state"]
      : typeof req.body?.["state"] === "string"
        ? req.body["state"]
        : undefined;

  let site: {
    id: string;
    siteName: string;
    siteKey: string;
    allowedOrigins: unknown;
    defaultLocale: string;
  } | null = null;

  const keyToLookup = (header && header.trim() !== "") ? header.trim() : (queryKey && queryKey.trim() !== "") ? queryKey.trim() : undefined;

  if (keyToLookup) {
    site = await prisma.site.findUnique({
      where: { siteKey: keyToLookup },
      select: {
        id: true,
        siteName: true,
        siteKey: true,
        allowedOrigins: true,
        defaultLocale: true,
      },
    });
  } else if (querySiteId && querySiteId.trim() !== "") {
    site = await prisma.site.findUnique({
      where: { id: querySiteId.trim() },
      select: {
        id: true,
        siteName: true,
        siteKey: true,
        allowedOrigins: true,
        defaultLocale: true,
      },
    });
  } else if (queryState) {
    // A provider's redirect back (Google, GitHub, Discord, Apple's form post)
    // carries no key and no site origin: only the state this server signed
    // names the site. Signed since 2026-10-20 (`<payload>.<signature>`), so it
    // is read with the callback's own verifier; a plain JSON decode of the
    // whole string fails on the signature and left every callback
    // `missing_site_key`.
    const decoded = verifyOAuthState(queryState);
    if (decoded) {
      site = await prisma.site.findUnique({
        where: { id: decoded.siteId },
        select: {
          id: true,
          siteName: true,
          siteKey: true,
          allowedOrigins: true,
          defaultLocale: true,
        },
      });
    }
  } else if (origin !== undefined && origin !== "") {
    // Canvas components on published Framer sites identify by their Origin
    const normalized = origin.trim().replace(/\/+$/, "");
    const allSites = await prisma.site.findMany({
      select: {
        id: true,
        siteName: true,
        siteKey: true,
        allowedOrigins: true,
        defaultLocale: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const matching = allSites.filter((s) =>
      originAllowed(normalized, parseAllowedOrigins(s.allowedOrigins))
    );
    if (matching.length > 0) {
      site = matching[0] ?? null;
    }
  }

  // Fallback to Referer header for browser popups/redirects
  if (!site) {
    const referer = req.header("referer");
    if (referer) {
      try {
        const refOrigin = new URL(referer).origin.replace(/\/+$/, "");
        const allSites = await prisma.site.findMany({
          select: {
            id: true,
            siteName: true,
            siteKey: true,
            allowedOrigins: true,
            defaultLocale: true,
          },
          orderBy: { createdAt: "asc" },
        });
        const matching = allSites.filter((s) =>
          originAllowed(refOrigin, parseAllowedOrigins(s.allowedOrigins))
        );
        if (matching.length > 0) {
          site = matching[0] ?? null;
        }
      } catch {
        // invalid URL
      }
    }
  }

  // An unknown key is a 400 rather than a 404. A 404 would confirm that some
  // other key does exist, which turns this endpoint into a key oracle.
  if (!site) {
    if (origin !== undefined) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    throw badRequest(header ? "unknown_site" : "missing_site_key");
  }

  const allowed = parseAllowedOrigins(site.allowedOrigins);

  // A request with no `Origin` at all is not from a browser: curl, a server,
  // or a mobile app. Allowed through, because the cookie is what authorizes
  // and a non-browser client cannot be CSRF'd. Browsers always send it on a
  // cross-origin request.
  if (origin !== undefined && !originAllowed(origin, allowed)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    throw unauthorized("origin_not_allowed");
  }

  if (origin !== undefined) {
    // Echo the exact origin, never a wildcard. See `originAllowed`.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.header("access-control-request-private-network")) {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    // The response varies by origin, so a cache must not serve one site's
    // response to another. Without this, a CDN is a cross-tenant leak.
    res.setHeader("Vary", "Origin");
  }

  req.site = {
    id: site.id,
    siteName: site.siteName,
    siteKey: site.siteKey,
    allowedOrigins: allowed,
    defaultLocale: site.defaultLocale,
  };
}

/**
 * Preflight.
 *
 * Answered here rather than by the `cors` package because the allowlist is
 * per-site and lives in the database, which a static configuration object
 * cannot express. A preflight carries no cookie and no body, so the site key
 * header is all there is to go on.
 */
export const preflight: RequestHandler = (req, res, next) => {
  if (req.method !== "OPTIONS") {
    next();
    return;
  }

  void handlePreflight(req, res).catch(next);
};

async function handlePreflight(req: Request, res: Response): Promise<void> {
  const origin = req.header("origin");
  const key = req.header(SITE_KEY_HEADER) ?? req.header("access-control-request-headers");

  res.setHeader("Vary", "Origin");

  if (origin === undefined) {
    res.status(204).end();
    return;
  }

  // The browser does not send custom headers on a preflight, only their names,
  // so the site key is usually absent here. Check the origin against every
  // site that lists it: this reveals only whether some site allows this origin,
  // which the subsequent request would reveal anyway.
  const match = await prisma.site.findFirst({
    where: key ? { siteKey: key } : {},
    select: { allowedOrigins: true },
    orderBy: { createdAt: "asc" },
  });

  const allowed = match ? parseAllowedOrigins(match.allowedOrigins) : [];

  const anySiteAllows =
    originAllowed(origin, allowed) ||
    (await siteCountForOrigin(origin)) > 0;

  if (!anySiteAllows) {
    // 204 with no CORS headers. The browser blocks the real request and
    // reports a CORS error, which is the correct outcome, and this does not
    // confirm or deny anything about which sites exist.
    res.status(204).end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    // The test country header is honoured only in test mode; see gatewayRouter.
    // ngrok-skip-browser-warning: see `middleware/creator.ts`.
    `Content-Type, Accept, ${SITE_KEY_HEADER}, X-MemberFrame-Test-Country, ngrok-skip-browser-warning`
  );
  if (req.header("access-control-request-private-network")) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  // 10 minutes. Long enough to save the round trip on a busy page, short
  // enough that removing an origin from the allowlist takes effect soon.
  res.setHeader("Access-Control-Max-Age", "600");
  res.status(204).end();
}

/**
 * Does any site allow this origin?
 *
 * A JSON column cannot be indexed directly in MySQL, so this is a scan. It
 * runs only on a preflight that arrived without a resolvable site key, and
 * only for the 10-minute `Max-Age` window, so the cost is bounded. If the
 * sites table ever grows past a few thousand rows, add a generated column on
 * `allowed_origins` and index that.
 */
async function siteCountForOrigin(origin: string): Promise<number> {
  const normalized = origin.trim().replace(/\/+$/, "");

  const rows = await prisma.site.findMany({ select: { allowedOrigins: true } });

  return rows.filter((row) => originAllowed(normalized, parseAllowedOrigins(row.allowedOrigins)))
    .length;
}
