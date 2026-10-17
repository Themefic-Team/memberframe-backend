/**
 * Payments routes. FP-16 section 8.
 *
 *   paymentsRouter   /api/site/payments        the plugin, creator token
 *   checkoutRouter   /api/checkout             the published site, member cookie
 *   billingRouter    /api/member/billing       the published site, member cookie
 *   handleWebhook    /api/webhooks/:gateway/:siteId/:mode   the gateways
 *   handlePayBridge  /api/pay/razorpay/:checkoutId           Razorpay Checkout
 *
 * Every response here is a status shape. No route returns a gateway secret,
 * and none can: `gatewayStore.ts` is the only file that decrypts one, and what
 * it hands a route has no secret field.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { ApiError, badRequest, ok, route, unauthorized } from "../middleware/errors.js";
import { creatorAuth, requireCreator } from "../middleware/creator.js";
import { requireOwnedSite } from "../services/creatorAuthService.js";
import { requireSite } from "../middleware/site.js";
import { hit, clientIp } from "../middleware/rateLimit.js";
import { rateLimited } from "../middleware/errors.js";
import { loadSession } from "../services/sessionService.js";
import { secretsAvailable } from "../lib/secretBox.js";
import { isSafeSitePath } from "../lib/siteSettings.js";
import { publicApiBase } from "../lib/publicApiBase.js";
import {
  ADAPTERS,
  connectGateway,
  connectedGateways,
  disconnectGateway,
  gatewayStatuses,
  loadCredentials,
  loadPaymentSettings,
  savePaymentSettings,
} from "../services/payments/gatewayStore.js";
import { applyPaymentEvent, endTestSubscriptions } from "../services/payments/apply.js";
import {
  billingPortal,
  cancelSubscription,
  checkoutStatus,
  createCheckout,
  memberBilling,
  publicPricing,
  resumeSubscription,
} from "../services/payments/checkoutService.js";
import { resolveCountry } from "../services/payments/gatewayRouter.js";
import { GatewayError, isGatewayId, isInterval, isPaymentMode, type GatewayId, type PaymentMode } from "../services/payments/types.js";

function requireSecrets(): void {
  if (!secretsAvailable()) throw new ApiError(503, "payments_not_configured");
}

function limit(req: Request, scope: string, max: number, windowSeconds = 3600): void {
  const decision = hit(`${scope}:${clientIp(req)}`, max, windowSeconds);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

// ============================================================================
// CREATOR: /api/site/payments
// ============================================================================

export const paymentsRouter = Router();
paymentsRouter.use(creatorAuth);

const siteIdSchema = z.string().trim().min(1).max(36);

async function creatorSite(req: Request, siteId: unknown) {
  const creator = requireCreator(req);
  const parsed = siteIdSchema.safeParse(siteId);
  if (!parsed.success) throw badRequest("missing_site_id");
  return requireOwnedSite(creator.userId, parsed.data);
}

async function paymentsOverview(siteId: string, base: string = env.apiBaseUrl) {
  const [settings, gateways, subscriptions] = await Promise.all([
    loadPaymentSettings(siteId),
    gatewayStatuses(siteId, base),
    prisma.subscription.groupBy({
      by: ["mode", "status"],
      where: { siteId, status: { in: ["active", "past_due", "canceling"] } },
      _count: { _all: true },
    }),
  ]);

  return {
    settings,
    gateways,
    secretsAvailable: secretsAvailable(),
    /** A gateway cannot reach a local address, so webhooks need a public one. */
    publicApi: base.startsWith("https://"),
    activeSubscriptions: {
      test: subscriptions.filter((row) => row.mode === "test").reduce((sum, row) => sum + row._count._all, 0),
      live: subscriptions.filter((row) => row.mode === "live").reduce((sum, row) => sum + row._count._all, 0),
    },
  };
}

paymentsRouter.get(
  "/",
  route(async (req, res) => {
    const site = await creatorSite(req, req.query["siteId"]);
    ok(res, await paymentsOverview(site.id, publicApiBase(req)));
  })
);

const settingsSchema = z.object({
  siteId: siteIdSchema,
  mode: z.enum(["test", "live"]).optional(),
  defaultGateway: z.enum(["", "stripe", "lemonsqueezy", "razorpay"]).optional(),
  autoDetectGeolocation: z.boolean().optional(),
  defaultCurrency: z.enum(["USD", "EUR", "GBP", "INR"]).optional(),
  graceDays: z.number().int().min(0).max(30).optional(),
  afterPurchasePath: z.string().trim().max(255).optional(),
  pricingPath: z.string().trim().max(255).optional(),
});

