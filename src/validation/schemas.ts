/**
 * Request shapes.
 *
 * Zod rather than hand-rolled checks, for one reason: this is the front door,
 * and hand-rolled validators are exactly where an edge case hides. A schema
 * that rejects `{"email": {"$ne": null}}` without anyone thinking about it is
 * worth the dependency.
 *
 * Note what these schemas do NOT do. They check shape, not policy. Password
 * strength lives in `lib/credentials.ts` so that all three copies of the rule
 * stay identical and the parity test can compare them; duplicating a minimum
 * length here would create a fourth copy that nothing checks.
 *
 * A failure becomes a 400 with the offending fields named, handled centrally
 * in `middleware/errors.ts`. A 400 here means the request was malformed. A
 * refused credential is a 401, and conflating the two is how a wrong password
 * ends up rendering "something went wrong".
 */

import { z } from "zod";

/**
 * An email, loosely.
 *
 * Deliberately not `z.string().email()`. Zod's check is stricter than real
 * deliverability and rejects addresses that work, and the only cost of being
 * permissive is one wasted lookup. The same reasoning as `looksLikeEmail` in
 * the shared policy, and the same shape, so a client that passed its own check
 * is not refused here for a different reason.
 *
 * The 254 ceiling is the RFC 5321 limit on a path.
 */
const email = z
  .string({ required_error: "An email address is required." })
  .trim()
  .min(3, "That is too short to be an email address.")
  .max(254, "That is longer than any real email address.")
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "That does not look like an email address.");

/**
 * A password, as a transport value only.
 *
 * Bounded at 1024 rather than at the policy's 128. The two limits do different
 * jobs: this one stops a megabyte of text reaching the hashing function and
 * burning CPU, and the policy's is the rule a member is told about. Rejecting
 * at 129 here would produce a 400 where the member deserves a 400 with a
 * readable problem list, which is what `weak_password` carries.
 *
 * Not trimmed. A trailing space is part of the secret, and trimming it would
 * mean registering one string and signing in with another.
 */
const password = z
  .string({ required_error: "A password is required." })
  .min(1, "A password is required.")
  .max(1024, "That password is too long.");

/** An optional display name. Empty becomes null rather than an empty string. */
const optionalName = z
  .string()
  .trim()
  .max(255, "That name is too long.")
  .transform((value) => (value === "" ? null : value))
  .nullish()
  .transform((value) => value ?? null);

export const registerSchema = z.object({
  email,
  password,
  name: optionalName,
});

export const loginPasswordSchema = z.object({
  email,
  password,
  // Absent means false. The client sends it only when the box is ticked.
  rememberMe: z.boolean().optional().default(false),
});

export const forgotPasswordSchema = z.object({
  email,
});

export const resetPasswordSchema = z.object({
  token: z
    .string({ required_error: "A reset token is required." })
    .min(16, "That reset token is not valid.")
    .max(512, "That reset token is not valid."),
  newPassword: password,
});

export const sendOtpSchema = z.object({
  email,
});

export const verifyOtpSchema = z.object({
  email,
  // Exactly six digits. A length check alone would accept "12345a", which
  // cannot match a generated code and would still consume an attempt.
  code: z
    .string({ required_error: "A code is required." })
    .trim()
    .regex(/^\d{6}$/, "A code is six digits."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
