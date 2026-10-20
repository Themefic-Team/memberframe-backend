/**
 * 31-sign-in-methods.md: one account per email, each provider an identity
 * linked to it; an unverified address never signs in to an existing account;
 * the OAuth state is signed; Apple's token is checked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  type Member = { id: string; siteId: string; email: string; passwordHash: string | null; emailVerifiedAt: Date | null; deletedAt: Date | null; name: string | null; avatarUrl: string | null; signupMethod?: string | null };
  type Identity = { id: string; siteId: string; memberId: string; provider: string; providerUserId: string; email: string };
  const state = { members: [] as Member[], identities: [] as Identity[], revoked: [] as string[], next: 1 };
  const key = (w: { siteId: string; provider: string; providerUserId: string }) => `${w.siteId}|${w.provider}|${w.providerUserId}`;
  const prisma = {
    memberIdentity: {
      findUnique: async ({ where }: { where: { siteId_provider_providerUserId: { siteId: string; provider: string; providerUserId: string } } }) => {
        const found = state.identities.find((row) => key(row) === key(where.siteId_provider_providerUserId));
        if (!found) return null;
        const member = state.members.find((row) => row.id === found.memberId)!;
        return { id: found.id, member: { id: member.id, deletedAt: member.deletedAt } };
      },
      upsert: async ({ where, create, update }: { where: { siteId_provider_providerUserId: { siteId: string; provider: string; providerUserId: string } }; create: Identity; update: Partial<Identity> }) => {
        const found = state.identities.find((row) => key(row) === key(where.siteId_provider_providerUserId));
        if (found) Object.assign(found, update);
        else state.identities.push({ ...create, id: `identity_${state.next++}` });
      },
    },
    member: {
      findFirst: async ({ where }: { where: { siteId: string; email: string } }) =>
        state.members.find((row) => row.siteId === where.siteId && row.email === where.email && row.deletedAt === null) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => state.members.find((row) => row.id === where.id)!,
      create: async ({ data }: { data: Omit<Member, "id" | "deletedAt" | "passwordHash"> }) => {
        const member: Member = { passwordHash: null, deletedAt: null, ...data, id: `member_${state.next++}` } as Member;
        state.members.push(member);
        return { id: member.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Member> }) => {
        Object.assign(state.members.find((row) => row.id === where.id)!, data);
      },
    },
  };
  return { state, prisma };
});

vi.mock("../src/config/db.js", () => ({ prisma: db.prisma }));
vi.mock("../src/lib/tiers.js", () => ({ freeTierKey: async () => "free_member" }));
vi.mock("../src/services/webhookService.js", () => ({ emitMemberEvent: () => undefined }));
vi.mock("../src/services/sessionService.js", () => ({
  revokeAllSessionsForMember: async (memberId: string) => {
    db.state.revoked.push(memberId);
    return 1;
  },
}));

const { decideOAuthLink, resolveOAuthMember } = await import("../src/services/memberIdentityService.js");
const { OAUTH_STATE_TTL_MS, signOAuthState, verifyOAuthState } = await import("../src/lib/oauthState.js");

const SITE = "site_1";
const profile = (overrides: Partial<Parameters<typeof resolveOAuthMember>[1]> = {}) => ({
  provider: "google" as const,
  providerUserId: "g-123",
  email: "ada@example.com",
  name: "Ada",
  emailVerified: true,
  ...overrides,
});
const addMember = (overrides: Partial<(typeof db.state.members)[number]> = {}) => {
  const member = { id: `member_${db.state.next++}`, siteId: SITE, email: "ada@example.com", passwordHash: null, emailVerifiedAt: new Date(), deletedAt: null, name: null, avatarUrl: null, ...overrides };
  db.state.members.push(member);
  return member;
};

beforeEach(() => {
  db.state.members = [];
  db.state.identities = [];
  db.state.revoked = [];
});

describe("decideOAuthLink", () => {
  it("prefers the provider's own identity, then a verified email, and refuses an unverified one", () => {
    expect(decideOAuthLink({ identityMemberId: "m1", emailMember: null, emailVerified: false })).toEqual({ kind: "identity", memberId: "m1" });
    expect(decideOAuthLink({ identityMemberId: null, emailMember: null, emailVerified: false })).toEqual({ kind: "create" });
    expect(decideOAuthLink({ identityMemberId: null, emailMember: { id: "m2", hasPassword: true, emailConfirmed: true }, emailVerified: true })).toEqual({
      kind: "link",
      memberId: "m2",
      clearPassword: false,
    });
    expect(decideOAuthLink({ identityMemberId: null, emailMember: { id: "m2", hasPassword: true, emailConfirmed: false }, emailVerified: false })).toEqual({
      kind: "refuse",
      reason: "email_unverified_link",
    });
  });

  it("clears the password of an unconfirmed password account it links to (pre-hijacking)", () => {
    expect(decideOAuthLink({ identityMemberId: null, emailMember: { id: "m3", hasPassword: true, emailConfirmed: false }, emailVerified: true })).toMatchObject({
      clearPassword: true,
    });
  });
});

describe("resolveOAuthMember", () => {
  it("creates a member signed up with the provider, with its identity", async () => {
    const result = await resolveOAuthMember(SITE, profile());
    expect(result).toEqual({ id: expect.any(String) });
    expect(db.state.members[0]).toMatchObject({ signupMethod: "google", email: "ada@example.com" });
    expect(db.state.identities).toEqual([expect.objectContaining({ provider: "google", providerUserId: "g-123" })]);
  });

  it("puts Google then GitHub on the same email on one member, with two identities", async () => {
    const first = await resolveOAuthMember(SITE, profile());
    const second = await resolveOAuthMember(SITE, profile({ provider: "github", providerUserId: "42" }));
    expect(second).toEqual(first);
    expect(db.state.members).toHaveLength(1);
    expect(db.state.identities.map((row) => row.provider)).toEqual(["google", "github"]);
  });

  it("finds the member by identity even after the email changed at the provider", async () => {
    const first = await resolveOAuthMember(SITE, profile());
    const again = await resolveOAuthMember(SITE, profile({ email: "ada.new@example.com" }));
    expect(again).toEqual(first);
    expect(db.state.identities[0]!.email).toBe("ada.new@example.com");
  });

  it("refuses an unverified address on an existing account", async () => {
    addMember({ passwordHash: "hash" });
    expect(await resolveOAuthMember(SITE, profile({ emailVerified: false }))).toEqual({ refused: "email_unverified_link" });
    expect(db.state.identities).toHaveLength(0);
  });

  it("clears an unconfirmed password and ends its sessions when linking", async () => {
    const member = addMember({ passwordHash: "attacker-hash", emailVerifiedAt: null });
    await resolveOAuthMember(SITE, profile());
    expect(member.passwordHash).toBeNull();
    expect(member.emailVerifiedAt).toBeInstanceOf(Date);
    expect(db.state.revoked).toEqual([member.id]);
  });

  it("keeps a confirmed password when linking", async () => {
    const member = addMember({ passwordHash: "own-hash" });
    await resolveOAuthMember(SITE, profile());
    expect(member.passwordHash).toBe("own-hash");
    expect(db.state.revoked).toEqual([]);
  });
});

describe("the OAuth state", () => {
  const SECRET = "test-secret";
  const payload = { siteId: SITE, origin: "https://site.example", returnTo: "https://site.example/login" };

  it("round-trips a state this server signed", () => {
    expect(verifyOAuthState(signOAuthState(payload, 1_000, SECRET), 2_000, SECRET)).toEqual(payload);
  });

  it("refuses a tampered, unsigned, foreign, or expired state", () => {
    const state = signOAuthState(payload, 1_000, SECRET);
    const [body, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, returnTo: "https://evil.example/", exp: 9e15 })).toString("base64url");
    expect(verifyOAuthState(`${forged}.${signature}`, 2_000, SECRET)).toBeNull();
    expect(verifyOAuthState(body, 2_000, SECRET)).toBeNull();
    expect(verifyOAuthState(Buffer.from(JSON.stringify(payload)).toString("base64url"), 2_000, SECRET)).toBeNull();
    expect(verifyOAuthState(state, 2_000, "another-secret")).toBeNull();
    expect(verifyOAuthState(state, 1_000 + OAUTH_STATE_TTL_MS + 1, SECRET)).toBeNull();
  });
});
