/**
 * Webhooks, the pure part: events, payload, signature, retries, filters, and
 * which URLs may be called. No database and no network here, so every rule is
 * tested directly. Development doc:
 * memberframe/docs/development-docs/20-webhooks.md
 */

import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const WEBHOOK_EVENTS = [
  "member.created",
  "member.updated",
  "member.tier_changed",
  "member.deleted",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type DeliveryEvent = WebhookEvent | "webhook.test";

export const MAX_WEBHOOKS_PER_SITE = 10;
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Seconds to wait before attempt 2, 3, 4, 5, and 6. Attempt 1 is immediate,
 * and a delivery that fails all six is marked failed, about 9 hours in.
 */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && (WEBHOOK_EVENTS as ReadonlyArray<string>).includes(value);
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the documented header. */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${v1}`;
}

/** When the next attempt runs after `attempts` failures, or null to give up. */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_SECONDS[attempts - 1];
  if (delay === undefined) return null;
  return new Date(now.getTime() + delay * 1000);
}

// ============================================================================
// PAYLOAD
// ============================================================================

export interface WebhookTier {
  key: string;
  name: string;
}

export interface WebhookMember {
  id: string;
  email: string;
  name: string | null;
  status: string;
  tier: WebhookTier;
  emailVerified: boolean;
  createdAt: string;
  /** The creator's custom profile fields, by key. */
  profile: Record<string, unknown>;
}

export interface WebhookPayload {
  id: string;
  type: DeliveryEvent;
  createdAt: string;
  site: { id: string; name: string };
  member: WebhookMember;
  previousTier?: WebhookTier;
}

/** A tier key as the creator named it, or the key itself for one that is gone. */
export function tierOf(key: string, ladder: ReadonlyArray<{ key: string; name?: string }>): WebhookTier {
  return { key, name: ladder.find((tier) => tier.key === key)?.name ?? key };
}

export function buildPayload(input: {
  deliveryId: string;
  type: DeliveryEvent;
  now: Date;
  site: { id: string; name: string };
  member: {
    id: string;
    email: string;
    name: string | null;
    status: string;
    activeTier: string;
    emailVerifiedAt: Date | null;
    createdAt: Date;
    metadata: unknown;
  };
  ladder: ReadonlyArray<{ key: string; name?: string }>;
  previousTier?: string;
}): WebhookPayload {
  const metadata = input.member.metadata;
  const profile =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};

  return {
    id: input.deliveryId,
    type: input.type,
    createdAt: input.now.toISOString(),
    site: { id: input.site.id, name: input.site.name },
    member: {
      id: input.member.id,
      email: input.member.email,
      name: input.member.name,
      status: input.member.status,
      tier: tierOf(input.member.activeTier, input.ladder),
      emailVerified: input.member.emailVerifiedAt !== null,
      createdAt: input.member.createdAt.toISOString(),
      profile,
    },
    ...(input.previousTier !== undefined ? { previousTier: tierOf(input.previousTier, input.ladder) } : {}),
  };
}

// ============================================================================
// FIELD MAPPING: A CUSTOM BODY
// ============================================================================
// A webhook can send chosen values under the creator's own keys instead of
// the standard payload, so a CRM gets `{"Email": ..., "Last_Name": ...}`
// with nothing to reshape on its side.

/** The values a mapping can pick, besides `profile.<field key>`. */
export const FIELD_SOURCES = [
  "event.type",
  "event.id",
  "event.createdAt",
  "site.name",
  "member.id",
  "member.email",
  "member.name",
  "member.firstName",
  "member.lastName",
  "member.status",
  "member.tier.key",
  "member.tier.name",
  "member.emailVerified",
  "member.createdAt",
  "previousTier.key",
  "previousTier.name",
] as const;

export const MAX_FIELD_MAP = 50;

/** A key in a custom body: letters, digits, `_`, `-`, `.`; starts with a letter or `_`. */
export const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const PROFILE_SOURCE = /^profile\.[a-z][a-z0-9_]{0,39}$/;

export interface FieldMapping {
  source: string;
  key: string;
}

export function isFieldSource(value: string): boolean {
  return (FIELD_SOURCES as ReadonlyArray<string>).includes(value) || PROFILE_SOURCE.test(value);
}

/** Why a mapping cannot be saved, or null. Null and an empty list both mean the standard payload. */
export function fieldMapProblem(map: ReadonlyArray<FieldMapping>): string | null {
  if (map.length > MAX_FIELD_MAP) return `At most ${MAX_FIELD_MAP} fields.`;
  const keys = new Set<string>();
  for (const entry of map) {
    if (!isFieldSource(entry.source)) return `Unknown value: ${entry.source}`;
    if (!FIELD_KEY_PATTERN.test(entry.key)) {
      return `"${entry.key}" cannot be a key. Use letters, digits, _ - and ., starting with a letter.`;
    }
    if (keys.has(entry.key)) return `The key ${entry.key} is used twice.`;
    keys.add(entry.key);
  }
  return null;
}

/** First and last name from one name field. Zoho CRM requires a last name, so there always is one. */
export function splitName(name: string | null, email: string): { first: string | null; last: string } {
  const words = (name ?? "").trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return { first: null, last: email.split("@")[0] || email };
  if (words.length === 1) return { first: null, last: words[0]! };
  return { first: words.slice(0, -1).join(" "), last: words[words.length - 1]! };
}

/** One source's value from a payload, or null when this event does not have it. */
export function sourceValue(payload: WebhookPayload, source: string): unknown {
  const { member } = payload;
  if (source.startsWith("profile.")) return member.profile[source.slice("profile.".length)] ?? null;

  switch (source) {
    case "event.type":
      return payload.type;
    case "event.id":
      return payload.id;
    case "event.createdAt":
      return payload.createdAt;
    case "site.name":
      return payload.site.name;
    case "member.id":
      return member.id;
    case "member.email":
      return member.email;
    case "member.name":
      return member.name;
    case "member.firstName":
      return splitName(member.name, member.email).first;
    case "member.lastName":
      return splitName(member.name, member.email).last;
    case "member.status":
      return member.status;
    case "member.tier.key":
      return member.tier.key;
    case "member.tier.name":
      return member.tier.name;
    case "member.emailVerified":
      return member.emailVerified;
    case "member.createdAt":
      return member.createdAt;
    case "previousTier.key":
      return payload.previousTier?.key ?? null;
    case "previousTier.name":
      return payload.previousTier?.name ?? null;
    default:
      return null;
  }
}

/** The body a webhook sends: the standard payload, or a flat object of the mapped keys. */
export function webhookBody(payload: WebhookPayload, fieldMap: unknown): Record<string, unknown> {
  const map = readFieldMap(fieldMap);
  if (map.length === 0) return payload as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const entry of map) body[entry.key] = sourceValue(payload, entry.source);
  return body;
}

/** A stored mapping, keeping only well-formed entries. */
export function readFieldMap(value: unknown): FieldMapping[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is FieldMapping =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as FieldMapping).source === "string" &&
      typeof (entry as FieldMapping).key === "string" &&
      isFieldSource((entry as FieldMapping).source) &&
      FIELD_KEY_PATTERN.test((entry as FieldMapping).key)
  );
}

// ============================================================================
// WHICH WEBHOOKS RECEIVE AN EVENT
// ============================================================================

export interface WebhookFilter {
  enabled: boolean;
  events: unknown;
  tiers: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Whether a webhook receives this event for a member on these tiers. An empty
 * tier list is every plan. For a plan change both the old and the new plan
 * count, so a "Gold" webhook hears about members joining and leaving Gold.
 */
export function webhookWants(hook: WebhookFilter, event: WebhookEvent, tierKeys: ReadonlyArray<string>): boolean {
  if (!hook.enabled) return false;
  if (!stringList(hook.events).includes(event)) return false;
  const tiers = stringList(hook.tiers);
  return tiers.length === 0 || tierKeys.some((key) => tiers.includes(key));
}

// ============================================================================
// WHICH URLS MAY BE CALLED
// ============================================================================

/**
 * Whether an address is one our server must never call on a creator's
 * behalf: loopback, private, link-local (cloud metadata lives there),
 * carrier-grade NAT, unspecified, and their IPv6 equivalents.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const mapped = lower.startsWith("::ffff:") ? lower.slice(7) : "";
    return mapped !== "" && isIP(mapped) === 4 && isPrivateAddress(mapped);
  }

  return true;
}

/**
 * Why a URL cannot be a webhook, or null. The shape only; the address it
 * resolves to is checked again at send time, when DNS can have changed.
 */
export function webhookUrlProblem(raw: string, production: boolean): string | null {
  const value = raw.trim();
  if (value === "" || value.length > 1000) return "Enter the full address the service gave you.";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "That is not a web address.";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return "The address must start with https://";
  if (production && url.protocol !== "https:") return "The address must start with https://";
  if (url.username !== "" || url.password !== "") return "Put credentials in the service, not in the address.";

  if (production) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      return "That address is not reachable from the internet.";
    }
    if (isIP(host) !== 0 && isPrivateAddress(host)) return "That address is not reachable from the internet.";
  }

  return null;
}
