/**
 * The response contract, server side.
 *
 * The frontend's `src/services/apiClient.ts` is a five-arm discriminated union
 * mapping PRD section 10.6 one for one, with 32 tests behind it. Those tests
 * prove the client maps a 403 to `forbidden`. They prove nothing about whether
 * this server sends 403 where the contract says it should.
 *
 * This file is the other half. The helpers are the only way a route may answer,
 * so the status codes cannot drift from the union the client switches on.
 *
 *   2xx              -> ok
 *   401              -> unauthorized   signed out. Show the locked state
 *   403              -> forbidden      signed in, not entitled
 *   429              -> rate_limited   show the wait, never retry automatically
 *   anything else    -> unavailable    fail closed
 *
 * The trap this prevents: returning 400 for a bad password. The client has no
 * `bad_request` arm, so a 400 falls into `unavailable`, and a visitor who typed
 * the wrong password sees "something went wrong" instead of a sign-in error.
 * 400 is for a malformed request, never for a failed credential check.
 */

import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";

// ============================================================================
// THE ERROR TYPE ROUTES THROW
// ============================================================================

export class ApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    reason?: string,
    message?: string,
    extra: Record<string, unknown> = {}
  ) {
    super(message ?? reason ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

/**
 * 401. Not signed in, or the credential did not check out.
 *
 * Used for both "no session" and "wrong password", deliberately. FP-02 section
 * 3.4 rule 3 wants one indistinguishable answer for a wrong password and an
 * address that was never registered, and the status is part of what has to
 * match, not just the message.
 */
export const unauthorized = (reason?: string, extra?: Record<string, unknown>): ApiError =>
  new ApiError(401, reason, undefined, extra);

/** 403. The session is valid and the member is not entitled. */
export const forbidden = (reason?: string): ApiError => new ApiError(403, reason);

/** 429. Carries the wait, because the client renders it. */
export const rateLimited = (retryAfterSeconds: number): ApiError =>
  new ApiError(429, "rate_limited", undefined, { retryAfterSeconds });

/** 400. A malformed request. Never a failed credential check. */
export const badRequest = (reason?: string, extra?: Record<string, unknown>): ApiError =>
  new ApiError(400, reason, undefined, extra);

/** 404. Also what a cross-tenant read gets: see the note in `notFound`. */
export const notFound = (reason?: string): ApiError => new ApiError(404, reason);

// ============================================================================
// SUCCESS
// ============================================================================

export function ok<T extends Record<string, unknown>>(res: Response, body: T): void {
  res.status(200).json(body);
}

/** 200 with an empty object, for an endpoint whose answer is "done". */
export function okEmpty(res: Response): void {
  res.status(200).json({});
}

// ============================================================================
// THE HANDLERS
// ============================================================================

/** Anything that reached the router and matched nothing. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ reason: "not_found", path: req.path });
}

/**
 * The last stop. Four kinds of thing arrive here.
 *
 * Registered with `app.use` after the routes, and it has to take four
 * arguments even though `next` is unused, because that is how Express
 * recognises an error handler.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Already answered. Writing a second status would throw inside the handler.
  if (res.headersSent) return;

  const origin = req.header("origin");
  if (origin && !res.getHeader("Access-Control-Allow-Origin")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  // 1. A route said what it meant.
  if (error instanceof ApiError) {
    if (error.status === 429) {
      const retry = Number(error.extra["retryAfterSeconds"] ?? 60);
      // The header as well as the body. The body is what this client reads,
      // and the header is what every other HTTP client in the world reads.
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retry))));
    }

    res.status(error.status).json({
      ...(error.reason ? { reason: error.reason } : {}),
      ...error.extra,
    });
    return;
  }

  // 2. A request body failed validation. 400, with the fields named, because
  //    this genuinely is a malformed request rather than a refused one.
  if (error instanceof ZodError) {
    res.status(400).json({
      reason: "invalid_request",
      fields: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  // 3. Prisma could not reach MySQL, or the schema is behind the client. A
  //    503 rather than a 500: the client treats both as `unavailable`, and 503
  //    is the honest one for a dependency that is down.
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("Can't reach database server") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Prisma Client")
  ) {
    process.stderr.write(`[500] database: ${message}\n`);
    res.status(503).json({ reason: "service_unavailable" });
    return;
  }

  // 4. Something unforeseen. Logged in full, reported as nothing.
  //    An exception message can carry a query, a column name, or an email
  //    address, and none of that belongs in a response a visitor can read.
  process.stderr.write(
    `[500] ${message}\n${error instanceof Error ? (error.stack ?? "") : ""}\n`
  );

  res.status(500).json({
    reason: "server_error",
    // Only outside production, where it saves a trip to the terminal.
    ...(env.isProduction ? {} : { detail: message }),
  });
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler`.
 *
 * Express 4 does not catch rejections from an async function: the request hangs
 * until the client gives up, with nothing in the log. Express 5 fixes this, and
 * this wrapper is what makes the 4 to 5 upgrade a no-op rather than a hunt.
 */
export function route(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
