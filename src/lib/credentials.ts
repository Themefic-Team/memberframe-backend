/**
 * Email and password rules. THE THIRD COPY.
 *
 * The other two are:
 *   src/utils/credentials.ts              the plugin side, unit tested
 *   src/canvas-components/MemberAuth.tsx  the published site
 *
 * Held together by `test/credentialsParity.test.ts` in the frontend package,
 * and now by `test/credentialsParity.test.ts` in this one, which reads the
 * frontend source across the directory boundary.
 *
 * THIS COPY IS THE ONLY ONE THAT IS A SECURITY CONTROL.
 *
 * The other two run in a browser, where a regex is advice to a cooperative
 * visitor and an attacker simply posts to the endpoint. This one runs on the
 * server, so it is the rule rather than the hint. That inversion is why the
 * copies must agree: a client that accepts what this file refuses produces a
 * cheerful form followed by a 400 with no field to blame.
 *
 * What this file still does not do, and what the real defences are: the hash in
 * `password.ts`, the lockout in `memberAuthService.ts`, the rate limit in
 * `middleware/rateLimit.ts`, and a check against a breached-password corpus,
 * which nothing here implements. The corpus is the one with the most effect and
 * the one still missing. See `05-member-auth.md` section 9.3.
 */

// ============================================================================
// POLICY CONSTANTS
// ============================================================================
// Byte-identical to the other two copies, and the parity test compares these
// as well as the functions. A matching function body with a different number
// would pass a naive comparison and still disagree.

/** FP-02 section 2.1: "min 8-character validation". */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * An upper bound, which is about denial of service rather than strength.
 *
 * This is the copy where that actually matters. Argon2id or scrypt will hash a
 * megabyte if asked, and an unbounded password field is a cheap way to burn
 * server CPU: the client cap is advice, this one is the limit.
 *
 * Conflict C15: bcrypt would silently truncate at 72 bytes, so two different
 * long passwords would unlock one account. `password.ts` uses scrypt, which has
 * no such ceiling.
 */
export const PASSWORD_MAX_LENGTH = 128;

/** The longest minimum a site may ask for. */
export const PASSWORD_POLICY_MAX_MIN = 64;

/** The rules a creator sets in Settings, Membership. Sign in never checks them. */
export interface PasswordPolicy {
  minLength: number;
  requireNumber: boolean;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireSymbol: boolean;
}

/** Below three characters the email check fires on ordinary words. */
export const EMAIL_FRAGMENT_MIN_LENGTH = 3;

/** Not a breach corpus. Those live elsewhere and weigh gigabytes. */
export const COMMON_PASSWORDS: ReadonlyArray<string> = [
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "qwerty123",
  "iloveyou",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "welcome1",
  "admin123",
  "letmein1",
  "monkey12",
  "abc12345",
  "trustno1",
  "superman",
];

// ============================================================================
// TYPES
// ============================================================================

export type PasswordProblem =
  | "too_short"
  | "too_long"
  | "needs_letter"
  | "needs_number"
  | "needs_uppercase"
  | "needs_lowercase"
  | "needs_symbol"
  | "contains_email"
  | "too_common";

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

// ============================================================================
// SHARED RULES. IDENTICAL IN ALL THREE COPIES
// ============================================================================

export function looksLikeEmail(value: string): boolean {
  const email = value.trim();
  if (email.length < 3 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function passwordProblems(
  password: string,
  email: string,
  policy: PasswordPolicy
): ReadonlyArray<PasswordProblem> {
  const problems: PasswordProblem[] = [];
  const value = String(password ?? "");
  const rules = readPasswordPolicy(policy);

  if (value.length < rules.minLength) problems.push("too_short");
  if (value.length > PASSWORD_MAX_LENGTH) problems.push("too_long");

  const lowered = value.toLowerCase();

  if (COMMON_PASSWORDS.includes(lowered)) problems.push("too_common");

  const localPart =
    String(email ?? "")
      .trim()
      .toLowerCase()
      .split("@")[0] ?? "";

  if (
    localPart.length >= EMAIL_FRAGMENT_MIN_LENGTH &&
    lowered.includes(localPart)
  ) {
    problems.push("contains_email");
  }

  // Always a letter; the rest as the site's rules say (05-member-auth.md 13).
  if (!/[a-zA-Z]/.test(value)) problems.push("needs_letter");
  if (rules.requireNumber && !/[0-9]/.test(value)) problems.push("needs_number");
  if (rules.requireUppercase && !/[A-Z]/.test(value)) problems.push("needs_uppercase");
  if (rules.requireLowercase && !/[a-z]/.test(value)) problems.push("needs_lowercase");
  if (rules.requireSymbol && !/[^a-zA-Z0-9]/.test(value)) problems.push("needs_symbol");

  return problems;
}

/**
 * The site's rules, read defensively: a length from 8 to 64, and a number
 * required unless the rules say otherwise, which is the rule before rules
 * could be set. Anything missing or malformed falls back to that.
 */
export function readPasswordPolicy(value: unknown): PasswordPolicy {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof PasswordPolicy, unknown>>;
  const length = Math.round(Number(raw.minLength));
  return {
    minLength: Number.isFinite(length) ? Math.min(PASSWORD_POLICY_MAX_MIN, Math.max(PASSWORD_MIN_LENGTH, length)) : PASSWORD_MIN_LENGTH,
    requireNumber: raw.requireNumber !== false,
    requireUppercase: raw.requireUppercase === true,
    requireLowercase: raw.requireLowercase === true,
    requireSymbol: raw.requireSymbol === true,
  };
}

export function passwordScore(password: string): PasswordScore {
  const value = String(password ?? "");
  if (value.length === 0) return 0;

  let score = 0;

  if (value.length >= PASSWORD_MIN_LENGTH) score += 1;
  if (value.length >= 12) score += 1;
  if (value.length >= 16) score += 1;

  const variety =
    (/[a-z]/.test(value) ? 1 : 0) +
    (/[A-Z]/.test(value) ? 1 : 0) +
    (/[0-9]/.test(value) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(value) ? 1 : 0);

  if (variety >= 3) score += 1;

  if (COMMON_PASSWORDS.includes(value.toLowerCase())) return 0;

  return Math.min(4, score) as PasswordScore;
}

// ============================================================================
// SERVER-SIDE ONLY
// ============================================================================

/**
 * The one call a route makes.
 *
 * `policy` is the site's rules from its settings (`auth.passwordPolicy`),
 * never anything the caller sends: the form follows the same rules, but only
 * this check counts. Whatever the rules, a password is at least 8 characters,
 * has a letter, is not common, and does not contain the email.
 */
export function isAcceptablePassword(password: string, email: string, policy: PasswordPolicy): boolean {
  return passwordProblems(password, email, policy).length === 0;
}

/** A new site's rules, and the rule before rules could be set: 8 characters, a letter, a number. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireNumber: true,
  requireUppercase: false,
  requireLowercase: false,
  requireSymbol: false,
};

/**
 * Normalize an address for storage and lookup.
 *
 * Trim and lowercase. The column collation is case insensitive and accent
 * SENSITIVE (`utf8mb4_0900_as_ci`, set in the hand-written migration), so MySQL
 * would match case for us. Doing it here as well means the stored value is
 * predictable rather than whatever the member happened to type, and it keeps
 * application-level comparisons consistent with the database's.
 *
 * Accents are deliberately preserved: an accented local part is a different
 * mailbox, not a typo.
 */
export function normalizeEmail(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}
