/**
 * Emails to creators about their MemberFrame plan, and BEAF's team notices.
 * F19, 19-pro-lock-and-trial.md 2.4.
 *
 * Both in Framefic's design (`lib/frameficMail.ts`), as every Framefic plugin
 * sends them: customer mails follow BEAF's `signup-mail.html`, team notices
 * its `team-*-mail.html`. BEAF sent its customers nothing but codes; these
 * cover the whole life of a plan. All go through the platform sender.
 */

import { env } from "../../config/env.js";
import { customerMail, teamMail } from "../../lib/frameficMail.js";
import type { Mail } from "../../lib/mailer.js";

export const PLAN_LABELS: Record<string, string> = {
  monthly: "Pro Monthly",
  yearly: "Pro Yearly",
  lifetime: "Lifetime Deal",
};

export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * The project as an email names it. A site created since 2026-10-28 has no
 * name (the plugin no longer reads it from Framer), so it is "your project".
 */
function projectLabel(name: string | null | undefined): string {
  return name?.trim() || "your project";
}

const SUPPORT = "Questions? Reply to this email or visit framefic.com/support.";

// ============================================================================
// TO THE CREATOR
// ============================================================================

export function trialStartedMail(to: string, projectName: string | null, endsAt: Date, name = "there"): Mail {
  return customerMail(to, "plugin_trial_started", "Your 7-day MemberFrame trial has started", {
    heading: "You're all set!",
    subheading: "Your 7-day free trial has started",
    greetingName: name,
    paragraphs: [
      `Every MemberFrame feature is unlocked for **${projectLabel(projectName)}** until **${formatDate(endsAt)}**.`,
      "During the trial your published components show a small Made with Framefic mark. Upgrade to PRO anytime to remove it.",
    ],
    footnote: SUPPORT,
  });
}

export function trialEndingMail(to: string, projectName: string | null, endsAt: Date, name = "there"): Mail {
  return customerMail(to, "plugin_trial_ending", "Your MemberFrame trial ends soon", {
    heading: "Your trial ends soon",
    subheading: `Free trial for ${projectLabel(projectName)}`,
    greetingName: name,
    paragraphs: [
      `Your free trial for **${projectLabel(projectName)}** ends on **${formatDate(endsAt)}**.`,
      "Upgrade in the MemberFrame plugin to keep your members signing in and your content protected.",
    ],
    footnote: SUPPORT,
  });
}

export function trialEndedMail(to: string, projectName: string | null, name = "there"): Mail {
  return customerMail(to, "plugin_trial_ended", "Your MemberFrame trial has ended", {
    heading: "Your trial has ended",
    subheading: "Upgrade now to keep using MemberFrame",
    greetingName: name,
    paragraphs: [
      `The free trial for **${projectLabel(projectName)}** has ended, so its MemberFrame components are locked and members cannot sign in.`,
      "Open the MemberFrame plugin and upgrade to restore everything. Your members and settings are saved and waiting.",
    ],
    footnote: SUPPORT,
  });
}

export function planReceiptMail(
  to: string,
  input: { projectName: string | null; plan: string; amountMinor: number; creditMinor: number; currency: string; periodEnd: Date | null; kind: string },
  name = "there"
): Mail {
  const label = PLAN_LABELS[input.plan] ?? input.plan;
  const paragraphs = [`Thank you. We received **${formatMoney(input.amountMinor, input.currency)}** for **${label}** on ${projectLabel(input.projectName)}.`];
  if (input.creditMinor > 0) paragraphs.push(`**${formatMoney(input.creditMinor, input.currency)}** of unused time on your previous plan was taken off.`);
  if (input.periodEnd) paragraphs.push(`Your plan renews on **${formatDate(input.periodEnd)}**.`);
  else if (input.plan === "lifetime") paragraphs.push("Lifetime access never renews and never expires. The watermark has been removed.");
  return customerMail(to, `plugin_receipt_${input.kind}`, input.kind === "renewal" ? `Your ${label} plan renewed` : `Your ${label} plan is active`, {
    heading: input.kind === "renewal" ? "Your plan renewed" : "Payment completed",
    subheading: label,
    greetingName: name,
    paragraphs,
    footnote: SUPPORT,
  });
}

