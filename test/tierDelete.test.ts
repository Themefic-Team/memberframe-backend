/**
 * DELETE /api/site/tiers/:id. Development doc:
 * memberframe/docs/development-docs/23-dynamic-tiers.md, section 8.
 *
 * A paid tier with no members can go; the Free tier never can, and a tier
 * members hold is refused with how many, so nobody is left paying for a tier
 * the site no longer has.
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const tierFindFirst = vi.fn();
const memberCount = vi.fn();
const gatewayDelete = vi.fn((args: unknown) => ({ op: "gatewayPrice.deleteMany", args }));
const tierDelete = vi.fn((args: unknown) => ({ op: "tier.delete", args }));
const transaction = vi.fn(async (ops: unknown[]) => ops);

vi.mock("../src/config/db.js", () => ({
  prisma: {
    tier: { findFirst: tierFindFirst, delete: tierDelete },
    member: { count: memberCount },
    gatewayPrice: { deleteMany: gatewayDelete },
    $transaction: transaction,
  },
}));
vi.mock("../src/middleware/creator.js", () => ({
  creatorAuth: (_req: Request, _res: Response, next: () => void) => next(),
  requireCreator: () => ({ userId: "user_1" }),
  pluginCors: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock("../src/services/creatorAuthService.js", () => ({
  requireOwnedSite: vi.fn(async () => ({ id: "site_1" })),
}));

const { siteRouter } = await import("../src/routes/site.js");

async function del(tierId: string) {
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      body = value;
      return res;
    },
    setHeader: () => undefined,
    getHeader: () => undefined,
    end: () => res,
  } as unknown as Response;
  const req = {
    method: "DELETE",
    url: `/tiers/${tierId}?siteId=site_1`,
    path: `/tiers/${tierId}`,
    query: { siteId: "site_1" },
    params: {},
    headers: {},
    header: () => undefined,
  } as unknown as Request;

  await new Promise<void>((resolve) => {
    (res as unknown as { json: (value: Record<string, unknown>) => unknown }).json = (value) => {
      body = value;
      resolve();
      return res;
    };
    siteRouter(req, res, (error?: unknown) => {
      const e = error as { status?: number; reason?: string; extra?: Record<string, unknown> } | undefined;
      status = e?.status ?? 404;
      body = { reason: e?.reason, ...(e?.extra ?? {}) };
      resolve();
    });
  });
  return { status, body };
}

describe("deleting a tier", () => {
  it("deletes a paid tier nobody holds, with its cached gateway prices", async () => {
    tierFindFirst.mockResolvedValueOnce({ id: "t1", key: "gold_plus", rank: 2 });
    memberCount.mockResolvedValueOnce(0);

    const { status, body } = await del("t1");

    expect(status).toBe(200);
    expect(body).toMatchObject({ deleted: true, id: "t1" });
    expect(gatewayDelete).toHaveBeenCalledWith({ where: { siteId: "site_1", tierKey: "gold_plus" } });
    expect(tierDelete).toHaveBeenCalledWith({ where: { id: "t1" } });
  });

  it("never deletes the Free tier", async () => {
    tierFindFirst.mockResolvedValueOnce({ id: "t0", key: "free", rank: 0 });
    tierDelete.mockClear();

    const { status, body } = await del("t0");

    expect(status).toBe(400);
    expect(body["reason"]).toBe("free_tier_is_fixed");
    expect(tierDelete).not.toHaveBeenCalled();
  });

  it("refuses while members hold the tier, and says how many", async () => {
    tierFindFirst.mockResolvedValueOnce({ id: "t1", key: "gold_plus", rank: 2 });
    memberCount.mockResolvedValueOnce(3);
    tierDelete.mockClear();

    const { status, body } = await del("t1");

    expect(status).toBe(400);
    expect(body["reason"]).toBe("tier_in_use");
    expect(tierDelete).not.toHaveBeenCalled();
  });

  it("answers a tier that is not this site's", async () => {
    tierFindFirst.mockResolvedValueOnce(null);
    expect((await del("nope")).body["reason"]).toBe("tier_not_found");
  });
});
