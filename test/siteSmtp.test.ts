/**
 * A site's own SMTP. Development doc: 25-custom-smtp.md.
 *
 * Three things are pinned. The values a creator types are checked the same way
 * on every save. The host can never be steered at the platform's own network,
 * by an IP literal, a local name, or a DNS answer. And a member email tries the
 * site's server first and falls back to the platform sender when it fails, so
 * a creator's broken settings never lock a member out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ emailLog: { create: vi.fn(async (_args: unknown) => ({})), findFirst: vi.fn() } }));
vi.mock("../src/config/db.js", () => ({ prisma: db }));

const settings = vi.hoisted(() => ({ integrations: {} as Record<string, unknown> }));
vi.mock("../src/services/settingsService.js", () => ({
  loadSiteSettings: vi.fn(async () => settings),
  invalidateSiteSettings: vi.fn(),
}));
vi.mock("../src/services/integrationSecrets.js", () => ({
  readIntegrationSecret: vi.fn(async () => "app-password"),
}));

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ options: Record<string, unknown>; mail: Record<string, unknown> }>, fail: "" }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => ({
      sendMail: async (mail: Record<string, unknown>) => {
        // The platform transport has no `tls.servername`; the site's always has the key.
        const isSite = "tls" in options;
        if (isSite && smtp.fail) throw new Error(smtp.fail);
        smtp.sent.push({ options, mail });
        return { messageId: isSite ? "site-1" : "platform-1" };
      },
      close: () => undefined,
    }),
  },
}));

import { isPrivateAddress, readSiteSmtp, resolveMailHost, smtpValueProblems, transportOptions } from "../src/lib/siteSmtp.js";
import { sendMail, sendWithSiteSmtp, otpMail } from "../src/lib/mailer.js";
import { validatePatch } from "../src/lib/siteSettings.js";
import { env } from "../src/config/env.js";

const GOOD = {
  host: "smtp.example.com",
  port: "587",
  security: "starttls",
  username: "apikey",
  fromName: "Tabfolio",
  fromAddress: "hello@tabfolio.com",
  replyTo: "",
};

describe("the values", () => {
  it("accepts a complete configuration", () => {
    expect(smtpValueProblems(GOOD, false)).toEqual([]);
    expect(readSiteSmtp(GOOD, false)).toMatchObject({ host: "smtp.example.com", port: 587, security: "starttls" });
  });

  it("names each bad value", () => {
    const keys = smtpValueProblems(
      { host: "", port: "abc", security: "tls9", fromAddress: "nope", fromName: "Two\nlines", replyTo: "x" },
      false
    ).map((problem) => problem.key);
    expect(keys).toEqual(["host", "port", "security", "fromAddress", "fromName", "replyTo"]);
  });

  it("refuses private hosts and odd ports in production, and allows them in development", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.2", "169.254.169.254", "mail.internal"]) {
      expect(smtpValueProblems({ ...GOOD, host }, false).map((problem) => problem.key)).toEqual(["host"]);
      expect(smtpValueProblems({ ...GOOD, host }, true)).toEqual([]);
    }
    expect(smtpValueProblems({ ...GOOD, port: "1025" }, false).map((problem) => problem.key)).toEqual(["port"]);
    expect(smtpValueProblems({ ...GOOD, port: "1025" }, true)).toEqual([]);
  });
});

describe("private addresses", () => {
  it("covers IPv4, IPv6, and IPv4 written as IPv6", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ["8.8.8.8", "142.250.80.37", "2607:f8b0:4004:800::200e"]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it("refuses a name that resolves to any private address, not just the first", async () => {
    const answers = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.7" }];
    await expect(resolveMailHost("smtp.evil.test", false, answers)).rejects.toThrow("private address");
    await expect(resolveMailHost("smtp.ok.test", false, async () => [{ address: "93.184.216.34" }])).resolves.toBe("93.184.216.34");
  });

  it("connects to the resolved address and checks the certificate against the typed name", () => {
    const options = transportOptions(readSiteSmtp(GOOD, false)!, "pw", "93.184.216.34");
    expect(options.host).toBe("93.184.216.34");
    expect(options.tls.servername).toBe("smtp.example.com");
    expect(options.requireTLS).toBe(true);
    expect(options.secure).toBe(false);
  });
});

describe("saving", () => {
  it("refuses to turn custom SMTP on with a bad value, and allows turning it off", () => {
    const on = validatePatch({ integrations: { custom_smtp: { enabled: true, values: { ...GOOD, host: "" } } } });
    expect(on.map((problem) => problem.path)).toContain("integrations.custom_smtp.values.host");

    const off = validatePatch({ integrations: { custom_smtp: { enabled: false, values: { host: "" } } } });
    expect(off).toEqual([]);
  });
});

describe("sending", () => {
  beforeEach(() => {
    smtp.sent = [];
    smtp.fail = "";
    db.emailLog.create.mockClear();
    // Development allows private hosts, so the IP below needs no DNS.
    settings.integrations = { custom_smtp: { enabled: true, values: { ...GOOD, host: "127.0.0.1", port: "1025" }, secretsPresent: ["password"] } };
  });

  const drivers = () => db.emailLog.create.mock.calls.map((call) => (call[0] as { data: { driver: string } }).data.driver);

  it("sends a member email through the site's own server, from the site's address", async () => {
    const result = await sendMail(otpMail("member@example.com", "123456", "Tabfolio", "site_1"));
    expect(result).toMatchObject({ sent: true, messageId: "site-1" });
    expect(smtp.sent[0]!.mail["from"]).toBe('"Tabfolio" <hello@tabfolio.com>');
    expect(drivers()).toEqual(["site_smtp"]);
  });

  it("falls back to the platform sender when the site's server fails, and logs both", async () => {
    smtp.fail = "535 Authentication failed";
    const result = await sendMail(otpMail("member@example.com", "123456", "Tabfolio", "site_1"));
    expect(result.sent).toBe(true);
    expect(drivers()).toEqual(["site_smtp", env.mail.driver]);
    const failed = db.emailLog.create.mock.calls[0]![0] as { data: { error: string; sentAt: Date | null } };
    expect(failed.data).toMatchObject({ error: "535 Authentication failed", sentAt: null });
  });

  it("uses the platform sender when custom SMTP is off", async () => {
    settings.integrations = { custom_smtp: { enabled: false, values: GOOD, secretsPresent: ["password"] } };
    await sendMail(otpMail("member@example.com", "123456", "Tabfolio", "site_1"));
    expect(drivers()).toEqual([env.mail.driver]);
  });

  it("tests the site's server with no fallback", async () => {
    smtp.fail = "Connection timeout";
    const result = await sendWithSiteSmtp("site_1", otpMail("me@example.com", "1", "Tabfolio", "site_1"));
    expect(result).toMatchObject({ sent: false, error: "Connection timeout" });
    expect(drivers()).toEqual(["site_smtp"]);
  });
});
