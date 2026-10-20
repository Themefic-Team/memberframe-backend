/**
 * The `state` a member sign-in carries through the provider and back
 * (31-sign-in-methods.md 4).
 *
 * Signed and short-lived. It names the site, the page that opened the sign in,
 * and the page the one-time code goes back to. Before 2026-10-20 it was plain
 * base64 JSON: anyone could write one whose `returnTo` was their own site, send
 * it to a member as a sign-in link, and receive that member's code. Now the
 * callback accepts only a state this server wrote, unchanged, within ten
 * minutes, and `returnTo` was checked against the site's allowlist when it was
 * written.
 *
 * Signed with INSTANCE_SEAL_SECRET (required in production) under its own
 * prefix, so a seal can never pass as a state or a state as a seal.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  siteId: string;
  origin: string;
  returnTo: string;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`oauth-state.${body}`).digest("base64url");
}

/** `<payload>.<signature>`, both base64url. */
export function signOAuthState(payload: OAuthStatePayload, now: number = Date.now(), secret: string = env.billing.instanceSealSecret): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: now + OAUTH_STATE_TTL_MS, nonce: randomBytes(9).toString("base64url") })
  ).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** The payload of a state this server signed, unexpired; otherwise null. */
export function verifyOAuthState(
  state: string | null | undefined,
  now: number = Date.now(),
  secret: string = env.billing.instanceSealSecret
): OAuthStatePayload | null {
  if (!state || !secret || state.length > 4096) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(body, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value["exp"] !== "number" || value["exp"] < now) return null;
    if (typeof value["siteId"] !== "string" || value["siteId"] === "") return null;
    return {
      siteId: value["siteId"],
      origin: typeof value["origin"] === "string" ? value["origin"] : "",
      returnTo: typeof value["returnTo"] === "string" ? value["returnTo"] : "",
    };
  } catch {
    return null;
  }
}