paymentsRouter.put(
  "/settings",
  route(async (req, res) => {
    const input = settingsSchema.parse(req.body);
    const site = await creatorSite(req, input.siteId);
    const { siteId: _ignored, ...patch } = input;

    const before = await loadPaymentSettings(site.id);

    // Live needs a gateway that can take real money. Refused with the reason,
    // so a creator never "goes live" into a site that cannot sell.
    if (patch.mode === "live" && before.mode !== "live") {
      requireSecrets();
      const live = await connectedGateways(site.id, "live");
      if (live.length === 0) throw badRequest("no_live_gateway");
    }

    const next = await savePaymentSettings(site.id, patch);

    // Test buyers lose what they bought with a test card the moment the site
    // goes live. FP-16 section 11.
    let endedTestSubscriptions = 0;
    if (before.mode === "test" && next.mode === "live") {
      endedTestSubscriptions = await endTestSubscriptions(site.id);
    }

    ok(res, { ...(await paymentsOverview(site.id, publicApiBase(req))), endedTestSubscriptions });
  })
);

const connectSchema = z.object({
  siteId: siteIdSchema,
  mode: z.enum(["test", "live"]),
  values: z.record(z.string().trim().max(500)).default({}),
});

paymentsRouter.put(
  "/gateways/:gateway",
  route(async (req, res) => {
    requireSecrets();
    const input = connectSchema.parse(req.body);
    const site = await creatorSite(req, input.siteId);
    const gateway = req.params["gateway"];
    if (!isGatewayId(gateway)) throw badRequest("unknown_gateway");

    limit(req, "payments-connect", 30);

    try {
      const { notice } = await connectGateway(site.id, gateway, input.mode, input.values, publicApiBase(req));
      ok(res, { ...(await paymentsOverview(site.id, publicApiBase(req))), notice });
    } catch (error) {
      // The gateway's own words, because they say exactly what is wrong with
      // the key, and the plugin shows them under the field (F03).
      if (error instanceof GatewayError) throw badRequest("gateway_rejected", { message: error.message });
      throw error;
    }
  })
);

paymentsRouter.delete(
  "/gateways/:gateway",
  route(async (req, res) => {
    const site = await creatorSite(req, req.query["siteId"]);
    const gateway = req.params["gateway"];
    const mode = req.query["mode"];
    if (!isGatewayId(gateway)) throw badRequest("unknown_gateway");
    if (!isPaymentMode(mode)) throw badRequest("unknown_mode");

    await disconnectGateway(site.id, gateway, mode);
    ok(res, await paymentsOverview(site.id, publicApiBase(req)));
  })
);

/** One member's purchases, for the Manage tab's member flyout. */
paymentsRouter.get(
  "/members/:memberId",
  route(async (req, res) => {
    const site = await creatorSite(req, req.query["siteId"]);
    const memberId = String(req.params["memberId"] ?? "");

    const [subscriptions, payments] = await Promise.all([
      prisma.subscription.findMany({
        where: { siteId: site.id, memberId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          tierKey: true, interval: true, gateway: true, mode: true, status: true,
          currentPeriodEnd: true, amountMinor: true, currency: true, createdAt: true,
        },
      }),
      prisma.payment.findMany({
        where: { siteId: site.id, memberId },
        orderBy: { paidAt: "desc" },
        take: 10,
        select: { amountMinor: true, currency: true, status: true, paidAt: true, gateway: true, mode: true },
      }),
    ]);

    ok(res, { subscriptions, payments });
  })
);

// ============================================================================
// MEMBER: /api/checkout and /api/member/billing
// ============================================================================

async function requireMember(req: Request) {
  const site = requireSite(req);
  const token = req.cookies?.[env.session.cookieName] as string | undefined;
  const session = await loadSession(token, site.id);
  if (!session) throw unauthorized();
  return { site, session };
}

/** The site's own origin, from the request. `resolveSite` already checked it against the allowlist. */
function siteOrigin(req: Request, allowed: string[]): string {
  const origin = req.header("origin");
  if (origin && allowed.includes(origin.replace(/\/+$/, ""))) return origin.replace(/\/+$/, "");
  const first = allowed[0];
  if (!first) throw badRequest("no_site_origin");
  return first;
}

export const checkoutRouter = Router();

checkoutRouter.get(
  "/pricing",
  route(async (req, res) => {
    const site = requireSite(req);
    const { mode } = await loadPaymentSettings(site.id);
    // Prices are shown in the buyer's currency where the creator set one, so
    // the answer depends on who asks and must not be shared by a cache.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Origin, X-MemberFrame-Test-Country");
    ok(res, { ...(await publicPricing(site.id, resolveCountry(req, mode === "test"))) });
  })
);

