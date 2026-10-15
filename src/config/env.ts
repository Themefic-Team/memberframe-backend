/**
 * Typed configuration, validated once at boot.
 *
 * Every value is read here and nowhere else, so `process.env` appears exactly
 * once in this codebase. A module that reaches for an environment variable
 * directly is reading something nothing validated.
 *
 * The validation is strict and fatal on purpose. A server that starts with a
 * broken mail configuration and discovers it at the first password reset is
 * worse than one that refuses to start: the first loses a member's reset, the
 * second loses nothing because it never served a request.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

// ============================================================================
// .env LOADING
// ============================================================================
// Hand-rolled rather than `dotenv`, because the parsing needed is ten lines and
// this file is the one place a dependency would read a secret.

function loadDotEnv(): void {
  const file = path.join(process.cwd(), ".env");

  let contents: string;
  try {
    contents = readFileSync(file, "utf-8");
  } catch {
    // No .env is legitimate: a container passes real environment variables.
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    // Strip one layer of matching quotes. A URL with a # in it needs them.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    // A real environment variable wins over the file, so a container override
    // works without editing anything.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

// ============================================================================
// READERS
// ============================================================================

const missing: string[] = [];
const invalid: string[] = [];

function str(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  missing.push(key);
  return "";
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;

  // Not parseInt: it accepts "5abc" and returns 5, so a typo becomes a silent
  // wrong value rather than an error anyone sees.
  if (!/^-?\d+$/.test(raw.trim())) {
    invalid.push(`${key} must be an integer, got "${raw}"`);
    return fallback;
  }

  return Number(raw.trim());
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;

  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;

  invalid.push(`${key} must be true or false, got "${raw}"`);
  return fallback;
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;

  const value = raw.trim() as T;
  if (allowed.includes(value)) return value;

  invalid.push(`${key} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return fallback;
}

// ============================================================================
// THE CONFIGURATION
// ============================================================================

const nodeEnv = oneOf("NODE_ENV", ["development", "test", "production"] as const, "development");
const mailDriver = oneOf("MAIL_DRIVER", ["log", "smtp"] as const, "log");

export const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  isTest: nodeEnv === "test",

  port: int("PORT", 4001),
  apiBaseUrl: str("API_BASE_URL", "http://127.0.0.1:4001"),

  database: {
    // Under test there is no .env and no MySQL, and a unit test that imports
    // this module for a rate-limit constant should not need either. The
    // placeholder is deliberately unreachable rather than a plausible local
    // URL, so a test that genuinely tries to connect fails loudly instead of
    // quietly talking to a real development database.
    url:
      nodeEnv === "test"
        ? (process.env["DATABASE_URL"] ?? "mysql://test:test@127.0.0.1:1/memberframe_test_unused")
        : str("DATABASE_URL"),
    connectionLimit: int("DATABASE_CONNECTION_LIMIT", 0),
  },

  session: {
    cookieName: str("SESSION_COOKIE_NAME", "mf_session"),
    ttlSeconds: int("SESSION_TTL_SECONDS", 86_400),
    rememberTtlSeconds: int("SESSION_REMEMBER_TTL_SECONDS", 2_592_000),
    crossSite: bool("SESSION_COOKIE_CROSS_SITE", false),
  },

  mail: {
    driver: mailDriver,
    fromAddress: str("MAIL_FROM_ADDRESS", "no-reply@memberframe.test"),
    fromName: str("MAIL_FROM_NAME", "MemberFrame"),
    host: process.env["MAIL_HOST"] ?? "",
    port: int("MAIL_PORT", 587),
    secure: bool("MAIL_SECURE", false),
    user: process.env["MAIL_USER"] ?? "",
    password: process.env["MAIL_PASSWORD"] ?? "",
  },

  passwordReset: {
    urlTemplate: str(
      "PASSWORD_RESET_URL_TEMPLATE",
      "https://example.framer.website/reset-password?token={token}"
    ),
    ttlSeconds: int("PASSWORD_RESET_TTL_SECONDS", 900),
  },

  otp: {
    ttlSeconds: int("OTP_TTL_SECONDS", 600),
    resendLockSeconds: int("OTP_RESEND_LOCK_SECONDS", 60),
    maxAttempts: int("OTP_MAX_ATTEMPTS", 3),
  },

  login: {
    maxFailures: int("LOGIN_MAX_FAILURES", 5),
    lockoutSeconds: int("LOGIN_LOCKOUT_SECONDS", 900),
  },

  rateLimit: {
    windowSeconds: int("RATE_LIMIT_WINDOW_SECONDS", 900),
    maxPerEmail: int("RATE_LIMIT_MAX_PER_EMAIL", 5),
    maxPerIp: int("RATE_LIMIT_MAX_PER_IP", 20),
  },
} as const;

// ============================================================================
// FATAL CHECKS
// ============================================================================

/** Rules that are not about presence but about coherence. */
function crossChecks(): void {
  if (env.mail.driver === "smtp" && env.mail.host === "") {
    invalid.push("MAIL_DRIVER=smtp needs MAIL_HOST. Use MAIL_DRIVER=log to skip sending.");
  }

  if (!env.passwordReset.urlTemplate.includes("{token}")) {
    invalid.push("PASSWORD_RESET_URL_TEMPLATE must contain {token} or the link cannot work.");
  }

  // Production-only, because these two are exactly the settings a developer
  // leaves at their local value and then deploys.
  if (env.isProduction) {
    if (!env.apiBaseUrl.startsWith("https://")) {
      invalid.push("API_BASE_URL must be https in production. A session cookie needs Secure.");
    }

    if (env.mail.driver === "log") {
      invalid.push("MAIL_DRIVER=log in production means no member ever receives an email.");
    }

    if (env.session.crossSite && !env.apiBaseUrl.startsWith("https://")) {
      invalid.push("SESSION_COOKIE_CROSS_SITE needs https. SameSite=None requires Secure.");
    }
  }
}

crossChecks();

if (missing.length > 0 || invalid.length > 0) {
  /**
   * Fatal everywhere except under test.
   *
   * Refusing to start is right for a server: one that boots with a broken mail
   * configuration and finds out at the first password reset has already lost
   * that member's reset. But `process.exit` at import time also makes every
   * module that imports this file untestable, and a unit test for rate-limit
   * arithmetic should not need a database URL to run.
   *
   * Under test the problems are printed and execution continues. Anything that
   * actually needs the missing value still fails, at the point of use, with an
   * error naming it.
   */
  const lines = [
    "",
    nodeEnv === "test"
      ? "Configuration problems (not fatal under test):"
      : "MemberFrame API cannot start: the configuration is incomplete.",
    "",
  ];

  if (missing.length > 0) {
    lines.push("Missing, with no safe default:");
    for (const key of missing) lines.push(`  ${key}`);
    lines.push("");
  }

  if (invalid.length > 0) {
    lines.push("Invalid:");
    for (const problem of invalid) lines.push(`  ${problem}`);
    lines.push("");
  }

  lines.push("Copy .env.example to .env and fill it in. Every value is documented there.");
  lines.push("");

  // Written to stderr rather than thrown: a stack trace above a configuration
  // problem buries the one line that says what to fix.
  process.stderr.write(lines.join("\n"));

  if (nodeEnv !== "test") process.exit(1);
}
