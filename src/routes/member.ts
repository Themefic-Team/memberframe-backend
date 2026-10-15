/**
 * The member runtime routes.
 *
 * Called by `<MemberAuth>` and `<MemberGate>` on a creator's published site.
 * Every path here matches what those components already call, because they are
 * deployed inside generated files on real sites and are the most expensive
 * thing in the system to change. Backend PRD section 6.1 has the reconciliation
 * table.
 *
 * Each handler is thin on purpose: validate, call a service, set a cookie,
 * answer. The decisions live in `services/`, where they can be read without
 * Express in the way.
 */

import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";
import { badRequest, forbidden, ok, okEmpty, route, unauthorized } from "../middleware/errors.js";
import { requireSite } from "../middleware/site.js";
import { guardCredentialCheck, guardEmailSend } from "../middleware/rateLimit.js";
import { clearSessionCookie, sessionLifetimeSeconds, setSessionCookie } from "../lib/cookies.js";
import {
  registerMember,
  requestPasswordReset,
  resetPassword,
  sendMemberOtp,
  signInWithPassword,
  verifyMemberOtp,
} from "../services/memberAuthService.js";
import {
  issueSession,
  loadSession,
  loadTierLadder,
  revokeAllSessionsForMember,
  revokeSession,
  touchSession,
} from "../services/sessionService.js";
import { loadSiteSettings } from "../services/settingsService.js";
import { applyMetadata, publicFieldDefinitions } from "../lib/memberMetadata.js";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  forgotPasswordSchema,
  loginPasswordSchema,
  registerSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from "../validation/schemas.js";

export const memberRouter = Router();

/**
 * Shape a member for the wire.
 *
 * One place, so no endpoint can accidentally serialize a column the client
 * must not see. `passwordHash` is the obvious one; `failedLoginCount` and
 * `lockedUntil` matter too, because either would say whether an address is
 * registered.
 *
 * `currentPeriodEnd` and `gracePeriodEndsAt` are zero until the subscriptions
 * table exists (backend PRD phase B3). `isEntitled` reads them only on the
 * `past_due` and `canceled` branches, so a zero can only deny access, never
 * grant it, which is the right direction to be wrong in.
 */
function memberPayload(member: {
  id: string;
  siteId: string;
  email: string;
  name: string | null;
  activeTier: string;
  status: string;
}) {
  return {
    memberId: member.id,
    email: member.email,
    name: member.name,
    activeTier: member.activeTier,
    status: member.status,
    currentPeriodEnd: 0,
    gracePeriodEndsAt: 0,
    siteId: member.siteId,
  };
}

// ============================================================================
// GET /api/member/session
// ============================================================================
// What `<MemberGate>` calls on every page load. A 401 is not an error here: it
// is the ordinary answer for a visitor who is not signed in, and the component
// renders its locked state. Returning anything else would make the gate show a
// failure message to someone who simply has not signed in.

const handleSession = route(async (req: Request, res: Response) => {
  const site = requireSite(req);
  const token = req.cookies?.[env.session.cookieName] as string | undefined;

  const session = await loadSession(token, site.id);

  if (!session) {
    // The tier ladder goes out even when nobody is signed in. The gate needs
    // it to interpret its own `requiredTier`, and withholding it would force
    // the component back onto its hardcoded default, which is conflict C5.
    res.status(401).json({ tiers: await loadTierLadder(site.id) });
    return;
  }

  void touchSession(session.sessionId);

  ok(res, { member: session.member, tiers: session.tiers });
});

memberRouter.get("/session", handleSession);
memberRouter.post("/session", handleSession);

// ============================================================================
// POST /api/member/register
// ============================================================================