export function renewalReminderMail(
  to: string,
  input: { projectName: string | null; plan: string; amountMinor: number; currency: string; renewsAt: Date },
  name = "there"
): Mail {
  const label = PLAN_LABELS[input.plan] ?? input.plan;
  return customerMail(to, "plugin_renewal_reminder", `Your ${label} plan renews on ${formatDate(input.renewsAt)}`, {
    heading: "Your plan renews soon",
    subheading: label,
    greetingName: name,
    paragraphs: [
      `**${label}** for ${projectLabel(input.projectName)} renews on **${formatDate(input.renewsAt)}** for **${formatMoney(input.amountMinor, input.currency)}**.`,
      "Nothing to do if you want to keep it. To change or cancel, open Profile, Manage Subscription in the MemberFrame plugin.",
    ],
    footnote: SUPPORT,
  });
}

export function paymentFailedMail(to: string, input: { projectName: string | null; plan: string }, name = "there"): Mail {
  const label = PLAN_LABELS[input.plan] ?? input.plan;
  return customerMail(to, "plugin_payment_failed", "Your MemberFrame payment failed", {
    heading: "Your payment failed",
    subheading: label,
    greetingName: name,
    paragraphs: [
      `We could not charge your card for **${label}** on ${projectLabel(input.projectName)}. We will try again over the next few days.`,
      "Update your card in the MemberFrame plugin: Profile, Manage Subscription, Manage Billing.",
    ],
    footnote: SUPPORT,
  });
}

export function planCanceledMail(to: string, input: { projectName: string | null; plan: string; endsAt: Date | null }, name = "there"): Mail {
  const label = PLAN_LABELS[input.plan] ?? input.plan;
  return customerMail(to, "plugin_plan_canceled", `Your ${label} plan is cancelled`, {
    heading: "Subscription canceled",
    subheading: label,
    greetingName: name,
    paragraphs: [
      input.endsAt
        ? `You'll have full access to **${projectLabel(input.projectName)}** until **${formatDate(input.endsAt)}**. We'd love to have you back anytime.`
        : `**${label}** for ${projectLabel(input.projectName)} is cancelled. We'd love to have you back anytime.`,
      "Changed your mind? Resubscribe anytime from the MemberFrame plugin.",
    ],
    footnote: SUPPORT,
  });
}

export function planExpiredMail(to: string, input: { projectName: string | null }, name = "there"): Mail {
  return customerMail(to, "plugin_plan_expired", "Your MemberFrame plan has ended", {
    heading: "Your plan has ended",
    subheading: "Upgrade now to keep using MemberFrame",
    greetingName: name,
    paragraphs: [
      `The MemberFrame plan for **${projectLabel(input.projectName)}** has ended, so its components are locked and members cannot sign in.`,
      "Open the MemberFrame plugin and upgrade to restore everything. Your members and settings are saved and waiting.",
    ],
    footnote: SUPPORT,
  });
}

// ============================================================================
// TO THE TEAM, BEAF's team-*-mail.html
// ============================================================================

export interface TeamPerson {
  name: string;
  email: string;
  projectName?: string | null;
  siteId?: string;
}

const now = (): string => new Date().toUTCString();

