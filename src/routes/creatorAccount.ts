/**
 * The hosted account page and its API. F19, 19-pro-lock-and-trial.md 2.1.
 *
 *   GET  /auth                       the page, opened by the plugin in a new tab
 *   GET  /auth/success               "Authentication Successful!", closes itself
 *   POST /api/account/code           email a six-digit code (sign in, sign up, reset)
 *   POST /api/account/verify         check it; sign in, create the account, or set a password
 *   POST /api/account/login          email and password
 *   GET  /api/account/google         Google sign in, and its /callback
 *   POST /api/account/google/mock    development only: BEAF's simulated Google sign in
 *
 * BEAF's behaviour, so every Framefic plugin signs customers in the same way:
 * signing in or resetting with an unknown address says "No account found",
 * signing up with a known one says it "already exists", and each error carries
 * a `message` the page shows as is. That names whether an address has an
 * account, as BEAF does; both routes are rate limited per address and per IP.
 *
 * Every success ends in `completeHandoff(sessionId, userId)`; the plugin's poll
 * on /api/connect/handoff picks it up. Same origin as the page, so no CORS.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";
import { ApiError, ok, route } from "../middleware/errors.js";
import { guardCredentialCheck, guardEmailSend } from "../middleware/rateLimit.js";
import { hashPassword, verifyAgainstNothing, verifyPassword } from "../lib/password.js";
import { renderAuthSuccessPage, renderCreatorAuthPage, renderMockGooglePage } from "../lib/creatorAuthPageHtml.js";
import { sendMail } from "../lib/mailer.js";
import {
  ACCOUNT_CODE_SCOPE,
  consumeCreatorCode,
  findOrCreateCreator,
  startConnect,
} from "../services/creatorAuthService.js";
import { completeHandoff, isValidSessionId } from "../services/creatorHandoffService.js";
import { teamNotice } from "../services/license/licenseMail.js";

export const authPageRouter = Router();
export const accountRouter = Router();

const sessionId = z.string().refine(isValidSessionId, { message: "invalid_session" });
const email = z.string().trim().toLowerCase().email().max(254);
/** BEAF's rule: at least 6 characters. */
const password = z.string().min(6).max(200);
const purpose = z.enum(["signin", "signup", "reset"]);

const readTheme = (value: unknown): "light" | "dark" => (value === "light" ? "light" : "dark");

/** An error the page shows word for word. */
const fail = (status: number, reason: string, message: string): ApiError => new ApiError(status, reason, message, { message });

const MESSAGES = {
  noAccount: "No account found with this email. Please sign up first.",
  exists: "An account with this email already exists. Please sign in.",
  invalidCode: "Invalid or expired verification code. Please request a new one.",
  invalidLogin: "Invalid email or password.",
  noPassword: "This account doesn't have a password yet. Sign in with an email code or Google.",
  resendTooSoon: "Please wait a minute before requesting another code.",
};

/** Where the page goes after any sign in: the success page, with the trial pill when one is coming. */
async function successUrl(userId: string, theme: "light" | "dark"): Promise<string> {
  const hadTrial = await prisma.pluginTrial.findFirst({ where: { userId }, select: { id: true } });
  return `/auth/success?theme=${theme}${hadTrial ? "" : "&trial=1"}`;
}

const themeOf = (req: Request): "light" | "dark" => readTheme(req.body?.theme ?? req.query["theme"]);

// ============================================================================
// THE PAGES
// ============================================================================

const pageHeaders = (res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
};

authPageRouter.get("/auth", (req: Request, res: Response) => {
  const id = req.query["sessionId"];
  pageHeaders(res);
  res.type("html").send(
    renderCreatorAuthPage({
      mode: req.query["mode"] === "register" ? "register" : "login",
      sessionId: isValidSessionId(id) ? id : "",
      theme: readTheme(req.query["theme"]),
      googleEnabled: googleConfigured() || googleMockAllowed(),
      error: req.query["error"] === "google" ? "Google sign in did not finish. Please try again." : "",
    })
  );
});