memberRouter.post(
  "/register",
  route(async (req, res) => {
    const site = requireSite(req);
    const input = registerSchema.parse(req.body);

    // A creator can close registration from the Settings tab, for an
    // invite-only or a sold-out membership. 403 rather than 404: the endpoint
    // exists and the caller is refused, which is the distinction the client's
    // `forbidden` arm is for, and `<MemberAuth>` renders it as a message
    // rather than as a failure.
    const settings = await loadSiteSettings(site.id);
    if (!settings.auth.allowRegistration) throw forbidden("registration_closed");

    // Rate limited as an email-sending action even though it sends none yet:
    // creating accounts in bulk is the abuse to stop, and a verification email
    // is a near-term addition.
    guardEmailSend(req, "register", input.email);

    const member = await registerMember({
      siteId: site.id,
      email: input.email,
      password: input.password,
      name: input.name,
    });

    const ttl = sessionLifetimeSeconds(false);
    const session = await issueSession(member.id, site.id, ttl, {
      userAgent: req.header("user-agent"),
      ipAddress: req.ip,
    });

    setSessionCookie(res, session.token, { maxAgeSeconds: ttl });

    ok(res, { member: memberPayload(member), tiers: await loadTierLadder(site.id) });
  })
);

// ============================================================================
// POST /api/member/login-password
// ============================================================================

memberRouter.post(
  "/login-password",
  route(async (req, res) => {
    const site = requireSite(req);
    const input = loginPasswordSchema.parse(req.body);

    // Per IP only. The per-address defence is the database lockout, and adding
    // an in-memory per-address limit here would let an attacker lock a member
    // out of their own account with five guesses. See `rateLimit.ts`.
    guardCredentialCheck(req, "login");

    const member = await signInWithPassword({
      siteId: site.id,
      email: input.email,
      password: input.password,
    });

    const ttl = sessionLifetimeSeconds(input.rememberMe);
    const session = await issueSession(member.id, site.id, ttl, {
      userAgent: req.header("user-agent"),
      ipAddress: req.ip,
    });

    setSessionCookie(res, session.token, { maxAgeSeconds: ttl });

    ok(res, { member: memberPayload(member), tiers: await loadTierLadder(site.id) });
  })
);

// ============================================================================
// POST /api/member/forgot-password
// ============================================================================
// Always 200. FP-02 section 3.4 rule 3: an unregistered address and a
// registered one must be indistinguishable, so there is no branch here to get
// wrong. The service returns void precisely so a future edit cannot start
// reporting which case it was.

memberRouter.post(
  "/forgot-password",
  route(async (req, res) => {
    const site = requireSite(req);
    const input = forgotPasswordSchema.parse(req.body);

    guardEmailSend(req, "forgot", input.email);

    await requestPasswordReset({
      siteId: site.id,
      siteName: site.siteName,
      email: input.email,
    });

    okEmpty(res);
  })
);

// ============================================================================
// POST /api/member/reset-password
// ============================================================================

memberRouter.post(
  "/reset-password",
  route(async (req, res) => {
    const site = requireSite(req);
    const input = resetPasswordSchema.parse(req.body);

    guardCredentialCheck(req, "reset");

    const result = await resetPassword({
      siteId: site.id,
      token: input.token,
      newPassword: input.newPassword,
    });

    // Sign them in on the device that completed the reset. Every other session
    // was revoked inside the service, which is what makes this a recovery.
    const ttl = sessionLifetimeSeconds(false);
    const session = await issueSession(result.memberId, site.id, ttl, {
      userAgent: req.header("user-agent"),
      ipAddress: req.ip,
    });

    setSessionCookie(res, session.token, { maxAgeSeconds: ttl });

    const member = await prisma.member.findUnique({
      where: { id: result.memberId },
      select: {
        id: true,
        siteId: true,
        email: true,
        name: true,
        activeTier: true,
        status: true,
      },
    });

    if (!member) throw unauthorized("invalid_token");

    ok(res, { member: memberPayload(member), tiers: await loadTierLadder(site.id) });
  })
);

// ============================================================================
// POST /api/member/send-otp
// ============================================================================

