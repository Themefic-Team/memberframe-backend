/**
 * Events from MemberFrame's own Stripe account. F19, 19-pro-lock-and-trial.md.
 *
 * Mounted before the JSON parser: the signature is over the exact bytes. Each
 * event is processed once (`PlatformWebhookEvent`), and only events about a
 * MemberFrame plan are acted on, since one Stripe account may serve several
 * products (BEAF filtered the same way).
 *
 * BEAF's `invoice.paid` threw on first purchases and never marked them
 * processed; every branch here is covered by `test/pluginBilling.test.ts`.
 */

import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import { sendMail } from "../../lib/mailer.js";
import { verifyStripeSignature } from "../payments/stripe.js";
import { asNumber, asRecord, asString, type StripeObject } from "../../lib/stripeRest.js";
import { recordLifetime, recordPayment, syncSubscription } from "./billingService.js";
import {
  PLAN_LABELS,
  formatMoney,
  paymentFailedMail,
  planCanceledMail,
  planExpiredMail,
  planReceiptMail,
  teamNotice,
} from "./licenseMail.js";

const APP = "memberframe";

async function ownerOf(siteId: string): Promise<{ email: string; name: string; projectName: string; siteId: string } | null> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { siteName: true, user: { select: { email: true, name: true } } },
  });
  return site ? { email: site.user.email, name: site.user.name, projectName: site.siteName, siteId } : null;
}

function notifyTeam(notice: ReturnType<typeof teamNotice>): void {
  if (notice) void sendMail(notice);
}

const RECEIPT_KIND: Record<string, "initial" | "renewal" | "upgrade"> = {
  subscription_create: "initial",
  subscription_cycle: "renewal",
  subscription_update: "upgrade",
};