/** One notice per event. Null when no TEAM_NOTIFICATION_EMAIL is set. */
export function teamNotice(
  kind: "signup" | "purchase" | "recurring" | "upgrade" | "cancel" | "payment_failed" | "trial_ended",
  person: TeamPerson,
  details: {
    plan?: string;
    amountMinor?: number;
    currency?: string;
    transactionId?: string | null;
    coupon?: string | null;
    nextBillingDate?: Date | null;
    effectiveDate?: Date | null;
    feedback?: string | null;
    attempt?: number;
    source?: string;
    trialStart?: Date | null;
    trialEnd?: Date | null;
  } = {}
): Mail | null {
  const to = env.billing.teamEmail;
  if (!to) return null;

  const label = details.plan ? (PLAN_LABELS[details.plan] ?? details.plan) : "-";
  const money =
    details.amountMinor !== undefined && details.currency
      ? { value: (details.amountMinor / 100).toFixed(2), currency: details.currency.toUpperCase() }
      : undefined;
  const who = [
    { label: "Customer Name", value: person.name },
    { label: "Customer Email", value: person.email, kind: "email" as const },
    { label: "Site Name", value: person.projectName || "-" },
    { label: "Framer Site ID", value: person.siteId ?? "-", kind: "mono" as const },
  ];

  switch (kind) {
    case "signup":
      return teamMail(to, "team_signup", `New MemberFrame registration: ${person.email}`, {
        title: "New User Registration",
        badge: "Account Registration",
        tone: "blue",
        heading: "New User Registration",
        intro: "A new user has registered for the MemberFrame plugin. Account details are provided below:",
        summaryLabel: "New User",
        summaryValue: person.name,
        rows: [
          { label: "User Name", value: person.name },
          { label: "User Email", value: person.email, kind: "email" },
          { label: "Sign Up Source", value: details.source ?? "Email" },
          { label: "Registration Date", value: now() },
        ],
      });
    case "purchase":
    case "upgrade":
      return teamMail(to, `team_${kind}`, `${kind === "upgrade" ? "Plan upgrade" : "New order"}: ${label} by ${person.email}`, {
        title: kind === "upgrade" ? "Plan Upgrade" : "New Subscription Purchase",
        badge: details.plan === "lifetime" ? "Lifetime Order" : kind === "upgrade" ? "Plan Upgrade" : "Subscription Order",
        tone: "green",
        heading: kind === "upgrade" ? "Plan Upgrade Received" : "New Subscription Order Received",
        intro: "A new purchase has been successfully processed for the MemberFrame plugin. Order summary and customer details are provided below:",
        summaryLabel: "Plan Purchased",
        summaryValue: label,
        ...(money ? { summaryAmount: money } : {}),
        rows: [
          ...who,
          { label: "Transaction ID", value: details.transactionId ?? "-", kind: "mono" },
          { label: "Coupon Applied", value: details.coupon || "None", kind: "good" },
          { label: "Transaction Date", value: now() },
        ],
      });
    case "recurring":
      return teamMail(to, "team_recurring", `Recurring payment: ${label} by ${person.email}`, {
        title: "Recurring Payment Successful",
        badge: "Recurring Payment Successful",
        tone: "green",
        heading: "Recurring Payment Received",
        intro: "A subscription renewal payment has been processed for the MemberFrame plugin. Details are provided below:",
        summaryLabel: "Plan Renewed",
        summaryValue: label,
        ...(money ? { summaryAmount: money } : {}),
        rows: [
          ...who,
          { label: "Transaction ID", value: details.transactionId ?? "-", kind: "mono" },
          { label: "Next Billing Date", value: details.nextBillingDate ? formatDate(details.nextBillingDate) : "-" },
          { label: "Payment Date", value: now() },
        ],
      });
    case "cancel":
      return teamMail(to, "team_cancel", `Plan cancelled: ${label} by ${person.email}`, {
        title: "Plan Cancelled",
        badge: "Subscription Cancelled",
        tone: "red",
        heading: "Subscription Plan Cancelled",
        intro: "A customer has cancelled their MemberFrame subscription. Details are provided below:",
        summaryLabel: "Cancelled Plan",
        summaryValue: label,
        rows: [
          ...who,
          { label: "Access Ends", value: details.effectiveDate ? formatDate(details.effectiveDate) : "-" },
          { label: "Feedback", value: details.feedback || "-" },
          { label: "Cancellation Date", value: now() },
        ],
      });
    case "payment_failed":
      return teamMail(to, "team_payment_failed", `Payment failed: ${label} by ${person.email}`, {
        title: "Payment Failed / Incomplete",
        badge: "Payment Failed",
        tone: "red",
        heading: "Payment Failed",
        intro: "A payment for the MemberFrame plugin could not be completed. Stripe will retry automatically. Details are provided below:",
        summaryLabel: "Plan",
        summaryValue: label,
        ...(money ? { summaryAmount: money } : {}),
        rows: [...who, { label: "Attempt", value: String(details.attempt ?? 1) }, { label: "Date", value: now() }],
      });
    case "trial_ended":
      return teamMail(to, "team_trial_ended", `Free trial ended: ${person.email}`, {
        title: "Free Trial Ended",
        badge: "Free Trial Ended",
        tone: "amber",
        heading: "Free Trial Ended",
        intro: "A MemberFrame free trial has ended without a purchase. Details are provided below:",
        summaryLabel: "Trial Project",
        summaryValue: person.projectName || "-",
        rows: [
          ...who,
          { label: "Trial Start", value: details.trialStart ? formatDate(details.trialStart) : "-" },
          { label: "Trial End", value: details.trialEnd ? formatDate(details.trialEnd) : "-" },
        ],
      });
  }
}
