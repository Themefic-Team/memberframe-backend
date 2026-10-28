/**
 * F19: the trial's one-per-everything rule and the account hand-off.
 * Development doc: 19-pro-lock-and-trial.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The default trial, whatever a developer's .env sets for testing: a real
// environment variable wins over the file.
vi.hoisted(() => {
  process.env["TRIAL_DURATION_MINUTES"] = "0";
  process.env["TRIAL_DURATION_DAYS"] = "7";
});

const db = vi.hoisted(() => ({
  pluginTrial: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  creatorAuthHandoff: { findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
  creatorSession: { create: vi.fn(async () => ({})) },
  user: { findUnique: vi.fn() },
}));
vi.mock("../src/config/db.js", () => ({ prisma: db }));

import { startTrialIfEligible, trialDurationMs } from "../src/services/license/trialService.js";
import { claimHandoff, completeHandoff } from "../src/services/creatorHandoffService.js";
import { hashToken } from "../src/lib/tokens.js";

const NOW = new Date("2026-10-18T12:00:00Z");
const INPUT = { userId: "u1", email: "Me@Example.com", siteId: "site1" };

beforeEach(() => vi.clearAllMocks());

describe("starting a trial", () => {
  it("starts a 7-day trial bound to this project when nothing matches", async () => {
    db.pluginTrial.findFirst.mockResolvedValue(null);
    db.pluginTrial.create.mockResolvedValue({});

    const result = await startTrialIfEligible(INPUT, NOW);

    expect(trialDurationMs()).toBe(7 * 86_400_000);
    expect(result).toEqual({ started: true, endsAt: new Date(NOW.getTime() + 7 * 86_400_000) });
    const created = db.pluginTrial.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({ userId: "u1", email: "me@example.com", siteId: "site1", status: "trialing" });
    // Nothing read from Framer is stored (Marketplace review, 2026-10-28).
    expect(created.data).not.toHaveProperty("framerUserId");
    expect(created.data).not.toHaveProperty("framerProjectId");
    expect(created.data).not.toHaveProperty("projectName");
  });

  it("checks the account, the email, and the site", async () => {
    db.pluginTrial.findFirst.mockResolvedValue(null);
    db.pluginTrial.create.mockResolvedValue({});
    await startTrialIfEligible(INPUT, NOW);
    const where = (db.pluginTrial.findFirst.mock.calls[0]![0] as { where: { OR: unknown[] } }).where.OR;
    expect(where).toEqual([{ userId: "u1" }, { email: "me@example.com" }, { siteId: "site1" }]);
  });

  it("refuses with no fallback when any identifier already had one", async () => {
    // BEAF inserted a trial anyway after a failed check. Never here.
    db.pluginTrial.findFirst.mockResolvedValue({ userId: "other", email: "x@y.com" });
    expect(await startTrialIfEligible(INPUT, NOW)).toEqual({ started: false, reason: "site" });
    expect(db.pluginTrial.create).not.toHaveBeenCalled();
  });

  it("lets the unique index decide a race", async () => {
    db.pluginTrial.findFirst.mockResolvedValue(null);
    db.pluginTrial.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" }));
    expect(await startTrialIfEligible(INPUT, NOW)).toEqual({ started: false, reason: "account" });
  });
});

describe("the account hand-off", () => {
  const SESSION = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

  it("is stored by hash, never by the session id itself", async () => {
    db.creatorAuthHandoff.upsert.mockResolvedValue({});
    await completeHandoff(SESSION, "u1", NOW);
    const call = db.creatorAuthHandoff.upsert.mock.calls[0]![0] as { where: { sessionIdHash: string }; create: { expiresAt: Date } };
    expect(call.where.sessionIdHash).toBe(hashToken(SESSION));
    expect(JSON.stringify(call)).not.toContain(SESSION);
    expect(call.create.expiresAt).toEqual(new Date(NOW.getTime() + 600_000));
  });

  it("is pending until the creator signs in", async () => {
    db.creatorAuthHandoff.findUnique.mockResolvedValue(null);
    expect(await claimHandoff(SESSION, {}, NOW)).toBeNull();
  });

  it("gives a session token once, and never again", async () => {
    db.creatorAuthHandoff.findUnique.mockResolvedValue({ id: "h1", userId: "u1", expiresAt: new Date(NOW.getTime() + 60_000), consumedAt: null });
    db.creatorAuthHandoff.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    db.user.findUnique.mockResolvedValue({ email: "me@example.com", name: "Me", avatarUrl: null });

    const first = await claimHandoff(SESSION, {}, NOW);
    expect(first).toMatchObject({ creator: { email: "me@example.com" } });
    expect(first!.token.length).toBeGreaterThan(20);
    expect(db.creatorSession.create).toHaveBeenCalledTimes(1);

    // A second poll racing the first: the atomic spend refuses it.
    expect(await claimHandoff(SESSION, {}, NOW)).toBeNull();
    expect(db.creatorSession.create).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired or spent hand-off", async () => {
    db.creatorAuthHandoff.findUnique.mockResolvedValue({ id: "h1", userId: "u1", expiresAt: new Date(NOW.getTime() - 1), consumedAt: null });
    expect(await claimHandoff(SESSION, {}, NOW)).toBeNull();
    db.creatorAuthHandoff.findUnique.mockResolvedValue({ id: "h1", userId: "u1", expiresAt: new Date(NOW.getTime() + 60_000), consumedAt: NOW });
    expect(await claimHandoff(SESSION, {}, NOW)).toBeNull();
    expect(db.creatorSession.create).not.toHaveBeenCalled();
  });
});