memberRouter.post(
  "/send-otp",
  route(async (req, res) => {
    const site = requireSite(req);
    const input = sendOtpSchema.parse(req.body);

    guardEmailSend(req, "otp", input.email);

    const result = await sendMemberOtp({
      siteId: site.id,
      siteName: site.siteName,
      email: input.email,
    });

    ok(res, result);
  })
);

// ============================================================================
// POST /api/member/verify-otp
// ============================================================================

memberRouter.post(
  "/verify-otp",
  route(async (req, res) => {
    const site = requireSite(req);
    const input = verifyOtpSchema.parse(req.body);

    guardCredentialCheck(req, "otp");

    const member = await verifyMemberOtp({
      siteId: site.id,
      email: input.email,
      code: input.code,
    });

    const ttl = sessionLifetimeSeconds(false);
    const session = await issueSession(member.id, site.id, ttl, {
      userAgent: req.header("user-agent"),
      ipAddress: req.ip,
    });

    setSessionCookie(res, session.token, { maxAgeSeconds: ttl });

    ok(res, { member: memberPayload(member), tiers: await loadTierLadder(site.id) });
  })
);

// ============================================================================
// POST /api/member/logout
// ============================================================================
// 200 whether or not a session was found. "You are signed out" is true either
// way, and a 401 here would make a double-click look like a failure.

memberRouter.post(
  "/logout",
  route(async (req, res) => {
    requireSite(req);
    const token = req.cookies?.[env.session.cookieName] as string | undefined;

    if (token) await revokeSession(token);

    clearSessionCookie(res);
    okEmpty(res);
  })
);

// ============================================================================
// POST /api/member/logout-everywhere
// ============================================================================
// Not in any plan, and two lines given the machinery exists. A member who
// suspects someone else is signed in as them has no other way to act on it,
// and the alternative is telling them to change their password to achieve a
// side effect.

memberRouter.post(
  "/logout-everywhere",
  route(async (req, res) => {
    const site = requireSite(req);
    const token = req.cookies?.[env.session.cookieName] as string | undefined;

    const session = await loadSession(token, site.id);
    if (!session) throw unauthorized();

    const revoked = await revokeAllSessionsForMember(session.member.memberId);

    clearSessionCookie(res);
    ok(res, { sessionsRevoked: revoked });
  })
);


// ============================================================================
// GET /api/member/profile
// ============================================================================
// What `<MemberDashboard>` calls to render the profile form. It returns the
// member, the tier ladder, the creator's custom field DEFINITIONS, and the
// member's values for them.
//
// Definitions and values together in one response on purpose: they are useless
// apart. A form cannot be rendered from values alone, because nothing says what
// control or label a key has, and definitions alone render an empty form over a
// profile the member already filled in.

memberRouter.get(
  "/profile",
  route(async (req, res) => {
    const site = requireSite(req);
    const token = req.cookies?.[env.session.cookieName] as string | undefined;

    const session = await loadSession(token, site.id);

    // A 401 is the ordinary answer for a visitor who is not signed in, not an
    // error. The component renders its signed-out state.
    if (!session) throw unauthorized();

    const settings = await loadSiteSettings(site.id);

    const member = await prisma.member.findFirst({
      where: { id: session.member.memberId, siteId: site.id, deletedAt: null },
      select: { metadata: true },
    });

    ok(res, {
      member: session.member,
      tiers: session.tiers,
      fields: publicFieldDefinitions(settings.customFields),
      // Only the keys that still have a definition. A value left over from a
      // deleted field is not the member's business and not the component's.
      metadata: applyMetadata(settings.customFields, member?.metadata, {}).metadata,
    });
  })
);

// ============================================================================
// PATCH /api/member/profile
// ============================================================================
// FP-09 section 4.2. The member edits their own name and their own custom
// fields, and nothing else.
//
// What this endpoint deliberately CANNOT change: email, tier, status. Email is
// an identity change and needs a verification round trip it does not have;
// tier and status are what the member pays for, and an endpoint authorized by
// the member's own cookie that could raise their tier is a self-service
// upgrade to VIP. Those belong to the creator routes and to the payment
// webhooks.