/** What one event does. Exported for the tests. */
export async function processPlatformEvent(event: StripeObject): Promise<void> {
  const type = asString(event["type"]) ?? "";
  const data = asRecord(asRecord(event["data"])["object"]);
  const previous = asRecord(asRecord(event["data"])["previous_attributes"]);

  if (type === "invoice.paid") {
    const subscriptionId = asString(data["subscription"]);
    if (!subscriptionId) return;
    const synced = await syncSubscription(subscriptionId);
    if (!synced) return;

    const kind = RECEIPT_KIND[asString(data["billing_reason"]) ?? ""] ?? "renewal";
    const lines = asRecord(data["lines"]);
    const credit = (Array.isArray(lines["data"]) ? lines["data"] : [])
      .map((line) => asNumber(asRecord(line)["amount"]) ?? 0)
      .filter((amount) => amount < 0)
      .reduce((sum, amount) => sum - amount, 0);
    const amountMinor = asNumber(data["amount_paid"]) ?? 0;
    const currency = asString(data["currency"]) ?? "usd";

    const fresh = await recordPayment({
      subscriptionId: synced.id,
      kind,
      amountMinor,
      creditMinor: credit,
      currency,
      stripeInvoiceId: asString(data["id"]),
      paidAt: new Date(),
    });
    if (!fresh) return;

    const owner = await ownerOf(synced.siteId);
    if (owner) {
      void sendMail(planReceiptMail(owner.email, { projectName: owner.projectName, plan: synced.plan, amountMinor, creditMinor: credit, currency, periodEnd: synced.currentPeriodEnd, kind }, owner.name));
      notifyTeam(
        teamNotice(kind === "renewal" ? "recurring" : kind === "upgrade" ? "upgrade" : "purchase", owner, {
          plan: synced.plan,
          amountMinor,
          currency,
          transactionId: asString(data["id"]),
          nextBillingDate: synced.currentPeriodEnd,
        })
      );
    }
    return;
  }

  if (type === "invoice.payment_failed") {
    const subscriptionId = asString(data["subscription"]);
    if (!subscriptionId) return;
    const synced = await syncSubscription(subscriptionId);
    if (!synced) return;
    const owner = await ownerOf(synced.siteId);
    if (owner) {
      void sendMail(paymentFailedMail(owner.email, { projectName: owner.projectName, plan: synced.plan }, owner.name));
      notifyTeam(
        teamNotice("payment_failed", owner, {
          plan: synced.plan,
          amountMinor: asNumber(data["amount_due"]) ?? 0,
          currency: asString(data["currency"]) ?? "usd",
          attempt: asNumber(data["attempt_count"]) ?? 1,
        })
      );
    }
    return;
  }

  if (type === "customer.subscription.updated" || type === "customer.subscription.created") {
    const id = asString(data["id"]);
    if (!id) return;
    const synced = await syncSubscription(id, data);
    if (!synced) return;
    // Cancelled at period end, here or in Stripe's portal: say so once.
    if (data["cancel_at_period_end"] === true && previous["cancel_at_period_end"] === false) {
      const owner = await ownerOf(synced.siteId);
      if (owner) {
        void sendMail(planCanceledMail(owner.email, { projectName: owner.projectName, plan: synced.plan, endsAt: synced.currentPeriodEnd }, owner.name));
        const reason = asString(asRecord(data["metadata"])["cancel_reason"]);
        notifyTeam(teamNotice("cancel", owner, { plan: synced.plan, effectiveDate: synced.currentPeriodEnd, feedback: reason }));
      }
    }
    return;
  }

  if (type === "customer.subscription.deleted") {
    const id = asString(data["id"]);
    if (!id) return;
    const synced = await syncSubscription(id, data);
    if (!synced) return;
    const row = await prisma.pluginSubscription.findUnique({ where: { id: synced.id }, select: { expiredNotifiedAt: true } });
    // An upgrade to lifetime ends the old plan on purpose and says nothing.
    if (row && !row.expiredNotifiedAt) {
      await prisma.pluginSubscription.update({ where: { id: synced.id }, data: { expiredNotifiedAt: new Date() } });
      const owner = await ownerOf(synced.siteId);
      if (owner) void sendMail(planExpiredMail(owner.email, { projectName: owner.projectName }, owner.name));
    }
    return;
  }

  if (type === "payment_intent.succeeded") {
    const metadata = asRecord(data["metadata"]);
    if (metadata["app"] !== APP || metadata["plan"] !== "lifetime") return;
    const siteId = asString(metadata["site_id"]);
    const userId = asString(metadata["user_id"]);
    if (!siteId || !userId) return;
    const amountMinor = asNumber(data["amount"]) ?? 0;
    const currency = asString(data["currency"]) ?? "usd";
    const creditMinor = Number(metadata["credit_minor"] ?? 0) || 0;
    const result = await recordLifetime({
      siteId,
      userId,
      amountMinor,
      creditMinor,
      currency,
      paymentIntentId: asString(data["id"]),
      replacesSubscription: asString(metadata["replaces_subscription"]),
    });
    if (!result.created) return;
    const owner = await ownerOf(siteId);
    if (owner) {
      void sendMail(planReceiptMail(owner.email, { projectName: owner.projectName, plan: "lifetime", amountMinor, creditMinor, currency, periodEnd: null, kind: "lifetime" }, owner.name));
      notifyTeam(
        teamNotice(creditMinor > 0 ? "upgrade" : "purchase", owner, {
          plan: "lifetime",
          amountMinor,
          currency,
          transactionId: asString(data["id"]),
          coupon: asString(metadata["promotion_code"]),
        })
      );
    }
  }
}

/** POST /api/webhooks/platform/stripe */
export async function handlePlatformWebhook(req: Request, res: Response): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const secrets = [env.billing.stripeWebhookSecret, env.isProduction ? "" : env.payments.stripeCliWebhookSecret];
  if (!verifyStripeSignature(raw, req.header("stripe-signature"), secrets)) {
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  let event: StripeObject;
  try {
    event = asRecord(JSON.parse(raw.toString("utf8")));
  } catch {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const eventId = asString(event["id"]);
  if (!eventId) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  if (await prisma.platformWebhookEvent.findUnique({ where: { stripeEventId: eventId }, select: { id: true } })) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    await processPlatformEvent(event);
  } catch (error) {
    // Not recorded, so Stripe's retry processes it again.
    process.stderr.write(`[billing] ${String(event["type"])} ${eventId} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    res.status(500).json({ error: "processing_failed" });
    return;
  }

  try {
    await prisma.platformWebhookEvent.create({ data: { stripeEventId: eventId, type: String(event["type"] ?? "").slice(0, 80) } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
  res.json({ received: true });
}
