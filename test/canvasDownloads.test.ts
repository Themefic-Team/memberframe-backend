/**
 * Protected downloads uploaded on the canvas (32-canvas-downloads.md): the
 * same access rules as page and section locks, and a shared password that
 * needs no account. The service runs against an in-memory table.
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string; siteId: string };
const assets = new Map<string, Row>();
const TIER_KEYS = ["free_member", "tier_silver", "tier_gold"];
const MEMBER = { memberId: "mem_1", activeTier: "tier_silver", status: "active", currentPeriodEnd: 0, gracePeriodEndsAt: 0 };
const TIERS = [
  { key: "free_member", rank: 0, name: "Free" },
  { key: "tier_silver", rank: 1, name: "Silver" },
  { key: "tier_gold", rank: 2, name: "Gold" },
];

vi.mock("../src/config/db.js", () => ({
  prisma: {
    asset: {
      count: vi.fn(async () => assets.size),
      findFirst: vi.fn(async ({ where }: { where: { id: string; siteId: string } }) => {
        const row = assets.get(where.id);
        return row && row.siteId === where.siteId ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { passwordHash: null, downloadCount: 0, lastDownloadAt: null, storageKey: null, createdAt: new Date(), ...data };
        assets.set(data.id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = assets.get(where.id)!;
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
          else row[key] = value;
        }
        return { ...row };
      }),
    },
    tier: {
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((key) => TIER_KEYS.includes(key)).map((key) => ({ key }))),
    },
    member: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === MEMBER.memberId ? { id: MEMBER.memberId } : null)),
    },
  },
}));
vi.mock("../src/services/sessionService.js", () => ({ loadTierLadder: vi.fn(async () => TIERS) }));
vi.mock("../src/services/assets/remoteUrl.js", () => {
  class RemoteUrlError extends Error {}
  return {
    RemoteUrlError,
    checkRemoteUrlShape: (value: string) => value,
    assertPublicUrl: async () => {
      throw new RemoteUrlError("offline in tests");
    },
  };
});
vi.mock("../src/services/assets/storage.js", () => ({
  StorageError: class extends Error {},
  putFile: vi.fn(),
  removeFile: vi.fn(),
  openFile: vi.fn(async () => ({ stream: Readable.from(["file"]), sizeBytes: 4 })),
}));

const service = await import("../src/services/assets/assetService.js");
const { createLinkToken } = await import("../src/services/assets/downloadLink.js");

const SITE = "site_1";
const FILE_URL = "https://framerusercontent.com/assets/AbCdEf123.zip";
const member = { member: MEMBER as never, tiers: TIERS };

/** The token inside a signed link. */
const tokenOf = (signedUrl: string) => signedUrl.split("/api/assets/download/")[1]!;

async function rejection(promise: Promise<unknown>): Promise<{ status?: number; reason?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; reason?: string };
  }
  throw new Error("expected a rejection");
}

beforeEach(() => assets.clear());

describe("the access rules, the same as the locks", () => {
  it("accepts any paid plan, a tier, exact tiers, and a password; refuses a tier the site does not have", async () => {
    const paid = await service.createLinkedAsset(SITE, { name: "Kit", url: FILE_URL, requiredTier: "any_paid" });
    expect(paid.requiredTier).toBe("any_paid");
    const exact = await service.createLinkedAsset(SITE, { name: "Kit", url: FILE_URL, requiredTier: "only:tier_gold, tier_silver,tier_gold" });
    expect(exact.requiredTier).toBe("only:tier_gold,tier_silver");
    expect((await rejection(service.createLinkedAsset(SITE, { name: "Kit", url: FILE_URL, requiredTier: "only:tier_gold,tier_nope" }))).reason).toBe("unknown_tier");
    expect((await rejection(service.createLinkedAsset(SITE, { name: "Kit", url: FILE_URL, requiredTier: "tier_nope" }))).reason).toBe("unknown_tier");
  });

  it("names exact tiers for the button's note", async () => {
    const exact = await service.createLinkedAsset(SITE, { name: "Kit", url: FILE_URL, requiredTier: "only:tier_silver,tier_gold" });
    const shown = await service.publicAsset(SITE, exact.id, member);
    expect(shown.asset.requiredTierName).toBe("Silver or Gold");
    expect(shown.access).toBe("granted");
  });
});

