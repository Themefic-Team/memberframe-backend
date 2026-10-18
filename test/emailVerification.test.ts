/**
 * Email confirmation for password sign up.
 *
 * Register creates the member unverified and emails a code, with no session.
 * The code confirms the address and still signs nobody in. A correct password
 * for an unconfirmed address is refused with `email_not_verified`, and a fresh
 * code goes out, so the member can finish confirming from the sign in form.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/lib/tokens.js";
import { hashPassword } from "../src/lib/password.js";

vi.mock("../src/config/db.js", () => ({
  prisma: {
    memberOtp: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    // The site's Free tier, the tier at rank 0, where a new member starts.
    tier: { findFirst: vi.fn(async () => ({ key: "free_member" })) },
  },
}));

vi.mock("../src/lib/mailer.js", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  otpMail: vi.fn().mockReturnValue({ template: "member_otp" }),
  verifyEmailMail: vi.fn().mockReturnValue({ template: "member_verify_email" }),
  passwordResetMail: vi.fn(),
  passwordChangedMail: vi.fn(),
}));

vi.mock("../src/services/settingsService.js", () => ({
  loadSiteSettings: vi.fn().mockResolvedValue({ auth: { allowRegistration: true } }),
}));

import { prisma } from "../src/config/db.js";
import { otpMail, sendMail, verifyEmailMail } from "../src/lib/mailer.js";
import {
  registerMember,
  resendEmailVerification,
  signInWithPassword,
  verifyMemberEmail,
} from "../src/services/memberAuthService.js";

const MEMBER = {
  id: "member_1",
  siteId: "site_1",
  email: "new@example.com",
  name: null,
  activeTier: "free_member",
  status: "active",
};

function liveOtp(code: string) {
  return {
    id: "otp_1",
    siteId: "site_1",
    email: "new@example.com",
    codeHash: hashToken(code),
    attempts: 0,
    expiresAt: new Date(Date.now() + 500_000),
    resendAvailableAt: new Date(Date.now() - 1000),
    consumedAt: null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.memberOtp.updateMany).mockResolvedValue({ count: 0 });
  vi.mocked(prisma.memberOtp.create).mockResolvedValue(liveOtp("000000"));
});

describe("registerMember", () => {
  it("creates the member unverified and emails a confirmation code", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockResolvedValue(MEMBER as never);

    const result = await registerMember({
      siteId: "site_1",
      siteName: "My Site",
      email: "New@Example.com",
      password: "Correct-Horse-9-Battery",
      name: null,
    });

    const created = vi.mocked(prisma.member.create).mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(created.data["emailVerifiedAt"]).toBeNull();
    expect(created.data).not.toHaveProperty("lastLoginAt");

    expect(verifyEmailMail).toHaveBeenCalledWith("new@example.com", expect.any(String), "My Site", "site_1");
    expect(otpMail).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(result.verification.resendAfterSeconds).toBe(60);
  });
});

describe("verifyMemberEmail", () => {
  it("confirms the address with the right code", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "member_1", emailVerifiedAt: null } as never);
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(liveOtp("123456"));

    await verifyMemberEmail({ siteId: "site_1", email: "new@example.com", code: "123456" });

    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "member_1" },
      data: { emailVerifiedAt: expect.any(Date) },
    });
  });

  it("refuses a wrong code without confirming", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "member_1", emailVerifiedAt: null } as never);
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(liveOtp("123456"));
    vi.mocked(prisma.memberOtp.update).mockResolvedValue({ ...liveOtp("123456"), attempts: 1 });

    await expect(
      verifyMemberEmail({ siteId: "site_1", email: "new@example.com", code: "999999" })
    ).rejects.toMatchObject({ status: 401, reason: "invalid_code" });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("answers an address with no account exactly like a wrong code", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(liveOtp("123456"));

    await expect(
      verifyMemberEmail({ siteId: "site_1", email: "nobody@example.com", code: "123456" })
    ).rejects.toMatchObject({ status: 401, reason: "invalid_code" });
  });
});

describe("signInWithPassword", () => {
  it("refuses an unconfirmed address after the password matches, and sends a code", async () => {
    const passwordHash = await hashPassword("Correct-Horse-9-Battery");
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      ...MEMBER,
      passwordHash,
      failedLoginCount: 0,
      lockedUntil: null,
      emailVerifiedAt: null,
    } as never);
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(null);

    await expect(
      signInWithPassword({
        siteId: "site_1",
        siteName: "My Site",
        email: "new@example.com",
        password: "Correct-Horse-9-Battery",
      })
    ).rejects.toMatchObject({ status: 403, reason: "email_not_verified", extra: { resendAfterSeconds: 60 } });

    expect(verifyEmailMail).toHaveBeenCalledTimes(1);
  });

  it("points at the live code instead of sending another inside the resend lock", async () => {
    const passwordHash = await hashPassword("Correct-Horse-9-Battery");
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      ...MEMBER,
      passwordHash,
      failedLoginCount: 0,
      lockedUntil: null,
      emailVerifiedAt: null,
    } as never);
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      ...liveOtp("123456"),
      resendAvailableAt: new Date(Date.now() + 30_000),
    });

    await expect(
      signInWithPassword({
        siteId: "site_1",
        siteName: "My Site",
        email: "new@example.com",
        password: "Correct-Horse-9-Battery",
      })
    ).rejects.toMatchObject({ status: 403, reason: "email_not_verified" });

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("says nothing about confirmation to a wrong password", async () => {
    const passwordHash = await hashPassword("Correct-Horse-9-Battery");
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      ...MEMBER,
      passwordHash,
      failedLoginCount: 0,
      lockedUntil: null,
      emailVerifiedAt: null,
    } as never);

    await expect(
      signInWithPassword({
        siteId: "site_1",
        siteName: "My Site",
        email: "new@example.com",
        password: "wrong-password-entirely",
      })
    ).rejects.toMatchObject({ status: 401, reason: "invalid_credentials" });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("resendEmailVerification", () => {
  it("sends nothing for a confirmed or unknown address, and answers the same", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    const unknown = await resendEmailVerification({ siteId: "site_1", siteName: "My Site", email: "x@example.com" });

    vi.mocked(prisma.member.findFirst).mockResolvedValue({ emailVerifiedAt: new Date() } as never);
    const confirmed = await resendEmailVerification({ siteId: "site_1", siteName: "My Site", email: "x@example.com" });

    expect(unknown).toEqual(confirmed);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