const createSessionSchema = z.object({
  tierKey: z.string().trim().min(1).max(50),
  interval: z.string().refine(isInterval, "interval"),
  returnPath: z.string().trim().max(255).default("/pricing"),
});

checkoutRouter.post(
  "/create-session",
  route(async (req, res) => {
    requireSecrets();
    const { site, session } = await requireMember(req);
    const input = createSessionSchema.parse(req.body);
    if (!isSafeSitePath(input.returnPath)) throw badRequest("unsafe_path");

    limit(req, `checkout:${session.member.memberId}`, 10);
    const { mode } = await loadPaymentSettings(site.id);

    const result = await createCheckout({
      siteId: site.id,
      siteName: site.siteName,
      member: { id: session.member.memberId, email: session.member.email, name: session.member.name },
      tierKey: input.tierKey,
      interval: input.interval as "month" | "year" | "lifetime",
      returnPath: input.returnPath,
      origin: siteOrigin(req, site.allowedOrigins),
      country: resolveCountry(req, mode === "test"),
    });

    ok(res, result);
  })
);

checkoutRouter.get(
  "/status/:checkoutId",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    ok(res, await checkoutStatus(site.id, session.member.memberId, String(req.params["checkoutId"] ?? "")));
  })
);

export const billingRouter = Router();

billingRouter.get(
  "/",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    ok(res, await memberBilling(site.id, session.member.memberId));
  })
);

const returnSchema = z.object({ returnPath: z.string().trim().max(255).default("/") });

billingRouter.post(
  "/portal",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    limit(req, `billing:${session.member.memberId}`, 20);
    const { returnPath } = returnSchema.parse(req.body ?? {});
    const path = isSafeSitePath(returnPath) ? returnPath : "/";
    const url = await billingPortal(site.id, session.member.memberId, `${siteOrigin(req, site.allowedOrigins)}${path}`);
    ok(res, { url });
  })
);

billingRouter.post(
  "/cancel",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    limit(req, `billing:${session.member.memberId}`, 20);
    await cancelSubscription(site.id, session.member.memberId);
    ok(res, await memberBilling(site.id, session.member.memberId));
  })
);

billingRouter.post(
  "/resume",
  route(async (req, res) => {
    const { site, session } = await requireMember(req);
    limit(req, `billing:${session.member.memberId}`, 20);
    await resumeSubscription(site.id, session.member.memberId);
    ok(res, await memberBilling(site.id, session.member.memberId));
  })
);

// ============================================================================
// WEBHOOKS: /api/webhooks/:gateway/:siteId/:mode
// ============================================================================
// Mounted with `express.raw`, before the JSON parser, because the signature is
// over the exact bytes the gateway sent. Order, from backend PRD 7.4:
//
//   1. verify the signature            fail: 400, nothing recorded
//   2. insert into webhook_events      duplicate: 200, nothing done
//   3. apply                           fail: remove the row, 500, the gateway retries
//
// Applying before answering, rather than queueing, because there is no queue
// yet and every action is a few rows and at most one gateway call. A failure
// removes the ledger row, so the retry is processed rather than skipped.

