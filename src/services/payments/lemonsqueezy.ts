/**
 * Lemon Squeezy. FP-16 section 5. Merchant of Record: it collects and files
 * sales tax and VAT, which is why EU buyers are routed here.
 *
 * Its API cannot create products. Rather than make the creator build one
 * product per tier, the creator makes ONE product with three variants
 * (monthly, yearly, one-time) and pastes their ids once. Each checkout charges
 * the tier's own price through `custom_price`, which Lemon Squeezy also uses
 * for every renewal of that subscription. The checkout shows the tier's name.
 *
 * Lemon Squeezy has no per-delivery event id, so the ledger key is built from
 * the event name, the object id, and its `updated_at`: one state change of one
 * object, which is exactly the unit that must apply once.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { maskedSuffix } from "../../lib/secretBox.js";
import {
  GatewayError,
  asNumber,
  asRecord,
  asString,
  fromIso,
  header,
  paymentEvent,
  type BillingInterval,
  type CheckoutSpec,
  type ConnectInput,
  type ConnectResult,
  type GatewayAdapter,
  type GatewayCredentials,
  type ParsedWebhook,
  type PaymentEvent,
} from "./types.js";

const API = "https://api.lemonsqueezy.com/v1";

export const LEMONSQUEEZY_EVENTS = [
  "order_created",
  "order_refunded",
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_payment_success",
  "subscription_payment_failed",
] as const;

/** The variant ids the creator links, one per interval. */
export const VARIANT_OPTION: Record<BillingInterval, string> = {
  month: "monthlyVariantId",
  year: "yearlyVariantId",
  lifetime: "oneTimeVariantId",
};

async function lemon(
  apiKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
      ...(body ? { "Content-Type": "application/vnd.api+json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return {};
  const json = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const errors = Array.isArray(json["errors"]) ? json["errors"] : [];
    const first = asRecord(errors[0]);
    throw new GatewayError(
      "lemonsqueezy",
      response.status,
      asString(first["detail"]) ?? asString(first["title"]) ?? `Lemon Squeezy answered ${response.status}.`
    );
  }
  return json;
}

function apiKeyOf(credentials: GatewayCredentials): string {
  const key = credentials.secrets["apiKey"];
  if (!key) throw new GatewayError("lemonsqueezy", 400, "Lemon Squeezy is not connected.");
  return key;
}

export function verifyLemonSignature(rawBody: Buffer, signature: string | undefined, secrets: string[]): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature, "hex");
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export function parseLemonEvent(event: Record<string, unknown>): PaymentEvent[] {
  const meta = asRecord(event["meta"]);
  const type = asString(meta["event_name"]) ?? "";
  const custom = asRecord(meta["custom_data"]);
  const checkoutId = asString(custom["mf_checkout_id"]);
  const data = asRecord(event["data"]);
  const id = asString(data["id"]);
  const attributes = asRecord(data["attributes"]);
  const urls = asRecord(attributes["urls"]);

  switch (type) {
    case "order_created": {
      if (!id || asString(attributes["status"]) !== "paid") return [];
      return [
        paymentEvent("activate", type, {
          checkoutId,
          externalId: id,
          customerId: asString(attributes["customer_id"]),
          // A subscription's first order also fires this. `subscription_created`
          // activates those, so here only a one-time purchase counts.
          onlyFor: "lifetime",
          payment: {
            externalId: id,
            amountMinor: asNumber(attributes["total"]) ?? 0,
            currency: asString(attributes["currency"]) ?? "USD",
            receiptUrl: asString(urls["receipt"]),
            paidAt: fromIso(attributes["created_at"]) ?? new Date(),
          },
        }),
      ];
    }

    case "order_refunded":
      return id ? [paymentEvent("refunded", type, { externalId: id })] : [];

    case "subscription_created":
      return id
        ? [
            paymentEvent("activate", type, {
              checkoutId,
              externalId: id,
              customerId: asString(attributes["customer_id"]),
              currentPeriodEnd: fromIso(attributes["renews_at"]),
              onlyFor: "recurring",
              manageUrl: asString(urls["customer_portal"]),
            }),
          ]
        : [];

    case "subscription_updated":
    case "subscription_cancelled":
    case "subscription_resumed":
    case "subscription_expired": {
      if (!id) return [];
      const status = asString(attributes["status"]);
      if (type === "subscription_expired" || status === "expired") {
        return [paymentEvent("ended", type, { externalId: id })];
      }
      if (type === "subscription_cancelled" || status === "cancelled" || attributes["cancelled"] === true) {
        return [paymentEvent("cancel_scheduled", type, { externalId: id, currentPeriodEnd: fromIso(attributes["ends_at"]) })];
      }
      if (status === "past_due" || status === "unpaid") {
        return [paymentEvent("payment_failed", type, { externalId: id })];
      }
      if (status === "active" || status === "on_trial") {
        return [
          paymentEvent("resumed", type, {
            externalId: id,
            currentPeriodEnd: fromIso(attributes["renews_at"]),
            manageUrl: asString(urls["customer_portal"]),
          }),
        ];
      }
      return [];
    }

    case "subscription_payment_success": {
      const subscriptionId = asString(attributes["subscription_id"]);
      if (!subscriptionId || !id) return [];
      return [
        paymentEvent("renewed", type, {
          checkoutId,
          externalId: subscriptionId,
          payment: {
            externalId: id,
            amountMinor: asNumber(attributes["total"]) ?? 0,
            currency: asString(attributes["currency"]) ?? "USD",
            receiptUrl: asString(urls["invoice_url"]),
            paidAt: fromIso(attributes["created_at"]) ?? new Date(),
          },
        }),
      ];
    }

    case "subscription_payment_failed": {
      const subscriptionId = asString(attributes["subscription_id"]);
      return subscriptionId ? [paymentEvent("payment_failed", type, { externalId: subscriptionId })] : [];
    }

    default:
      return [];
  }
}

