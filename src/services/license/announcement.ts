/**
 * The promo campaign card on the panel's Home, from env, so Framefic changes
 * the offer with no new plugin build (37-promo-campaign-card.md). The same
 * env names and rules as Hydra Booking's card. GET /api/plugin/announcement
 * answers it.
 *
 * One normalized, public `campaign` object (or null) that the panel renders as
 * is: no default text, no default code, nothing invented. A value that does
 * not parse hides the card instead of stopping the server, and is named once
 * in the log.
 *
 *   ANNOUNCEMENT_ENABLED                    yes/no or true/false. no hides the card. Unset: on
 *   ANNOUNCEMENT_CAMPAIGN_ID                required for the card. Letters, digits, . _ - (64 max).
 *                                           A new id starts a fresh offer on every site
 *   ANNOUNCEMENT_TITLE                      required for the card (80 characters max)
 *   ANNOUNCEMENT_SUBTITLE                   optional (160 max)
 *   ANNOUNCEMENT_BUTTON_TEXT                required for the card (40 max): the action after the copy
 *   ANNOUNCEMENT_COUPON_CODE                optional. Letters, digits, _ - (64 max). Copied as written.
 *                                           It must exist as an active Stripe promotion code on
 *                                           MemberFrame's own Stripe account (the payment form's
 *                                           "Have a coupon code?" looks it up): this text alone
 *                                           discounts nothing
 *   ANNOUNCEMENT_COUNTDOWN_ENABLED          yes/no or true/false. Unset: no countdown
 *   ANNOUNCEMENT_DURATION_MINUTES           required with the countdown: the offer window, more
 *                                           than 0 and at most 10080 (7 days)
 *   ANNOUNCEMENT_COUNTDOWN_VISIBLE_MINUTES  optional: show the timer only in the window's last
 *                                           minutes. Unset: the whole window. Capped at the duration
 *   ANNOUNCEMENT_SHOW_TO                    who sees it: a comma list of free (no paid plan: none, trial,
 *                                           expired), monthly, yearly, lifetime; or all. Default: free
 *
 * The countdown is the card's own window, kept in the creator's browser. It
 * does not end the discount: only Stripe does (expire or deactivate the
 * promotion code).
 */

import { env } from "../../config/env.js";

export type AnnouncementSource = typeof env.announcement;

export interface AnnouncementCountdown {
  enabled: boolean;
  /** The offer window. Null when the countdown is off. */
  durationMinutes: number | null;
  /** The timer shows in the window's last minutes; never more than the duration. */
  visibleMinutes: number | null;
}

/** Who sees the card: free is every site without a paid plan (none, trial, expired). */
export type AnnouncementAudience = "free" | "monthly" | "yearly" | "lifetime";
export const AUDIENCES: ReadonlyArray<AnnouncementAudience> = ["free", "monthly", "yearly", "lifetime"];

/** The campaign card: every field from env, plain text. */
export interface AnnouncementCampaign {
  id: string;
  title: string;
  subtitle: string;
  buttonText: string;
  couponCode: string | null;
  /** "all" when every audience is in; else "free". */
  showTo: "free" | "all";
  /** Exactly who sees it. */
  audience: AnnouncementAudience[];
  countdown: AnnouncementCountdown;
}

export interface Announcement {
  /** The campaign card, or null when it is off or not valid. */
  campaign: AnnouncementCampaign | null;
}

/** Seven days: the longest window, and the card's own snooze. */
export const MAX_DURATION_MINUTES = 7 * 24 * 60;
const LIMITS = { title: 80, subtitle: 160, buttonText: 40 } as const;
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COUPON = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** yes/no or true/false, any case. Empty: the fallback. Anything else: undefined (not valid). */
export function parseSwitch(raw: string, fallback: boolean): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "") return fallback;
  if (value === "yes" || value === "true") return true;
  if (value === "no" || value === "false") return false;
  return undefined;
}

/** "free,monthly" to the audiences, in a fixed order. Empty: free. Undefined for an unknown name. */
export function parseAudience(raw: string): AnnouncementAudience[] | undefined {
  const names = raw.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (names.length === 0) return ["free"];
  if (names.includes("all")) return [...AUDIENCES];
  if (names.some((name) => !(AUDIENCES as ReadonlyArray<string>).includes(name))) return undefined;
  return AUDIENCES.filter((audience) => names.includes(audience));
}

