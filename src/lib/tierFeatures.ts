/**
 * A tier's feature list: the lines its pricing card shows, each included or
 * not. Development doc: memberframe/docs/development-docs/28-tier-features.md.
 */

import { z } from "zod";

export const MAX_TIER_FEATURES = 20;
export const MAX_TIER_FEATURE_LENGTH = 120;

export interface TierFeature {
  text: string;
  included: boolean;
}

/** What a create or update may send. */
export const tierFeaturesSchema = z
  .array(
    z.object({
      text: z.string().trim().min(1).max(MAX_TIER_FEATURE_LENGTH),
      included: z.boolean().default(true),
    })
  )
  .max(MAX_TIER_FEATURES);

/**
 * A stored list, read defensively. The column is JSON nothing else validates,
 * so a malformed entry is dropped rather than sent to a published page.
 */
export function readTierFeatures(value: unknown): TierFeature[] {
  if (!Array.isArray(value)) return [];
  const features: TierFeature[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record["text"] === "string" ? record["text"].trim().slice(0, MAX_TIER_FEATURE_LENGTH) : "";
    if (text === "") continue;
    features.push({ text, included: record["included"] !== false });
    if (features.length === MAX_TIER_FEATURES) break;
  }
  return features;
}
