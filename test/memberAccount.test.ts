/**
 * The member's own account area (memberframe
 * docs/development-docs/33-member-account.md): the rules in
 * `lib/memberAccount.ts`, then the guards on each route in
 * `routes/memberAccount.ts` against a mocked database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

process.env["INSTANCE_SEAL_SECRET"] = process.env["INSTANCE_SEAL_SECRET"] ?? "test-secret-for-avatar-tokens-0123456789";

const memberFindFirst = vi.fn();
const memberUpdate = vi.fn(async () => ({}));
const memberDelete = vi.fn((args: unknown) => ({ op: "member.delete", args }));
const identityFindMany = vi.fn();
const identityDeleteMany = vi.fn(async () => ({ count: 1 }));
const sessionFindMany = vi.fn(async () => []);
const sessionFindFirst = vi.fn();
const sessionUpdate = vi.fn(async () => ({}));
const subscriptionFindMany = vi.fn(async () => []);
const otpDeleteMany = vi.fn((args: unknown) => ({ op: "memberOtp.deleteMany", args }));
const transaction = vi.fn(async (ops: unknown[]) => ops);
const loadSession = vi.fn();
const revokeAll = vi.fn(async () => 2);
const emitMemberEvent = vi.fn(async () => undefined);
const putFile = vi.fn(async () => ({ storageKey: "local:site_1/abc", sizeBytes: 10 }));
const removeFile = vi.fn(async () => undefined);

vi.mock("../src/config/db.js", () => ({
  prisma: {
    member: { findFirst: memberFindFirst, update: memberUpdate, delete: memberDelete },
    memberIdentity: { findMany: identityFindMany, deleteMany: identityDeleteMany },
    memberSession: { findMany: sessionFindMany, findFirst: sessionFindFirst, update: sessionUpdate },
    subscription: { findMany: subscriptionFindMany },
    memberOtp: { deleteMany: otpDeleteMany },
    $transaction: transaction,
  },
}));
vi.mock("../src/middleware/site.js", () => ({
  requireSite: () => ({ id: "site_1", siteName: "Site" }),
}));
vi.mock("../src/middleware/rateLimit.js", () => ({ guardCredentialCheck: () => undefined }));
vi.mock("../src/services/sessionService.js", () => ({
  loadSession,
  revokeAllSessionsForMember: revokeAll,
}));
vi.mock("../src/services/settingsService.js", () => ({
  loadSiteSettings: async () => ({ auth: { passwordPolicy: undefined } }),
}));
vi.mock("../src/lib/mailer.js", () => ({ passwordChangedMail: () => ({}), sendMail: async () => undefined }));
vi.mock("../src/services/webhookService.js", () => ({ MEMBER_SNAPSHOT_SELECT: { id: true, siteId: true, email: true }, emitMemberEvent }));
vi.mock("../src/services/assets/storage.js", () => ({ putFile, removeFile, openFile: vi.fn() }));
vi.mock("../src/lib/publicApiBase.js", () => ({ publicApiBase: () => "https://api.example.com" }));

const lib = await import("../src/lib/memberAccount.js");
const { memberAccountRouter } = await import("../src/routes/memberAccount.js");
const { hashToken } = await import("../src/lib/tokens.js");
const { hashPassword } = await import("../src/lib/password.js");

const SESSION = { sessionId: "sess_1", member: { memberId: "member_1" }, tiers: [] };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  let status = 200;
  let json: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    setHeader: () => undefined,
    getHeader: () => undefined,
    cookie: () => res,
    clearCookie: () => res,
    end: () => res,
  } as unknown as Response;
  const req = {
    method,
    url: path,
    path,
    query: {},
    params: {},
    body,
    headers: { "content-type": "application/json", ...headers },
    header: (name: string) => headers[name.toLowerCase()],
    cookies: { [process.env["SESSION_COOKIE_NAME"] ?? "mf_member_session"]: "token_1", mf_member_session: "token_1", mf_session: "token_1" },
    ip: "127.0.0.1",
  } as unknown as Request;

  await new Promise<void>((resolve) => {
    (res as unknown as { json: (value: Record<string, unknown>) => unknown }).json = (value) => {
      json = value;
      resolve();
      return res;
    };
    memberAccountRouter(req, res, (error?: unknown) => {
      const e = error as { status?: number; reason?: string } | undefined;
      status = e?.status ?? 404;
      json = { reason: e?.reason };
      resolve();
    });
  });
  return { status, body: json };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadSession.mockResolvedValue(SESSION);
});

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe("deviceLabel", () => {
  it("names the browser and the system", () => {
    expect(lib.deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(lib.deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(lib.deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Windows");
    expect(lib.deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
  });

  it("falls back for an empty or unknown agent", () => {
    expect(lib.deviceLabel(null)).toBe("Unknown device");
    expect(lib.deviceLabel("curl/8.0")).toBe("Unknown device");
  });
});

describe("canUnlink", () => {
  it("keeps a way back in", () => {
    expect(lib.canUnlink("google", false, ["google"])).toBe(false);
    expect(lib.canUnlink("google", true, ["google"])).toBe(true);
    expect(lib.canUnlink("google", false, ["google", "github"])).toBe(true);
    expect(lib.canUnlink("discord", true, ["google"])).toBe(false);
  });
});

describe("blocksAccountDeletion", () => {
  it("blocks only a plan that will charge again", () => {
    expect(lib.blocksAccountDeletion({ status: "active", interval: "month", cancelAtPeriodEnd: false })).toBe(true);
    expect(lib.blocksAccountDeletion({ status: "past_due", interval: "year", cancelAtPeriodEnd: false })).toBe(true);
    expect(lib.blocksAccountDeletion({ status: "active", interval: "month", cancelAtPeriodEnd: true })).toBe(false);
    expect(lib.blocksAccountDeletion({ status: "active", interval: "lifetime", cancelAtPeriodEnd: false })).toBe(false);
    expect(lib.blocksAccountDeletion({ status: "canceled", interval: "month", cancelAtPeriodEnd: false })).toBe(false);
  });
});

describe("confirmsEmail", () => {
  it("matches the member's own address only", () => {
    expect(lib.confirmsEmail(" Member@Example.com ", "member@example.com")).toBe(true);
    expect(lib.confirmsEmail("other@example.com", "member@example.com")).toBe(false);
    expect(lib.confirmsEmail("", "")).toBe(false);
  });
});

describe("sniffImageType", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  it("reads the type from the file's own bytes", () => {
    expect(lib.sniffImageType(png)).toBe("image/png");
    expect(lib.sniffImageType(jpeg)).toBe("image/jpeg");
    expect(lib.sniffImageType(webp)).toBe("image/webp");
  });

  it("refuses anything else, markup and SVG included", () => {
    expect(lib.sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(lib.sniffImageType(new TextEncoder().encode("<html>"))).toBeNull();
    expect(lib.sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("avatar tokens", () => {
  it("round trips, and refuses an edited token", () => {
    const token = lib.signAvatarToken({ storageKey: "local:site_1/abc", type: "image/png" }, "secret");
    expect(lib.verifyAvatarToken(token, "secret")).toEqual({ storageKey: "local:site_1/abc", type: "image/png" });
    expect(lib.verifyAvatarToken(token, "other-secret")).toBeNull();
    const [, signature] = token.split(".");
    const forged = `${Buffer.from("p.local:site_2/zzz").toString("base64url")}.${signature}`;
    expect(lib.verifyAvatarToken(forged, "secret")).toBeNull();
  });

  it("finds our token in our own address only", () => {
    expect(lib.avatarTokenFromUrl("https://api.example.com/api/avatars/abc.def")).toBe("abc.def");
    expect(lib.avatarTokenFromUrl("https://lh3.googleusercontent.com/a/photo")).toBeNull();
    expect(lib.avatarTokenFromUrl(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe("the account routes", () => {
  it("refuse a visitor with no session", async () => {
    loadSession.mockResolvedValue(null);
    for (const [method, path] of [
      ["GET", "/account"],
      ["POST", "/password"],
      ["DELETE", "/identities/google"],
      ["DELETE", "/sessions/sess_2"],
      ["DELETE", "/avatar"],
      ["DELETE", "/account"],
    ] as const) {
      const { status } = await call(method, path, { newPassword: "x", confirmEmail: "x" });
      expect(status, `${method} ${path}`).toBe(401);
    }
  });

  it("refuse to unlink the last way to sign in", async () => {
    memberFindFirst.mockResolvedValue({ passwordHash: null });
    identityFindMany.mockResolvedValue([{ provider: "google" }]);
    const { status, body } = await call("DELETE", "/identities/google");
    expect(status).toBe(400);
    expect(body.reason).toBe("last_sign_in_method");
    expect(identityDeleteMany).not.toHaveBeenCalled();
  });

  it("unlink when a password remains, scoped to this member", async () => {
    memberFindFirst.mockResolvedValue({ passwordHash: "hash" });
    identityFindMany.mockResolvedValue([{ provider: "google" }]);
    const { status } = await call("DELETE", "/identities/google");
    expect(status).toBe(200);
    expect(identityDeleteMany).toHaveBeenCalledWith({ where: { memberId: "member_1", siteId: "site_1", provider: "google" } });
  });

  it("only sign out another device that belongs to this member", async () => {
    sessionFindFirst.mockResolvedValue(null);
    const missing = await call("DELETE", "/sessions/someone_elses");
    expect(missing.body.reason).toBe("session_not_found");
    expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ memberId: "member_1", siteId: "site_1" }) }));

    sessionFindFirst.mockResolvedValue({ id: "sess_1", tokenHash: hashToken("token_1") });
    const current = await call("DELETE", "/sessions/sess_1");
    expect(current.body.reason).toBe("current_session");
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("need the current password to change one, then sign out the other devices", async () => {
    memberFindFirst.mockResolvedValue({ id: "member_1", email: "m@example.com", passwordHash: await hashPassword("Old-pass-123") });
    const wrong = await call("POST", "/password", { currentPassword: "nope", newPassword: "New-pass-456" });
    expect(wrong.body.reason).toBe("wrong_password");
    expect(memberUpdate).not.toHaveBeenCalled();

    const right = await call("POST", "/password", { currentPassword: "Old-pass-123", newPassword: "New-pass-456" });
    expect(right.status).toBe(200);
    expect(revokeAll).toHaveBeenCalledWith("member_1", "token_1");
  });

  it("let a member with no password set a first one", async () => {
    memberFindFirst.mockResolvedValue({ id: "member_1", email: "m@example.com", passwordHash: null });
    const { status } = await call("POST", "/password", { newPassword: "New-pass-456" });
    expect(status).toBe(200);
  });

  it("refuse a photo that is not really an image", async () => {
    const { status, body } = await call("POST", "/avatar", Buffer.from("<svg onload=alert(1)>"), { "content-type": "image/png" });
    expect(status).toBe(400);
    expect(body.reason).toBe("unsupported_image");
    expect(putFile).not.toHaveBeenCalled();
  });

  it("refuse to delete while a plan will charge again, and need the email", async () => {
    memberFindFirst.mockResolvedValue({ id: "member_1", siteId: "site_1", email: "m@example.com", avatarUrl: null });
    const mismatch = await call("DELETE", "/account", { confirmEmail: "other@example.com" });
    expect(mismatch.body.reason).toBe("email_mismatch");

    subscriptionFindMany.mockResolvedValue([{ status: "active", interval: "month", cancelAtPeriodEnd: false }] as never);
    const renewing = await call("DELETE", "/account", { confirmEmail: "m@example.com" });
    expect(renewing.body.reason).toBe("active_plan");
    expect(transaction).not.toHaveBeenCalled();

    subscriptionFindMany.mockResolvedValue([{ status: "active", interval: "month", cancelAtPeriodEnd: true }] as never);
    const ending = await call("DELETE", "/account", { confirmEmail: "m@example.com" });
    expect(ending.status).toBe(200);
    expect(emitMemberEvent).toHaveBeenCalledWith("member.deleted", expect.objectContaining({ id: "member_1" }));
    expect(transaction).toHaveBeenCalled();
  });
});