/** A positive, finite number of minutes, at most seven days. Empty: null. Anything else: undefined. */
export function parseMinutes(raw: string): number | null | undefined {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_DURATION_MINUTES ? minutes : undefined;
}

/**
 * Plain text: control characters out, runs of spaces as one, cut at `max`
 * characters (whole code points). Markup is not stripped or interpreted
 * here: the panel renders this as text, never as HTML.
 */
export function plainText(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : clean;
}

/** The campaign card, or null with the reasons it is not shown. */
export function campaignView(source: AnnouncementSource): { campaign: AnnouncementCampaign | null; problems: string[] } {
  const problems: string[] = [];
  const enabled = parseSwitch(source.enabled, true);
  if (enabled === undefined) problems.push("ANNOUNCEMENT_ENABLED must be yes, no, true, or false");
  if (enabled !== true) return { campaign: null, problems };

  const id = source.campaignId.trim();
  if (!id) return { campaign: null, problems }; // No campaign set: no card, and nothing to report.
  if (!CAMPAIGN_ID.test(id)) problems.push("ANNOUNCEMENT_CAMPAIGN_ID may hold letters, digits, dot, underscore, and dash (64 max)");

  const title = plainText(source.title, LIMITS.title);
  const subtitle = plainText(source.subtitle, LIMITS.subtitle);
  const buttonText = plainText(source.buttonText, LIMITS.buttonText);
  if (!title) problems.push("ANNOUNCEMENT_TITLE is required for the campaign card");
  if (!buttonText) problems.push("ANNOUNCEMENT_BUTTON_TEXT is required for the campaign card");

  const rawCoupon = source.couponCode.trim();
  const couponCode = rawCoupon === "" || ["none", "null"].includes(rawCoupon.toLowerCase()) ? null : rawCoupon;
  if (couponCode !== null && !COUPON.test(couponCode)) problems.push("ANNOUNCEMENT_COUPON_CODE may hold letters, digits, underscore, and dash (64 max)");

  const countdownOn = parseSwitch(source.countdownEnabled, false);
  let countdown: AnnouncementCountdown = { enabled: false, durationMinutes: null, visibleMinutes: null };
  if (countdownOn === undefined) {
    problems.push("ANNOUNCEMENT_COUNTDOWN_ENABLED must be yes, no, true, or false");
  } else if (countdownOn) {
    const duration = parseMinutes(source.durationMinutes);
    const visible = parseMinutes(source.countdownVisibleMinutes);
    if (duration === undefined || duration === null) problems.push(`ANNOUNCEMENT_DURATION_MINUTES must be a number of minutes above 0 and at most ${MAX_DURATION_MINUTES}`);
    if (visible === undefined) problems.push(`ANNOUNCEMENT_COUNTDOWN_VISIBLE_MINUTES must be a number of minutes above 0 and at most ${MAX_DURATION_MINUTES}`);
    if (typeof duration === "number" && visible !== undefined) {
      countdown = { enabled: true, durationMinutes: duration, visibleMinutes: Math.min(visible ?? duration, duration) };
    }
  }

  const audience = parseAudience(source.showTo);
  if (!audience) problems.push("ANNOUNCEMENT_SHOW_TO must be all, or a comma list of free, monthly, yearly, lifetime");
  if (problems.length > 0 || !audience) return { campaign: null, problems };
  const showTo = audience.length === AUDIENCES.length ? "all" : "free";
  return { campaign: { id: id.toLowerCase(), title, subtitle, buttonText, couponCode, showTo, audience, countdown }, problems };
}

let lastWarning = "";

/** Each distinct set of problems is logged once, never the values themselves. */
function warnOnce(problems: string[]): void {
  const message = problems.join("; ");
  if (!message || message === lastWarning) return;
  lastWarning = message;
  console.warn(`[announcement] campaign card hidden: ${message}`);
}

export function announcementView(source: AnnouncementSource = env.announcement): Announcement {
  const { campaign, problems } = campaignView(source);
  warnOnce(problems);
  return { campaign };
}
