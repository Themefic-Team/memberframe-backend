/**
 * Creator authentication for the plugin panel, and the CORS policy it needs.
 *
 * Two separate doors into this API, and keeping them separate is the point:
 *
 *   `/api/member/*`   a visitor on a published Framer site. Identified by the
 *                     site key header, verified by `Origin`, authorized by an
 *                     HTTP-only cookie. `middleware/site.ts`.
 *
 *   `/api/site/*`     the creator, inside the plugin panel. Authorized by a
 *                     bearer token and nothing else. This file.
 *
 * A member session must never open a creator route and the reverse, which is
 * why the two use different tables, different headers, and different
 * middleware rather than one with a role column.
 *
 * ## Why the panel uses a bearer token and not a cookie
 *
 * Backend PRD section 2.3 calls the cross-site session cookie the project's
 * largest architectural risk: Safari blocks third-party cookies by default and
 * Firefox partitions them. The plugin panel is an iframe on an origin we do not
 * control, so a cookie there would meet that problem immediately and with no
 * mitigation available, because unlike a creator's own site there is no
 * first-party subdomain to move to.
 *
 * A bearer token sidesteps it completely. It also removes CSRF from this half
 * of the API as a category: a request that carries no ambient credential cannot
 * be forged by a page the creator happens to be visiting.
 *
 * What it costs is that the token must live somewhere in the panel, and PRD
 * section 14.1 S2 bars `localStorage`. The panel stores it in Framer plugin
 * data, which is scoped to the Framer project rather than to an origin. See
 * `src/services/connectionStore.ts` and conflict C27.
 */

import type { Request, RequestHandler } from "express";
import { unauthorized } from "./errors.js";
import { loadCreator, touchCreatorSession, type LoadedCreator } from "../services/creatorAuthService.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      creator?: LoadedCreator;
    }
  }
}

/**
 * Read the token out of `Authorization: Bearer <token>`.
 *
 * Header only. Never a query parameter and never a body field: a URL reaches
 * server access logs, browser history, and any `Referer` the page later sends,
 * and this value reads every member of every site the creator owns.
 */
export function bearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/** The creator for this request, or a 500 if the middleware did not run. */
export function requireCreator(req: Request): LoadedCreator {
  if (!req.creator) {
    throw new Error("requireCreator called on a route without the creatorAuth middleware.");
  }
  return req.creator;
}

/**
 * Resolve the bearer token, or 401.
 *
 * One 401 for absent, unknown, revoked, and expired. The panel's job on a 401
 * is identical in all four cases, which is to show the connect screen, and
 * telling them apart would answer a question an unauthenticated caller has no
 * right to ask.
 */
export const creatorAuth: RequestHandler = (req, res, next) => {
  void authenticate(req).then(next, next);
};

async function authenticate(req: Request): Promise<void> {
  const creator = await loadCreator(bearerToken(req));
  if (!creator) throw unauthorized("not_connected");

  touchCreatorSession(creator.sessionId);
  req.creator = creator;
}

// ============================================================================
// CORS FOR THE PANEL
// ============================================================================

/**
 * A wildcard origin, and here it is correct.
 *
 * `middleware/site.ts` refuses a wildcard in the strongest terms, and nothing
 * about that changes: the member API sends a credentialed cookie, and the CORS
 * specification makes `Allow-Origin: *` and `Allow-Credentials: true` mutually
 * exclusive, so a wildcard there is not merely unwise, it does not function.
 *
 * This half carries no cookie. Authorization is a bearer token the caller must
 * already hold, so what a wildcard permits is a page on any origin making an
 * unauthenticated request and getting a 401. The browser is not the security
 * boundary here, the token is.
 *
 * There is also no workable alternative. The panel's origin is whatever Framer
 * serves plugins from, which differs between the editor, a preview, and local
 * development with a self-signed certificate on 127.0.0.1. An allowlist of
 * those would be a list of hostnames we do not control, maintained by us,
 * breaking silently whenever Framer changes one.
 *
 * `Allow-Credentials` is deliberately NOT set, and must stay unset. Setting it
 * alongside the wildcard is the one combination that would make this unsafe,
 * and browsers reject it outright, which is a useful backstop.
 */
export const pluginCors: RequestHandler = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
};
