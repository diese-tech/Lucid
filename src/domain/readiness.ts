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
  /**
   * Topping up exactly these roles (to their raw capacity) would resolve it —
   * the SMALLEST such set found, so this never over-claims that every
   * visibly-short role is individually required when Fill or another
   * flex-role signup could cover one of them instead.
   */
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
    // The roles whose RAW count is visibly below capacity — this, not the
    // matching's internal per-role split, is what "Waiting on: <role>" must
    // be scoped to: a role the matcher leaves short only because it shuffled
    // an existing dual-role player elsewhere (freeing them to plug a gap
    // somewhere else) still isn't a role staff actually need to recruit for,
    // even though its displayed raw count already met capacity.
    const rolesBelowCapacity = roleCounts.filter((rc) => rc.count < rc.capacity);
    const minimalFix = minimalSufficientTopUp(eligibleSignups, format, rolesBelowCapacity);

    blocker = minimalFix ? { kind: 'shortage', roles: minimalFix } : { kind: 'overlap' };
  }

  return { eligibleCount, targetPlayers, roleCounts, fillCount, blocker };
}

/**
 * The smallest subset of `candidates` that, topped up to raw capacity with
 * dedicated non-overlapping signups, makes the pool feasible — or null if no
 * subset (including all of them together) does.
 *
 * Checking only the full candidate set isn't enough: two visibly-short roles
 * can share the same flexible candidates (a dual-role signup, or Fill), so
 * topping up EITHER ALONE can already be sufficient — Fill covers the other.
 * Reporting both as "Waiting on" would then overstate what staff actually
 * need. `candidates` is at most 5 roles, so trying every subset (smallest
 * first, so the first hit found is genuinely minimal) is a few dozen cheap
 * matching calls at worst, not a real cost. See the counterexamples in
 * readiness.test.ts, including the one this exists specifically to catch.
 */
function minimalSufficientTopUp(
  eligibleSignups: SignupRecord[],
  format: PickupFormat,
  candidates: RoleCount[],
): Role[] | null {
  const n = candidates.length;
  const subsetsBySize = Array.from({ length: (1 << n) - 1 }, (_, i) => i + 1).sort(
    (a, b) => popcount(a) - popcount(b) || a - b,
  );

  for (const mask of subsetsBySize) {
    const subset = candidates.filter((_, index) => mask & (1 << index));
    const probe: SignupRecord[] = [...eligibleSignups];
    for (const rc of subset) {
      for (let i = rc.count; i < rc.capacity; i++) {
        probe.push({ userId: `__readiness-probe-${rc.role}-${i}`, role: rc.role, createdAt: 0 });
      }
    }
    if (generateRoster(probe, format).feasible) return subset.map((rc) => rc.role);
  }
  return null;
}

function popcount(value: number): number {
  let count = 0;
  for (let bits = value; bits !== 0; bits >>= 1) count += bits & 1;
  return count;
}
