/**
 * F19 settings read the BEAF backend's .env names too (the company billing
 * standard), skip example placeholders, and allow an inline comment.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = [
  "PLATFORM_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY", "PLATFORM_STRIPE_PUBLISHABLE_KEY", "STRIPE_PUBLISHABLE_KEY",
  "PLATFORM_STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET", "PLATFORM_PRICE_MONTHLY", "STRIPE_PRICE_MONTHLY",
  "PLATFORM_PRICE_YEARLY", "STRIPE_PRICE_YEARLY", "PLATFORM_PRICE_LIFETIME", "STRIPE_PRICE_LIFETIME",
  "CREATOR_GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID", "CREATOR_GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET",
  "LIFETIME_MAX", "LIFETIME_DEAL_MAX_USERS", "TRIAL_DURATION_MINUTES",
];

async function loadWith(dotEnv: string) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "mf-env-"));
  writeFileSync(join(dir, ".env"), dotEnv);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.resetModules();
  try {
    return (await import("../src/config/env.js")).env;
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

afterEach(() => vi.restoreAllMocks());

describe("billing settings in .env", () => {
  it("reads BEAF's names, skips placeholders, and strips an inline comment", async () => {
    const env = await loadWith(
      [
        "GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET=your-google-client-secret",
        "STRIPE_PUBLISHABLE_KEY='pk_test_abc'",
        "STRIPE_SECRET_KEY='sk_test_abc'",
        "STRIPE_WEBHOOK_SECRET=whsec_your_webhook_signing_secret",
        "STRIPE_PRICE_MONTHLY=price_monthly_id_here",
        "STRIPE_PRICE_YEARLY=price_1Year",
        "TRIAL_DURATION_MINUTES=10 # Optional: short trial for testing",
        "LIFETIME_DEAL_MAX_USERS=20",
      ].join("\n")
    );

    expect(env.billing.stripeSecretKey).toBe("sk_test_abc");
    expect(env.billing.stripePublishableKey).toBe("pk_test_abc");
    expect(env.billing.stripeWebhookSecret).toBe("");
    expect(env.billing.prices).toEqual({ monthly: "", yearly: "price_1Year", lifetime: "" });
    expect(env.billing.googleClientId).toBe("");
    expect(env.billing.trialMinutes).toBe(10);
    expect(env.billing.lifetimeMax).toBe(20);
  });

  it("prefers MemberFrame's own names when both are set", async () => {
    const env = await loadWith(["PLATFORM_STRIPE_SECRET_KEY=sk_test_ours", "STRIPE_SECRET_KEY=sk_test_beaf", "LIFETIME_MAX=5", "LIFETIME_DEAL_MAX_USERS=20"].join("\n"));
    expect(env.billing.stripeSecretKey).toBe("sk_test_ours");
    expect(env.billing.lifetimeMax).toBe(5);
  });
});
