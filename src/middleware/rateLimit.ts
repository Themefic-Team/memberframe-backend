/**
 * Rate limiting for the endpoints that send email or check a credential.
 *
 * PRD section 16.4 requires that OTP send "cannot be used to bomb a
 * third-party inbox". That needs two limits, not one:
 *
 *   per address  stops one mailbox being flooded
 *   per IP       stops one attacker walking a list of addresses at one
 *                request each, which the per-address limit never notices
 *
 * In memory, which is a real limitation and worth stating plainly: it resets
 * on restart and it does not coordinate across processes, so running two
 * instances behind a load balancer doubles every limit. That is acceptable
 * while this is one process and it is NOT acceptable at scale. The fix is a
 * shared store, Redis or a MySQL table, and backend PRD section 4.3 explains
 * why that is a deferral rather than an oversight.
 *
 * What is NOT in memory: the five-failure account lockout. That lives in
 * `members.failed_login_count` and `members.locked_until`, because a lockout
 * that a restart clears is not a lockout.
 */

import type { Request } from "express";
import { env } from "../config/env.js";
import { rateLimited } from "./errors.js";

interface Bucket {
  count: number;
  /** When the window ends, in epoch milliseconds. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Sweep expired buckets.
 *
 * Without this the map grows for every distinct address and IP ever seen,
 * which is a slow memory leak that looks like normal growth. Called on each
 * check rather than on a timer so there is no interval to leak in tests.
 */
function sweep(now: number): void {
  if (buckets.size < 1000) return;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface LimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Count one hit against a key.
 *
 * A fixed window, not a sliding one. A fixed window permits a burst across a
 * boundary, up to twice the limit in theory, and that is an acceptable
 * trade for not storing a timestamp per request.
 */
export function hit(key: string, max: number, windowSeconds: number, now = Date.now()): LimitDecision {
  sweep(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;

  if (existing.count > max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * The client's IP.
 *
 * `req.ip` already honours `X-Forwarded-For` when Express is told to trust the
 * proxy, which `app.ts` does only in production. That distinction matters:
 * trusting the header unconditionally lets any client set its own IP and
 * bypass the per-IP limit entirely by sending a new one each time.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Both limits for one email-sending request. Throws 429 on the first that trips.
 *
 * `scope` keeps the buckets separate per endpoint, so exhausting the OTP limit
 * does not also block a password reset. They are different actions with
 * different costs.
 */
export function guardEmailSend(req: Request, scope: string, email: string): void {
  const now = Date.now();

  const perEmail = hit(
    `${scope}:email:${email.toLowerCase()}`,
    env.rateLimit.maxPerEmail,
    env.rateLimit.windowSeconds,
    now
  );

  if (!perEmail.allowed) throw rateLimited(perEmail.retryAfterSeconds);

  const perIp = hit(
    `${scope}:ip:${clientIp(req)}`,
    env.rateLimit.maxPerIp,
    env.rateLimit.windowSeconds,
    now
  );

  if (!perIp.allowed) throw rateLimited(perIp.retryAfterSeconds);
}

/**
 * The per-IP limit for a credential check.
 *
 * Deliberately not per address. The account lockout in the database is the
 * per-address defence, and adding an in-memory one on top would let an
 * attacker lock a member out of their own account by making five bad guesses
 * and then letting the real owner meet a 429. The database lockout is
 * reversible and visible; this one would not be.
 */
export function guardCredentialCheck(req: Request, scope: string): void {
  const decision = hit(
    `${scope}:ip:${clientIp(req)}`,
    env.rateLimit.maxPerIp,
    env.rateLimit.windowSeconds
  );

  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

/** For tests, which must not inherit another test's counters. */
export function resetRateLimits(): void {
  buckets.clear();
}
