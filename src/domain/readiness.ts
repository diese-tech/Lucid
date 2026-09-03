/**
 * Readiness telemetry: a diagnostic summary of how close a pickup's signup
 * pool is to a feasible roster.
 *
 * This is display-only. generateRoster() in roster.ts remains the sole
 * authority on whether a pickup is actually ready — see that module's header
 * for why raw counts (what this file computes) can look sufficient while the
 * matching still fails, and vice versa is never possible (matching can only
 * succeed with fewer "explicit-role" signups than capacity by pulling in
 * Fill players, which is exactly the shortage/overlap distinction below).
 */

import { ROLES, type PickupFormat, type Role, capacityForFormat } from './roles.js';
import { generateRoster, type SignupRecord } from './roster.js';

export interface RoleCount {
  role: Role;
  /** Unique players who explicitly selected this role (Fill does not count here). */
  count: number;
  capacity: number;
}

export type Blocker =
  /** Every role's raw count is at or above capacity, yet the roster still isn't feasible. */
  | { kind: 'overlap' }
  /** At least one role has fewer explicit signups than it needs. */
  | { kind: 'shortage'; roles: Role[] }
  | null;

export interface Readiness {
  /** Unique currently-eligible players signed up for anything, including Fill-only. */
  eligibleCount: number;
  /** Unique players a feasible roster needs — 10 for Pickup vs Pickup, 5 for Pickup vs Premade. */
  targetPlayers: number;
  roleCounts: RoleCount[];
  /** Unique currently-eligible players who signed up for Fill. */
  fillCount: number;
  blocker: Blocker;
}

/**
 * Summarize a signup pool that has already been filtered to currently-eligible
 * players (see src/discord/eligibility.ts) — this module knows nothing about
 * Discord roles or guild membership.
 */
export function computeReadiness(eligibleSignups: SignupRecord[], format: PickupFormat): Readiness {
  const capacity = capacityForFormat(format);
  const targetPlayers = capacity * ROLES.length;

  const eligibleCount = new Set(eligibleSignups.map((signup) => signup.userId)).size;
  const fillCount = new Set(
    eligibleSignups.filter((signup) => signup.role === 'fill').map((signup) => signup.userId),
  ).size;

  const roleCounts: RoleCount[] = ROLES.map((role) => ({
    role,
    count: new Set(
      eligibleSignups.filter((signup) => signup.role === role).map((signup) => signup.userId),
    ).size,
    capacity,
  }));

  const feasible = generateRoster(eligibleSignups, format).feasible;
  let blocker: Blocker = null;
  if (!feasible) {
    const shortRoles = roleCounts.filter((rc) => rc.count < rc.capacity).map((rc) => rc.role);
    // Every role already shows enough raw signups, so the block is flex-player
    // overlap, not a shortage — see roster.ts's counterexample in its header.
    blocker = shortRoles.length > 0 ? { kind: 'shortage', roles: shortRoles } : { kind: 'overlap' };
  }

  return { eligibleCount, targetPlayers, roleCounts, fillCount, blocker };
}