const profilePatchSchema = z.object({
  name: z
    .string()
    .trim()
    .max(255, "That name is too long.")
    .nullish()
    .transform((value) => (value === "" ? null : (value ?? undefined))),
  metadata: z.record(z.unknown()).optional(),
});

memberRouter.patch(
  "/profile",
  route(async (req, res) => {
    const site = requireSite(req);
    const token = req.cookies?.[env.session.cookieName] as string | undefined;

    const session = await loadSession(token, site.id);
    if (!session) throw unauthorized();

    const input = profilePatchSchema.parse(req.body);
    const settings = await loadSiteSettings(site.id);

    const existing = await prisma.member.findFirst({
      where: { id: session.member.memberId, siteId: site.id, deletedAt: null },
      select: { metadata: true },
    });

    if (!existing) throw unauthorized();

    const result = applyMetadata(settings.customFields, existing.metadata, input.metadata ?? {});

    if (result.problems.length > 0) {
      // 400 with every problem named. This genuinely is a malformed request
      // rather than a refused one, and the member can act on each line.
      throw badRequest("invalid_profile", { problems: result.problems });
    }

    const member = await prisma.member.update({
      where: { id: session.member.memberId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        // Cast rather than widen `MemberMetadata`: Prisma's InputJsonValue
        // needs an index signature an interface cannot have, and the values
        // were just checked against the definitions one by one.
        metadata: result.metadata as Prisma.InputJsonObject,
      },
      select: {
        id: true,
        siteId: true,
        email: true,
        name: true,
        activeTier: true,
        status: true,
        metadata: true,
      },
    });

    ok(res, {
      member: memberPayload(member),
      fields: publicFieldDefinitions(settings.customFields),
      metadata: result.metadata,
    });
  })
);

// ============================================================================
// MULTI-PROVIDER OAUTH COMMON HELPERS
// ============================================================================

function buildOAuthState(siteId: string, origin: string): string {
  const statePayload = {
    siteId,
    origin,
    nonce: Math.random().toString(36).substring(2),
  };
  return Buffer.from(JSON.stringify(statePayload)).toString("base64url");
}

function parseOAuthState(stateParam?: string | null): { siteId?: string; origin?: string } {
  if (!stateParam) return {};
  try {
    return JSON.parse(Buffer.from(stateParam, "base64url").toString("utf8")) as {
      siteId?: string;
      origin?: string;
    };
  } catch {
    return {};
  }
}

