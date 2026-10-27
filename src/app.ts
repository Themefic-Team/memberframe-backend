/**
 * The Express app.
 *
 * Separate from `server.ts` so a test can import the app without binding a
 * port. `server.ts` is the only file that calls `listen`.
 */

import path from "node:path";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { checkDatabase } from "./config/db.js";
import { errorHandler, notFoundHandler, ok, route } from "./middleware/errors.js";
import { preflight, resolveSite } from "./middleware/site.js";
import { pluginCors } from "./middleware/creator.js";
import { memberRouter } from "./routes/member.js";
import { handleAvatar, memberAccountRouter } from "./routes/memberAccount.js";
import { connectRouter } from "./routes/connect.js";
import { siteRouter } from "./routes/site.js";
import { previewRouter } from "./routes/preview.js";
import { reportsRouter } from "./routes/reports.js";
import { emailRouter } from "./routes/email.js";
import { licenseRouter } from "./routes/license.js";
import { pluginBillingRouter } from "./routes/pluginBilling.js";
import { accountRouter, authPageRouter } from "./routes/creatorAccount.js";
import { handlePlatformWebhook } from "./services/license/platformWebhook.js";
import { requireActiveLicense } from "./middleware/license.js";
import { handleShieldScript } from "./routes/shield.js";
import {
  billingRouter,
  checkoutRouter,
  handlePayBridge,
  handleWebhook,
  paymentsRouter,
} from "./routes/payments.js";
import {
  assetsCreatorRouter,
  assetsRouter,
  bookmarksRouter,
  handleAssetDownload,
  meterRouter,
} from "./routes/content.js";

export function createApp(): Express {
  const app = express();

  // No `X-Powered-By: Express`. It names the framework and version to anyone
  // shopping for a target, and buys nothing.
  app.disable("x-powered-by");

  // Trust the proxy only in production, where there is one. Trusting it in
  // development would let any client set its own `X-Forwarded-For` and walk
  // straight past the per-IP rate limit by sending a new value each time.
  if (env.isProduction) app.set("trust proxy", 1);

  // Gateway webhooks, before the JSON parser: the signature is over the exact
  // bytes the gateway sent, and parsing them first would lose those bytes.
  // Their own limit, because a gateway event can be a few tens of kilobytes.
  // MemberFrame's own Stripe account (F19), same reason: raw bytes first.
  app.post("/api/webhooks/platform/stripe", express.raw({ type: "*/*", limit: "1mb" }), handlePlatformWebhook);

  app.post(
    "/api/webhooks/:gateway/:siteId/:mode",
    express.raw({ type: "*/*", limit: "1mb" }),
    handleWebhook
  );

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
  // The panel's billing and license routes (F19). Here, ahead of the member
  // preflight below, which otherwise answers their OPTIONS request with no
  // Access-Control-Allow-Origin and the browser blocks every call.
  app.use("/api/plugin", pluginCors);
  // The canvas preview: public, read-only, no cookie, and asked for from a
  // Framer canvas origin no site allowlists. Mounted whole, ahead of the
  // site check. Reasoning in routes/preview.ts.
  app.use("/api/preview", pluginCors, previewRouter);
  // What a canvas component reads to draw the trial mark or the lock (F19).
  // Public and read-only, for the same reasons as the preview.
  app.use("/api/license", pluginCors, licenseRouter);
  // The hosted account page the plugin opens in a new tab, and its API (F19).
  // Same origin as the page, so neither needs CORS.
  // The account page's icon and the mail images (F19), public and cacheable.
  app.use("/assets", express.static(path.join(process.cwd(), "assets"), { maxAge: "7d", index: false }));
  app.use(authPageRouter);
  app.use("/api/account", accountRouter);

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

  // The root, so a person opening the domain in a browser sees what this is
  // instead of a 404. Names the service and nothing more: no version.
  app.get("/", (_req, res) => {
    ok(res, { service: "MemberFrame API", status: "ok", health: "/health" });
  });

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

  // A member's uploaded photo. Before resolveSite for the same reason: an
  // <img> request carries no Origin. The signed token is what scopes it.
  app.get("/api/avatars/:token", (req, res) => void handleAvatar(req, res));

  // ------------------------------------------------------------------------
  // Member runtime
  // ------------------------------------------------------------------------
  // `resolveSite` guards the whole subtree, so no handler below can run
  // without a resolved tenant and a checked origin. Mounting it per route
  // would be one `router.use` away from a route that forgot.

  // The member's own billing, FP-16, ahead of the general member routes.
  //
  // `requireActiveLicense` after each: a project whose MemberFrame trial or
  // plan has ended is refused here too, not only blurred on the page (F19).
  app.use("/api/member/billing", resolveSite, requireActiveLicense, billingRouter);
  // Bookmarks and the reading meter, FP-10 and FP-07.
  app.use("/api/member/bookmarks", resolveSite, requireActiveLicense, bookmarksRouter);
  app.use("/api/member/meter", resolveSite, requireActiveLicense, meterRouter);
  // The member's own account area: security, photo, deleting the account.
  app.use("/api/member", resolveSite, requireActiveLicense, memberAccountRouter);
  app.use("/api/member", resolveSite, requireActiveLicense, memberRouter);

  // Pricing and checkout for the published site, FP-16. Same tenant check.
  app.use("/api/checkout", resolveSite, requireActiveLicense, checkoutRouter);

  // The Razorpay bridge page. A plain navigation, so no origin and no site
  // header: the checkout id in the path is what scopes it.
  app.get("/api/pay/razorpay/:checkoutId", handlePayBridge);

  // Protected files, FP-12. The download link is a plain navigation with no
  // origin and no site header, so it is mounted before the site check and its
  // signed token is what scopes it. The rest needs a resolved site.
  app.get("/api/assets/download/:token", handleAssetDownload);
  app.use("/api/assets", resolveSite, requireActiveLicense, assetsRouter);

  // ------------------------------------------------------------------------
  // The plugin panel
  // ------------------------------------------------------------------------
  // Deliberately NOT behind `resolveSite`. A connect request has no site yet,
  // and a creator route is scoped by the site id in the request checked against
  // the token's owner, never by a public site key: the key is baked into every
  // published component, so accepting it as creator authorization would hand
  // the member list to anyone who viewed the page source.

  app.use("/api/connect", connectRouter);
  // MemberFrame's own plans, F19: license, checkout, upgrade, cancel, portal.
  app.use("/api/plugin", pluginCors, pluginBillingRouter);
  app.use("/api/site/payments", paymentsRouter);
  // Reports, read only (24-reports.md).
  app.use("/api/site/reports", reportsRouter);
  // A site's own SMTP: status and test send (25-custom-smtp.md).
  app.use("/api/site/email", emailRouter);
  app.use("/api/site/assets", assetsCreatorRouter);
  app.use("/api/site", siteRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
