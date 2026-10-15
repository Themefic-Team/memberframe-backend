/**
 * The Express app.
 *
 * Separate from `server.ts` so a test can import the app without binding a
 * port. `server.ts` is the only file that calls `listen`.
 */

import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { checkDatabase } from "./config/db.js";
import { errorHandler, notFoundHandler, ok, route } from "./middleware/errors.js";
import { preflight, resolveSite } from "./middleware/site.js";
import { pluginCors } from "./middleware/creator.js";
import { memberRouter } from "./routes/member.js";
import { connectRouter } from "./routes/connect.js";
import { siteRouter } from "./routes/site.js";
import { handleShieldScript } from "./routes/shield.js";

export function createApp(): Express {
  const app = express();

  // No `X-Powered-By: Express`. It names the framework and version to anyone
  // shopping for a target, and buys nothing.
  app.disable("x-powered-by");

  // Trust the proxy only in production, where there is one. Trusting it in
  // development would let any client set its own `X-Forwarded-For` and walk
  // straight past the per-IP rate limit by sending a new value each time.
  if (env.isProduction) app.set("trust proxy", 1);

  // A small body limit. Nothing here accepts more than a few hundred bytes,
  // and the default of 100kb is a free denial-of-service budget.
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: true, limit: "16kb" }));
  app.use(cookieParser());

  // ------------------------------------------------------------------------
  // Two doors, two CORS policies
  // ------------------------------------------------------------------------
  // The plugin half is mounted first because it answers its own OPTIONS, and
  // `preflight` below would otherwise reach them first and refuse: that one
  // resolves a site from the key header, and a connect request has no site yet.
  //
  // `pluginCors` sends a wildcard origin and no `Allow-Credentials`, which is
  // safe here and would not be on the member half. The reasoning is in
  // `middleware/creator.ts` and the short version is that this half carries no
  // cookie: authorization is a bearer token the caller must already hold.

  app.use("/api/connect", pluginCors);
  app.use("/api/site", pluginCors);

  // Preflight for the member half, which needs a site, because an OPTIONS
  // request carries neither a cookie nor the custom header.
  app.use(preflight);

  // ------------------------------------------------------------------------
  // Health, with no site key required
  // ------------------------------------------------------------------------
  // Two endpoints rather than one. `/health` answers "is the process up" and
  // is what a load balancer should poll. `/health/db` touches MySQL and is
  // what a human checks, and it is kept out of the balancer's path so a
  // database blip does not take every instance out of rotation.

  app.get("/health", (_req, res) => {
    ok(res, { status: "ok", environment: env.nodeEnv });
  });

  app.get(
    "/health/db",
    route(async (_req, res) => {
      const status = await checkDatabase();

      res.status(status.connected ? 200 : 503).json({
        connected: status.connected,
        // Only outside production. A version string is reconnaissance.
        ...(env.isProduction
          ? {}
          : { version: status.version, database: status.database, warnings: status.warnings }),
        ...(status.error && !env.isProduction ? { error: status.error } : {}),
      });
    })
  );

  // ------------------------------------------------------------------------
  // Global Route Shield script
  // ------------------------------------------------------------------------
  // Delivered as a public JavaScript asset to published Framer sites.
  // Must run before resolveSite because <script> GET tags carry no origin
  // header and must not be rejected by origin allowlist checks.
  app.get("/api/member/shield.js", handleShieldScript);
  app.get("/api/shield.js", handleShieldScript);

  // ------------------------------------------------------------------------
  // Member runtime
  // ------------------------------------------------------------------------
  // `resolveSite` guards the whole subtree, so no handler below can run
  // without a resolved tenant and a checked origin. Mounting it per route
  // would be one `router.use` away from a route that forgot.

  app.use("/api/member", resolveSite, memberRouter);

  // ------------------------------------------------------------------------
  // The plugin panel
  // ------------------------------------------------------------------------
  // Deliberately NOT behind `resolveSite`. A connect request has no site yet,
  // and a creator route is scoped by the site id in the request checked against
  // the token's owner, never by a public site key: the key is baked into every
  // published component, so accepting it as creator authorization would hand
  // the member list to anyone who viewed the page source.

  app.use("/api/connect", connectRouter);
  app.use("/api/site", siteRouter);

  // ------------------------------------------------------------------------
  // Not built yet, and honest about it
  // ------------------------------------------------------------------------

  app.all("/api/checkout/*", (_req, res) => {
    res.status(501).json({
      reason: "not_implemented",
      detail: "Payments are backend PRD phase B3.",
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