function getCallerOrigin(req: Request): string {
  const reqOrigin = req.header("origin");
  const reqReferer = req.header("referer");
  let returnOrigin = reqOrigin || "";
  if (!returnOrigin && reqReferer) {
    try {
      returnOrigin = new URL(reqReferer).origin;
    } catch {
      // ignore invalid URL
    }
  }
  return returnOrigin;
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function renderOAuthPopupHtml(options: {
  ok: boolean;
  targetOrigin: string;
  reason?: string;
  providerName: string;
  afterLoginPath?: string;
}): string {
  if (!options.ok) {
    return `<!DOCTYPE html>
<html>
<head><title>Authentication cancelled or failed</title></head>
<body>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: "memberframe-auth-result", ok: false, reason: ${JSON.stringify(options.reason || "cancelled")} }, ${JSON.stringify(options.targetOrigin || "*")});
      setTimeout(function() { window.close(); }, 800);
    } else {
      window.location.href = "/";
    }
  </script>
  <p style="font-family: sans-serif; text-align: center; margin-top: 40px; color: #dc2626;">
    ${options.providerName} authentication did not complete. ${options.reason ? `(${options.reason})` : "Please try again."}
  </p>
</body>
</html>`;
  }

  const afterLogin = options.afterLoginPath || "/dashboard";
  return `<!DOCTYPE html>
<html>
<head><title>Signed in</title></head>
<body>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: "memberframe-auth-result", ok: true }, ${JSON.stringify(options.targetOrigin || "*")});
        setTimeout(function() { window.close(); }, 300);
      } else {
        window.location.href = ${JSON.stringify(afterLogin)};
      }
    } catch(e) {
      window.location.href = ${JSON.stringify(afterLogin)};
    }
  </script>
  <p style="font-family: sans-serif; text-align: center; margin-top: 40px; color: #10b981;">
    Signed in with ${options.providerName}! Redirecting...
  </p>
</body>
</html>`;
}

async function completeOAuthMemberLogin(
  res: Response,
  req: Request,
  siteId: string,
  profile: {
    email: string;
    name?: string | null;
    avatarUrl?: string | null;
    emailVerified?: boolean;
  }
) {
  const emailNormalized = profile.email.toLowerCase().trim();
  let member = await prisma.member.findFirst({
    where: { siteId, email: emailNormalized, deletedAt: null },
  });

  if (!member) {
    member = await prisma.member.create({
      data: {
        siteId,
        email: emailNormalized,
        name: profile.name || null,
        avatarUrl: profile.avatarUrl || null,
        emailVerifiedAt: profile.emailVerified ? new Date() : null,
        activeTier: "free_member",
        status: "active",
      },
    });
  } else {
    await prisma.member.update({
      where: { id: member.id },
      data: {
        lastLoginAt: new Date(),
        name: member.name || profile.name || null,
        avatarUrl: member.avatarUrl || profile.avatarUrl || null,
        emailVerifiedAt: member.emailVerifiedAt || (profile.emailVerified ? new Date() : null),
      },
    });
  }

  const ttl = sessionLifetimeSeconds(true);
  const session = await issueSession(member.id, siteId, ttl, {
    userAgent: req.header("user-agent"),
    ipAddress: req.ip,
  });
  setSessionCookie(res, session.token, { maxAgeSeconds: ttl });
  return member;
}

// ============================================================================
// GOOGLE OAUTH
// ============================================================================

memberRouter.get(
  "/oauth/google",
  route(async (req, res) => {
    const site = requireSite(req);
    const settings = await loadSiteSettings(site.id);
    const google = settings.integrations?.["google_oauth"];

    if (!google?.enabled || !google.values?.["clientId"]) {
      throw badRequest("google_oauth_not_configured", {
        message: "Google sign-in is not configured or enabled for this site.",
      });
    }

    const redirectUri =
      google.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/google/callback`;
    const state = buildOAuthState(site.id, getCallerOrigin(req));

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", google.values["clientId"]);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "select_account");

    res.redirect(authUrl.toString());
  })
);

memberRouter.get(
  "/oauth/google/callback",
  route(async (req, res) => {
    const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
    const stateParam = typeof req.query["state"] === "string" ? req.query["state"] : null;
    const errorParam = typeof req.query["error"] === "string" ? req.query["error"] : null;

    const stateObj = parseOAuthState(stateParam);
    const targetOrigin = stateObj.origin || "*";

    if (errorParam || !code) {
      res.type("html").send(
        renderOAuthPopupHtml({
          ok: false,
          targetOrigin,
          reason: errorParam || "no_code",
          providerName: "Google",
        })
      );
      return;
    }

    const siteId = stateObj.siteId || req.site?.id;
    if (!siteId) throw badRequest("missing_site_id");

    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw badRequest("unknown_site");

    const settings = await loadSiteSettings(site.id);
    const google = settings.integrations?.["google_oauth"];

    if (!google?.values?.["clientId"] || !google.values?.["clientSecret"]) {
      throw badRequest("google_oauth_credentials_missing");
    }

    const redirectUri =
      google.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/google/callback`;

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: google.values["clientId"],
        client_secret: google.values["clientSecret"],
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      res.type("html").send(
        renderOAuthPopupHtml({
          ok: false,
          targetOrigin,
          reason: "token_exchange_failed",
          providerName: "Google",
        })
      );
      return;
    }

    const tokenData = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenData.access_token) throw badRequest("invalid_google_token_response");

    const userinfoResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userinfoResponse.ok) throw badRequest("google_userinfo_failed");

    const profile = (await userinfoResponse.json()) as {
      email: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    if (!profile.email) throw badRequest("google_profile_missing_email");

    await completeOAuthMemberLogin(res, req, site.id, {
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
      emailVerified: profile.email_verified,
    });

    res.type("html").send(
      renderOAuthPopupHtml({
        ok: true,
        targetOrigin,
        providerName: "Google",
        afterLoginPath: settings.auth?.afterLoginPath,
      })
    );
  })
);

