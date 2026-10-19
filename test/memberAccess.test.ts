/**
 * Doc 26: Revoke access ends billing too, and Send magic link emails a
 * single-use sign in. Prisma, the gateways, sessions, and mail are stand-ins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
let members: Row[] = [];
let subscriptions: Row[] = [];

const prisma = {
  member: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => members.find((m) => m.id === where.id && m.siteId === where.siteId && m["deletedAt"] === null) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(members.find((m) => m.id === where.id)!, data)),
  },
  subscription: {
    findMany: vi.fn(async ({ where }: { where: { memberId: string; status: { in: string[] } } }) =>
      subscriptions.filter((s) => s["memberId"] === where.memberId && where.status.in.includes(s["status"] as string))
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(subscriptions.find((s) => s.id === where.id)!, data)),
  },
};

const cancelNow = vi.fn(async () => undefined);
const loadCredentials = vi.fn(async (): Promise<unknown> => ({ gateway: "stripe" }));
const revokeAll = vi.fn(async () => 1);
const revokeSession = vi.fn(async () => undefined);
const issueSession = vi.fn(async () => ({ token: "handoff-token-0123456789abcdef", expiresAt: new Date() }));
const sendMail = vi.fn(async (_mail: unknown): Promise<{ sent: boolean; messageId: string | null }> => ({ sent: true, messageId: "m1" }));

vi.mock("../src/config/db.js", () => ({ prisma }));
vi.mock("../src/lib/tiers.js", () => ({ freeTierKey: async () => "free" }));
vi.mock("../src/services/sessionService.js", () => ({ issueSession, revokeAllSessionsForMember: revokeAll, revokeSession }));
vi.mock("../src/services/settingsService.js", () => ({ loadSiteSettings: async () => ({ auth: { loginPath: "/login" } }) }));
vi.mock("../src/services/webhookService.js", () => ({ emitMemberEvent: vi.fn() }));
vi.mock("../src/services/payments/apply.js", () => ({ RUNNING: ["active", "past_due", "canceling"] }));
vi.mock("../src/services/payments/gatewayStore.js", () => ({
  ADAPTERS: { stripe: { cancelNow }, lemonsqueezy: { cancelNow }, razorpay: { cancelNow } },
  loadCredentials,
}));
vi.mock("../src/lib/mailer.js", async (original) => ({ ...(await original<object>()), sendMail }));

const { revokeMemberAccess, restoreMemberAccess, issueMagicLink } = await import("../src/services/memberAccessService.js");
const { GatewayError } = await import("../src/services/payments/types.js");

const SITE = { id: "site_1", siteName: "Tabfolio", allowedOrigins: ["https://framer.com", "https://tabfolio.framer.website"] };

beforeEach(() => {
  vi.clearAllMocks();
  members = [{ id: "m1", siteId: "site_1", email: "ann@x.com", activeTier: "gold", status: "active", deletedAt: null }];
  subscriptions = [
    { id: "s1", siteId: "site_1", memberId: "m1", gateway: "stripe", mode: "live", interval: "month", externalId: "sub_1", status: "active" },
    { id: "s2", siteId: "site_1", memberId: "m1", gateway: "stripe", mode: "live", interval: "lifetime", externalId: "pi_1", status: "active" },
    { id: "s3", siteId: "site_1", memberId: "m1", gateway: "stripe", mode: "live", interval: "month", externalId: "sub_old", status: "ended" },
  ];
});

describe("revoke access", () => {
  it("cancels running recurring plans at the gateway, ends lifetime ones, drops to Free and canceled, and signs out", async () => {
    const result = await revokeMemberAccess("site_1", "m1");

    expect(cancelNow).toHaveBeenCalledTimes(1);
    expect(cancelNow).toHaveBeenCalledWith({ gateway: "stripe" }, "sub_1");
    expect(result.canceledSubscriptions).toBe(1);
    expect(subscriptions.map((s) => s["status"])).toEqual(["ended", "ended", "ended"]);
    expect(members[0]).toMatchObject({ activeTier: "free", status: "canceled" });
    expect(revokeAll).toHaveBeenCalledWith("m1");
  });

  it("changes nothing when the gateway refuses the cancel", async () => {
    cancelNow.mockRejectedValueOnce(new GatewayError("stripe", 402, "nope"));

    await expect(revokeMemberAccess("site_1", "m1")).rejects.toMatchObject({ status: 502, reason: "gateway_cancel_failed" });
    expect(members[0]).toMatchObject({ activeTier: "gold", status: "active" });
    expect(subscriptions[0]!["status"]).toBe("active");
    expect(revokeAll).not.toHaveBeenCalled();
  });

  it("ends a plan here when the gateway's keys are gone", async () => {
    loadCredentials.mockResolvedValueOnce(null);
    await revokeMemberAccess("site_1", "m1");
    expect(cancelNow).not.toHaveBeenCalled();
    expect(subscriptions[0]!["status"]).toBe("ended");
  });

  it("restores a revoked member to active", async () => {
    await revokeMemberAccess("site_1", "m1");
    await restoreMemberAccess("site_1", "m1");
    expect(members[0]).toMatchObject({ activeTier: "free", status: "active" });
  });
});

describe("magic link", () => {
  it("emails the site's login page with a one-hour single-use code in the fragment", async () => {
    const link = await issueMagicLink(SITE, "m1");

    expect(link.url).toBe("https://tabfolio.framer.website/login#mf_oauth=handoff-token-0123456789abcdef");
    expect(issueSession).toHaveBeenCalledWith("m1", "site_1", 3600, {});
    const mail = sendMail.mock.calls[0]![0] as unknown as { to: string; subject: string; siteId: string; text: string };
    expect(mail).toMatchObject({ to: "ann@x.com", subject: "Sign in to Tabfolio", siteId: "site_1" });
    expect(mail.text).toContain(link.url);
  });

  it("refuses a revoked member and a site with no address", async () => {
    members[0]!["status"] = "canceled";
    await expect(issueMagicLink(SITE, "m1")).rejects.toMatchObject({ status: 409, reason: "member_revoked" });

    members[0]!["status"] = "active";
    await expect(issueMagicLink({ ...SITE, allowedOrigins: ["https://framer.com"] }, "m1")).rejects.toMatchObject({ reason: "no_site_url" });
  });

  it("says so, and spends the code, when the email does not go", async () => {
    sendMail.mockResolvedValueOnce({ sent: false, messageId: null });
    await expect(issueMagicLink(SITE, "m1")).rejects.toMatchObject({ status: 502, reason: "mail_failed" });
    expect(revokeSession).toHaveBeenCalledWith("handoff-token-0123456789abcdef");
  });
});
