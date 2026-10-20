/**
 * The shape every gateway is translated into. FP-16 section 4.3, PRD 10.5.
 *
 * Nothing above `services/payments/<gateway>.ts` knows which gateway it is
 * talking to. Each adapter turns its gateway's API and webhooks into these
 * types, and `apply.ts` acts on them the same way for all three.
 */

export type GatewayId = "stripe" | "lemonsqueezy" | "razorpay";
export type PaymentMode = "test" | "live";
export type BillingInterval = "month" | "year" | "lifetime";

export const GATEWAYS: ReadonlyArray<GatewayId> = ["stripe", "lemonsqueezy", "razorpay"];
export const MODES: ReadonlyArray<PaymentMode> = ["test", "live"];
export const INTERVALS: ReadonlyArray<BillingInterval> = ["month", "year", "lifetime"];

export function isGatewayId(value: unknown): value is GatewayId {
  return typeof value === "string" && (GATEWAYS as ReadonlyArray<string>).includes(value);
}

export function isPaymentMode(value: unknown): value is PaymentMode {
  return value === "test" || value === "live";
}

export function isInterval(value: unknown): value is BillingInterval {
  return typeof value === "string" && (INTERVALS as ReadonlyArray<string>).includes(value);
}

/** A connected gateway, decrypted, for the length of one request. Never logged, never returned. */
export interface GatewayCredentials {
  gateway: GatewayId;
  mode: PaymentMode;
  /** Razorpay key id, Lemon Squeezy store id, Stripe account id. */
  publicId: string | null;
  secrets: Record<string, string>;
  webhookSecret: string | null;
  options: Record<string, unknown>;
}

/** What the creator pasted, before verification. */
export interface ConnectInput {
  mode: PaymentMode;
  values: Record<string, string>;
  /** Where this gateway should send webhooks for this site and mode. */
  webhookUrl: string;
}

/** What connecting produced, ready to encrypt and store. */
export interface ConnectResult {
  publicId: string | null;
  secrets: Record<string, string>;
  webhookSecret: string | null;
  webhookEndpointId: string | null;
  accountName: string | null;
  maskedSuffix: string | null;
  options: Record<string, unknown>;
  /** A note for the creator, e.g. why the webhook could not be registered automatically. */
  notice: string | null;
}

export interface PriceSpec {
  siteId: string;
  tierKey: string;
  tierName: string;
  interval: BillingInterval;
  amountMinor: number;
  currency: string;
}

/** A gateway-side price MemberFrame already created, reused for this checkout. */
export interface KnownPrice {
  externalId: string;
  externalProductId: string | null;
}

export interface CheckoutSpec extends PriceSpec {
  checkoutId: string;
  siteName: string;
  member: { id: string; email: string; name: string | null };
  successUrl: string;
  cancelUrl: string;
  /** From `ensurePrice`, for gateways that charge against a stored price. */
  price: KnownPrice | null;
  /** A customer id from this member's earlier purchase on this gateway, if any. */
  customerId: string | null;
  /**
   * Unused credit from the plan being upgraded, taken off the first charge
   * only (30-plan-changes.md). A gateway that cannot discount ignores it, and
   * the credit is refunded after payment instead.
   */
  discountMinor?: number;
}

export interface CheckoutResult {
  /** Where to send the buyer. For Razorpay this is MemberFrame's own bridge page. */
  url: string;
  externalId: string;
  /** The credit actually taken off the first charge, when the gateway applied `discountMinor`. */
  discountApplied?: number;
  /**
   * How to open the checkout on the creator's own page instead of sending the
   * buyer away. `url` stays the fallback when the gateway's script cannot load.
   */
  embed?: CheckoutEmbed;
}

/** On-site checkout. Public values only: a key id and an order or subscription id. */
export type CheckoutEmbed =
  | { kind: "lemonsqueezy" }
  | {
      kind: "razorpay";
      key: string;
      orderId?: string;
      subscriptionId?: string;
      name: string;
      description: string;
      prefill: { email: string; name: string };
    };

/**
 * One thing that happened at a gateway, in MemberFrame's terms.
 *
 * `activate` names the checkout it completes, through the metadata MemberFrame
 * put on the checkout. Everything after that names the subscription by the
 * gateway's own id.
 */
export type PaymentAction =
  | "activate"
  | "renewed"
  | "payment_failed"
  | "cancel_scheduled"
  | "resumed"
  | "ended"
  | "refunded";

export interface PaymentEvent {
  action: PaymentAction;
  /** The gateway's event type, for the ledger and logs. */
  type: string;
  /** From MemberFrame's metadata on the checkout. Present on `activate`. */
  checkoutId: string | null;
  /** Subscription id, or order or payment id for a lifetime purchase. */
  externalId: string | null;
  customerId: string | null;
  currentPeriodEnd: Date | null;
  /** `activate` from an event that also fires for the other kind of purchase. */
  onlyFor: "lifetime" | "recurring" | null;
  payment: {
    externalId: string;
    amountMinor: number;
    currency: string;
    receiptUrl: string | null;
    paidAt: Date;
  } | null;
  manageUrl: string | null;
}

/**
 * A checkout as MemberFrame recorded it, for asking the gateway how it ended.
 * `externalId` is what `createCheckout` returned: a Stripe session, a
 * Razorpay order or subscription, a Lemon Squeezy checkout.
 */
