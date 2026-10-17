/**
 * Gateway keys and payment settings, at rest. FP-16 sections 7 and 11.
 *
 * The only file that decrypts a gateway secret. Everything it returns to a
 * route is a status shape with no secret field, so a route cannot leak a key
 * by returning what it was given.
 */

import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import { openJson, open, seal, sealJson } from "../../lib/secretBox.js";
import { isSafeSitePath } from "../../lib/siteSettings.js";
import { badRequest } from "../../middleware/errors.js";
import { lemonSqueezyAdapter, LEMONSQUEEZY_EVENTS } from "./lemonsqueezy.js";
import { razorpayAdapter, RAZORPAY_EVENTS } from "./razorpay.js";
import { stripeAdapter, STRIPE_EVENTS } from "./stripe.js";
import {
  GATEWAYS,
  asRecord,
  isGatewayId,
  type GatewayAdapter,
  type GatewayCredentials,
  type GatewayId,
  type PaymentMode,
} from "./types.js";

export const ADAPTERS: Record<GatewayId, GatewayAdapter> = {
  stripe: stripeAdapter,
  lemonsqueezy: lemonSqueezyAdapter,
  razorpay: razorpayAdapter,
};

/** The events each gateway must send, for the plugin's setup instructions. */
export const GATEWAY_EVENTS: Record<GatewayId, ReadonlyArray<string>> = {
  stripe: STRIPE_EVENTS,
  lemonsqueezy: LEMONSQUEEZY_EVENTS,
  razorpay: RAZORPAY_EVENTS,
};

export interface PaymentSettingsShape {
  mode: PaymentMode;
  defaultGateway: GatewayId | "";
  autoDetectGeolocation: boolean;
  defaultCurrency: string;
  graceDays: number;
  afterPurchasePath: string;
  pricingPath: string;
}

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettingsShape = {
  mode: "test",
  defaultGateway: "",
  autoDetectGeolocation: true,
  defaultCurrency: "USD",
  graceDays: 3,
  afterPurchasePath: "/dashboard",
  pricingPath: "/pricing",
};

export async function loadPaymentSettings(siteId: string): Promise<PaymentSettingsShape> {
  const row = await prisma.paymentSettings.findUnique({ where: { siteId } });
  if (!row) return { ...DEFAULT_PAYMENT_SETTINGS };

  return {
    mode: row.mode === "live" ? "live" : "test",
    defaultGateway: isGatewayId(row.defaultGateway) ? row.defaultGateway : "",
    autoDetectGeolocation: row.autoDetectGeolocation,
    defaultCurrency: row.defaultCurrency,
    graceDays: row.graceDays,
    afterPurchasePath: row.afterPurchasePath,
    pricingPath: row.pricingPath,
  };
}

export async function savePaymentSettings(
  siteId: string,
  patch: Partial<PaymentSettingsShape>
): Promise<PaymentSettingsShape> {
  for (const path of [patch.afterPurchasePath, patch.pricingPath]) {
    if (path !== undefined && !isSafeSitePath(path)) throw badRequest("unsafe_path");
  }

  const current = await loadPaymentSettings(siteId);
  const next = { ...current, ...patch };

  await prisma.paymentSettings.upsert({
    where: { siteId },
    create: { siteId, ...next },
    update: next,
  });

  return next;
}

/** Where a gateway posts this site's events. One URL per site and mode. */
export function webhookUrl(siteId: string, gateway: GatewayId, mode: PaymentMode, base: string = env.apiBaseUrl): string {
  return `${base}/api/webhooks/${gateway}/${encodeURIComponent(siteId)}/${mode}`;
}

/** Decrypted keys for one request, or null when this gateway is not connected in this mode. */
export async function loadCredentials(
  siteId: string,
  gateway: GatewayId,
  mode: PaymentMode
): Promise<(GatewayCredentials & { configId: string; webhookEndpointId: string | null }) | null> {
  const row = await prisma.gatewayConfig.findUnique({
    where: { siteId_gateway_mode: { siteId, gateway, mode } },
  });
  if (!row) return null;

  return {
    configId: row.id,
    gateway,
    mode,
    publicId: row.publicId,
    secrets: openJson(row.secretsEncrypted),
    webhookSecret: row.webhookSecretEncrypted ? open(row.webhookSecretEncrypted) : null,
    options: asRecord(row.options),
    webhookEndpointId: row.webhookEndpointId,
  };
}

/** Every gateway connected in this mode, decrypted. */
export async function connectedGateways(siteId: string, mode: PaymentMode): Promise<GatewayCredentials[]> {
  const rows = await prisma.gatewayConfig.findMany({ where: { siteId, mode }, select: { gateway: true } });
  const out: GatewayCredentials[] = [];
  for (const row of rows) {
    if (!isGatewayId(row.gateway)) continue;
    const credentials = await loadCredentials(siteId, row.gateway, mode);
    if (credentials) out.push(credentials);
  }
  return out;
}

