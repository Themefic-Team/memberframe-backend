/**
 * A provider's redirect back to a sign-in callback carries no site key and no
 * site origin, only the state this server signed (31-sign-in-methods.md 4).
 * `resolveSite` must find the site from that signed state, or every social
 * sign in ends on `missing_site_key` before the callback runs.
 */

import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const findUnique = vi.fn(async ({ where }: { where: { id?: string } }) =>
  where.id === "site-1"
    ? { id: "site-1", siteName: "Journal", siteKey: "key-1", allowedOrigins: ["https://journal.example"], defaultLocale: "en" }
    : null
);

vi.mock("../src/config/db.js", () => ({
  prisma: { site: { findUnique, findMany: async () => [] } },
}));

const { resolveSite } = await import("../src/middleware/site.js");
const { signOAuthState } = await import("../src/lib/oauthState.js");

function run(query: Record<string, string>, body: Record<string, string> = {}): Promise<{ req: Request; error: unknown }> {
  const req = { query, body, header: () => undefined } as unknown as Request;
  const res = { setHeader: () => undefined } as unknown as Response;
  return new Promise((done) => {
    resolveSite(req, res, (error?: unknown) => done({ req, error }));
  });
}

describe("resolveSite on a provider's redirect back", () => {
  const state = signOAuthState({ siteId: "site-1", origin: "https://journal.example", returnTo: "" });

  it("finds the site from the signed state in the query (Google, GitHub, Discord)", async () => {
    const { req, error } = await run({ code: "abc", state });
    expect(error).toBeUndefined();
    expect(req.site?.id).toBe("site-1");
  });

  it("finds the site from the signed state in a posted form (Apple)", async () => {
    const { req, error } = await run({}, { code: "abc", state });
    expect(error).toBeUndefined();
    expect(req.site?.id).toBe("site-1");
  });

  it("refuses a state this server did not sign", async () => {
    const forged = Buffer.from(JSON.stringify({ siteId: "site-1" })).toString("base64url");
    const { error } = await run({ code: "abc", state: forged });
    expect(error).toMatchObject({ message: expect.stringContaining("missing_site_key") });
  });
});
