/**
 * `npm run stripe:prices` (add `-- --write` to put the ids in .env)
 *
 * Creates MemberFrame's three plan prices in the Stripe account behind
 * STRIPE_SECRET_KEY (or PLATFORM_STRIPE_SECRET_KEY) and prints their ids.
 * The prices are the BEAF ones, the Framefic standard: Pro Monthly $4.99,
 * Pro Yearly $49.99, Lifetime Deal $99.99 once.
 *
 * Safe to run again: each price has a lookup key, so a second run finds the
 * prices it made instead of making more. Test keys only, unless `--live`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../src/config/env.js";
import { asRecord, asString, platformStripe } from "../src/lib/stripeRest.js";

const PLANS = [
  { plan: "monthly", env: "STRIPE_PRICE_MONTHLY", lookupKey: "memberframe_pro_monthly", amount: 499, interval: "month", nickname: "Pro Monthly" },
  { plan: "yearly", env: "STRIPE_PRICE_YEARLY", lookupKey: "memberframe_pro_yearly", amount: 4999, interval: "year", nickname: "Pro Yearly" },
  { plan: "lifetime", env: "STRIPE_PRICE_LIFETIME", lookupKey: "memberframe_lifetime", amount: 9999, interval: null, nickname: "Lifetime Deal" },
] as const;

const PRODUCT_NAME = "MemberFrame Pro";

async function findOrCreateProduct(): Promise<string> {
  const list = await platformStripe("GET", "/products", { active: "true", limit: 100 });
  const existing = (Array.isArray(list["data"]) ? list["data"] : [])
    .map(asRecord)
    .find((product) => asRecord(product["metadata"])["app"] === "memberframe");
  if (existing) return asString(existing["id"])!;

  const created = await platformStripe("POST", "/products", {
    name: PRODUCT_NAME,
    description: "MemberFrame plugin for Framer: every membership feature, no watermark.",
    metadata: { app: "memberframe" },
  });
  return asString(created["id"])!;
}

async function findOrCreatePrice(product: string, plan: (typeof PLANS)[number]): Promise<{ id: string; created: boolean }> {
  const found = await platformStripe("GET", "/prices", { lookup_keys: [plan.lookupKey], active: "true", limit: 1 });
  const hit = (Array.isArray(found["data"]) ? found["data"] : []).map(asRecord)[0];
  if (hit) return { id: asString(hit["id"])!, created: false };

  const price = await platformStripe("POST", "/prices", {
    product,
    currency: "usd",
    unit_amount: plan.amount,
    nickname: plan.nickname,
    lookup_key: plan.lookupKey,
    metadata: { app: "memberframe", plan: plan.plan },
    ...(plan.interval ? { recurring: { interval: plan.interval } } : {}),
  });
  return { id: asString(price["id"])!, created: true };
}

/** Put each id on its line in .env: our PLATFORM_ name if the file uses it, else BEAF's STRIPE_ name. */
function writeEnv(ids: Record<string, string>): void {
  const file = path.join(process.cwd(), ".env");
  let text = readFileSync(file, "utf8");
  for (const plan of PLANS) {
    const ours = plan.env.replace("STRIPE_PRICE_", "PLATFORM_PRICE_");
    const key = new RegExp(`^${ours}=`, "m").test(text) ? ours : plan.env;
    const line = `${key}=${ids[plan.plan]}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(file, text);
}

async function main(): Promise<void> {
  const key = env.billing.stripeSecretKey;
  if (!key) {
    process.stderr.write("\n  No Stripe key. Set STRIPE_SECRET_KEY (or PLATFORM_STRIPE_SECRET_KEY) in .env first.\n\n");
    process.exit(1);
  }
  const live = key.startsWith("sk_live_") || key.startsWith("rk_live_");
  if (live && !process.argv.includes("--live")) {
    process.stderr.write("\n  That is a live Stripe key. Run with -- --live to create real prices.\n\n");
    process.exit(1);
  }

  process.stdout.write(`\n  MemberFrame plan prices, Stripe ${live ? "LIVE" : "test"} mode\n\n`);
  const product = await findOrCreateProduct();
  const ids: Record<string, string> = {};
  for (const plan of PLANS) {
    const price = await findOrCreatePrice(product, plan);
    ids[plan.plan] = price.id;
    process.stdout.write(`  ${price.created ? "created " : "found   "} ${plan.nickname.padEnd(14)} ${price.id}\n`);
  }

  process.stdout.write("\n  For .env:\n\n");
  for (const plan of PLANS) process.stdout.write(`  ${plan.env}=${ids[plan.plan]}\n`);

  if (process.argv.includes("--write")) {
    writeEnv(ids);
    process.stdout.write("\n  Written to .env. Restart the backend to use them.\n\n");
  } else {
    process.stdout.write("\n  Run with -- --write to put them in .env.\n\n");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  Stripe said: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
