/**
 * Tier features (memberframe/docs/development-docs/28-tier-features.md): the
 * lines a tier's pricing card shows. The schema guards what a creator sends;
 * the reader guards what the JSON column hands back to a published page.
 */

import { describe, expect, it } from "vitest";
import { MAX_TIER_FEATURES, readTierFeatures, tierFeaturesSchema } from "../src/lib/tierFeatures.js";

describe("tier features", () => {
  it("accepts lines, trims them, and defaults to included", () => {
    expect(tierFeaturesSchema.parse([{ text: "  All courses " }, { text: "Priority support", included: false }])).toEqual([
      { text: "All courses", included: true },
      { text: "Priority support", included: false },
    ]);
  });

  it("refuses a blank line, a long one, and too many", () => {
    expect(tierFeaturesSchema.safeParse([{ text: "   " }]).success).toBe(false);
    expect(tierFeaturesSchema.safeParse([{ text: "x".repeat(121) }]).success).toBe(false);
    expect(tierFeaturesSchema.safeParse(Array.from({ length: MAX_TIER_FEATURES + 1 }, () => ({ text: "Line" }))).success).toBe(false);
  });

  it("reads a stored list defensively", () => {
    expect(readTierFeatures(null)).toEqual([]);
    expect(readTierFeatures("text")).toEqual([]);
    expect(readTierFeatures([{ text: "Ok" }, { text: "" }, 7, null, { text: "No", included: false }, { included: true }])).toEqual([
      { text: "Ok", included: true },
      { text: "No", included: false },
    ]);
  });
});