export interface GatewayStatus {
  gateway: GatewayId;
  mode: PaymentMode;
  connected: boolean;
  accountName: string | null;
  publicId: string | null;
  maskedSuffix: string | null;
  /** Lemon Squeezy variant ids, safe to show. */
  options: Record<string, unknown>;
  webhookUrl: string;
  /** A webhook secret is stored, so events can be verified. */
  webhookConfigured: boolean;
  /** MemberFrame registered the endpoint itself. */
  webhookAutomatic: boolean;
  lastWebhookAt: string | null;
  events: ReadonlyArray<string>;
}

export async function gatewayStatuses(siteId: string, base: string = env.apiBaseUrl): Promise<GatewayStatus[]> {
  const rows = await prisma.gatewayConfig.findMany({ where: { siteId } });
  const out: GatewayStatus[] = [];

  for (const mode of ["test", "live"] as const) {
    for (const gateway of GATEWAYS) {
      const row = rows.find((entry) => entry.gateway === gateway && entry.mode === mode);
      out.push({
        gateway,
        mode,
        connected: Boolean(row),
        accountName: row?.accountName ?? null,
        publicId: row?.publicId ?? null,
        maskedSuffix: row?.maskedSuffix ?? null,
        options: asRecord(row?.options),
        webhookUrl: webhookUrl(siteId, gateway, mode, base),
        webhookConfigured: Boolean(row?.webhookSecretEncrypted),
        webhookAutomatic: Boolean(row?.webhookEndpointId),
        lastWebhookAt: row?.lastWebhookAt?.toISOString() ?? null,
        events: GATEWAY_EVENTS[gateway],
      });
    }
  }
  return out;
}

/** Verify and store a gateway's keys. Replaces what was there for that gateway and mode. */
export async function connectGateway(
  siteId: string,
  gateway: GatewayId,
  mode: PaymentMode,
  values: Record<string, string>,
  /** Where the gateway should post. A route passes `publicApiBase(req)`. */
  base: string = env.apiBaseUrl
): Promise<{ notice: string | null }> {
  const adapter = ADAPTERS[gateway];
  const previous = await loadCredentials(siteId, gateway, mode).catch(() => null);

  // A field left empty on an update keeps its stored value, so a creator can
  // add a variant id without pasting the secret key again.
  const merged: Record<string, string> = { ...values };
  if (previous) {
    if (gateway === "stripe" && !merged["secretKey"]) merged["secretKey"] = previous.secrets["secretKey"] ?? "";
    if (gateway === "lemonsqueezy") {
      if (!merged["apiKey"]) merged["apiKey"] = previous.secrets["apiKey"] ?? "";
      if (!merged["storeId"]) merged["storeId"] = previous.publicId ?? "";
    }
    if (gateway === "razorpay") {
      if (!merged["keyId"]) merged["keyId"] = previous.publicId ?? "";
      if (!merged["keySecret"]) merged["keySecret"] = previous.secrets["keySecret"] ?? "";
      if (!merged["webhookSecret"]) merged["webhookSecret"] = previous.webhookSecret ?? "";
    }
  }

  const result = await adapter.connect({ mode, values: merged, webhookUrl: webhookUrl(siteId, gateway, mode, base) });

  // Replacing keys registers a fresh endpoint; the old one would otherwise
  // keep delivering, signed with a secret this row no longer holds.
  if (previous && previous.webhookEndpointId && previous.webhookEndpointId !== result.webhookEndpointId) {
    await adapter.disconnect(previous, previous.webhookEndpointId);
  }

  const data = {
    publicId: result.publicId,
    secretsEncrypted: sealJson(result.secrets),
    webhookSecretEncrypted: result.webhookSecret ? seal(result.webhookSecret) : null,
    webhookEndpointId: result.webhookEndpointId,
    options: result.options as object,
    accountName: result.accountName,
    maskedSuffix: result.maskedSuffix,
    verifiedAt: new Date(),
  };

  await prisma.gatewayConfig.upsert({
    where: { siteId_gateway_mode: { siteId, gateway, mode } },
    create: { siteId, gateway, mode, ...data },
    update: data,
  });

  return { notice: result.notice };
}

/** How many subscriptions still renew through this gateway and mode. */
export async function liveSubscriptionCount(siteId: string, gateway: GatewayId, mode: PaymentMode): Promise<number> {
  return prisma.subscription.count({
    where: { siteId, gateway, mode, status: { in: ["active", "past_due", "canceling"] }, interval: { not: "lifetime" } },
  });
}

export async function disconnectGateway(siteId: string, gateway: GatewayId, mode: PaymentMode): Promise<void> {
  const credentials = await loadCredentials(siteId, gateway, mode);
  if (!credentials) return;

  const renewing = await liveSubscriptionCount(siteId, gateway, mode);
  if (renewing > 0) throw badRequest("gateway_in_use", { subscriptions: renewing });

  await ADAPTERS[gateway].disconnect(credentials, credentials.webhookEndpointId);
  await prisma.gatewayConfig.delete({ where: { id: credentials.configId } });
}
