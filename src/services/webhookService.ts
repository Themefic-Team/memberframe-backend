/**
 * Webhooks: queue member events and deliver them. Development doc:
 * memberframe/docs/development-docs/20-webhooks.md
 *
 * Nothing here ever throws into the request that caused an event. A member's
 * sign up must not fail, or wait, because a creator's CRM is slow or down, so
 * an event writes delivery rows and returns, and the worker posts them.
 */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { loadTierLadder } from "./sessionService.js";
import {
  WEBHOOK_TIMEOUT_MS,
  buildPayload,
  isPrivateAddress,
  nextAttemptAt,
  signWebhook,
  webhookBody,
  webhookUrlProblem,
  webhookWants,
  type DeliveryEvent,
  type WebhookEvent,
} from "../lib/webhooks.js";

/** The member fields a payload is built from. */
export interface MemberSnapshot {
  id: string;
  siteId: string;
  email: string;
  name: string | null;
  status: string;
  activeTier: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  metadata: unknown;
}

export const MEMBER_SNAPSHOT_SELECT = {
  id: true,
  siteId: true,
  email: true,
  name: true,
  status: true,
  activeTier: true,
  emailVerifiedAt: true,
  createdAt: true,
  metadata: true,
} as const;

function log(message: string): void {
  process.stderr.write(`[webhooks] ${message}\n`);
}

// ============================================================================
// EMITTING
// ============================================================================

/**
 * Queue an event for every enabled webhook of the site that wants it.
 *
 * Pass the member as a snapshot when the row is about to disappear (a
 * delete), or its id otherwise. Fire and forget: `void emitMemberEvent(...)`.
 */
export async function emitMemberEvent(
  event: WebhookEvent,
  member: MemberSnapshot | { id: string; siteId: string },
  options: { previousTier?: string } = {}
): Promise<void> {
  try {
    const hooks = await prisma.outboundWebhook.findMany({
      where: { siteId: member.siteId, enabled: true },
      select: { id: true, enabled: true, events: true, tiers: true, fieldMap: true },
    });
    if (hooks.length === 0) return;

    const snapshot: MemberSnapshot | null =
      "email" in member
        ? member
        : await prisma.member.findFirst({ where: { id: member.id, siteId: member.siteId }, select: MEMBER_SNAPSHOT_SELECT });
    if (!snapshot) return;

    const tierKeys = [snapshot.activeTier, ...(options.previousTier !== undefined ? [options.previousTier] : [])];
    const wanted = hooks.filter((hook) => webhookWants(hook, event, tierKeys));
    if (wanted.length === 0) return;

    const [site, ladder] = await Promise.all([
      prisma.site.findUnique({ where: { id: snapshot.siteId }, select: { id: true, siteName: true } }),
      loadTierLadder(snapshot.siteId),
    ]);
    if (!site) return;

    const now = new Date();
    await prisma.outboundDelivery.createMany({
      data: wanted.map((hook) => {
        const id = randomUUID();
        const payload = buildPayload({
          deliveryId: id,
          type: event,
          now,
          site: { id: site.id, name: site.siteName },
          member: snapshot,
          ladder,
          ...(options.previousTier !== undefined ? { previousTier: options.previousTier } : {}),
        });
        return {
          id,
          webhookId: hook.id,
          siteId: snapshot.siteId,
          event,
          // The body as this webhook sends it: standard, or its own fields.
          payload: webhookBody(payload, hook.fieldMap) as Prisma.InputJsonObject,
          status: "pending",
          nextAttemptAt: now,
        };
      }),
    });

    kickDeliveries();
  } catch (error) {
    log(`could not queue ${event}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// DELIVERING
// ============================================================================

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/**
 * Post one payload. In production the host is resolved first and refused if
 * any address is private: the URL was checked when saved, but DNS can point
 * it somewhere else afterwards.
 */
export async function sendWebhook(
  url: string,
  secret: string,
  event: DeliveryEvent,
  deliveryId: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<SendResult> {
  const shape = webhookUrlProblem(url, env.isProduction);
  if (shape) return { ok: false, status: null, error: shape };

  if (env.isProduction) {
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      const addresses = await lookup(host, { all: true });
      if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
        return { ok: false, status: null, error: "That address is not reachable from the internet." };
      }
    } catch {
      return { ok: false, status: null, error: "The address could not be found." };
    }
  }

  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "MemberFrame-Webhooks/1.0",
        "X-MemberFrame-Event": event,
        "X-MemberFrame-Delivery": deliveryId,
        "X-MemberFrame-Signature": signWebhook(secret, body, Math.floor(Date.now() / 1000)),
      },
      body,
    });
    // 2xx, and 3xx too (2026-10-25): a redirect after a POST means the service
    // took the request (beta.crmfic.com stored the member and answered 302).
    // Counting it failed retried for hours and could store the member again.
    // The redirect itself is not followed: that would send the data twice.
    const ok = response.status >= 200 && response.status < 400;
    return { ok, status: response.status, error: ok ? null : `The service answered ${response.status}.` };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: null,
      error: aborted ? "No answer within 10 seconds." : `Could not connect: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Record one attempt's result on the delivery row. */
async function recordAttempt(delivery: { id: string; attempts: number }, result: SendResult, now: Date): Promise<void> {
  const attempts = delivery.attempts + 1;
  const retryAt = result.ok ? null : nextAttemptAt(attempts, now);

  await prisma.outboundDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts,
      lastStatus: result.status,
      lastError: result.error,
      status: result.ok ? "delivered" : retryAt ? "pending" : "failed",
      nextAttemptAt: retryAt,
      deliveredAt: result.ok ? now : null,
    },
  });
}

