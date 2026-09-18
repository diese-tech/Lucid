/**
 * Pure logic for issue #54 Phase 2's guild inventory bootstrap -- kept free
 * of Discord/Sheets types so it's directly testable against fixtures. The
 * orchestration in vetting/bootstrap.ts supplies already-fetched member data
 * and calls these to decide what a SYSTEM row should say.
 */

import type { VettingTier } from '../vetting/config.js';

export interface ManagedTierDetection {
  /** The single tier this member's roles map to, or null if zero or 2+ (a conflict). */
  tier: VettingTier | null;
  /** True when the member holds more than one configured tier role at once. */
  conflict: boolean;
}

/**
 * Which configured tier role (if any) a member currently holds. Never
 * guesses when a member holds more than one -- that's exactly the "multiple
 * managed tier roles exist" case the issue says must surface as a conflict
 * rather than silently preferring one.
 */
export function detectManagedTier(
  memberRoleIds: readonly string[],
  tierRoleIds: Record<VettingTier, string>,
): ManagedTierDetection {
  const held = Object.entries(tierRoleIds)
    .filter(([, roleId]) => memberRoleIds.includes(roleId))
    .map(([tier]) => Number(tier) as VettingTier);

  if (held.length === 0) return { tier: null, conflict: false };
  if (held.length === 1) return { tier: held[0]!, conflict: false };
  return { tier: null, conflict: true };
}

/** Comma-joined, alphabetically sorted, human-readable role names for SYSTEM's Current Roles column. */
export function renderRoleNames(roleNames: readonly string[]): string {
  return [...roleNames].sort((a, b) => a.localeCompare(b)).join(', ');
}

export interface SystemRowInput {
  discordId: string;
  username: string;
  displayName: string;
  joinedAt: Date | null;
  currentRolesText: string;
  tier: VettingTier | null;
}

/**
 * The SYSTEM columns A-H for one member: Discord ID, Username, Display Name,
 * Active, Joined At, Left At, Current Roles, Current Tier Role -- always
 * `Active = TRUE` and `Left At` blank, since bootstrap only ever processes
 * members currently present in the guild (departure is Phase 3's job).
 *
 * Deliberately stops at column H. Column I (Final Decision) is a formula
 * reading from VETTING, and column J (Last Applied Tier) belongs to Phase
 * 6's reconciliation -- neither is this function's, or bootstrap's, to set.
 */
export function buildSystemRowValues(input: SystemRowInput): string[] {
  return [
    input.discordId,
    input.username,
    input.displayName,
    'TRUE',
    input.joinedAt ? input.joinedAt.toISOString() : '',
    '',
    input.currentRolesText,
    input.tier !== null ? String(input.tier) : '',
  ];
}
