/**
 * Which gateway a buyer gets. FP-16 section 6, PRD F03.
 *
 * Decided on the server from the request's own country header, never from a
 * country the browser names: the choice has tax consequences, and a client
 * could name any country it likes.
 *
 * Where the country comes from, first match wins:
 *
 *   1. A test override, `X-MemberFrame-Test-Country`, honoured only while the
 *      site is in test mode, so a creator can try the India route from
 *      anywhere. It can never move a live buyer.
 *   2. The CDN or proxy in front of the API (Cloudflare, Vercel, CloudFront,
 *      Fastly, App Engine all set one).
 *   3. The buyer's IP, looked up in a local GeoLite2 country database
 *      (`geoip-country`), so routing works with no CDN at all. Behind a tunnel
 *      in development the address is the one the tunnel forwards.
 */

import geoip from "geoip-country";
import { env } from "../../config/env.js";
import type { BillingInterval, GatewayCredentials, GatewayId } from "./types.js";
import { ADAPTERS } from "./gatewayStore.js";

export const TEST_COUNTRY_HEADER = "x-memberframe-test-country";

const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "cloudfront-viewer-country",
  "fastly-geo-country-code",
  "x-appengine-country",
  "x-country-code",
] as const;

/** EU member states plus the UK, Norway, Iceland, Liechtenstein, and Switzerland: where VAT handling matters. */
const VAT_REGION = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "GB", "NO", "IS", "LI", "CH",
]);

/** A plausible IP address, checked before it reaches the lookup. */
const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})$/;

/** The country of an IP address, or null for a private, local, or unknown one. */
export function countryFromIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const address = ip.trim().replace(/^::ffff:/, "");
  if (address.length > 45 || !IP_PATTERN.test(address)) return null;
  try {
    const found = geoip.lookup(address);
    return found && /^[A-Z]{2}$/.test(found.country) ? found.country : null;
  } catch {
    return null;
  }
}

/**
 * The buyer's IP. In production Express already reads it from the proxy
 * (`trust proxy`), so `req.ip` is right. In development a tunnel such as
 * ngrok sits in front and `req.ip` is the tunnel's own local address, so the
 * first forwarded address is used. It is only ever used to pick a gateway.
 */
export function buyerIp(request: { ip?: string; headers: Record<string, string | string[] | undefined> }): string | null {
  if (!env.isProduction) {
    const raw = request.headers["x-forwarded-for"];
    const forwarded = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return request.ip ?? null;
}

/** The country for routing and currency, from every source above, in order. */
export function resolveCountry(
  request: { ip?: string; headers: Record<string, string | string[] | undefined> },
  testMode: boolean
): string | null {
  if (testMode) {
    const raw = request.headers[TEST_COUNTRY_HEADER];
    const override = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
    if (override && /^[A-Z]{2}$/.test(override)) return override;
  }
  return countryFrom(request.headers) ?? countryFromIp(buyerIp(request));
}

export function countryFrom(headers: Record<string, string | string[] | undefined>): string | null {
  for (const name of COUNTRY_HEADERS) {
    const raw = headers[name];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
    // Cloudflare sends XX for unknown and T1 for Tor.
    if (value && /^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1") return value;
  }
  return null;
}

export interface RouteDecision {
  gateway: GatewayId;
  reason: string;
}

/**
 * Pick a gateway, or null when nothing connected can sell this.
 *
 *   routing off              the default gateway, else the first that can sell
 *   India                    Razorpay
 *   EU, UK, EEA, Switzerland Lemon Squeezy
 *   anywhere else            Stripe
 *
 * Every step falls through to the next option that can actually sell this
 * interval, and the reason is returned so the log says why.
 */
export function chooseGateway(input: {
  connected: GatewayCredentials[];
  interval: BillingInterval;
  /** The currency the buyer is being charged in. Razorpay sells INR only, a Lemon Squeezy store its own. */
  currency: string;
  country: string | null;
  autoDetectGeolocation: boolean;
  defaultGateway: GatewayId | "";
}): RouteDecision | null {
  const sellable = input.connected.filter((credentials) => ADAPTERS[credentials.gateway].canSell(credentials, input.interval, input.currency));
  const has = (gateway: GatewayId) => sellable.some((credentials) => credentials.gateway === gateway);

  const fallback = (why: string): RouteDecision | null => {
    if (input.defaultGateway && has(input.defaultGateway)) {
      return { gateway: input.defaultGateway, reason: `${why}; default gateway` };
    }
    for (const gateway of ["stripe", "lemonsqueezy", "razorpay"] as const) {
      if (has(gateway)) return { gateway, reason: `${why}; first connected gateway that sells this` };
    }
    return null;
  };

  if (!input.autoDetectGeolocation) return fallback("routing off");
  if (input.country === null) return fallback("no country");

  if (input.country === "IN") {
    return has("razorpay") ? { gateway: "razorpay", reason: "India" } : fallback("India, Razorpay not available");
  }
  if (VAT_REGION.has(input.country)) {
    return has("lemonsqueezy") ? { gateway: "lemonsqueezy", reason: "VAT region" } : fallback("VAT region, Lemon Squeezy not available");
  }
  return has("stripe") ? { gateway: "stripe", reason: "global" } : fallback("global, Stripe not available");
}

/** The order methods are listed in after the recommended one (29-checkout-methods.md). */
export const METHOD_ORDER: ReadonlyArray<GatewayId> = ["stripe", "lemonsqueezy", "razorpay"];

/**
 * The methods a buyer may choose for this price: every connected gateway
 * that can sell it, the one suiting their location first. Routing always runs
 * here, with no default gateway: the buyer decides, this only preselects.
 */
export function availableMethods(input: {
  connected: GatewayCredentials[];
  interval: BillingInterval;
  currency: string;
  country: string | null;
}): { methods: GatewayId[]; recommended: GatewayId | null } {
  const sellable = METHOD_ORDER.filter((gateway) =>
    input.connected.some(
      (credentials) => credentials.gateway === gateway && ADAPTERS[gateway].canSell(credentials, input.interval, input.currency)
    )
  );
  const recommended =
    chooseGateway({ ...input, autoDetectGeolocation: true, defaultGateway: "" })?.gateway ?? sellable[0] ?? null;
  const methods = recommended ? [recommended, ...sellable.filter((gateway) => gateway !== recommended)] : sellable;
  return { methods, recommended };
}