// ============================================================================
// GITHUB OAUTH
// ============================================================================

memberRouter.get(
  "/oauth/github",
  route(async (req, res) => {
    const site = requireSite(req);
    const settings = await loadSiteSettings(site.id);
    const github = settings.integrations?.["github_oauth"];

    if (!github?.enabled || !github.values?.["clientId"]) {
      throw badRequest("github_oauth_not_configured", {
        message: "GitHub sign-in is not configured or enabled for this site.",
      });
    }

    const redirectUri =
      github.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/github/callback`;
    const state = buildOAuthState(site.id, getCallerOrigin(req));

    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", github.values["clientId"]);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "read:user user:email");
    authUrl.searchParams.set("state", state);

    res.redirect(authUrl.toString());
  })
);

memberRouter.get(
  "/oauth/github/callback",
  route(async (req, res) => {
    const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
    const stateParam = typeof req.query["state"] === "string" ? req.query["state"] : null;
    const errorParam = typeof req.query["error"] === "string" ? req.query["error"] : null;

    const stateObj = parseOAuthState(stateParam);
    const targetOrigin = stateObj.origin || "*";

    if (errorParam || !code) {
      res.type("html").send(
        renderOAuthPopupHtml({
          ok: false,
          targetOrigin,
          reason: errorParam || "no_code",
          providerName: "GitHub",
        })
      );
      return;
    }

    const siteId = stateObj.siteId || req.site?.id;
    if (!siteId) throw badRequest("missing_site_id");

    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw badRequest("unknown_site");

    const settings = await loadSiteSettings(site.id);
    const github = settings.integrations?.["github_oauth"];

    if (!github?.values?.["clientId"] || !github.values?.["clientSecret"]) {
      throw badRequest("github_oauth_credentials_missing");
    }

    const redirectUri =
      github.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/github/callback`;

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: github.values["clientId"],
        client_secret: github.values["clientSecret"],
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      res.type("html").send(
        renderOAuthPopupHtml({
          ok: false,
          targetOrigin,
          reason: "token_exchange_failed",
          providerName: "GitHub",
        })
      );
      return;
    }

    const tokenData = (await tokenResponse.json()) as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      res.type("html").send(
        renderOAuthPopupHtml({
          ok: false,
          targetOrigin,
          reason: tokenData.error || "invalid_token_response",
          providerName: "GitHub",
        })
      );
      return;
    }

    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "MemberFrame-OAuth",
      },
    });

    if (!userResponse.ok) throw badRequest("github_userinfo_failed");

    const userProfile = (await userResponse.json()) as {
      id: number;
      login: string;
      name?: string | null;
      avatar_url?: string | null;
      email?: string | null;
    };

    let resolvedEmail = userProfile.email;
    if (!resolvedEmail) {
      const emailsResponse = await fetch("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "User-Agent": "MemberFrame-OAuth",
        },
      });
      if (emailsResponse.ok) {
        const emails = (await emailsResponse.json()) as Array<{
          email: string;
          primary?: boolean;
          verified?: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
        if (primary) resolvedEmail = primary.email;
      }
    }

    if (!resolvedEmail) throw badRequest("github_profile_missing_email");

    await completeOAuthMemberLogin(res, req, site.id, {
      email: resolvedEmail,
      name: userProfile.name || userProfile.login,
      avatarUrl: userProfile.avatar_url,
      emailVerified: true,
    });

    res.type("html").send(
      renderOAuthPopupHtml({
        ok: true,
        targetOrigin,
        providerName: "GitHub",
        afterLoginPath: settings.auth?.afterLoginPath,
      })
    );
  })
);

