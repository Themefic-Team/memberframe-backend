/**
 * Webhooks. Development doc: memberframe/docs/development-docs/20-webhooks.md
 *
 * The pure rules are tested directly. The worker and the queue run against a
 * mocked database and a fake endpoint, which also verifies the signature the
 * way a receiver would, from the documented formula.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  outboundWebhook: { findMany: vi.fn(), findFirst: vi.fn() },
  outboundDelivery: { createMany: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  member: { findFirst: vi.fn() },
  site: { findUnique: vi.fn() },
}));

vi.mock("../src/config/db.js", () => ({ prisma: db }));
vi.mock("../src/services/sessionService.js", () => ({
  loadTierLadder: vi.fn(async () => [
    { key: "free_member", rank: 0, name: "Free" },
    { key: "tier_gold", rank: 2, name: "Gold" },
  ]),
}));

import {
  MAX_ATTEMPTS,
  fieldMapProblem,
  splitName,
  webhookBody,
  buildPayload,
  isPrivateAddress,
  nextAttemptAt,
  signWebhook,
  webhookUrlProblem,
  webhookWants,
} from "../src/lib/webhooks.js";
import { deliverDue, emitMemberEvent, sendWebhook } from "../src/services/webhookService.js";

const NOW = new Date("2026-10-17T10:00:00.000Z");
const MEMBER = {
  id: "m1",
  siteId: "s1",
  email: "jordan@example.com",
  name: "Jordan",
  status: "active",
  activeTier: "tier_gold",
  emailVerifiedAt: NOW,
  createdAt: NOW,
  metadata: { company: "Acme" },
};
const LADDER = [
  { key: "free_member", name: "Free" },
  { key: "tier_gold", name: "Gold" },
];

describe("signWebhook", () => {
  it("is the documented formula", () => {
    const expected = createHmac("sha256", "whsec_x").update("1700000000.{\"a\":1}").digest("hex");
    expect(signWebhook("whsec_x", '{"a":1}', 1700000000)).toBe(`t=1700000000,v1=${expected}`);
  });
});

describe("retries", () => {
  it("waits 1, 5, 30 minutes, then 2 and 6 hours, then gives up", () => {
    const minutes = (attempts: number) => (nextAttemptAt(attempts, NOW)!.getTime() - NOW.getTime()) / 60000;
    expect([1, 2, 3, 4, 5].map(minutes)).toEqual([1, 5, 30, 120, 360]);
    expect(nextAttemptAt(MAX_ATTEMPTS, NOW)).toBeNull();
  });
});

describe("buildPayload", () => {
  it("carries the member, plan names, profile, and the previous plan", () => {
    const payload = buildPayload({
      deliveryId: "d1",
      type: "member.tier_changed",
      now: NOW,
      site: { id: "s1", name: "Tabfolio" },
      member: MEMBER,
      ladder: LADDER,
      previousTier: "free_member",
    });

    expect(payload).toEqual({
      id: "d1",
      type: "member.tier_changed",
      createdAt: NOW.toISOString(),
      site: { id: "s1", name: "Tabfolio" },
      member: {
        id: "m1",
        email: "jordan@example.com",
        name: "Jordan",
        status: "active",
        tier: { key: "tier_gold", name: "Gold" },
        emailVerified: true,
        createdAt: NOW.toISOString(),
        profile: { company: "Acme" },
      },
      previousTier: { key: "free_member", name: "Free" },
    });
  });

  it("names a deleted tier by its key, and sends an empty profile for none", () => {
    const payload = buildPayload({
      deliveryId: "d1",
      type: "member.updated",
      now: NOW,
      site: { id: "s1", name: "S" },
      member: { ...MEMBER, activeTier: "gone", metadata: null },
      ladder: LADDER,
    });
    expect(payload.member.tier).toEqual({ key: "gone", name: "gone" });
    expect(payload.member.profile).toEqual({});
    expect("previousTier" in payload).toBe(false);
  });
});

describe("webhookWants", () => {
  const hook = (over: Partial<{ enabled: boolean; events: unknown; tiers: unknown }> = {}) => ({
    enabled: true,
    events: ["member.created", "member.tier_changed"],
    tiers: [],
    ...over,
  });

  it("takes the events it lists, for every plan when no plan is picked", () => {
    expect(webhookWants(hook(), "member.created", ["free_member"])).toBe(true);
    expect(webhookWants(hook(), "member.deleted", ["free_member"])).toBe(false);
  });

  it("limits to the picked plans, old or new", () => {
    const gold = hook({ tiers: ["tier_gold"] });
    expect(webhookWants(gold, "member.created", ["free_member"])).toBe(false);
    expect(webhookWants(gold, "member.tier_changed", ["free_member", "tier_gold"])).toBe(true);
  });

  it("takes nothing when switched off", () => {
    expect(webhookWants(hook({ enabled: false }), "member.created", ["free_member"])).toBe(false);
  });
});

describe("URL safety", () => {
  it("knows private, loopback, link-local, and mapped addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("requires https and a public host in production", () => {
    expect(webhookUrlProblem("https://hooks.zapier.com/x", true)).toBeNull();
    expect(webhookUrlProblem("http://hooks.zapier.com/x", true)).toMatch(/https/);
    expect(webhookUrlProblem("https://localhost/x", true)).toMatch(/not reachable/);
    expect(webhookUrlProblem("https://169.254.169.254/latest", true)).toMatch(/not reachable/);
    expect(webhookUrlProblem("https://user:pass@example.com", true)).toMatch(/credentials/);
    expect(webhookUrlProblem("ftp://example.com", true)).toMatch(/https/);
    expect(webhookUrlProblem("not a url", true)).toMatch(/web address/);
  });

  it("lets a developer use a local receiver outside production", () => {
    expect(webhookUrlProblem("http://localhost:8080/hook", false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function payload() {
  return buildPayload({ deliveryId: "d1", type: "member.created", now: NOW, site: { id: "s1", name: "S" }, member: MEMBER, ladder: LADDER });
}
const standardBody = () => payload() as unknown as Record<string, unknown>;

describe("sendWebhook", () => {
  it("posts JSON with headers a receiver can verify", async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response(null, { status: 204 });
    });

    const result = await sendWebhook("https://example.com/hook", "whsec_s", "member.created", "d1", standardBody(), fetchImpl as typeof fetch);

    expect(result).toEqual({ ok: true, status: 204, error: null });
    const { headers, body } = seen[0]!;
    expect(headers["X-MemberFrame-Event"]).toBe("member.created");
    expect(headers["X-MemberFrame-Delivery"]).toBe("d1");
    expect(JSON.parse(body).member.email).toBe("jordan@example.com");

    const [t, v1] = headers["X-MemberFrame-Signature"]!.split(",").map((part) => part.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "whsec_s").update(`${t}.${body}`).digest("hex"));
  });

  it("reports a non-2xx answer and a network failure", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await sendWebhook("https://example.com", "s", "member.created", "d1", standardBody(), down as typeof fetch)).toMatchObject({ ok: false, status: 503 });

    const offline = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await sendWebhook("https://example.com", "s", "member.created", "d1", standardBody(), offline as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});

describe("the queue and the worker", () => {
  beforeEach(() => {
    for (const table of Object.values(db)) for (const fn of Object.values(table)) fn.mockReset();
  });

  it("queues one delivery per webhook that wants the event", async () => {
    db.outboundWebhook.findMany.mockResolvedValue([
      { id: "w-all", enabled: true, events: ["member.created"], tiers: [] },
      { id: "w-gold", enabled: true, events: ["member.created"], tiers: ["tier_gold"] },
      { id: "w-free", enabled: true, events: ["member.created"], tiers: ["free_member"] },
      { id: "w-other", enabled: true, events: ["member.deleted"], tiers: [] },
    ]);
    db.site.findUnique.mockResolvedValue({ id: "s1", siteName: "Tabfolio" });
    db.outboundDelivery.createMany.mockResolvedValue({ count: 2 });
    db.outboundDelivery.findMany.mockResolvedValue([]);

    await emitMemberEvent("member.created", MEMBER);

    const rows = db.outboundDelivery.createMany.mock.calls[0]![0].data as Array<{ webhookId: string; id: string; payload: { id: string; type: string } }>;
    expect(rows.map((row) => row.webhookId)).toEqual(["w-all", "w-gold"]);
    expect(rows[0]!.payload.id).toBe(rows[0]!.id);
    expect(rows[0]!.payload.type).toBe("member.created");
  });

  it("does nothing, quietly, for a site with no webhooks or a failing database", async () => {
    db.outboundWebhook.findMany.mockResolvedValue([]);
    await emitMemberEvent("member.created", MEMBER);
    expect(db.outboundDelivery.createMany).not.toHaveBeenCalled();

    db.outboundWebhook.findMany.mockRejectedValue(new Error("db down"));
    await expect(emitMemberEvent("member.created", MEMBER)).resolves.toBeUndefined();
  });

  it("marks a 2xx delivered, and schedules a retry for a failure", async () => {
    const due = (id: string, attempts: number) => ({
      id,
      attempts,
      event: "member.created",
      payload: payload(),
      webhook: { url: "https://example.com", secret: "s" },
    });
    db.outboundDelivery.findMany.mockResolvedValueOnce([due("ok", 0), due("bad", 0), due("last", MAX_ATTEMPTS - 1)]);
    db.outboundDelivery.update.mockResolvedValue({});

    const fetchImpl = vi.fn(async (url: string) => new Response(null, { status: url === "https://example.com" && fetchImpl.mock.calls.length === 1 ? 200 : 500 }));
    await deliverDue(fetchImpl as unknown as typeof fetch);

    const updates = db.outboundDelivery.update.mock.calls.map((call) => call[0] as { where: { id: string }; data: { status: string; nextAttemptAt: Date | null; attempts: number } });
    expect(updates.find((u) => u.where.id === "ok")!.data.status).toBe("delivered");
    const bad = updates.find((u) => u.where.id === "bad")!.data;
    expect(bad.status).toBe("pending");
    expect(bad.attempts).toBe(1);
    expect(bad.nextAttemptAt).toBeInstanceOf(Date);
    expect(updates.find((u) => u.where.id === "last")!.data.status).toBe("failed");
  });
});

describe("field mapping", () => {
  const tierChange = () =>
    buildPayload({
      deliveryId: "d9",
      type: "member.tier_changed",
      now: NOW,
      site: { id: "s1", name: "Tabfolio" },
      member: { ...MEMBER, name: "Jordan Lee Okafor", metadata: { company: "Acme", phone: "+880" } },
      ladder: LADDER,
      previousTier: "free_member",
    });

  it("sends the chosen values under the creator's own keys, and nothing else", () => {
    const sent = webhookBody(tierChange(), [
      { source: "member.email", key: "Email" },
      { source: "member.firstName", key: "First_Name" },
      { source: "member.lastName", key: "Last_Name" },
      { source: "member.tier.name", key: "Membership_Plan" },
      { source: "previousTier.name", key: "Old_Plan" },
      { source: "profile.company", key: "Account_Name" },
      { source: "event.type", key: "mf.event" },
    ]);
    expect(sent).toEqual({
      Email: "jordan@example.com",
      First_Name: "Jordan Lee",
      Last_Name: "Okafor",
      Membership_Plan: "Gold",
      Old_Plan: "Free",
      Account_Name: "Acme",
      "mf.event": "member.tier_changed",
    });
  });

  it("sends null for a value this event does not have", () => {
    const created = buildPayload({ deliveryId: "d", type: "member.created", now: NOW, site: { id: "s", name: "S" }, member: MEMBER, ladder: LADDER });
    expect(webhookBody(created, [{ source: "previousTier.key", key: "Old" }, { source: "profile.missing", key: "X" }])).toEqual({ Old: null, X: null });
  });

  it("sends the standard payload with no mapping", () => {
    expect(webhookBody(tierChange(), null)).toEqual(tierChange());
    expect(webhookBody(tierChange(), [])).toEqual(tierChange());
  });

  it("always has a last name, which Zoho CRM requires", () => {
    expect(splitName("Jordan", "j@x.com")).toEqual({ first: null, last: "Jordan" });
    expect(splitName(null, "jordan.o@x.com")).toEqual({ first: null, last: "jordan.o" });
    expect(splitName("  Ana  Maria  Silva ", "a@x.com")).toEqual({ first: "Ana Maria", last: "Silva" });
  });

  it("refuses unknown values, bad keys, and a key used twice", () => {
    expect(fieldMapProblem([{ source: "member.email", key: "Email" }])).toBeNull();
    expect(fieldMapProblem([{ source: "member.password", key: "P" }])).toMatch(/Unknown/);
    expect(fieldMapProblem([{ source: "member.email", key: "has space" }])).toMatch(/cannot be a key/);
    expect(fieldMapProblem([{ source: "member.email", key: "1st" }])).toMatch(/cannot be a key/);
    expect(fieldMapProblem([{ source: "member.email", key: "E" }, { source: "member.name", key: "E" }])).toMatch(/twice/);
  });
});
