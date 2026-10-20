/**
 * Which member a social sign in belongs to (31-sign-in-methods.md).
 *
 * One account per email, each provider a separate identity linked to it, as
 * Auth0, Clerk, and Firebase do. In order:
 *
 *   1. This provider's own user id is already linked: that member, even if
 *      their email at the provider has changed since.
 *   2. A member has this email: linked only when the provider says it verified
 *      the address. Otherwise refused, so an unverified address can never sign
 *      in to someone else's account.
 *   3. Nobody: a new member, signed up with this provider.
 *
 * Linking to a password account whose email was never confirmed clears the
 * password and ends its sessions. Someone could have registered that address
 * first with a password of their own ("pre-hijacking"); the provider just
 * proved who really owns it.
 *
 * `decideOAuthLink` is the rule, pure and tested. `resolveOAuthMember` only
 * reads and writes the rows it names.
 */

import { prisma } from "../config/db.js";
import { freeTierKey } from "../lib/tiers.js";
import { revokeAllSessionsForMember } from "./sessionService.js";
import { emitMemberEvent } from "./webhookService.js";

export const OAUTH_PROVIDERS = ["google", "apple", "github", "discord"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface OAuthProfile {
  provider: OAuthProvider;
  /** The provider's own stable id: Google and Apple `sub`, GitHub and Discord `id`. */
  providerUserId: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  /** Whether the provider says it verified this address. */
  emailVerified: boolean;
}

export type LinkDecision =
  | { kind: "identity"; memberId: string }
  | { kind: "link"; memberId: string; clearPassword: boolean }
  | { kind: "create" }
  | { kind: "refuse"; reason: "email_unverified_link" };

export function decideOAuthLink(input: {
  /** The live member this provider id is linked to, if any. */
  identityMemberId: string | null;
  /** The live member with this email, if any. */
  emailMember: { id: string; hasPassword: boolean; emailConfirmed: boolean } | null;
  emailVerified: boolean;
}): LinkDecision {
  if (input.identityMemberId) return { kind: "identity", memberId: input.identityMemberId };
  if (!input.emailMember) return { kind: "create" };
  if (!input.emailVerified) return { kind: "refuse", reason: "email_unverified_link" };
  return {
    kind: "link",
    memberId: input.emailMember.id,
    clearPassword: input.emailMember.hasPassword && !input.emailMember.emailConfirmed,
  };
}

/** The member to sign in for this social sign in, linking or creating as the rule says, or why not. */
export async function resolveOAuthMember(siteId: string, profile: OAuthProfile): Promise<{ id: string } | { refused: string }> {
  const email = profile.email.toLowerCase().trim();
  const now = new Date();

  const identity = await prisma.memberIdentity.findUnique({
    where: { siteId_provider_providerUserId: { siteId, provider: profile.provider, providerUserId: profile.providerUserId } },
    select: { id: true, member: { select: { id: true, deletedAt: true } } },
  });
  const identityMemberId = identity && identity.member.deletedAt === null ? identity.member.id : null;

  const emailRow = identityMemberId
    ? null
    : await prisma.member.findFirst({
        where: { siteId, email, deletedAt: null },
        select: { id: true, passwordHash: true, emailVerifiedAt: true },
      });

  const decision = decideOAuthLink({
    identityMemberId,
    emailMember: emailRow ? { id: emailRow.id, hasPassword: emailRow.passwordHash !== null, emailConfirmed: emailRow.emailVerifiedAt !== null } : null,
    emailVerified: profile.emailVerified,
  });

  if (decision.kind === "refuse") return { refused: decision.reason };

  let memberId: string;
  if (decision.kind === "create") {
    const created = await prisma.member.create({
      data: {
        siteId,
        email,
        name: profile.name || null,
        avatarUrl: profile.avatarUrl || null,
        emailVerifiedAt: profile.emailVerified ? now : null,
        signupMethod: profile.provider,
        lastLoginAt: now,
        activeTier: await freeTierKey(siteId),
        status: "active",
      },
      select: { id: true },
    });
    memberId = created.id;
    void emitMemberEvent("member.created", { id: memberId, siteId });
  } else {
    memberId = decision.memberId;
    const current = await prisma.member.findUniqueOrThrow({
      where: { id: memberId },
      select: { name: true, avatarUrl: true, emailVerifiedAt: true },
    });
    const clearPassword = decision.kind === "link" && decision.clearPassword;
    await prisma.member.update({
      where: { id: memberId },
      data: {
        lastLoginAt: now,
        name: current.name || profile.name || null,
        avatarUrl: current.avatarUrl || profile.avatarUrl || null,
        emailVerifiedAt: current.emailVerifiedAt ?? (profile.emailVerified ? now : null),
        ...(clearPassword ? { passwordHash: null, passwordUpdatedAt: now } : {}),
      },
    });
    // Whoever set that password is signed out everywhere.
    if (clearPassword) await revokeAllSessionsForMember(memberId);
  }

  // Record (or move, after a re-registration) this provider's identity.
  await prisma.memberIdentity.upsert({
    where: { siteId_provider_providerUserId: { siteId, provider: profile.provider, providerUserId: profile.providerUserId } },
    create: { siteId, memberId, provider: profile.provider, providerUserId: profile.providerUserId, email, lastUsedAt: now },
    update: { memberId, email, lastUsedAt: now },
  });

  return { id: memberId };
}
