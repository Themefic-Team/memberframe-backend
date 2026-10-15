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
  },
}));

vi.mock("../src/lib/mailer.js", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  otpMail: vi.fn().mockReturnValue({ to: "test@example.com", subject: "Code", text: "123456", html: "<p>123456</p>" }),
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

  it("enforces resend cooldown if requested too soon", async () => {
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

  it("verifies correct code and auto-creates member if registration allowed", async () => {
    const code = "123456";
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "newmember@example.com",
      codeHash: hashToken(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    vi.mocked(prisma.memberOtp.update).mockResolvedValue({} as any);

    // Member does not exist yet
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

    // Created member
    vi.mocked(prisma.member.create).mockResolvedValue({
      id: "mem_new",
      siteId: "site_1",
      email: "newmember@example.com",
      name: null,
      activeTier: "free_member",
      status: "active",
    } as any);

    const member = await verifyMemberOtp({
      siteId: "site_1",
      email: "newmember@example.com",
      code,
    });

    expect(member.id).toBe("mem_new");
    expect(member.email).toBe("newmember@example.com");
    expect(member.activeTier).toBe("free_member");
    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(prisma.memberOtp.update).toHaveBeenCalledWith({
      where: { id: "otp_1" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("blocks auto-creation if allowRegistration is false", async () => {
    const code = "123456";
    vi.mocked(prisma.memberOtp.findFirst).mockResolvedValue({
      id: "otp_1",
      siteId: "site_1",
      email: "newmember@example.com",
      codeHash: hashToken(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + 500_000),
      resendAvailableAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    vi.mocked(prisma.memberOtp.update).mockResolvedValue({} as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

    vi.mocked(loadSiteSettings).mockResolvedValueOnce({
      auth: { allowRegistration: false },
    } as any);

    await expect(
      verifyMemberOtp({
        siteId: "site_1",
        email: "newmember@example.com",
        code,
      })
    ).rejects.toMatchObject({
      status: 403,
      reason: "registration_closed",
    });
  });
});
