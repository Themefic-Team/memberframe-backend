/**
 * A project becomes a site by the site's own id, and nothing read from Framer
 * is stored (Marketplace review, 2026-10-28, memberframe/docs/development-docs/
 * 35-marketplace-review-report.md).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  site: { create: vi.fn() },
  tier: { create: vi.fn(async () => ({})) },
  siteSettings: { create: vi.fn(async () => ({})) },
}));
const db = vi.hoisted(() => ({
  site: { findUnique: vi.fn() },
  $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
}));
vi.mock("../src/config/db.js", () => ({ prisma: db }));

import { attachProject } from "../src/services/creatorAuthService.js";

const OWN = { id: "site1", userId: "u1", siteKey: "mf_site_1", siteName: "Older name", allowedOrigins: ["https://acme.com"] };

beforeEach(() => {
  vi.clearAllMocks();
  tx.site.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "new-site",
    siteKey: data["siteKey"],
    siteName: data["siteName"],
    allowedOrigins: data["allowedOrigins"],
  }));
});

describe("attachProject", () => {
  it("returns the creator's own site, untouched, for its id", async () => {
    db.site.findUnique.mockResolvedValue(OWN);

    const site = await attachProject("u1", { siteId: "site1" });

    expect(site).toEqual({ siteId: "site1", siteKey: "mf_site_1", siteName: "Older name", allowedOrigins: ["https://acme.com"] });
    expect(db.site.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "site1" } }));
    expect(tx.site.create).not.toHaveBeenCalled();
  });

  it("refuses a site that belongs to another account", async () => {
    db.site.findUnique.mockResolvedValue({ ...OWN, userId: "someone-else" });

    await expect(attachProject("u1", { siteId: "site1" })).rejects.toMatchObject({ status: 403, reason: "project_claimed_by_another_account" });
    expect(tx.site.create).not.toHaveBeenCalled();
  });

  it("creates a site with no name and no domains when there is no id", async () => {
    const site = await attachProject("u1", {});

    expect(db.site.findUnique).not.toHaveBeenCalled();
    const data = (tx.site.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ userId: "u1", siteName: null, allowedOrigins: [] });
    expect(data).not.toHaveProperty("framerSiteId");
    expect(site).toMatchObject({ siteId: "new-site", siteName: null, allowedOrigins: [] });
  });

  it("creates a site when the stored id no longer exists", async () => {
    db.site.findUnique.mockResolvedValue(null);

    const site = await attachProject("u1", { siteId: "gone" });

    expect(tx.site.create).toHaveBeenCalledTimes(1);
    expect(site.siteId).toBe("new-site");
  });

  it("never stores what an older panel still sends", async () => {
    // The route's schema drops these keys; this guards the service as well.
    const legacy = { framerProjectId: "proj1", framerUserId: "fu1", projectName: "Portfolio", origins: ["https://acme.com"] };

    await attachProject("u1", legacy as unknown as { siteId?: string });

    const saved = JSON.stringify(tx.site.create.mock.calls[0]![0]);
    for (const value of ["proj1", "fu1", "Portfolio", "acme.com"]) expect(saved).not.toContain(value);
  });
});
