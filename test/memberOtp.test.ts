/**
 * Member OTP service and schema tests. FP-03.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendOtpSchema, verifyOtpSchema } from "../src/validation/schemas.js";
import { hashToken } from "../src/lib/tokens.js";

// Mock DB and Mailer
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
  otpMail: vi.fn().mockReturnValue({ to: "test@example.com", subject: "Code", text: "123456", html: "<p>123456</p>" }),
  verifyEmailMail: vi.fn().mockReturnValue({ to: "test@example.com", subject: "Confirm", text: "123456", html: "<p>123456</p>" }),
}));

vi.mock("../src/services/settingsService.js", () => ({
  loadSiteSettings: vi.fn().mockResolvedValue({
    auth: { allowRegistration: true },
  }),
}));

import { prisma } from "../src/config/db.js";
import { loadSiteSettings } from "../src/services/settingsService.js";
import { sendMemberOtp, verifyMemberOtp } from "../src/services/memberAuthService.js";

describe("OTP Validation Schemas", () => {
  it("validates sendOtpSchema with valid email", () => {
    const res = sendOtpSchema.safeParse({ email: "user@example.com" });
    expect(res.success).toBe(true);
  });

  it("rejects invalid email in sendOtpSchema", () => {
    const res = sendOtpSchema.safeParse({ email: "not-an-email" });
    expect(res.success).toBe(false);
  });

  it("validates verifyOtpSchema with valid 6-digit code", () => {
    const res = verifyOtpSchema.safeParse({ email: "user@example.com", code: "123456" });
    expect(res.success).toBe(true);
  });

  it("rejects non-digit or wrong length code in verifyOtpSchema", () => {
    expect(verifyOtpSchema.safeParse({ email: "user@example.com", code: "12345" }).success).toBe(false);
    expect(verifyOtpSchema.safeParse({ email: "user@example.com", code: "1234567" }).success).toBe(false);
    expect(verifyOtpSchema.safeParse({ email: "user@example.com", code: "abcdef" }).success).toBe(false);
  });
});

describe("sendMemberOtp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates a new OTP and returns cooldown and expiry", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "mem_1" } as any);
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.memberOtp.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.memberOtp.create).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "user@example.com",
      codeHash: "hash",
      attempts: 0,
      expiresAt: new Date(Date.now() + 600_000),
      resendAvailableAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      createdAt: new Date(),
    });

    const result = await sendMemberOtp({
      siteId: "site_1",
      siteName: "My Site",
      email: "User@Example.COM",
    });

    expect(result.resendAfterSeconds).toBe(60);
    expect(result.expiresInSeconds).toBe(600);
    expect(prisma.memberOtp.create).toHaveBeenCalledTimes(1);
    expect(prisma.memberOtp.updateMany).toHaveBeenCalledWith({
      where: { siteId: "site_1", email: "user@example.com", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("sends nothing to an address with no account, and answers the same", async () => {
    // Code sign in is for registered members only (2026-10-18), and the answer
    // must not tell anyone whether an address has an account.
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    const { sendMail } = await import("../src/lib/mailer.js");

    const result = await sendMemberOtp({ siteId: "site_1", siteName: "My Site", email: "stranger@example.com" });

    expect(result).toEqual({ resendAfterSeconds: 60, expiresInSeconds: 600 });
    expect(prisma.memberOtp.create).not.toHaveBeenCalled();
    expect(prisma.memberOtp.updateMany).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("still sends an email confirmation code, which is for a member being created", async () => {
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.memberOtp.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.memberOtp.create).mockResolvedValue({} as any);

    await sendMemberOtp({ siteId: "site_1", siteName: "My Site", email: "new@example.com", purpose: "verify" });

    expect(prisma.member.findFirst).not.toHaveBeenCalled();
    expect(prisma.memberOtp.create).toHaveBeenCalledTimes(1);
  });

  it("enforces resend cooldown if requested too soon", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "mem_1" } as any);
    const now = new Date();
    const futureLock = new Date(now.getTime() + 45_000);

    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "user@example.com",
      codeHash: "hash",
      attempts: 0,
      expiresAt: new Date(now.getTime() + 500_000),
      resendAvailableAt: futureLock,
      consumedAt: null,
      createdAt: now,
    });

    await expect(
      sendMemberOtp({
        siteId: "site_1",
        siteName: "My Site",
        email: "user@example.com",
      })
    ).rejects.toMatchObject({
      status: 400,
      reason: "resend_too_soon",
    });
  });
});

describe("verifyMemberOtp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects if no active OTP exists", async () => {
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue(null);

    await expect(
      verifyMemberOtp({
        siteId: "site_1",
        email: "user@example.com",
        code: "123456",
      })
    ).rejects.toMatchObject({
      status: 401,
      reason: "invalid_code",
    });
  });

  it("rejects if OTP is expired", async () => {
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "user@example.com",
      codeHash: hashToken("123456"),
      attempts: 0,
      expiresAt: new Date(Date.now() - 1000), // in the past
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    await expect(
      verifyMemberOtp({
        siteId: "site_1",
        email: "user@example.com",
        code: "123456",
      })
    ).rejects.toMatchObject({
      status: 401,
      reason: "expired_code",
    });
  });

  it("increments attempt count on wrong code", async () => {
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "user@example.com",
      codeHash: hashToken("654321"),
      attempts: 1,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    vi.mocked(prisma.memberOtp.update).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "user@example.com",
      codeHash: hashToken("654321"),
      attempts: 2,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    await expect(
      verifyMemberOtp({
        siteId: "site_1",
        email: "user@example.com",
        code: "123456",
      })
    ).rejects.toMatchObject({
      status: 401,
      reason: "invalid_code",
    });

    expect(prisma.memberOtp.update).toHaveBeenCalledWith({
      where: { id: "otp_1" },
      data: { attempts: { increment: 1 } },
    });
  });

  it("burns the code and locks out after 3 failed attempts", async () => {
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "user@example.com",
      codeHash: hashToken("654321"),
      attempts: 2,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    vi.mocked(prisma.memberOtp.update).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "user@example.com",
      codeHash: hashToken("654321"),
      attempts: 3,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    await expect(
      verifyMemberOtp({
        siteId: "site_1",
        email: "user@example.com",
        code: "123456",
      })
    ).rejects.toMatchObject({
      status: 401,
      reason: "too_many_attempts",
    });

    expect(prisma.memberOtp.update).toHaveBeenCalledWith({
      where: { id: "otp_1" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("signs a registered member in with a correct code", async () => {
    const code = "123456";
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "member@example.com",
      codeHash: hashToken(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.memberOtp.update).mockResolvedValue({} as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "mem_1", emailVerifiedAt: null } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ id: "mem_1", email: "member@example.com", activeTier: "free_member" } as any);

    const member = await verifyMemberOtp({ siteId: "site_1", email: "member@example.com", code });

    expect(member.id).toBe("mem_1");
    expect(prisma.member.create).not.toHaveBeenCalled();
    // The code proves the address, so an unconfirmed member is confirmed.
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "mem_1" }, data: expect.objectContaining({ emailVerifiedAt: expect.any(Date) }) })
    );
  });

  it("never creates an account: an address with no member is refused like a wrong code", async () => {
    const code = "123456";
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "stranger@example.com",
      codeHash: hashToken(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.memberOtp.update).mockResolvedValue({} as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

    await expect(verifyMemberOtp({ siteId: "site_1", email: "stranger@example.com", code })).rejects.toMatchObject({
      status: 401,
      reason: "invalid_code",
    });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });
});