function headerMap(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

export const handleWebhook = route(async (req: Request, res: Response) => {
  const gateway = req.params["gateway"];
  const siteId = String(req.params["siteId"] ?? "");
  const mode = req.params["mode"];
  if (!isGatewayId(gateway) || !isPaymentMode(mode)) {
    res.status(404).json({ reason: "not_found" });
    return;
  }

  const credentials = await loadCredentials(siteId, gateway, mode);
  if (!credentials) {
    res.status(404).json({ reason: "not_found" });
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const headers = headerMap(req);
  const adapter = ADAPTERS[gateway];

  const secrets = [credentials.webhookSecret ?? ""];
  if (!env.isProduction && gateway === "stripe" && env.payments.stripeCliWebhookSecret) {
    secrets.push(env.payments.stripeCliWebhookSecret);
  }

  if (!adapter.verifyWebhook(rawBody, headers, secrets)) {
    res.status(400).json({ reason: "invalid_signature" });
    return;
  }

  let parsed;
  try {
    parsed = adapter.parseWebhook(rawBody, headers);
  } catch {
    res.status(400).json({ reason: "unreadable_payload" });
    return;
  }

  if (!parsed.eventId) {
    res.status(400).json({ reason: "missing_event_id" });
    return;
  }

  let ledgerId: string;
  try {
    const row = await prisma.webhookEvent.create({
      data: { gateway, eventId: parsed.eventId.slice(0, 255), siteId, type: parsed.type.slice(0, 100) },
    });
    ledgerId = row.id;
  } catch (error) {
    if (error instanceof Error && error.message.includes("P2002")) {
      ok(res, { received: true, duplicate: true });
      return;
    }
    throw error;
  }

  try {
    for (const event of parsed.events) {
      await applyPaymentEvent(siteId, credentials, event);
    }
    await prisma.webhookEvent.update({ where: { id: ledgerId }, data: { processedAt: new Date() } });
    await prisma.gatewayConfig.update({ where: { id: credentials.configId }, data: { lastWebhookAt: new Date() } });
  } catch (error) {
    await prisma.webhookEvent.delete({ where: { id: ledgerId } }).catch(() => undefined);
    process.stderr.write(
      `[payments] ${gateway} ${parsed.type} failed, will be retried: ${error instanceof Error ? error.message : String(error)}\n`
    );
    res.status(500).json({ reason: "processing_failed" });
    return;
  }

  ok(res, { received: true });
});

// ============================================================================
// RAZORPAY BRIDGE: /api/pay/razorpay/:checkoutId
// ============================================================================
// Razorpay has no hosted page that sends a subscriber back to the site, so the
// buyer lands here: a page that opens Razorpay Checkout (UPI QR, cards, net
// banking) and, when Razorpay reports success, sends them to the site's return
// URL. The checkout id is unguessable and single-purpose; the page shows only
// the public key id, the order or subscription id, and the buyer's own email.

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export const handlePayBridge = route(async (req: Request, res: Response) => {
  const checkoutId = String(req.params["checkoutId"] ?? "");
  const checkout = await prisma.checkout.findUnique({ where: { id: checkoutId } });

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (!checkout || checkout.gateway !== "razorpay" || checkout.state !== "open" || !checkout.externalId) {
    res.status(404).type("html").send("<!doctype html><title>Checkout expired</title><p>This checkout has expired. Go back and start again.</p>");
    return;
  }

  const [credentials, member, site, tier] = await Promise.all([
    loadCredentials(checkout.siteId, "razorpay", checkout.mode as PaymentMode),
    prisma.member.findUnique({ where: { id: checkout.memberId }, select: { email: true, name: true } }),
    prisma.site.findUnique({ where: { id: checkout.siteId }, select: { siteName: true, allowedOrigins: true } }),
    prisma.tier.findFirst({ where: { siteId: checkout.siteId, key: checkout.tierKey }, select: { name: true } }),
  ]);

  const origins = Array.isArray(site?.allowedOrigins) ? (site!.allowedOrigins as string[]) : [];
  const origin = origins[0];
  if (!credentials?.publicId || !origin) {
    res.status(404).type("html").send("<!doctype html><title>Checkout unavailable</title><p>This checkout is not available.</p>");
    return;
  }

  const separator = checkout.returnPath.includes("?") ? "&" : "?";
  const success = `${origin}${checkout.returnPath}${separator}mf_checkout=${encodeURIComponent(checkout.id)}`;
  const cancel = `${origin}${checkout.returnPath}${separator}mf_checkout_cancelled=1`;

  const options = {
    key: credentials.publicId,
    name: site?.siteName ?? "",
    description: tier?.name ?? checkout.tierKey,
    ...(checkout.interval === "lifetime" ? { order_id: checkout.externalId } : { subscription_id: checkout.externalId }),
    prefill: { email: member?.email ?? "", name: member?.name ?? "" },
    notes: { mf_checkout_id: checkout.id },
  };

  // JSON inside a script: `<` escaped so no value can close the tag.
  const config = JSON.stringify({ options, success, cancel }).replace(/</g, "\\u003c");

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(tier?.name ?? "Checkout")}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: Canvas; color: CanvasText; }
  main { text-align: center; padding: 24px; max-width: 360px; }
  button { margin-top: 12px; padding: 10px 18px; border-radius: 8px; border: 0; background: #5271ff; color: #fff; font: inherit; cursor: pointer; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <p id="state">Opening secure checkout.</p>
  <button id="retry" hidden>Open checkout</button>
  <p><a id="back" href="#">Go back</a></p>
</main>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  (function () {
    var config = ${config};
    document.getElementById("back").href = config.cancel;
    function open() {
      var options = config.options;
      options.handler = function () { window.location.replace(config.success); };
      options.modal = { ondismiss: function () {
        document.getElementById("state").textContent = "Checkout closed.";
        document.getElementById("retry").hidden = false;
      } };
      new Razorpay(options).open();
    }
    document.getElementById("retry").onclick = open;
    if (window.Razorpay) open();
    else document.getElementById("state").textContent = "Checkout could not load. Check your connection and refresh.";
  })();
</script>
</body>
</html>`);
});

export type { GatewayId };
