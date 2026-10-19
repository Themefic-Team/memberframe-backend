/**
 * F19: the platform webhook, the hourly job, and the server block.
 * Development doc: 19-pro-lock-and-trial.md.
 *
 * Stripe and the billing service are mocked: what is pinned is what this
 * code does with an event (once, and only for MemberFrame's plans) and which
 * emails go out (once each).
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  pluginTrial: { findMany: vi.fn(async (_query: any): Promise<unknown[]> => []), updateMany: vi.fn() },
  pluginSubscription: { findMany: vi.fn(async (_query: any): Promise<unknown[]> => []), updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  platformWebhookEvent: { findUnique: vi.fn(), create: vi.fn(async () => ({})) },
  user: { findUnique: vi.fn(async () => ({ email: "creator@example.com" })) },
  site: { findUnique: vi.fn(async () => ({ siteName: "Portfolio", user: { email: "creator@example.com", name: "Creator" } })) },
}));
vi.mock("../src/config/db.js", () => ({ prisma: db }));

const mail = vi.hoisted(() => ({ sendMail: vi.fn(async (_mail: { template: string }) => ({ sent: true, messageId: null })) }));
vi.mock("../src/lib/mailer.js", () => ({ sendMail: mail.sendMail }));

const billing = vi.hoisted(() => ({ syncSubscription: vi.fn(), recordPayment: vi.fn(), recordLifetime: vi.fn() }));
vi.mock("../src/services/license/billingService.js", () => billing);

const license = vi.hoisted(() => ({ siteLicense: vi.fn(), invalidateLicense: vi.fn() }));
vi.mock("../src/services/license/licenseService.js", () => license);

import { env } from "../src/config/env.js";
import { handlePlatformWebhook, processPlatformEvent } from "../src/services/license/platformWebhook.js";
import { runLicenseJob } from "../src/services/license/licenseJobs.js";
import { requireActiveLicense } from "../src/middleware/license.js";

const NOW = new Date("2026-10-18T12:00:00Z");
const DAY = 86_400_000;
const templates = () => mail.sendMail.mock.calls.map((call) => call[0].template);

beforeEach(() => {
  vi.clearAllMocks();
  db.pluginTrial.findMany.mockResolvedValue([]);
  db.pluginSubscription.findMany.mockResolvedValue([]);
});

describe("platform events", () => {
  const synced = { id: "row1", siteId: "site1", userId: "u1", plan: "yearly", previousStatus: "active", status: "active", currentPeriodEnd: new Date(NOW.getTime() + 365 * DAY) };

  it("records a paid invoice with its upgrade credit and sends one receipt", async () => {
    billing.syncSubscription.mockResolvedValue(synced);
    billing.recordPayment.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const event = {
      id: "evt_1",
      type: "invoice.paid",
      data: { object: { id: "in_1", subscription: "sub_1", billing_reason: "subscription_update", amount_paid: 4666, currency: "usd", lines: { data: [{ amount: -333 }, { amount: 4999 }] } } },
    };

    await processPlatformEvent(event);
    expect(billing.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ kind: "upgrade", amountMinor: 4666, creditMinor: 333, stripeInvoiceId: "in_1" }));
    expect(templates()).toEqual(["plugin_receipt_upgrade"]);

    // Delivered again: the payment row exists, so nothing is sent twice.
    await processPlatformEvent(event);
    expect(templates()).toEqual(["plugin_receipt_upgrade"]);
  });

  it("ignores events about other products on the same Stripe account", async () => {
    billing.syncSubscription.mockResolvedValue(null);
    await processPlatformEvent({ id: "evt_2", type: "invoice.paid", data: { object: { id: "in_2", subscription: "sub_other" } } });
    await processPlatformEvent({ id: "evt_3", type: "payment_intent.succeeded", data: { object: { metadata: { app: "beaf", plan: "lifetime" } } } });
    expect(billing.recordPayment).not.toHaveBeenCalled();
    expect(billing.recordLifetime).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("emails a cancellation once, when it is first scheduled", async () => {
    billing.syncSubscription.mockResolvedValue(synced);
    await processPlatformEvent({
      id: "evt_4",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", cancel_at_period_end: true }, previous_attributes: { cancel_at_period_end: false } },
    });
    await processPlatformEvent({ id: "evt_5", type: "customer.subscription.updated", data: { object: { id: "sub_1", cancel_at_period_end: true }, previous_attributes: {} } });
    expect(templates()).toEqual(["plugin_plan_canceled"]);
  });

  it("records a lifetime purchase from its payment", async () => {
    billing.recordLifetime.mockResolvedValue({ id: "row2", created: true });
    await processPlatformEvent({
      id: "evt_6",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1", amount: 9666, currency: "usd", metadata: { app: "memberframe", plan: "lifetime", site_id: "site1", user_id: "u1", credit_minor: "333", replaces_subscription: "sub_1" } } },
    });
    expect(billing.recordLifetime).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 9666, creditMinor: 333, replacesSubscription: "sub_1" }));
    expect(templates()).toEqual(["plugin_receipt_lifetime"]);
  });
});

describe("the webhook endpoint", () => {
  const SECRET = "whsec_test";
  const response = () => {
    const res = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    return res;
  };
  const request = (body: object, signature?: string) => {
    const raw = Buffer.from(JSON.stringify(body));
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", SECRET).update(`${t}.${raw.toString()}`).digest("hex");
    return { body: raw, header: () => signature ?? `t=${t},v1=${v1}` };
  };

  beforeEach(() => {
    (env.billing as { stripeWebhookSecret: string }).stripeWebhookSecret = SECRET;
  });

  it("refuses an unsigned or wrongly signed request", async () => {
    const res = response();
    await handlePlatformWebhook(request({ id: "evt_x", type: "invoice.paid" }, "t=1,v1=bad") as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it("processes an event once and answers a duplicate without processing it", async () => {
    db.platformWebhookEvent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "seen" });
    billing.syncSubscription.mockResolvedValue(null);

    const first = response();
    await handlePlatformWebhook(request({ id: "evt_7", type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } }) as never, first as never);
    expect(first.body).toEqual({ received: true });
    expect(db.platformWebhookEvent.create).toHaveBeenCalledTimes(1);

    const second = response();
    await handlePlatformWebhook(request({ id: "evt_7", type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } }) as never, second as never);
    expect(second.body).toEqual({ received: true, duplicate: true });
    expect(billing.syncSubscription).toHaveBeenCalledTimes(1);
  });
});

describe("the hourly job", () => {
  it("expires an ended trial and emails it once", async () => {
    db.pluginTrial.findMany.mockImplementation(async (query: { where: { endsAt?: { lte?: Date; gt?: Date } } }) =>
      query.where.endsAt?.gt ? [] : [{ id: "t1", siteId: "site1", email: "creator@example.com", projectName: "Portfolio" }]
    );
    db.pluginTrial.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect((await runLicenseJob(NOW)).trialsEnded).toBe(1);
    expect(license.invalidateLicense).toHaveBeenCalledWith("site1");
    expect(templates()).toEqual(["plugin_trial_ended"]);

    // A second server, or the next run: the claim fails, nothing is sent.
    expect((await runLicenseJob(NOW)).trialsEnded).toBe(0);
    expect(templates()).toEqual(["plugin_trial_ended"]);
  });

  it("reminds a yearly plan 7 days ahead and a monthly one only 3 days ahead", async () => {
    const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);
    db.pluginSubscription.findMany.mockImplementation(async (query: { where: { status?: string } }) =>
      query.where.status === "active"
        ? [
            { id: "y", siteId: "s", userId: "u", plan: "yearly", amountMinor: 4999, currency: "usd", currentPeriodEnd: inDays(5), renewalNotifiedFor: null },
            { id: "m", siteId: "s", userId: "u", plan: "monthly", amountMinor: 499, currency: "usd", currentPeriodEnd: inDays(5), renewalNotifiedFor: null },
            { id: "m2", siteId: "s", userId: "u", plan: "monthly", amountMinor: 499, currency: "usd", currentPeriodEnd: inDays(2), renewalNotifiedFor: inDays(2) },
          ]
        : []
    );
    db.pluginSubscription.updateMany.mockResolvedValue({ count: 1 });

    expect((await runLicenseJob(NOW)).renewalsWarned).toBe(1);
    expect(templates()).toEqual(["plugin_renewal_reminder"]);
  });
});

describe("the server block", () => {
  const run = async (licensed: boolean, enforce = true) => {
    (env.billing as { enforce: boolean }).enforce = enforce;
    license.siteLicense.mockResolvedValue({ licensed, state: licensed ? "active" : "expired" });
    const next = vi.fn();
    requireActiveLicense({ site: { id: "site1" } } as never, {} as never, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    return next.mock.calls[0]![0] as { status?: number; reason?: string } | undefined;
  };

  it("refuses an unlicensed site with 402 license_inactive", async () => {
    expect(await run(false)).toMatchObject({ status: 402, reason: "license_inactive" });
  });

  it("lets a licensed site through, and everything through when enforcement is off", async () => {
    expect(await run(true)).toBeUndefined();
    expect(await run(false, false)).toBeUndefined();
    (env.billing as { enforce: boolean }).enforce = false;
  });
});
