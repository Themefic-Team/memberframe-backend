/**
 * The rules behind a member's own account area (memberframe
 * docs/development-docs/33-member-account.md). Pure, so each is tested without
 * a database: the routes in `routes/memberAccount.ts` only load and save.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

// ============================================================================
// DEVICES
// ============================================================================

/**
 * A short, readable name for the browser a session was opened in, such as
 * "Chrome on Windows". Only the user agent is read: the session's IP address
 * is never shown to the member or sent anywhere.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (ua === "") return "Unknown device";

  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /SamsungBrowser\//.test(ua)
          ? "Samsung Internet"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua) && /Version\//.test(ua)
              ? "Safari"
              : "";

  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";

  if (browser && system) return `${browser} on ${system}`;
  return browser || system || "Unknown device";
}

// ============================================================================
// SIGN-IN METHODS
// ============================================================================

/**
 * Whether unlinking `provider` leaves the member a way back in: a password,
 * or another linked provider. Unlinking the last one would lock them out of
 * their own account.
 */
export function canUnlink(provider: string, hasPassword: boolean, providers: ReadonlyArray<string>): boolean {
  if (!providers.includes(provider)) return false;
  return hasPassword || providers.some((other) => other !== provider);
}

// ============================================================================
// DELETING THE ACCOUNT
// ============================================================================

export interface SubscriptionState {
  status: string;
  interval: string;
  cancelAtPeriodEnd: boolean;
}

/**
 * A plan that will charge the member again. Deleting the account does not
 * cancel at the payment provider, so the member cancels in Membership first.
 * A lifetime purchase, a plan already set to end, or one that has ended is no
 * obstacle.
 */
export function blocksAccountDeletion(subscription: SubscriptionState): boolean {
  if (subscription.interval === "lifetime") return false;
  if (subscription.cancelAtPeriodEnd) return false;
  return subscription.status === "active" || subscription.status === "past_due";
}

/** The typed confirmation must be the member's own address, ignoring case and spaces. */
export function confirmsEmail(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase() && email.trim() !== "";
}

// ============================================================================
// PROFILE PHOTO
// ============================================================================

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type AvatarType = "image/png" | "image/jpeg" | "image/webp";

/**
 * The image type from the file's own first bytes, or null. The declared type
 * is not trusted: anything that is not really a PNG, JPEG, or WebP is refused,
 * so the public photo address can never serve script or markup.
 */
export function sniffImageType(bytes: Uint8Array): AvatarType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

const AVATAR_TYPE_CODES: Record<AvatarType, string> = { "image/png": "p", "image/jpeg": "j", "image/webp": "w" };

interface AvatarPayload {
  storageKey: string;
  type: AvatarType;
}

function avatarSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`avatar.${body}`).digest("base64url");
}

/**
 * The public token for a stored photo: the storage key and type, signed. The
 * address needs no database lookup and cannot be forged or edited to name
 * another file. Same secret as the instance seal and OAuth state, with its own
 * prefix so a token of one kind is never valid as another.
 */
export function signAvatarToken(payload: AvatarPayload, secret: string = env.billing.instanceSealSecret): string {
  const body = Buffer.from(`${AVATAR_TYPE_CODES[payload.type]}.${payload.storageKey}`, "utf8").toString("base64url");
  return `${body}.${avatarSignature(body, secret)}`;
}

export function verifyAvatarToken(token: string, secret: string = env.billing.instanceSealSecret): AvatarPayload | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(avatarSignature(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const decoded = Buffer.from(body, "base64url").toString("utf8");
  const dot = decoded.indexOf(".");
  if (dot < 1) return null;
  const code = decoded.slice(0, dot);
  const storageKey = decoded.slice(dot + 1);
  const type = (Object.keys(AVATAR_TYPE_CODES) as AvatarType[]).find((key) => AVATAR_TYPE_CODES[key] === code);
  if (!type || storageKey === "") return null;
  return { storageKey, type };
}

/** The token inside one of our own photo addresses, or null for any other address (a Google photo). */
export function avatarTokenFromUrl(url: string | null | undefined): string | null {
  const match = /\/api\/avatars\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(url ?? "");
  return match ? match[1]! : null;
}
