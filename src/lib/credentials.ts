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
  requireStrength: boolean
): ReadonlyArray<PasswordProblem> {
  const problems: PasswordProblem[] = [];
  const value = String(password ?? "");

  if (value.length < PASSWORD_MIN_LENGTH) problems.push("too_short");
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

  if (requireStrength) {
    if (!/[a-zA-Z]/.test(value)) problems.push("needs_letter");
    if (!/[0-9]/.test(value)) problems.push("needs_number");
  }

  return problems;
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
 * `requireStrength` is `true` here with no way to turn it off, unlike the
 * client where it is a creator-facing property control. A creator who unticks
 * "Strong Password" is choosing what their sign-up form nags about, not
 * choosing to let a one-character password into the database.
 */
export function isAcceptablePassword(password: string, email: string): boolean {
  return passwordProblems(password, email, true).length === 0;
}

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