export const lemonSqueezyAdapter: GatewayAdapter = {
  id: "lemonsqueezy",

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const apiKey = (input.values["apiKey"] ?? "").trim();
    const storeId = (input.values["storeId"] ?? "").trim();
    if (!apiKey) throw new GatewayError("lemonsqueezy", 400, "Paste an API key.");
    if (!/^\d+$/.test(storeId)) throw new GatewayError("lemonsqueezy", 400, "Paste the Store ID, a number.");

    let store: Record<string, unknown>;
    try {
      store = await lemon(apiKey, "GET", `/stores/${storeId}`);
    } catch (error) {
      if (error instanceof GatewayError && (error.status === 401 || error.status === 404)) {
        throw new GatewayError("lemonsqueezy", 400, "Lemon Squeezy did not accept that API key and Store ID together.");
      }
      throw error;
    }

    // API keys are made in test mode or live mode, and every response says which.
    const keyTestMode = asRecord(store["meta"])["test_mode"];
    if (typeof keyTestMode === "boolean" && keyTestMode !== (input.mode === "test")) {
      throw new GatewayError(
        "lemonsqueezy",
        400,
        input.mode === "test" ? "That API key is a live key. Make one in test mode." : "That API key is a test mode key. Make one in live mode."
      );
    }

    const options: Record<string, string> = {};
    for (const interval of ["month", "year", "lifetime"] as const) {
      const variantId = (input.values[VARIANT_OPTION[interval]] ?? "").trim();
      if (variantId === "") continue;
      if (!/^\d+$/.test(variantId)) {
        throw new GatewayError("lemonsqueezy", 400, `The ${interval === "lifetime" ? "one-time" : interval + "ly"} variant ID must be a number.`);
      }
      try {
        await lemon(apiKey, "GET", `/variants/${variantId}`);
      } catch {
        throw new GatewayError("lemonsqueezy", 400, `Variant ${variantId} was not found in this store.`);
      }
      options[VARIANT_OPTION[interval]] = variantId;
    }

    // Lemon Squeezy refuses a signing secret longer than 40 characters:
    // 20 random bytes is exactly 40 hex characters, 160 bits.
    const webhookSecret = randomBytes(20).toString("hex");
    let webhookEndpointId: string | null = null;
    let notice: string | null = null;

    try {
      const webhook = await lemon(apiKey, "POST", "/webhooks", {
        data: {
          type: "webhooks",
          attributes: {
            url: input.webhookUrl,
            events: [...LEMONSQUEEZY_EVENTS],
            secret: webhookSecret,
            test_mode: input.mode === "test",
          },
          relationships: { store: { data: { type: "stores", id: storeId } } },
        },
      });
      webhookEndpointId = asString(asRecord(webhook["data"])["id"]);
    } catch (error) {
      notice =
        error instanceof GatewayError
          ? `Connected, but the webhook could not be registered: ${error.message}`
          : "Connected, but the webhook could not be registered.";
    }

    if (Object.keys(options).length === 0) {
      notice = (notice ? notice + " " : "") + "Add at least one variant ID so tiers can be sold.";
    }

    const attributes = asRecord(asRecord(store["data"])["attributes"]);
    // A custom price is charged in the store's own currency, so the store can
    // only sell tiers priced in it. Kept with the variants.
    const storeCurrency = asString(attributes["currency"]);
    if (storeCurrency) options["storeCurrency"] = storeCurrency.toUpperCase();

    return {
      publicId: storeId,
      secrets: { apiKey },
      webhookSecret,
      webhookEndpointId,
      accountName: asString(attributes["name"]),
      maskedSuffix: maskedSuffix(apiKey),
      options,
      notice,
    };
  },

  async disconnect(credentials, webhookEndpointId) {
    if (!webhookEndpointId) return;
    try {
      await lemon(apiKeyOf(credentials), "DELETE", `/webhooks/${encodeURIComponent(webhookEndpointId)}`);
    } catch {
      // Already gone.
    }
  },

  canSell(credentials, interval, currency) {
    if (typeof credentials.options[VARIANT_OPTION[interval]] !== "string") return false;
    const storeCurrency = credentials.options["storeCurrency"];
    return typeof storeCurrency !== "string" || storeCurrency === currency;
  },

  async createCheckout(credentials, spec: CheckoutSpec) {
    const variantId = credentials.options[VARIANT_OPTION[spec.interval]];
    if (typeof variantId !== "string") {
      throw new GatewayError("lemonsqueezy", 400, "No Lemon Squeezy variant is linked for this billing period.");
    }

    const checkout = await lemon(apiKeyOf(credentials), "POST", "/checkouts", {
      data: {
        type: "checkouts",
        attributes: {
          custom_price: spec.amountMinor,
          product_options: {
            name: spec.tierName,
            redirect_url: spec.successUrl,
            enabled_variants: [Number(variantId)],
          },
          checkout_data: {
            email: spec.member.email,
            ...(spec.member.name ? { name: spec.member.name } : {}),
            custom: { mf_checkout_id: spec.checkoutId, mf_member_id: spec.member.id, mf_site_id: spec.siteId },
          },
          test_mode: credentials.mode === "test",
          // Opens as an overlay on the creator's page through lemon.js. The
          // same URL still works as a plain page if the script cannot load.
          checkout_options: { embed: true },
        },
        relationships: {
          store: { data: { type: "stores", id: credentials.publicId ?? "" } },
          variant: { data: { type: "variants", id: variantId } },
        },
      },
    });

    const data = asRecord(checkout["data"]);
    const url = asString(asRecord(data["attributes"])["url"]);
    const id = asString(data["id"]);
    if (!url || !id) throw new GatewayError("lemonsqueezy", 502, "Lemon Squeezy did not return a checkout page.");
    return { url, externalId: id, embed: { kind: "lemonsqueezy" } };
  },

  verifyWebhook(rawBody, headers, secrets) {
    return verifyLemonSignature(rawBody, header(headers, "x-signature"), secrets);
  },

  parseWebhook(rawBody): ParsedWebhook {
    const event = asRecord(JSON.parse(rawBody.toString("utf8")));
    const meta = asRecord(event["meta"]);
    const data = asRecord(event["data"]);
    const type = asString(meta["event_name"]) ?? "unknown";
    const updatedAt = asString(asRecord(data["attributes"])["updated_at"]) ?? "";
    return {
      eventId: `${type}:${asString(data["id"]) ?? ""}:${updatedAt}`,
      type,
      events: parseLemonEvent(event),
    };
  },

  async periodEnd(credentials, externalId) {
    const subscription = await lemon(apiKeyOf(credentials), "GET", `/subscriptions/${encodeURIComponent(externalId)}`);
    return fromIso(asRecord(asRecord(subscription["data"])["attributes"])["renews_at"]);
  },

  async portalUrl(credentials, subscription) {
    // The portal link in the subscription is signed and expires, so a fresh one is read each time.
    try {
      const fresh = await lemon(apiKeyOf(credentials), "GET", `/subscriptions/${encodeURIComponent(subscription.externalId)}`);
      const urls = asRecord(asRecord(asRecord(fresh["data"])["attributes"])["urls"]);
      return asString(urls["customer_portal"]) ?? subscription.manageUrl;
    } catch {
      return subscription.manageUrl;
    }
  },

  async cancelAtPeriodEnd(credentials, externalId) {
    // Lemon Squeezy's cancel keeps the subscription active until `ends_at`.
    await lemon(apiKeyOf(credentials), "DELETE", `/subscriptions/${encodeURIComponent(externalId)}`);
  },

  resume: async (credentials, externalId) => {
    await lemon(apiKeyOf(credentials), "PATCH", `/subscriptions/${encodeURIComponent(externalId)}`, {
      data: { type: "subscriptions", id: externalId, attributes: { cancelled: false } },
    });
  },

  async cancelNow(credentials, externalId) {
    // No immediate cancel in the API. Cancel, then expire it here: the member
    // has moved to another tier, and access follows the new purchase.
    await lemon(apiKeyOf(credentials), "DELETE", `/subscriptions/${encodeURIComponent(externalId)}`);
  },

  /**
   * A partial refund. Renewals are subscription invoices and one-time
   * purchases are orders; the payment row does not say which, so the invoice
   * route is tried first and the order route on a 404.
   */
  /**
   * Lemon Squeezy links an order back to its checkout only through the
   * webhook's custom data. So the order is found by what is known: this
   * store, this buyer's email, the variant this checkout sold, made no
   * earlier than the checkout. For a subscription, the order's subscription
   * and its first paid invoice follow. Answered as `order_created`, or as
   * `subscription_created` plus `subscription_payment_success`, carrying the
   * checkout id the webhook would have carried.
   */
  async confirmCheckout(credentials, checkout) {
    const apiKey = apiKeyOf(credentials);
    const variantId = credentials.options[VARIANT_OPTION[checkout.interval]];
    if (typeof variantId !== "string" || !credentials.publicId || !checkout.memberEmail) return [];

    const query = new URLSearchParams({
      "filter[store_id]": credentials.publicId,
      "filter[user_email]": checkout.memberEmail,
      "page[size]": "10",
    });
    const orders = await lemon(apiKey, "GET", `/orders?${query.toString()}`);
    const list = Array.isArray(orders["data"]) ? orders["data"].map(asRecord) : [];
    // A minute of slack for clocks that disagree.
    const notBefore = checkout.createdAt.getTime() - 60_000;

    const order = list.find((entry) => {
      const attributes = asRecord(entry["attributes"]);
      const created = fromIso(attributes["created_at"]);
      return (
        asString(attributes["status"]) === "paid" &&
        asString(asRecord(attributes["first_order_item"])["variant_id"]) === variantId &&
        created !== null &&
        created.getTime() >= notBefore
      );
    });
    if (!order) return [];

    const custom = { mf_checkout_id: checkout.id };

    if (checkout.interval === "lifetime") {
      return parseLemonEvent({ meta: { event_name: "order_created", custom_data: custom }, data: order });
    }

    const orderId = asString(order["id"]) ?? "";
    const subscriptions = await lemon(apiKey, "GET", `/subscriptions?filter[order_id]=${encodeURIComponent(orderId)}`);
    const subscription = asRecord(Array.isArray(subscriptions["data"]) ? subscriptions["data"][0] : null);
    const subscriptionId = asString(subscription["id"]);
    if (!subscriptionId) return [];

    const events = parseLemonEvent({ meta: { event_name: "subscription_created", custom_data: custom }, data: subscription });

    const invoices = await lemon(
      apiKey,
      "GET",
      `/subscription-invoices?filter[subscription_id]=${encodeURIComponent(subscriptionId)}`
    ).catch(() => ({}) as Record<string, unknown>);
    const paid = (Array.isArray(invoices["data"]) ? invoices["data"].map(asRecord) : []).find(
      (invoice) => asString(asRecord(invoice["attributes"])["status"]) === "paid"
    );
    if (paid) {
      events.push(
        ...parseLemonEvent({ meta: { event_name: "subscription_payment_success", custom_data: custom }, data: paid })
      );
    }
    return events;
  },

  async refund(credentials, paymentExternalId, amountMinor) {
    const apiKey = apiKeyOf(credentials);
    const id = encodeURIComponent(paymentExternalId);
    try {
      await lemon(apiKey, "POST", `/subscription-invoices/${id}/refund`, {
        data: { type: "subscription-invoices", id: paymentExternalId, attributes: { amount: amountMinor } },
      });
    } catch (error) {
      if (!(error instanceof GatewayError) || error.status !== 404) throw error;
      await lemon(apiKey, "POST", `/orders/${id}/refund`, {
        data: { type: "orders", id: paymentExternalId, attributes: { amount: amountMinor } },
      });
    }
  },
};
