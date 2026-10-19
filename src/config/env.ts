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
    } else {
      // An unquoted value ends at " #", as dotenv reads it, so
      // `TRIAL_DURATION_MINUTES=10 # testing` is 10, not a refused integer.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
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

/**
 * A value copied from an example file and never filled in: "your-google-client-id...",
 * "whsec_your_webhook_signing_secret", "price_monthly_id_here". Read as unset, so a
 * half-filled .env turns a feature off instead of calling Stripe or Google with junk.
 */
function isPlaceholder(value: string): boolean {
  return /your[-_]/i.test(value) || /_here$/i.test(value);
}

/**
 * The first of several names that holds a real value. F19 billing reads
 * MemberFrame's own names first and the BEAF backend's after them, so one .env
 * layout works for every Framefic plugin (the company billing standard).
 */
function firstOf(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value && !isPlaceholder(value)) return value;
  }
  return "";
}

/** `int` over the first of several names that is set. */
function intOf(keys: string[], fallback: number): number {
  const key = keys.find((name) => (process.env[name] ?? "").trim() !== "");
  return key ? int(key, fallback) : fallback;
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
    /**
     * How the app signs in to MySQL. `prisma` is Prisma's own engine. `mariadb`
     * goes through the MariaDB JavaScript driver (`@prisma/adapter-mariadb`),
     * which also supports MySQL users on `sha256_password`, a login method
     * Prisma's engine refuses ("Unknown authentication plugin"). Migrations
     * follow the same choice: `node dist/migrate.js`.
     */
    driver: oneOf("DATABASE_DRIVER", ["prisma", "mariadb"] as const, "prisma"),
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
    /**
     * Whether a site's own SMTP host may be a private address or use any port
     * (25-custom-smtp.md section 3.1). On outside production, so a developer
     * can point a site at Mailpit; off in production, where it would let a
     * creator probe the platform's own network.
     */
    siteSmtpAllowPrivate: bool("SITE_SMTP_ALLOW_PRIVATE_HOSTS", nodeEnv !== "production"),
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

  payments: {
    /**
     * 32 bytes, base64. Encrypts every gateway secret at rest (`lib/secretBox.ts`).
     * Empty means payments are off: the payment routes answer 503 with
     * `payments_not_configured` rather than store a key in the clear.
     */
    encryptionKey: process.env["PAYMENTS_ENCRYPTION_KEY"] ?? "",
    /**
     * Development only. The `whsec_` secret `stripe listen` prints, accepted
     * for Stripe webhooks in addition to the stored one, so a forwarded test
     * event verifies without registering an endpoint. Ignored in production.
     */
    stripeCliWebhookSecret: process.env["STRIPE_CLI_WEBHOOK_SECRET"] ?? "",
    /** How often the expiry sweep runs, in seconds. F18 and period-end cancels. */
    sweepSeconds: int("PAYMENTS_SWEEP_SECONDS", 300),
  },

  /**
   * FP-12 protected files. `local` keeps uploads on this machine's disk, which
   * is right for one server with a persistent volume. `s3` keeps them in any
   * S3 compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO): set it
   * for more than one server, or a host whose disk is wiped on deploy.
   */
  assets: {
    driver: oneOf("ASSET_STORAGE", ["local", "s3"] as const, "local"),
    localDir: str("ASSET_STORAGE_DIR", "storage/assets"),
    maxBytes: int("ASSET_MAX_BYTES", 250 * 1024 * 1024),
    /** Seconds a download link works. PRD F10 and S5: 60. */
    linkSeconds: int("ASSET_LINK_SECONDS", 60),
    /**
     * Signs download links. Leave empty on one server: a random secret is made
     * at startup, which only ends links younger than a minute on a restart.
     * Set the same value on every server behind a load balancer.
     */
    signingSecret: process.env["ASSET_SIGNING_SECRET"] ?? "",
    s3: {
      /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.eu-west-1.amazonaws.com */
      endpoint: process.env["ASSET_S3_ENDPOINT"] ?? "",
      bucket: process.env["ASSET_S3_BUCKET"] ?? "",
      /** `auto` for R2. */
      region: process.env["ASSET_S3_REGION"] ?? "auto",
      accessKeyId: process.env["ASSET_S3_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: process.env["ASSET_S3_SECRET_ACCESS_KEY"] ?? "",
    },
  },

  /**
   * F19: what creators pay MemberFrame (19-pro-lock-and-trial.md). MemberFrame's
   * own Stripe account, entirely separate from the creators' gateway keys in
   * `payments` above, which take their members' money.
   */
  billing: {
    // Each also reads BEAF's name (STRIPE_SECRET_KEY, ...). See `firstOf`.
    stripeSecretKey: firstOf("PLATFORM_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"),
    stripePublishableKey: firstOf("PLATFORM_STRIPE_PUBLISHABLE_KEY", "STRIPE_PUBLISHABLE_KEY"),
    stripeWebhookSecret: firstOf("PLATFORM_STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"),
    /** Stripe price ids. The amounts shown in the panel are read from Stripe. */
    prices: {
      monthly: firstOf("PLATFORM_PRICE_MONTHLY", "STRIPE_PRICE_MONTHLY"),
      yearly: firstOf("PLATFORM_PRICE_YEARLY", "STRIPE_PRICE_YEARLY"),
      lifetime: firstOf("PLATFORM_PRICE_LIFETIME", "STRIPE_PRICE_LIFETIME"),
    },
    /** How many lifetime plans are sold before the offer closes. BEAF: 20. */
    lifetimeMax: intOf(["LIFETIME_MAX", "LIFETIME_DEAL_MAX_USERS"], 20),
    trialDays: int("TRIAL_DURATION_DAYS", 7),
    /** Testing only: a trial this many minutes long instead. 0 means use days. */
    trialMinutes: int("TRIAL_DURATION_MINUTES", 0),
    /** Where Stripe's billing portal sends the creator back to. */
    returnUrl: str("BILLING_RETURN_URL", "https://framer.com/projects"),
    /** BEAF's team notices. Empty sends none. */
    teamEmail: process.env["TEAM_NOTIFICATION_EMAIL"] ?? "",
    /**
     * Whether an unlicensed site is refused on the member API (402
     * license_inactive). On everywhere but unit tests, whose member route tests
     * predate F19 and mock no license.
     */
    enforce: bool("LICENSE_ENFORCEMENT", nodeEnv !== "test"),
    /** How often the trial and renewal job runs, in seconds. */
    jobSeconds: int("LICENSE_JOB_SECONDS", 3600),
    /**
     * Google sign in on the hosted account page (F19). MemberFrame's own OAuth
     * client, not a site's. Empty hides the Google button.
     */
    /**
     * Signs the seal the Builder puts on every component it inserts, so a
     * copied and pasted component can be told apart (27-instance-seal.md).
     * Required in production; development uses a fixed value so seals survive
     * a restart.
     */
    instanceSealSecret:
      process.env["INSTANCE_SEAL_SECRET"]?.trim() || (nodeEnv === "production" ? "" : "memberframe-development-instance-seal"),
    googleClientId: firstOf("CREATOR_GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID"),
    googleClientSecret: firstOf("CREATOR_GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"),
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

  if (env.assets.driver === "s3") {
    const s3 = env.assets.s3;
    if (!s3.endpoint.startsWith("https://") || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
      invalid.push(
        "ASSET_STORAGE=s3 needs ASSET_S3_ENDPOINT (https), ASSET_S3_BUCKET, ASSET_S3_ACCESS_KEY_ID and ASSET_S3_SECRET_ACCESS_KEY."
      );
    }
  }

  if (env.assets.linkSeconds < 10 || env.assets.linkSeconds > 600) {
    invalid.push("ASSET_LINK_SECONDS must be between 10 and 600. PRD F10 asks for 60.");
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

    if (env.payments.encryptionKey === "") {
      invalid.push("PAYMENTS_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -base64 32");
    }

    const billing = env.billing;
    if (!billing.stripeSecretKey || !billing.stripePublishableKey || !billing.stripeWebhookSecret) {
      invalid.push(
        "PLATFORM_STRIPE_SECRET_KEY, PLATFORM_STRIPE_PUBLISHABLE_KEY and PLATFORM_STRIPE_WEBHOOK_SECRET (or BEAF's STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET) are required in production: without them no creator can subscribe."
      );
    }
    if (!billing.prices.monthly || !billing.prices.yearly || !billing.prices.lifetime) {
      invalid.push("PLATFORM_PRICE_MONTHLY, PLATFORM_PRICE_YEARLY and PLATFORM_PRICE_LIFETIME (or STRIPE_PRICE_*) are required in production. Create them with: npm run stripe:prices");
    }
    if (!billing.instanceSealSecret) {
      invalid.push("INSTANCE_SEAL_SECRET is required in production. Generate one with: openssl rand -base64 32");
    }
    if (billing.trialMinutes > 0) {
      invalid.push("TRIAL_DURATION_MINUTES is for testing. Remove it in production.");
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