authPageRouter.get("/auth/success", (req: Request, res: Response) => {
  pageHeaders(res);
  res.type("html").send(renderAuthSuccessPage({ theme: readTheme(req.query["theme"]), trial: req.query["trial"] === "1" }));
});

// ============================================================================
// CODES AND PASSWORDS
// ============================================================================

accountRouter.post(
  "/code",
  route(async (req, res) => {
    const input = z.object({ email, sessionId, purpose: purpose.default("signin"), name: z.string().trim().max(255).optional() }).parse(req.body);
    guardEmailSend(req, "account", input.email);

    const user = await prisma.user.findUnique({ where: { email: input.email }, select: { name: true } });
    if (input.purpose === "signup" && user) throw fail(409, "account_exists", MESSAGES.exists);
    if (input.purpose !== "signup" && !user) throw fail(404, "no_account", MESSAGES.noAccount);

    try {
      await startConnect({
        email: input.email,
        framerProjectId: ACCOUNT_CODE_SCOPE,
        purpose: "account",
        accountPurpose: input.purpose,
        name: input.name || user?.name || "there",
      });
    } catch (error) {
      if (error instanceof ApiError && error.reason === "resend_too_soon") throw fail(429, "resend_too_soon", MESSAGES.resendTooSoon);
      throw error;
    }
    ok(res, { sent: true });
  })
);

accountRouter.post(
  "/verify",
  route(async (req, res) => {
    const input = z
      .object({
        email,
        sessionId,
        purpose: purpose.default("signin"),
        code: z.string().trim().regex(/^\d{6}$/),
        name: z.string().trim().max(255).optional(),
        password: password.optional(),
      })
      .parse(req.body);
    guardCredentialCheck(req, "account");

    const now = new Date();
    try {
      await consumeCreatorCode(input.email, input.code, ACCOUNT_CODE_SCOPE, now);
    } catch (error) {
      if (error instanceof ApiError && error.reason === "invalid_code") throw fail(401, "invalid_code", MESSAGES.invalidCode);
      throw error;
    }

    const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true, name: true } });
    if (input.purpose !== "signup" && !existing) throw fail(404, "no_account", MESSAGES.noAccount);
    if (input.purpose === "reset" && !input.password) throw fail(400, "password_required", "New password must be at least 6 characters.");

    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    const user = existing ?? (await findOrCreateCreator(input.email, input.name, now, passwordHash ? { passwordHash } : {}));
    if (existing && passwordHash) await prisma.user.update({ where: { id: existing.id }, data: { passwordHash } });

    if (!existing) {
      const notice = teamNotice("signup", { name: user.name, email: input.email }, { source: input.password ? "Email & password" : "Email code" });
      if (notice) void sendMail(notice);
    }

    await completeHandoff(input.sessionId, user.id, now);
    ok(res, { redirect: await successUrl(user.id, themeOf(req)) });
  })
);

accountRouter.post(
  "/login",
  route(async (req, res) => {
    const input = z.object({ email, sessionId, password: z.string().min(1).max(200) }).parse(req.body);
    guardCredentialCheck(req, "account");

    const user = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true, passwordHash: true } });
    if (user && !user.passwordHash) {
      await verifyAgainstNothing(input.password);
      throw fail(400, "no_password", MESSAGES.noPassword);
    }
    const valid = user?.passwordHash ? await verifyPassword(input.password, user.passwordHash) : await verifyAgainstNothing(input.password);
    if (!user || !valid) throw fail(401, "invalid_credentials", MESSAGES.invalidLogin);

    await completeHandoff(input.sessionId, user.id);
    ok(res, { redirect: await successUrl(user.id, themeOf(req)) });
  })
);

// ============================================================================
// GOOGLE
// ============================================================================