// ============================================================================
// APPLE SIGN-IN
// ============================================================================

memberRouter.get(
  "/oauth/apple",
  route(async (req, res) => {
    const site = requireSite(req);
    const settings = await loadSiteSettings(site.id);
    const apple = settings.integrations?.["apple_oauth"];

    if (!apple?.enabled || !apple.values?.["clientId"]) {
      throw badRequest("apple_oauth_not_configured", {
        message: "Apple sign-in is not configured or enabled for this site.",
      });
    }

    const redirectUri =
      apple.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/apple/callback`;
    const state = buildOAuthState(site.id, getCallerOrigin(req));

    const authUrl = new URL("https://appleid.apple.com/auth/authorize");
    authUrl.searchParams.set("client_id", apple.values["clientId"]);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code id_token");
    authUrl.searchParams.set("response_mode", "form_post");
    authUrl.searchParams.set("scope", "name email");
    authUrl.searchParams.set("state", state);

    res.redirect(authUrl.toString());
  })
);

const handleAppleCallback = route(async (req, res) => {
  const code = typeof req.body?.["code"] === "string" ? req.body["code"] : typeof req.query?.["code"] === "string" ? req.query["code"] : null;
  const idToken = typeof req.body?.["id_token"] === "string" ? req.body["id_token"] : typeof req.query?.["id_token"] === "string" ? req.query["id_token"] : null;
  const stateParam = typeof req.body?.["state"] === "string" ? req.body["state"] : typeof req.query?.["state"] === "string" ? req.query["state"] : null;
  const errorParam = typeof req.body?.["error"] === "string" ? req.body["error"] : typeof req.query?.["error"] === "string" ? req.query["error"] : null;

  const stateObj = parseOAuthState(stateParam);
  const targetOrigin = stateObj.origin || "*";

  if (errorParam || (!code && !idToken)) {
    res.type("html").send(
      renderOAuthPopupHtml({
        ok: false,
        targetOrigin,
        reason: errorParam || "no_code_or_token",
        providerName: "Apple",
      })
    );
    return;
  }

  const siteId = stateObj.siteId || req.site?.id;
  if (!siteId) throw badRequest("missing_site_id");

  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) throw badRequest("unknown_site");

  const settings = await loadSiteSettings(site.id);

  let email: string | null = null;
  if (idToken) {
    const jwtPayload = parseJwtPayload(idToken);
    if (jwtPayload && typeof jwtPayload["email"] === "string") {
      email = jwtPayload["email"];
    }
  }

  let appleName: string | null = null;
  const userParam = req.body?.["user"] || req.query?.["user"];
  if (userParam) {
    try {
      const userObj = typeof userParam === "string" ? JSON.parse(userParam) : userParam;
      appleName = [userObj?.name?.firstName, userObj?.name?.lastName].filter(Boolean).join(" ");
    } catch {
      // ignore user parse error
    }
  }

  if (!email && code) {
    // If id_token wasn't returned in form_post directly, exchange code with Apple token endpoint
    const apple = settings.integrations?.["apple_oauth"];
    if (apple?.values?.["clientSecret"]) {
      const redirectUri = apple.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/apple/callback`;
      const tokenRes = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: apple.values["clientId"] || "",
          client_secret: apple.values["clientSecret"],
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      if (tokenRes.ok) {
        const tokenJson = (await tokenRes.json()) as { id_token?: string };
        if (tokenJson.id_token) {
          const payload = parseJwtPayload(tokenJson.id_token);
          if (payload && typeof payload["email"] === "string") email = payload["email"];
        }
      }
    }
  }

  if (!email) {
    res.type("html").send(
      renderOAuthPopupHtml({
        ok: false,
        targetOrigin,
        reason: "apple_profile_missing_email",
        providerName: "Apple",
      })
    );
    return;
  }

  await completeOAuthMemberLogin(res, req, site.id, {
    email,
    name: appleName,
    avatarUrl: null,
    emailVerified: true,
  });

  res.type("html").send(
    renderOAuthPopupHtml({
      ok: true,
      targetOrigin,
      providerName: "Apple",
      afterLoginPath: settings.auth?.afterLoginPath,
    })
  );
});