export interface PendingCheckout {
  id: string;
  externalId: string | null;
  interval: BillingInterval;
  createdAt: Date;
  memberEmail: string;
}

export interface ParsedWebhook {
  /** Unique per delivery of one event, for the idempotency ledger. */
  eventId: string;
  type: string;
  events: PaymentEvent[];
}

export function paymentEvent(
  action: PaymentAction,
  type: string,
  fields: Partial<Omit<PaymentEvent, "action" | "type">> = {}
): PaymentEvent {
  return {
    action,
    type,
    checkoutId: fields.checkoutId ?? null,
    externalId: fields.externalId ?? null,
    customerId: fields.customerId ?? null,
    currentPeriodEnd: fields.currentPeriodEnd ?? null,
    onlyFor: fields.onlyFor ?? null,
    payment: fields.payment ?? null,
    manageUrl: fields.manageUrl ?? null,
  };
}

/**
 * The contract each gateway implements.
 *
 * `ensurePrice` is optional: Lemon Squeezy cannot have products created
 * through its API, so it charges a creator-linked variant with a custom price
 * instead (FP-16 section 5.1).
 */
export interface GatewayAdapter {
  id: GatewayId;
  /** Verify keys, register the webhook where the gateway allows it. */
  connect(input: ConnectInput): Promise<ConnectResult>;
  /** Remove what `connect` registered. Best effort. */
  disconnect(credentials: GatewayCredentials, webhookEndpointId: string | null): Promise<void>;
  ensurePrice?(credentials: GatewayCredentials, spec: PriceSpec, product: string | null): Promise<KnownPrice>;
  /** Can this gateway sell this interval, in this currency, with the current configuration? */
  canSell(credentials: GatewayCredentials, interval: BillingInterval, currency: string): boolean;
  createCheckout(credentials: GatewayCredentials, spec: CheckoutSpec): Promise<CheckoutResult>;
  /** True when the raw body was signed by the gateway with this site's secret. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, secrets: string[]): boolean;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): ParsedWebhook;
  /** The subscription's current period end, when an event did not carry it. */
  periodEnd?(credentials: GatewayCredentials, externalId: string): Promise<Date | null>;
  /** A page where the member manages billing on the gateway, or null when there is none. */
  portalUrl(credentials: GatewayCredentials, subscription: { externalId: string; customerId: string | null; manageUrl: string | null }, returnUrl: string): Promise<string | null>;
  cancelAtPeriodEnd(credentials: GatewayCredentials, externalId: string): Promise<void>;
  /** Undo a scheduled cancel. Null when the gateway cannot (Razorpay). */
  resume: ((credentials: GatewayCredentials, externalId: string) => Promise<void>) | null;
  /** End a recurring subscription now. Used when a member switches tier. */
  cancelNow(credentials: GatewayCredentials, externalId: string): Promise<void>;
  /**
   * Move a running subscription to another price, prorated by the gateway.
   * Absent where the gateway cannot (Lemon Squeezy charges a custom price that
   * a plan change cannot carry; Razorpay allows it for cards only), and those
   * switch through a new checkout plus a refund for the unused time instead.
   */
  changePlan?(credentials: GatewayCredentials, externalId: string, price: KnownPrice, upgrade: boolean): Promise<{ currentPeriodEnd: Date | null }>;
  /** Refund part of one payment, in that payment's currency. Used to credit unused time on a switch. */
  refund?(credentials: GatewayCredentials, paymentExternalId: string, amountMinor: number, currency: string): Promise<void>;
  /**
   * A downgrade at the end of the paid period (30-plan-changes.md): the next
   * renewal charges `price`, nothing is charged now.
   */
  scheduleChange?(credentials: GatewayCredentials, externalId: string, price: KnownPrice | null): Promise<void>;
  /**
   * What the gateway says about a subscription now, as the event its webhook
   * would have sent: renewed (with the period end), payment_failed,
   * cancel_scheduled, or ended. The sweep's safety net for a missed webhook.
   */
  syncStatus?(credentials: GatewayCredentials, externalId: string): Promise<PaymentEvent | null>;
  /** Undo `scheduleChange`. `price` is the current plan's, for a gateway that set the next price. */
  cancelScheduledChange?(credentials: GatewayCredentials, externalId: string, price: KnownPrice | null): Promise<void>;
  /**
   * Ask the gateway whether this checkout was paid, and answer in the same
   * events its webhooks would have sent. Empty while it is unpaid.
   *
   * The buyer's page polls checkout status after paying, and each poll asks
   * here, so a purchase is confirmed even when no webhook arrives: a local
   * API the gateway cannot reach, an endpoint Stripe refused to register, a
   * Razorpay webhook the creator never added. A webhook that does arrive
   * later finds the subscription already there and changes nothing.
   */
  confirmCheckout?(credentials: GatewayCredentials, checkout: PendingCheckout): Promise<PaymentEvent[]>;
}

/** A failure talking to a gateway, with the gateway's own message for the creator. */
export class GatewayError extends Error {
  constructor(
    readonly gateway: GatewayId,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Lowercase header lookup, since Node lowercases incoming header names. */
export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : typeof value === "number" ? String(value) : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function fromUnix(value: unknown): Date | null {
  const seconds = asNumber(value);
  return seconds === null || seconds <= 0 ? null : new Date(seconds * 1000);
}

export function fromIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
