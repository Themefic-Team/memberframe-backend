/**
 * MemberFrame's own Stripe account. F19, 19-pro-lock-and-trial.md.
 *
 * The member payments in `services/payments/stripe.ts` charge with each
 * creator's key; this charges creators, with the platform key from env. Same
 * REST approach and API version, sharing that file's form encoding, so the
 * two never disagree on how a request is written.
 */

import { env } from "../config/env.js";
import { formEncode } from "../services/payments/stripe.js";

const API = "https://api.stripe.com/v1";
const API_VERSION = "2024-06-20";

export type StripeObject = Record<string, unknown>;

export class PlatformBillingError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "PlatformBillingError";
    this.status = status;
    this.code = code;
  }
}

/** Whether billing can run at all. Off in a development setup with no Stripe key. */
export function platformBillingReady(): boolean {
  return env.billing.stripeSecretKey !== "";
}

export const asRecord = (value: unknown): StripeObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
export const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
export const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const fromUnix = (value: unknown): Date | null => {
  const seconds = asNumber(value);
  return seconds === null ? null : new Date(seconds * 1000);
};

/**
 * One call. `idempotencyKey` makes a retried POST (a double click, a network
 * retry) create one object, not two.
 */
export async function platformStripe(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  idempotencyKey?: string
): Promise<StripeObject> {
  if (!platformBillingReady()) throw new PlatformBillingError(503, "Billing is not configured on this server.", "billing_not_configured");

  const body = formEncode(params).join("&");
  const url = method !== "POST" && body ? `${API}${path}?${body}` : `${API}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.billing.stripeSecretKey}`,
      "Stripe-Version": API_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? body : undefined,
  });

  const json = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const error = asRecord(json["error"]);
    throw new PlatformBillingError(
      response.status >= 500 ? 502 : 400,
      asString(error["message"]) ?? `Stripe answered ${response.status}.`,
      asString(error["code"])
    );
  }
  return json;
}
