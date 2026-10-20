/**
 * What the checkout chooser calls each gateway. A creator's title and
 * description override these defaults (29-checkout-methods.md).
 */

import { z } from "zod";
import type { GatewayId } from "../services/payments/types.js";

export const METHOD_TITLE_MAX = 60;
export const METHOD_DESCRIPTION_MAX = 140;

export interface MethodLabel {
  title: string;
  description: string;
}

export type MethodLabels = Partial<Record<GatewayId, Partial<MethodLabel>>>;

export const DEFAULT_METHOD_LABELS: Record<GatewayId, MethodLabel> = {
  stripe: { title: "Credit or debit card", description: "Visa, Mastercard, Amex, Apple Pay, and Google Pay." },
  lemonsqueezy: { title: "Card or PayPal", description: "Sales tax and VAT included." },
  razorpay: { title: "UPI, cards, and net banking", description: "For buyers in India." },
};

const labelSchema = z.object({
  title: z.string().trim().max(METHOD_TITLE_MAX).optional(),
  description: z.string().trim().max(METHOD_DESCRIPTION_MAX).optional(),
});

/** What a settings save may send. An empty string falls back to the default. */
export const methodLabelsSchema = z.object({
  stripe: labelSchema.optional(),
  lemonsqueezy: labelSchema.optional(),
  razorpay: labelSchema.optional(),
});

/** A stored value, read defensively, keeping only non-empty strings. */
export function readMethodLabels(value: unknown): MethodLabels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: MethodLabels = {};
  for (const gateway of Object.keys(DEFAULT_METHOD_LABELS) as GatewayId[]) {
    const entry = (value as Record<string, unknown>)[gateway];
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record["title"] === "string" ? record["title"].trim().slice(0, METHOD_TITLE_MAX) : "";
    const description =
      typeof record["description"] === "string" ? record["description"].trim().slice(0, METHOD_DESCRIPTION_MAX) : "";
    if (title || description) out[gateway] = { ...(title ? { title } : {}), ...(description ? { description } : {}) };
  }
  return out;
}

/** The label a buyer sees: the creator's, else the default. */
export function resolveMethodLabel(gateway: GatewayId, labels: MethodLabels): MethodLabel {
  const own = labels[gateway] ?? {};
  return {
    title: own.title || DEFAULT_METHOD_LABELS[gateway].title,
    description: own.description || DEFAULT_METHOD_LABELS[gateway].description,
  };
}