const googleRedirectUri = () => `${env.apiBaseUrl}/api/account/google/callback`;
const googleConfigured = (): boolean => env.billing.googleClientId !== "" && env.billing.googleClientSecret !== "";
/**
 * BEAF opens a "Simulate Google Sign In" form when it has no Google keys. That
 * form signs in as any address typed into it, so here it exists only off
 * production; production without keys hides the button instead.
 */
const googleMockAllowed = (): boolean => !googleConfigured() && !env.isProduction;

/** The end of every Google sign in, real or simulated: find or create the account, then hand off. */
async function finishGoogleSignIn(
  res: Response,
  id: string,
  theme: "light" | "dark",
  profile: { googleId: string | null; email: string; name: string | undefined; picture: string | undefined }
): Promise<void> {
  const address = profile.email.trim().toLowerCase();
  const known =
    (profile.googleId ? await prisma.user.findUnique({ where: { googleId: profile.googleId }, select: { id: true } }) : null) ??
    (await prisma.user.findUnique({ where: { email: address }, select: { id: true } }));
  const user =
    known ??
    (await findOrCreateCreator(address, profile.name, new Date(), {
      ...(profile.googleId ? { googleId: profile.googleId } : {}),
      avatarUrl: profile.picture,
    }));
  if (profile.googleId || profile.picture) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(profile.googleId ? { googleId: profile.googleId } : {}),
        ...(profile.picture ? { avatarUrl: profile.picture.slice(0, 1000) } : {}),
      },
    });
  }
  if (!known) {
    const notice = teamNotice("signup", { name: profile.name || address, email: address }, { source: "Google" });
    if (notice) void sendMail(notice);
  }

  await completeHandoff(id, user.id);
  res.redirect(302, await successUrl(user.id, theme));
}

accountRouter.get("/google", (req: Request, res: Response) => {
  const id = req.query["sessionId"];
  const theme = readTheme(req.query["theme"]);
  if (!isValidSessionId(id) || (!googleConfigured() && !googleMockAllowed())) {
    res.redirect(302, `/auth?theme=${theme}&error=google`);
    return;
  }
  if (!googleConfigured()) {
    pageHeaders(res);
    res.type("html").send(renderMockGooglePage({ sessionId: id, theme }));
    return;
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.billing.googleClientId);
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("prompt", "select_account");
  // The session id is the state: random, made by the plugin, and the only
  // thing the callback needs to finish the hand-off.
  url.searchParams.set("state", `${id}.${theme}`);
  res.redirect(302, url.toString());
});

accountRouter.get(
  "/google/callback",
  route(async (req, res) => {
    const [id = "", rawTheme = "dark"] = String(req.query["state"] ?? "").split(".");
    const theme = readTheme(rawTheme);
    const back = () => res.redirect(302, `/auth?sessionId=${encodeURIComponent(id)}&theme=${theme}&error=google`);
    const code = req.query["code"];
    if (!isValidSessionId(id) || typeof code !== "string") {
      back();
      return;
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.billing.googleClientId,
        client_secret: env.billing.googleClientSecret,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
      }),
    });
    const tokens = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
    if (!tokenResponse.ok || !tokens.access_token) {
      back();
      return;
    }

    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = (await profileResponse.json().catch(() => ({}))) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    // An unverified Google address proves nothing about who owns it.
    if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified !== true) {
      back();
      return;
    }

    await finishGoogleSignIn(res, id, theme, { googleId: profile.sub, email: profile.email, name: profile.name, picture: profile.picture });
  })
);

accountRouter.post(
  "/google/mock",
  route(async (req, res) => {
    if (!googleMockAllowed()) throw new ApiError(404, "not_found");
    const input = z
      .object({ sessionId, email, name: z.string().trim().min(1).max(255), theme: z.string().optional() })
      .parse(req.body);
    // No Google id: a simulated sign in must never claim a real Google account.
    await finishGoogleSignIn(res, input.sessionId, readTheme(input.theme), {
      googleId: null,
      email: input.email,
      name: input.name,
      picture: undefined,
    });
  })
);
