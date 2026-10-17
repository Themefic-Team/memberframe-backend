/**
 * Encryption at rest for gateway secrets. PRD section 11.2, backend PRD B3.
 *
 * AES-256-GCM with a random 12-byte IV per value. The output is one string:
 *
 *   v1.<iv base64>.<auth tag base64>.<ciphertext base64>
 *
 * The version prefix is what makes key rotation possible later: a `v2` value
 * can be read with a new key while `v1` values are re-encrypted on next save.
 *
 * GCM authenticates as well as encrypts, so a value edited in the database
 * fails to decrypt rather than decrypting to something else. That matters
 * here: a tampered Stripe key that still "decrypts" would send a creator's
 * buyers to someone else's account.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";

const VERSION = "v1";
const IV_BYTES = 12;

function key(): Buffer {
  const raw = env.payments.encryptionKey;
  if (raw === "") {
    throw new ApiError(503, "payments_not_configured");
  }

  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error("PAYMENTS_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  }
  return bytes;
}

/** True when the server can store gateway secrets at all. */
export function secretsAvailable(): boolean {
  return env.payments.encryptionKey !== "";
}

export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unreadable sealed value.");
  }

  const [, iv, tag, ciphertext] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Seal an object of secrets as one value. */
export function sealJson(value: Record<string, string>): string {
  return seal(JSON.stringify(value));
}

export function openJson(sealed: string): Record<string, string> {
  const parsed = JSON.parse(open(sealed)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** The last four characters, for "•••• 4fQ2". Never more. */
export function maskedSuffix(value: string): string {
  return value.length <= 4 ? "" : value.slice(-4);
}
