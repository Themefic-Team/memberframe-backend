/**
 * The entitlement resolver. THE THIRD COPY.
 *
 * PRD section 11.3 requires this function to be implemented identically in the
 * plugin, the canvas components, and the backend, and says in plain words that
 * divergence between the three is a security defect.
 *
 * The other two copies are:
 *   src/utils/entitlement.ts              the plugin panel
 *   src/canvas-components/MemberGate.tsx  the published site
 *
 * Those two are held together by `test/memberGateParity.test.ts`, which has
 * been proved able to fail. Until this file existed, the third copy was the one
 * with nothing watching it, which is the copy that decides whether a real
 * member really gets in. `test/entitlementParity.test.ts` in this package now
 * reads the frontend source across the directory boundary and compares.
 *
 * Why a copy at all, rather than a shared package: the canvas component is
 * compiled by Framer alone on a creator's published site and can import
 * nothing from this repository. Since one copy is forced, a second is not worse
 * in kind, and a parity test is cheaper than a published package for three
 * consumers in one git repo. If the component constraint ever lifts, collapse
 * all three.
 *
 * DO NOT EDIT THIS FUNCTION WITHOUT EDITING BOTH OTHERS. The parity test will
 * fail the build if you do, which is the point.
 */

// ============================================================================
// TYPES, MIRRORED FROM src/types/member.ts
// ============================================================================

/** Any tier's key. The site's tiers are the creator's own (23-dynamic-tiers.md). */
export type TierKey = string;

export type RequiredTier = "anyone" | "signed_in" | TierKey;

export type MemberStatus = "active" | "trialing" | "past_due" | "canceled";

export interface MemberSessionData {
  memberId: string;
  email: string;
  name: string | null;
  activeTier: string;
  status: MemberStatus;
  /** Unix seconds, UTC. */
  currentPeriodEnd: number;
  /**
   * Unix seconds, UTC. Zero when no grace window applies.
   *
   * CONFLICT C1: the resolver below reads this field and the `MemberSessionData`
   * interface in PRD section F01 declares seven fields without it. The backend
   * PRD section 6.2 resolves it by requiring the session endpoint to send it.
   * This is the server side of that resolution.
   */
  gracePeriodEndsAt: number;
  siteId: string;
}

export interface TierLadderEntry {
  key: string;
  rank: number;
  name?: string;
}

/**
 * The fallback ladder.
 *
 * Present so this file's signature matches the other two copies exactly, which
 * the parity test depends on. In practice the backend always passes the site's
 * real tiers read from the database, and conflict C5 is resolved precisely so
 * the other two copies can stop relying on this default.
 */
export const DEFAULT_SITE_TIERS: ReadonlyArray<TierLadderEntry> = [
  { key: "free_member", rank: 0 },
  { key: "tier_1", rank: 1 },
  { key: "tier_2", rank: 2 },
  { key: "vip", rank: 3 },
];

// ============================================================================
// THE RESOLVER
// ============================================================================

export function isEntitled(
  session: MemberSessionData | null,
  requiredTier: RequiredTier,
  tiers: ReadonlyArray<TierLadderEntry> = DEFAULT_SITE_TIERS,
  nowSeconds: number = Date.now() / 1000
): boolean {
  if (requiredTier === "anyone") return true;
  if (!session) return false;

  // A canceled member keeps what they paid for until the period actually ends,
  // and a past_due member keeps access through the F18 grace window. Neither is
  // a courtesy: billing already took the money for that time.
  const statusOk =
    session.status === "active" ||
    session.status === "trialing" ||
    (session.status === "past_due" && nowSeconds < session.gracePeriodEndsAt) ||
    (session.status === "canceled" && nowSeconds < session.currentPeriodEnd);

  if (!statusOk) return false;
  if (requiredTier === "signed_in") return true;

  const required = tiers.find((tier) => tier.key === requiredTier);
  const held = tiers.find((tier) => tier.key === session.activeTier);

  // Either key missing means the site's tier table and this gate disagree.
  // Ranks cannot be compared, so the gate stays shut.
  if (!required || !held) return false;

  // Hierarchical by rank, so a VIP passes a Silver gate with no extra config.
  return held.rank >= required.rank;
}