describe("a password file", () => {
  it("stores a hash, never the password, and needs one to be created", async () => {
    expect((await rejection(service.createLinkedAsset(SITE, { name: "Deck", url: FILE_URL, requiredTier: "password" }))).reason).toBe("password_required");
    const asset = await service.createLinkedAsset(SITE, { name: "Deck", url: FILE_URL, requiredTier: "password", password: "open-sesame" });
    expect(asset.hasPassword).toBe(true);
    const row = assets.get(asset.id)!;
    expect(String(row["passwordHash"])).toMatch(/^scrypt\$/);
    expect(Object.values(row).map(String).join(" ")).not.toContain("open-sesame");
    expect(JSON.stringify(asset)).not.toMatch(/scrypt|open-sesame/);
  });

  it("asks everyone for the password, member or not", async () => {
    const asset = await service.createLinkedAsset(SITE, { name: "Deck", url: FILE_URL, requiredTier: "password", password: "open-sesame" });
    expect((await service.publicAsset(SITE, asset.id, null)).access).toBe("password");
    expect((await service.publicAsset(SITE, asset.id, member)).access).toBe("password");
    expect((await service.publicAsset(SITE, asset.id, null)).asset.requiredTierName).toBe("Password");
  });

  it("signs a link for the right password with no account, and refuses a wrong or missing one", async () => {
    const asset = await service.createLinkedAsset(SITE, { name: "Deck", url: FILE_URL, requiredTier: "password", password: "open-sesame" });
    expect((await rejection(service.signDownload(SITE, asset.id, null, "https://api.test", "wrong-one"))).reason).toBe("invalid_password");
    expect((await rejection(service.signDownload(SITE, asset.id, null, "https://api.test"))).reason).toBe("invalid_password");
    const signed = await service.signDownload(SITE, asset.id, null, "https://api.test", "open-sesame");
    expect(signed.signedUrl).toMatch(/^https:\/\/api\.test\/api\/assets\/download\//);
    // The link names neither the password nor the Framer address.
    expect(signed.signedUrl).not.toContain("open-sesame");
    expect(signed.signedUrl).not.toContain("framerusercontent");
  });

  it("opens with its link, and a new password kills the older links", async () => {
    const asset = await service.createLinkedAsset(SITE, { name: "Deck", url: FILE_URL, requiredTier: "password", password: "open-sesame" });
    // Served from storage here, so the test needs no network.
    Object.assign(assets.get(asset.id)!, { source: "upload", storageKey: "local:x" });
    const token = tokenOf((await service.signDownload(SITE, asset.id, null, "https://api.test", "open-sesame")).signedUrl);
    expect((await service.openDownload(token)).ok).toBe(true);

    await service.updateAsset(SITE, asset.id, { password: "new-secret" });
    expect(await service.openDownload(token)).toMatchObject({ ok: false, status: 404 });
    // A forged password grant fails too.
    const forged = createLinkToken({ assetId: asset.id, siteId: SITE, memberId: "pw:0000000000000000", expiresAt: Math.floor(Date.now() / 1000) + 60 });
    expect((await service.openDownload(forged)).ok).toBe(false);
  });

  it("drops the password when the file goes back to members", async () => {
    const asset = await service.createLinkedAsset(SITE, { name: "Deck", url: FILE_URL, requiredTier: "password", password: "open-sesame" });
    const updated = await service.updateAsset(SITE, asset.id, { requiredTier: "signed_in" });
    expect(updated.hasPassword).toBe(false);
    expect(assets.get(asset.id)!["passwordHash"]).toBeNull();
    expect((await rejection(service.signDownload(SITE, asset.id, null, "https://api.test", "open-sesame"))).reason).toBe("unauthenticated");
  });
});

describe("a members file, as before", () => {
  it("asks a visitor to sign in, refuses a member below it, and signs for one with access", async () => {
    const gold = await service.createLinkedAsset(SITE, { name: "Kit", url: FILE_URL, requiredTier: "tier_gold" });
    expect((await rejection(service.signDownload(SITE, gold.id, null, "https://api.test"))).reason).toBe("unauthenticated");
    expect((await rejection(service.signDownload(SITE, gold.id, member, "https://api.test"))).reason).toBe("tier_upgrade_required");
    const silver = await service.createLinkedAsset(SITE, { name: "Kit", url: FILE_URL, requiredTier: "only:tier_silver" });
    const signed = await service.signDownload(SITE, silver.id, member, "https://api.test");
    Object.assign(assets.get(silver.id)!, { source: "upload", storageKey: "local:x" });
    expect((await service.openDownload(tokenOf(signed.signedUrl))).ok).toBe(true);
  });

  it("still answers 401 before 404 for a visitor asking about an unknown file", async () => {
    expect((await rejection(service.signDownload(SITE, "ast_aaaaaaaaaaaaaaaaaaaa", null, "https://api.test"))).reason).toBe("unauthenticated");
  });
});
