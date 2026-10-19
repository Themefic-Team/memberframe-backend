/**
 * The hosted account page and its "signed in" page. F19,
 * 19-pro-lock-and-trial.md 2.1.
 *
 * A clone of the BEAF backend's `authPage.js` and `sendSocialAuthSuccessMessage`,
 * so every Framefic plugin signs its customers in on the same page: Sign In and
 * Sign Up tabs, the passwordless email code, "Or sign in with password", forgot
 * password, Google, and the 7-day trial wording. Branded MemberFrame and wired
 * to /api/account (`routes/creatorAccount.ts`) instead of BEAF's /api/auth.
 *
 * Every value placed in the page is escaped or validated before it gets here,
 * and the script's settings go in as JSON with `<` escaped.
 */

export interface AuthPageOptions {
  mode: "login" | "register";
  /** Already validated by `isValidSessionId`, or empty when missing. */
  sessionId: string;
  theme: "light" | "dark";
  googleEnabled: boolean;
  /** Shown when Google sign in came back with an error. */
  error: string;
}

import { basePath } from "./publicApiBase.js";

/** The icon, under the API's own path (a reverse proxy may mount it at /memberframe). */
const icon = (): string => `${basePath()}/assets/memberframe-icon.svg`;
const PLUGIN = "MemberFrame";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** JSON for an inline script: `<` escaped so no value can close the tag. */
const inlineJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/** BEAF's shared page look: the blue glow on black, the card, the CTA. */
const BASE_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
    :root {
      --bg-html: #000000;
      --bg-body: radial-gradient(1000px 560px at 50% -20px, #5271ff70 0%, rgb(112 138 255 / 21%) 50%, transparent 75%), radial-gradient(800px 480px at 50% 115%, rgb(82 113 255 / 63%) 0%, transparent 65%), #000000;
      --bg-card: rgba(16, 18, 27, 0.94);
      --border-card: rgba(255, 255, 255, 0.09);
      --text-primary: #ffffff;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --bg-input: #0b0c12;
      --border-input: rgba(255, 255, 255, 0.13);
      --border-input-focus: #5271FF;
      --text-input: #ffffff;
      --bg-tabs: #0b0c12;
      --border-tabs: rgba(255, 255, 255, 0.08);
      --bg-tab-active: #1e202f;
      --text-tab-active: #ffffff;
      --text-tab: #94a3b8;
      --divider-color: rgba(255, 255, 255, 0.08);
      --divider-text: #64748b;
      --social-btn-bg: #141622;
      --social-btn-bg-hover: #1a1e2e;
      --social-btn-text: #f1f5f9;
      --social-btn-border: rgba(255, 255, 255, 0.12);
      --social-btn-border-hover: rgba(82, 113, 255, 0.5);
      --social-btn-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      --social-btn-shadow-hover: 0 4px 14px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(82, 113, 255, 0.2);
      --card-shadow: 0 24px 60px rgba(0, 0, 0, 0.65), 0 0 1px rgba(255, 255, 255, 0.12), 0 0 35px rgba(82, 113, 255, 0.06);
      --otp-banner-bg: rgba(82, 113, 255, 0.1);
      --otp-banner-border: rgba(82, 113, 255, 0.25);
      --otp-banner-text: #e2e8f0;
    }
    body.light-mode, html.light-mode {
      --bg-html: #fbfbfb;
      --bg-body: radial-gradient(1000px 560px at 50% -20px, #5271ff70 0%, rgb(112 138 255 / 21%) 50%, transparent 75%), radial-gradient(800px 480px at 50% 115%, rgb(82 113 255 / 63%) 0%, transparent 65%), #fbfbfb;
      --bg-card: rgba(255, 255, 255, 0.98);
      --border-card: rgba(0, 0, 0, 0.08);
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --bg-input: #ffffff;
      --border-input: #cbd5e1;
      --border-input-focus: #5271FF;
      --text-input: #0f172a;
      --bg-tabs: #f1f5f9;
      --border-tabs: #e2e8f0;
      --bg-tab-active: #ffffff;
      --text-tab-active: #0f172a;
      --text-tab: #64748b;
      --divider-color: #e2e8f0;
      --divider-text: #94a3b8;
      --social-btn-bg: #ffffff;
      --social-btn-bg-hover: #f8fafc;
      --social-btn-text: #0f172a;
      --social-btn-border: #cbd5e1;
      --social-btn-border-hover: rgba(82, 113, 255, 0.45);
      --social-btn-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
      --social-btn-shadow-hover: 0 4px 14px rgba(15, 23, 42, 0.08), 0 0 0 1px rgba(82, 113, 255, 0.18);
      --card-shadow: 0 20px 50px rgba(15, 23, 42, 0.08), 0 0 1px rgba(0, 0, 0, 0.04), 0 0 25px rgba(82, 113, 255, 0.05);
      --otp-banner-bg: rgba(82, 113, 255, 0.08);
      --otp-banner-border: rgba(82, 113, 255, 0.3);
      --otp-banner-text: #1e293b;
    }
    html { background-color: var(--bg-html); min-height: 100%; }
    body {
      background: var(--bg-body);
      background-attachment: fixed;
      background-repeat: no-repeat;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
      position: relative;
      overflow-x: hidden;
      transition: background 0.25s ease, color 0.25s ease;
    }
    .submit-btn, .primary-cta {
      color: #fff !important;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      font-style: normal;
      font-weight: 400 !important;
      width: 100%;
      margin-top: 8px;
      letter-spacing: 0.22px;
      position: relative;
      z-index: 0;
      border: 2px solid transparent !important;
      background: linear-gradient(#5271FF, #5271FF) padding-box, linear-gradient(180deg, #708AFF 0%, #3358FF 100%) border-box !important;
      border-radius: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 36px;
      box-sizing: border-box;
      outline: none;
      transition: opacity 0.2s ease, transform 0.1s ease;
    }
    .submit-btn:hover:not(:disabled), .primary-cta:hover:not(:disabled) { opacity: 0.92; }
    .submit-btn:active:not(:disabled), .primary-cta:active:not(:disabled) { transform: scale(0.98); }
    .submit-btn:disabled, .primary-cta:disabled { opacity: 0.7; cursor: not-allowed; }
`;

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>`;

const EYE_SHOW = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
const EYE_HIDE = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`;

export function renderCreatorAuthPage(options: AuthPageOptions): string {
  const register = options.mode === "register";
  const themeClass = options.theme === "light" ? "light-mode" : "dark-mode";
  const googleHref = `${basePath()}/api/account/google?sessionId=${encodeURIComponent(options.sessionId)}${register ? "&mode=register" : ""}&theme=${options.theme}`;
  const config = inlineJson({ mode: options.mode, sessionId: options.sessionId, theme: options.theme, error: options.error, base: basePath() });
  const googleBlock = options.googleEnabled
    ? `<div id="auth-divider" class="divider">or continue with</div>
      <a id="google-auth-btn" class="social-btn-google" href="${escapeHtml(googleHref)}">
        ${GOOGLE_SVG}
        <span id="google-btn-text">${register ? "Sign up with Google" : "Continue with Google"}</span>
      </a>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" class="${themeClass}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Authenticate - ${PLUGIN}</title>
  <link rel="icon" type="image/svg+xml" href="${icon()}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
${BASE_CSS}
    .auth-container {
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: 20px;
      padding: 34px 28px;
      width: 100%;
      max-width: 390px;
      box-shadow: var(--card-shadow);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      text-align: center;
      position: relative;
      z-index: 10;
      transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
    }
    .plugin-icon { width: 50px; height: 50px; margin: 0 auto 14px auto; display: flex; align-items: center; justify-content: center; }
    .plugin-icon img { width: 48px; height: 48px; border-radius: 12px; object-fit: contain; display: block; box-shadow: 0 4px 16px rgba(82, 113, 255, 0.25); }
    .logo { font-size: 19px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; letter-spacing: -0.01em; }
    .subtitle { font-size: 12px; color: var(--text-secondary); margin-bottom: 20px; line-height: 1.5; }
    .social-btn-google {
      position: relative; display: flex; align-items: center; justify-content: center; gap: 9px; height: 36px;
      border-radius: 10px; border: 1px solid var(--social-btn-border); background: var(--social-btn-bg); color: var(--social-btn-text);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; font-weight: 500; cursor: pointer;
      text-decoration: none; box-shadow: var(--social-btn-shadow); margin-bottom: 16px; width: 100%; box-sizing: border-box;
      transition: background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), color 0.18s ease;
    }
    .social-btn-google:hover { background: var(--social-btn-bg-hover); border-color: var(--social-btn-border-hover); box-shadow: var(--social-btn-shadow-hover); transform: translateY(-1px); }
    .social-btn-google:active { transform: translateY(0); box-shadow: var(--social-btn-shadow); }
    .social-btn-google svg { background: transparent; flex-shrink: 0; }
    .divider { display: flex; align-items: center; gap: 12px; margin: 16px 0 18px 0; color: var(--divider-text); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--divider-color); }
    .tabs { display: flex; background: var(--bg-tabs); border-radius: 10px; padding: 4px; margin-bottom: 18px; border: 1px solid var(--border-tabs); }
    .tab { flex: 1; padding: 8px; text-align: center; font-size: 13px; font-weight: 600; color: var(--text-tab); cursor: pointer; border-radius: 7px; transition: all 0.2s ease; border: none; background: transparent; font-family: inherit; }
    .tab.active { background: var(--bg-tab-active); color: var(--text-tab-active); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12); }
    .form-group { margin-bottom: 14px; text-align: left; }
    label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }
    .input-wrapper { position: relative; width: 100%; }
    input { width: 100%; padding: 10.5px 12px; border-radius: 10px; border: 1px solid var(--border-input); background: var(--bg-input); color: var(--text-input); font-size: 13px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
    input:focus { border-color: var(--border-input-focus); box-shadow: 0 0 0 3px rgba(82, 113, 255, 0.15); }
    .otp-input { font-size: 22px !important; letter-spacing: 8px !important; text-align: center !important; font-weight: 700 !important; font-family: monospace, -apple-system, sans-serif !important; padding: 11px 14px !important; }
    .toggle-password-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s ease; z-index: 5; }
    .toggle-password-btn:hover { color: var(--text-primary); }
    .otp-banner { background: var(--otp-banner-bg); border: 1px solid var(--otp-banner-border); border-radius: 10px; padding: 11px 13px; margin-bottom: 14px; text-align: left; font-size: 12px; color: var(--otp-banner-text); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .otp-banner p { margin: 2px 0 0; font-size: 11.5px; color: var(--text-secondary); }
    .change-email-btn { background: transparent; border: 1px solid var(--border-input); color: #5271FF; font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 6px; cursor: pointer; flex-shrink: 0; }
    .change-email-btn:hover { background: rgba(82, 113, 255, 0.1); }
    .resend-row { margin-top: 10px; text-align: center; font-size: 12px; color: var(--text-muted); }
    .resend-btn { background: transparent; border: none; color: #5271FF; font-size: 12px; font-weight: 600; cursor: pointer; text-decoration: underline; padding: 0; }
    .password-fallback-toggle { margin-top: 10px; text-align: center; }
    .password-fallback-link { font-size: 12px; color: var(--text-secondary); text-decoration: underline; cursor: pointer; background: none; border: none; }
    .password-fallback-link:hover { color: #5271FF; }
    .forgot-password-link { background: transparent; border: none; color: #5271FF; font-size: 11.5px; font-weight: 500; cursor: pointer; padding: 0; text-decoration: none; transition: color 0.15s ease; }
    .forgot-password-link:hover { color: #708AFF; text-decoration: underline; }
    .back-to-login-link { background: none; border: none; color: var(--text-secondary); font-size: 12px; font-weight: 500; cursor: pointer; text-decoration: none; transition: color 0.15s ease; display: inline-block; padding: 4px; }
    .back-to-login-link:hover { color: var(--text-primary); text-decoration: underline; }
    .error-msg { background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; padding: 10px 12px; border-radius: 10px; font-size: 12px; margin-bottom: 14px; display: none; text-align: left; line-height: 1.4; }
    body.light-mode .error-msg { color: #dc2626; background: #fee2e2; border-color: #fca5a5; }
    .success-msg { background: rgba(34, 197, 94, 0.14); border: 1px solid rgba(34, 197, 94, 0.3); color: #86efac; padding: 10px 12px; border-radius: 10px; font-size: 12px; margin-bottom: 14px; display: none; text-align: left; line-height: 1.4; }
    body.light-mode .success-msg { color: #15803d; background: #dcfce7; border-color: #86efac; }
    .terms-text { font-size: 11px; color: var(--text-muted); line-height: 1.4; margin-top: 14px; text-align: center; }
    .terms-text a { color: #5271FF; text-decoration: underline; }
    .hidden { display: none; }
    .password-label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .password-label-row label { margin-bottom: 0; }
    .has-toggle { padding-right: 42px; }
    .otp-email { font-weight: 600; }
    .inline-link { color: #5271FF; font-weight: 600; text-decoration: underline; margin-left: 4px; }
  </style>
</head>
<body class="${themeClass}">
  <div class="auth-container">
    <div class="plugin-icon">
      <img src="${icon()}" alt="${PLUGIN}" width="48" height="48" />
    </div>

    <div class="logo">${PLUGIN}</div>
    <div id="auth-subtitle" class="subtitle">${options.sessionId ? "Sign in or create an account to continue in Framer" : "Open this page from the MemberFrame plugin in Framer."}</div>

    <div id="error" class="error-msg"></div>
    <div id="success" class="success-msg"></div>

    <div id="auth-tabs" class="tabs">
      <button type="button" id="tab-login" class="tab ${register ? "" : "active"}">Sign In</button>
      <button type="button" id="tab-register" class="tab ${register ? "active" : ""}">Sign Up</button>
    </div>

    <form id="auth-form" novalidate>
      <div id="group-username" class="form-group${register ? "" : " hidden"}">
        <label for="username">Full Name</label>
        <input type="text" id="username" autocomplete="name" placeholder="John Doe">
      </div>

      <div id="group-email" class="form-group">
        <label for="email">Email Address</label>
        <input type="email" id="email" autocomplete="email" placeholder="you@example.com">
      </div>

      <div id="group-password" class="form-group${register ? "" : " hidden"}">
        <div class="password-label-row">
          <label for="password">Password</label>
          <button type="button" id="forgot-password-link" class="forgot-password-link hidden">Forgot password?</button>
        </div>
        <div class="input-wrapper">
          <input type="password" id="password" class="has-toggle" autocomplete="current-password" placeholder="••••••••">
          <button type="button" id="toggle-password-btn" class="toggle-password-btn" aria-label="Toggle Password Visibility">
            <svg id="eye-icon-show" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EYE_SHOW}</svg>
            <svg id="eye-icon-hide" class="hidden" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EYE_HIDE}</svg>
          </button>
        </div>
      </div>

      <div id="group-otp" class="hidden">
        <div class="otp-banner">
          <div>
            <strong>Check your inbox</strong>
            <p>Code sent to <span id="otp-target-email" class="otp-email"></span></p>
          </div>
          <button type="button" id="change-email-btn" class="change-email-btn">Change</button>
        </div>
        <div class="form-group">
          <label for="otp-code">6-Digit Verification Code</label>
          <input type="text" id="otp-code" class="otp-input" maxlength="6" placeholder="123456" inputmode="numeric" autocomplete="one-time-code">
        </div>
        <div class="resend-row">
          <span id="resend-timer-text">Resend code in <b id="resend-countdown">60</b>s</span>
          <button type="button" id="resend-btn" class="resend-btn hidden">Resend Code</button>
        </div>
      </div>

      <div id="group-new-password" class="form-group hidden">
        <label for="new-password">New Password</label>
        <div class="input-wrapper">
          <input type="password" id="new-password" class="has-toggle" autocomplete="new-password" placeholder="At least 6 characters">
          <button type="button" id="toggle-new-password-btn" class="toggle-password-btn" aria-label="Toggle Password Visibility">
            <svg id="eye-icon-new-show" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EYE_SHOW}</svg>
            <svg id="eye-icon-new-hide" class="hidden" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EYE_HIDE}</svg>
          </button>
        </div>
      </div>

      <button type="submit" id="submit-btn" class="submit-btn primary-cta">${register ? "Sign Up - Start 7 Days Free Trial" : "Continue with Email"}</button>

      <div id="password-fallback-wrapper" class="password-fallback-toggle${register ? " hidden" : ""}">
        <button type="button" id="password-fallback-link" class="password-fallback-link">Or sign in with password</button>
      </div>

      <div id="back-to-login-wrapper" class="password-fallback-toggle hidden">
        <button type="button" id="back-to-login-link" class="back-to-login-link">← Back to Sign In</button>
      </div>

      ${googleBlock}

      <p class="terms-text">
        By continuing, you agree to our <a href="https://framefic.com/terms-conditions/" target="_blank" rel="noreferrer">Terms &amp; Conditions</a>.
      </p>
    </form>
  </div>

  <script>
    (function () {
      var CONFIG = ${config};
      var mode = CONFIG.mode;
      var passwordless = true;
      var otpStep = false;
      var sent = { email: "", name: "", password: "" };
      var countdown = null;
      var $ = function (id) { return document.getElementById(id); };
      var show = function (id, on) { var el = $(id); if (el) el.classList.toggle("hidden", !on); };

      if (!CONFIG.sessionId) {
        show("auth-tabs", false); show("auth-form", false);
        return;
      }

      function post(path, body) {
        body.sessionId = CONFIG.sessionId;
        body.theme = CONFIG.theme;
        return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
              if (!res.ok) throw new Error(data.message || (data.reason === "rate_limited" ? "Too many attempts. Please wait a few minutes and try again." : "Something went wrong. Please try again."));
              return data;
            });
          }, function () { throw new Error("Could not reach MemberFrame. Check your connection and try again."); });
      }

      function showError(message) {
        var el = $("error");
        $("success").style.display = "none";
        el.textContent = message || "An error occurred";
        if (message && message.indexOf("already exists") !== -1) {
          var a = document.createElement("a"); a.href = "#"; a.className = "inline-link"; a.textContent = "Sign In here";
          a.onclick = function (e) { e.preventDefault(); setMode("login"); };
          el.appendChild(a);
        } else if (message && message.indexOf("No account found") !== -1) {
          var b = document.createElement("a"); b.href = "#"; b.className = "inline-link"; b.textContent = "Sign Up with 7-day free trial";
          b.onclick = function (e) { e.preventDefault(); setMode("register"); };
          el.appendChild(b);
        }
        el.style.display = "block";
      }
      function clearMessages() { $("error").style.display = "none"; $("success").style.display = "none"; }
      function button(text, disabled) { var b = $("submit-btn"); b.textContent = text; b.disabled = !!disabled; }

      function startResendCountdown() {
        clearInterval(countdown);
        var left = 60;
        show("resend-timer-text", true); show("resend-btn", false);
        $("resend-countdown").textContent = left;
        countdown = setInterval(function () {
          left -= 1;
          if (left <= 0) { clearInterval(countdown); show("resend-timer-text", false); show("resend-btn", true); }
          else { $("resend-countdown").textContent = left; }
        }, 1000);
      }

      function setMode(next) {
        mode = next; otpStep = false; clearInterval(countdown); clearMessages();
        $("tab-login").classList.toggle("active", next === "login");
        $("tab-register").classList.toggle("active", next === "register");
        show("group-otp", false); $("otp-code").value = "";
        show("group-new-password", false); $("new-password").value = "";
        show("group-email", true);
        var google = $("google-btn-text");
        if (next === "forgot") {
          show("auth-tabs", false);
          $("auth-subtitle").textContent = "Reset your password to continue in Framer";
          show("group-username", false); show("group-password", false); show("forgot-password-link", false);
          show("password-fallback-wrapper", false); show("back-to-login-wrapper", true);
          show("auth-divider", false); show("google-auth-btn", false);
          button("Send Reset Code");
          $("email").focus();
          return;
        }
        show("auth-tabs", true);
        $("auth-subtitle").textContent = "Sign in or create an account to continue in Framer";
        show("back-to-login-wrapper", false); show("auth-divider", true); show("google-auth-btn", true);
        if (next === "register") {
          show("group-username", true); show("group-password", true); show("forgot-password-link", false);
          show("password-fallback-wrapper", false);
          button("Sign Up - Start 7 Days Free Trial");
          if (google) google.textContent = "Sign up with Google";
          $("password").setAttribute("autocomplete", "new-password");
        } else {
          passwordless = true;
          show("group-username", false); show("group-password", false); show("forgot-password-link", false);
          show("password-fallback-wrapper", true);
          $("password-fallback-link").textContent = "Or sign in with password";
          button("Continue with Email");
          if (google) google.textContent = "Continue with Google";
          $("password").setAttribute("autocomplete", "current-password");
        }
        var g = $("google-auth-btn");
        if (g) g.href = CONFIG.base + "/api/account/google?sessionId=" + encodeURIComponent(CONFIG.sessionId) + (next === "register" ? "&mode=register" : "") + "&theme=" + CONFIG.theme;
      }

      function enterOtpStep(email) {
        otpStep = true;
        $("otp-target-email").textContent = email;
        show("group-username", false); show("group-email", false); show("group-password", false);
        show("password-fallback-wrapper", false); show("back-to-login-wrapper", false);
        show("auth-divider", false); show("google-auth-btn", false);
        show("group-otp", true);
        $("otp-code").value = ""; $("otp-code").focus();
        startResendCountdown();
      }

      function cancelOtpStep() {
        var keep = mode;
        setMode(keep === "forgot" ? "forgot" : keep);
        if (keep === "login" && !passwordless) togglePasswordFallback();
      }

      function togglePasswordFallback() {
        passwordless = !passwordless;
        show("group-otp", false); otpStep = false;
        show("group-password", !passwordless); show("forgot-password-link", !passwordless);
        button(passwordless ? "Continue with Email" : "Sign In");
        $("password-fallback-link").textContent = passwordless ? "Or sign in with password" : "Or sign in with email code (passwordless)";
        if (!passwordless) $("password").focus();
      }

      function done(data) { window.location.href = data.redirect || CONFIG.base + "/auth/success?theme=" + CONFIG.theme; }

      function sendCode(purpose, labelBusy, labelIdle) {
        button(labelBusy, true);
        return post(CONFIG.base + "/api/account/code", { email: sent.email, purpose: purpose, name: sent.name || undefined })
          .then(function () { enterOtpStep(sent.email); }, function (err) { button(labelIdle); showError(err.message); throw err; });
      }

      $("auth-form").addEventListener("submit", function (e) {
        e.preventDefault();
        clearMessages();
        var email = $("email").value.trim();
        var name = $("username").value.trim();
        var password = $("password").value;
        var code = $("otp-code").value.trim();

        if (mode === "forgot") {
          if (!otpStep) {
            if (!email) return showError("Please enter your email address.");
            sent = { email: email, name: "", password: "" };
            sendCode("reset", "Sending reset code...", "Send Reset Code").then(function () {
              show("group-new-password", true); button("Reset Password & Sign In");
            }, function () {});
            return;
          }
          var newPassword = $("new-password").value;
          if (code.length < 6) return showError("Please enter the complete 6-digit verification code.");
          if (newPassword.length < 6) return showError("New password must be at least 6 characters.");
          button("Resetting password...", true);
          post(CONFIG.base + "/api/account/verify", { email: sent.email, code: code, purpose: "reset", password: newPassword })
            .then(done, function (err) { button("Reset Password & Sign In"); showError(err.message); });
          return;
        }

        if (mode === "register") {
          if (!otpStep) {
            if (!name) return showError("Please enter your full name.");
            if (!email) return showError("Please enter your email address.");
            if (password.length < 6) return showError("Password must be at least 6 characters.");
            sent = { email: email, name: name, password: password };
            sendCode("signup", "Sending verification code...", "Sign Up - Start 7 Days Free Trial").then(function () {
              button("Verify Code & Start 7 Days Free Trial");
            }, function () {});
            return;
          }
          if (code.length < 6) return showError("Please enter the complete 6-digit verification code.");
          button("Verifying code & creating account...", true);
          post(CONFIG.base + "/api/account/verify", { email: sent.email, code: code, purpose: "signup", name: sent.name, password: sent.password })
            .then(done, function (err) { button("Verify Code & Start 7 Days Free Trial"); showError(err.message); });
          return;
        }

        if (!passwordless) {
          if (!email || !password) return showError("Please enter your email and password.");
          button("Signing in...", true);
          post(CONFIG.base + "/api/account/login", { email: email, password: password })
            .then(done, function (err) { button("Sign In"); showError(err.message); });
          return;
        }

        if (!otpStep) {
          if (!email) return showError("Please enter your email address.");
          sent = { email: email, name: "", password: "" };
          sendCode("signin", "Sending 6-digit code...", "Continue with Email").then(function () {
            button("Verify & Sign In");
          }, function () {});
          return;
        }
        if (code.length < 6) return showError("Please enter the complete 6-digit verification code.");
        button("Verifying code...", true);
        post(CONFIG.base + "/api/account/verify", { email: sent.email, code: code, purpose: "signin" })
          .then(done, function (err) { button("Verify & Sign In"); showError(err.message); });
      });

      $("resend-btn").addEventListener("click", function () {
        clearMessages();
        var purpose = mode === "forgot" ? "reset" : mode === "register" ? "signup" : "signin";
        post(CONFIG.base + "/api/account/code", { email: sent.email, purpose: purpose, name: sent.name || undefined })
          .then(startResendCountdown, function (err) { showError(err.message); });
      });

      function toggleEye(inputId, showId, hideId) {
        var input = $(inputId); var visible = input.type === "password";
        input.type = visible ? "text" : "password";
        show(showId, !visible); show(hideId, visible);
      }
      $("toggle-password-btn").addEventListener("click", function () { toggleEye("password", "eye-icon-show", "eye-icon-hide"); });
      $("toggle-new-password-btn").addEventListener("click", function () { toggleEye("new-password", "eye-icon-new-show", "eye-icon-new-hide"); });
      $("tab-login").addEventListener("click", function (e) { e.preventDefault(); setMode("login"); });
      $("tab-register").addEventListener("click", function (e) { e.preventDefault(); setMode("register"); });
      $("password-fallback-link").addEventListener("click", togglePasswordFallback);
      $("forgot-password-link").addEventListener("click", function (e) { e.preventDefault(); setMode("forgot"); });
      $("back-to-login-link").addEventListener("click", function (e) { e.preventDefault(); setMode("login"); });
      $("change-email-btn").addEventListener("click", cancelOtpStep);

      setMode(mode);
      if (CONFIG.error) showError(CONFIG.error);
    })();
  </script>
</body>
</html>`;
}

/** BEAF's "Authentication Successful!" page, which closes itself. */
export function renderAuthSuccessPage(options: { theme: "light" | "dark"; trial: boolean }): string {
  const themeClass = options.theme === "light" ? "light-mode" : "dark-mode";
  return `<!DOCTYPE html>
<html lang="en" class="${themeClass}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Authenticated - ${PLUGIN}</title>
  <link rel="icon" type="image/svg+xml" href="${icon()}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
${BASE_CSS}
    body { text-align: center; overflow: hidden; }
    .success-card { background: var(--bg-card); border: 1px solid var(--border-card); border-radius: 20px; padding: 34px 28px; width: 100%; max-width: 360px; box-shadow: var(--card-shadow); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); position: relative; z-index: 10; }
    .icon-box { width: 56px; height: 56px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; }
    .icon-box img { width: 52px; height: 52px; border-radius: 12px; object-fit: contain; box-shadow: 0 4px 16px rgba(82, 113, 255, 0.25); }
    .title { font-size: 19px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px; letter-spacing: -0.01em; }
    .trial-pill { display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.3); color: #22c55e; border-radius: 8px; padding: 5px 12px; font-size: 12px; font-weight: 600; margin: 4px auto 14px; }
    .trial-pill svg { flex-shrink: 0; }
    .subtitle { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 20px; }
    .auto-close-note { font-size: 11.5px; color: var(--text-secondary); margin-top: 12px; }
    .auto-close-note span { font-weight: 600; color: var(--text-primary); }
  </style>
</head>
<body class="${themeClass}">
  <div class="success-card">
    <div class="icon-box"><img src="${icon()}" alt="${PLUGIN}" /></div>
    <div class="title">Authentication Successful!</div>
    ${
      options.trial
        ? `<div class="trial-pill">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      <span>7-Day Free Trial Activated</span>
    </div>`
        : ""
    }
    <div class="subtitle">Connected to ${PLUGIN} in Framer. You can return to the editor.</div>
    <button id="close-btn" class="primary-cta" type="button">Return to Framer</button>
    <div class="auto-close-note">This window will close automatically in <span id="auto-close-countdown">2</span>s...</div>
  </div>
  <script>
    (function () {
      function closeTab() {
        try { window.close(); } catch (e) {}
        try { self.close(); } catch (e) {}
        try { window.open("", "_self", ""); window.close(); } catch (e) {}
      }
      document.getElementById("close-btn").addEventListener("click", closeTab);
      var left = 2;
      var el = document.getElementById("auto-close-countdown");
      var timer = setInterval(function () {
        left -= 1;
        if (el && left >= 0) el.textContent = left;
        if (left <= 0) { clearInterval(timer); closeTab(); }
      }, 1000);
    })();
  </script>
</body>
</html>`;
}

/**
 * "Simulate Google Sign In", BEAF's `renderMockLoginScreen`: what the Google
 * button opens on a development server that has no `CREATOR_GOOGLE_*` keys, so
 * the whole sign up flow can be tried without a Google project. It signs in as
 * whatever address is typed, so the route never serves it in production.
 */
export function renderMockGooglePage(options: { sessionId: string; theme: "light" | "dark" }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Developer Mock Social Auth</title>
  <style>
    body { margin: 0; font-family: 'Inter', -apple-system, sans-serif; background: #09090e; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #13131c; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 32px; max-width: 400px; width: 90%; text-align: center; }
    .badge { background: rgba(234, 179, 8, 0.15); color: #FBBF24; padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 16px; display: inline-block; }
    h2 { font-size: 18px; margin-bottom: 8px; }
    p { font-size: 12px; color: #94a3b8; margin-bottom: 24px; line-height: 1.5; }
    .form-group { margin-bottom: 14px; text-align: left; }
    label { display: block; font-size: 12px; font-weight: 500; color: #94a3b8; margin-bottom: 6px; }
    input { width: 100%; padding: 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: #09090e; color: #fff; font-size: 13px; box-sizing: border-box; }
    button { width: 100%; background: linear-gradient(180deg, #5271FF 0%, #004AAD 100%); color: white; border: none; padding: 11px; border-radius: 10px; font-weight: 600; font-size: 13.5px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Local Dev Mode</span>
    <h2>Simulate Google Sign In</h2>
    <p>OAuth credentials missing in <code>.env</code> (<code>CREATOR_GOOGLE_CLIENT_ID</code>, <code>CREATOR_GOOGLE_CLIENT_SECRET</code>). Enter test details to proceed:</p>
    <form action="${escapeHtml(basePath())}/api/account/google/mock" method="POST">
      <input type="hidden" name="sessionId" value="${escapeHtml(options.sessionId)}" />
      <input type="hidden" name="theme" value="${options.theme}" />
      <div class="form-group">
        <label for="username">Full Name</label>
        <input type="text" id="username" name="name" value="Social Tester" maxlength="255" required />
      </div>
      <div class="form-group">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email" value="tester@google.com" maxlength="254" required />
      </div>
      <button type="submit">Authenticate Mock User</button>
    </form>
  </div>
</body>
</html>`;
}
