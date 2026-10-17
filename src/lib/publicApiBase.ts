/**
 * The address a payment gateway can reach this API on.
 *
 * `API_BASE_URL` in production. In development it is usually a loopback
 * address, which no gateway can post to, so Stripe refuses to register the
 * webhook and the others register one that never delivers. A tunnel such as
 * ngrok forwards the plugin's requests with `X-Forwarded-Proto: https` and its
 * own public host, and that host is used instead, so connecting a gateway
 * while developing registers a webhook that arrives.
 *
 * Never in production, where the configured address is the truth and the
 * Host header is whatever a client sent.
 */

import type { Request } from "express";
import { env } from "../config/env.js";

const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "::1" || name === "[::1]" || name.startsWith("127.") || name === "0.0.0.0";
}

function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).host);
  } catch {
    return true;
  }
}

export function publicApiBase(req: Request): string {
  if (env.isProduction || !isLoopbackUrl(env.apiBaseUrl)) return env.apiBaseUrl;

  const proto = first(req.headers["x-forwarded-proto"]);
  const host = first(req.headers["x-forwarded-host"]) ?? first(req.headers.host);
  if (proto !== "https" || !host || !HOST_PATTERN.test(host) || isLoopbackHost(host)) return env.apiBaseUrl;

  return `https://${host}`;
}