let running = false;
let again = false;

/** Deliver everything due. One run at a time; a call during a run schedules one more. */
export async function deliverDue(fetchImpl: typeof fetch = fetch): Promise<number> {
  if (running) {
    again = true;
    return 0;
  }
  running = true;
  let sent = 0;

  try {
    do {
      again = false;
      const due = await prisma.outboundDelivery.findMany({
        where: { status: "pending", nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: "asc" },
        take: 25,
        include: { webhook: { select: { url: true, secret: true } } },
      });

      for (const delivery of due) {
        const result = await sendWebhook(
          delivery.webhook.url,
          delivery.webhook.secret,
          delivery.event as DeliveryEvent,
          delivery.id,
          delivery.payload as Record<string, unknown>,
          fetchImpl
        );
        await recordAttempt(delivery, result, new Date());
        sent++;
      }

      if (due.length === 25) again = true;
    } while (again);
  } catch (error) {
    log(`delivery run failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
  }

  return sent;
}

/** Start a delivery run soon, without waiting for it. */
export function kickDeliveries(): void {
  setTimeout(() => void deliverDue(), 0);
}

// ============================================================================
// TEST
// ============================================================================

/**
 * Send a sample event now and answer with the result, for the plugin's Send
 * test. The member is made up: a test should not copy a real member's data
 * into a service the creator is still setting up.
 */
export async function sendTestEvent(webhookId: string, siteId: string): Promise<SendResult | null> {
  const hook = await prisma.outboundWebhook.findFirst({
    where: { id: webhookId, siteId },
    select: { id: true, url: true, secret: true, fieldMap: true, site: { select: { id: true, siteName: true } } },
  });
  if (!hook) return null;

  const now = new Date();
  const id = randomUUID();
  const ladder = await loadTierLadder(siteId);
  const tier = ladder[ladder.length - 1]?.key ?? "free_member";
  const payload = buildPayload({
    deliveryId: id,
    type: "webhook.test",
    now,
    site: { id: hook.site.id, name: hook.site.siteName },
    member: {
      id: "00000000-0000-7000-8000-000000000000",
      email: "jordan@example.com",
      name: "Jordan Okafor",
      status: "active",
      activeTier: tier,
      emailVerifiedAt: now,
      createdAt: now,
      metadata: { company: "Acme Design Co" },
    },
    ladder,
  });

  const body = webhookBody(payload, hook.fieldMap);
  const delivery = await prisma.outboundDelivery.create({
    data: {
      id,
      webhookId: hook.id,
      siteId,
      event: "webhook.test",
      payload: body as Prisma.InputJsonObject,
      status: "pending",
      nextAttemptAt: null,
    },
    select: { id: true, attempts: true },
  });

  const result = await sendWebhook(hook.url, hook.secret, "webhook.test", id, body);
  // A test is one attempt: it is never retried, so a failure is final.
  await prisma.outboundDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: 1,
      lastStatus: result.status,
      lastError: result.error,
      status: result.ok ? "delivered" : "failed",
      nextAttemptAt: null,
      deliveredAt: result.ok ? now : null,
    },
  });
  return result;
}