memberRouter.post("/oauth/apple/callback", handleAppleCallback);
memberRouter.get("/oauth/apple/callback", handleAppleCallback);

// ============================================================================
// DISCORD OAUTH
// ============================================================================

memberRouter.get(
  "/oauth/discord",
  route(async (req, res) => {
    const site = requireSite(req);
    const settings = await loadSiteSettings(site.id);
    const discord = settings.integrations?.["discord_oauth"];

    if (!discord?.enabled || !discord.values?.["clientId"]) {
      throw badRequest("discord_oauth_not_configured", {
        message: "Discord sign-in is not configured or enabled for this site.",
      });
    }

    const redirectUri =
      discord.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/discord/callback`;
    const state = buildOAuthState(site.id, getCallerOrigin(req));

    const authUrl = new URL("https://discord.com/oauth2/authorize");
    authUrl.searchParams.set("client_id", discord.values["clientId"]);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "identify email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "consent");

    res.redirect(authUrl.toString());
  })
);

memberRouter.get(
  "/oauth/discord/callback",
  route(async (req, res) => {
    const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
    const stateParam = typeof req.query["state"] === "string" ? req.query["state"] : null;
    const errorParam = typeof req.query["error"] === "string" ? req.query["error"] : null;

    const stateObj = parseOAuthState(stateParam);
    const targetOrigin = stateObj.origin || "*";

    if (errorParam || !code) {
      res.type("html").send(
        renderOAuthPopupHtml({
          ok: false,
          targetOrigin,
          reason: errorParam || "no_code",
          providerName: "Discord",
        })
      );
      return;
    }

    const siteId = stateObj.siteId || req.site?.id;
    if (!siteId) throw badRequest("missing_site_id");

    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw badRequest("unknown_site");

    const settings = await loadSiteSettings(site.id);
    const discord = settings.integrations?.["discord_oauth"];

    if (!discord?.values?.["clientId"] || !discord.values?.["clientSecret"]) {
      throw badRequest("discord_oauth_credentials_missing");
    }

    const redirectUri =
      discord.values["redirect_url"] || `${env.apiBaseUrl}/api/member/oauth/discord/callback`;

    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: discord.values["clientId"],
        client_secret: discord.values["clientSecret"],
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      res.type("html").send(
        renderOAuthPopupHtml({
          ok: false,
          targetOrigin,
          reason: "token_exchange_failed",
          providerName: "Discord",
        })
      );
      return;
    }

    const tokenData = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenData.access_token) throw badRequest("invalid_discord_token_response");

    const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResponse.ok) throw badRequest("discord_userinfo_failed");

    const user = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
      email?: string | null;
      verified?: boolean;
    };

    if (!user.email) throw badRequest("discord_profile_missing_email");

    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : null;

    await completeOAuthMemberLogin(res, req, site.id, {
      email: user.email,
      name: user.global_name || user.username,
      avatarUrl,
      emailVerified: Boolean(user.verified),
    });

    res.type("html").send(
      renderOAuthPopupHtml({
        ok: true,
        targetOrigin,
        providerName: "Discord",
        afterLoginPath: settings.auth?.afterLoginPath,
      })
    );
  })
);


