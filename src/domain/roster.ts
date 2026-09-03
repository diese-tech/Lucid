/**
 * Roster feasibility and generation.
 *
 * This module is deliberately free of any Discord or database types so it can be
 * unit-tested on its own. It is the one piece of Lucid with real algorithmic
 * content, and the one most likely to be "simplified" into something wrong.
 *
 * WHY THIS ISN'T JUST COUNTING REACTIONS
 * --------------------------------------
 * The obvious implementation — "do we have 2 people signed up for each role?" —
 * is incorrect whenever a player signs up for two roles, because that player is
 * shared capacity across both.
 *
 * Worked counterexample:
 *   Alice reacts Solo and Jungle.
 *   Bob   reacts Solo only.
 * Counting says Solo has 2 candidates and Jungle has 1. Walking the roles in
 * order and greedily taking the first eligible player gives Solo -> Alice, and
 * then Jungle has nobody left, so we wrongly report "not ready" — even though
 * Bob -> Solo, Alice -> Jungle works perfectly.
 *
 * So this is a bipartite matching problem: players on one side, roles (with a
 * capacity of 2 or 1) on the other. We use augmenting paths — when a role is
 * full, we ask whether one of its current holders could move somewhere else to
 * free a seat. With five roles and at most two roles per player the search is
 * tiny, so a plain recursive implementation is more than fast enough.
 */

import {
  ROLES,
  type PickupFormat,
  type Role,
  type SignupRole,
  type Team,
  capacityForFormat,
  teamsForFormat,
} from './roles.js';

export interface SignupRecord {
  userId: string;
  role: SignupRole;
  /** Unix ms. Used as the deterministic tie-break when a role is oversubscribed. */
  createdAt: number;
}

export interface SlotAssignment {
  team: Team;
  role: Role;
  userId: string;
}

export interface RosterResult {
  feasible: boolean;
  /** Populated only when `feasible` is true. */
  slots: SlotAssignment[];
}

export type GenerationMode = 'deterministic' | 'shuffle';

export interface GenerateOptions {
  mode?: GenerationMode;
  /** Injectable randomness so shuffle behavior is testable. */
  random?: () => number;
}

/** Map of userId -> the roles that user signed up for, in fixed ROLES order. */
function buildEligibility(signups: SignupRecord[]): Map<string, Role[]> {
  const byUser = new Map<string, Set<SignupRole>>();
  for (const signup of signups) {
    let roles = byUser.get(signup.userId);
    if (!roles) {
      roles = new Set();
      byUser.set(signup.userId, roles);
    }
    roles.add(signup.role);
  }

  const eligibility = new Map<string, Role[]>();
  for (const [userId, roles] of byUser) {
    const explicit = ROLES.filter((role) => roles.has(role));
    const fallback = roles.has('fill') ? ROLES.filter((role) => !roles.has(role)) : [];
    eligibility.set(userId, [...explicit, ...fallback]);
  }
  return eligibility;
}

/** Earliest signup timestamp per user — the deterministic ordering key. */
function earliestSignupByUser(signups: SignupRecord[]): Map<string, number> {
  const earliest = new Map<string, number>();
  for (const signup of signups) {
    const current = earliest.get(signup.userId);
    if (current === undefined || signup.createdAt < current) {
      earliest.set(signup.userId, signup.createdAt);
    }
  }
  return earliest;
}

function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

/**
 * Try to seat `userId`, displacing current holders onto other roles if needed.
 *
 * `visited` tracks roles already examined during THIS user's search, which is
 * what stops the recursion from cycling between two full roles forever.
 */
function tryAssign(
  userId: string,
  eligibility: Map<string, Role[]>,
  assignment: Map<Role, string[]>,
  capacity: number,
  visited: Set<Role>,
): boolean {
  for (const role of eligibility.get(userId) ?? []) {
    if (visited.has(role)) continue;
    visited.add(role);

    const holders = assignment.get(role)!;
    if (holders.length < capacity) {
      holders.push(userId);
      return true;
    }

    // Role is full. See whether any current holder can move elsewhere.
    for (let i = 0; i < holders.length; i++) {
      const holder = holders[i]!;
      holders.splice(i, 1);
      if (tryAssign(holder, eligibility, assignment, capacity, visited)) {
        holders.push(userId);
        return true;
      }
      holders.splice(i, 0, holder); // put them back; that path didn't work out
    }
  }
  return false;
}

/**
 * Build a maximum matching of players to roles.
 *
 * Returns role -> userIds, where each role holds at most `capacity` players.
 */
function match(
  signups: SignupRecord[],
  capacity: number,
  options: GenerateOptions,
): Map<Role, string[]> {
  const mode = options.mode ?? 'deterministic';
  const random = options.random ?? Math.random;

  const eligibility = buildEligibility(signups);
  const earliest = earliestSignupByUser(signups);

  let players = [...eligibility.keys()];
  const hasExplicitRole = (userId: string) =>
    signups.some((signup) => signup.userId === userId && signup.role !== 'fill');
  if (mode === 'shuffle') {
    players = [
      ...shuffleInPlace(players.filter(hasExplicitRole), random),
      ...shuffleInPlace(players.filter((userId) => !hasExplicitRole(userId)), random),
    ];
  } else {
    // Deterministic order: earliest signup first, user ID as a stable
    // tie-break so identical timestamps can't reorder between runs.
    players = players.sort((a, b) => {
      const explicitDelta = Number(hasExplicitRole(b)) - Number(hasExplicitRole(a));
      const delta = (earliest.get(a) ?? 0) - (earliest.get(b) ?? 0);
      return explicitDelta !== 0 ? explicitDelta : delta !== 0 ? delta : a.localeCompare(b);
    });
  }

  const assignment = new Map<Role, string[]>();
  for (const role of ROLES) assignment.set(role, []);

  for (const userId of players) {
    tryAssign(userId, eligibility, assignment, capacity, new Set());
  }

  return assignment;
}

/**
 * Split each role's matched players across the teams of a format.
 *
 * Pickup vs Premade has one team, so this is a passthrough. For Pickup vs
 * Pickup the deterministic rule is "earlier signer to Order" — arbitrary but
 * stable. Lucid is not trying to balance skill here; staff do that by hand with
 * Shuffle and Swap.
 */
function splitIntoTeams(
  assignment: Map<Role, string[]>,
  format: PickupFormat,
  signups: SignupRecord[],
  options: GenerateOptions,
): SlotAssignment[] {
  const teams = teamsForFormat(format);
  const earliest = earliestSignupByUser(signups);
  const mode = options.mode ?? 'deterministic';
  const random = options.random ?? Math.random;

  const slots: SlotAssignment[] = [];
  for (const role of ROLES) {
    const holders = [...assignment.get(role)!];

    if (mode === 'shuffle') {
      shuffleInPlace(holders, random);
    } else {
      holders.sort((a, b) => {
        const delta = (earliest.get(a) ?? 0) - (earliest.get(b) ?? 0);
        return delta !== 0 ? delta : a.localeCompare(b);
      });
    }

    teams.forEach((team, index) => {
      const userId = holders[index];
      if (userId) slots.push({ team, role, userId });
    });
  }
  return slots;
}

/**
 * Check feasibility and, when feasible, produce a complete roster.
 *
 * A pickup is roster-ready exactly when the matching fills every role to
 * capacity — not when raw signup counts look sufficient. See the module header.
 */
export function generateRoster(
  signups: SignupRecord[],
  format: PickupFormat,
  options: GenerateOptions = {},
): RosterResult {
  const capacity = capacityForFormat(format);
  const assignment = match(signups, capacity, options);

  const filled = [...assignment.values()].reduce((sum, users) => sum + users.length, 0);
  const feasible = filled === capacity * ROLES.length;

  if (!feasible) return { feasible: false, slots: [] };
  return { feasible: true, slots: splitIntoTeams(assignment, format, signups, options) };
}

/** Convenience wrapper for the roster-ready check, which ignores the assignment. */
export function isRosterReady(signups: SignupRecord[], format: PickupFormat): boolean {
  return generateRoster(signups, format).feasible;
}

/**
 * Per-role holder counts from the maximum matching, whether or not it fills
 * every role to capacity.
 *
 * Used by readiness telemetry (src/domain/readiness.ts) to tell a genuine
 * per-role shortage from a shortage that Fill's flexibility already resolves
 * elsewhere. A role's raw signup count alone can't answer that — Fill players
 * aren't tied to any one role until the matching actually runs, so which
 * role(s) end up short depends on where the algorithm routes them, not on
 * counting reactions. See this module's header for the general reason raw
 * counts are the wrong tool for exactly this kind of question.
 */
export function matchedRoleCounts(
  signups: SignupRecord[],
  format: PickupFormat,
  options: GenerateOptions = {},
): Record<Role, number> {
  const capacity = capacityForFormat(format);
  const assignment = match(signups, capacity, options);
  const counts = {} as Record<Role, number>;
  for (const role of ROLES) counts[role] = assignment.get(role)?.length ?? 0;
  return counts;
}

/** Stable comparison key, used to detect "Shuffle produced the same roster again". */
export function rosterFingerprint(slots: SlotAssignment[]): string {
  return [...slots]
    .map((slot) => `${slot.team}:${slot.role}:${slot.userId}`)
    .sort()
    .join('|');
}

/**
 * Generate a roster that differs from `currentFingerprint` if any alternative exists.
 *
 * Shuffle re-rolls rather than permuting the existing roster, so it can pull in
 * players who signed up after the first draft was generated. When only one valid
 * arrangement exists we give up after a bounded number of tries and tell the
 * caller, rather than silently redisplaying an identical roster.
 */
export function generateDifferentRoster(
  signups: SignupRecord[],
  format: PickupFormat,
  currentFingerprint: string,
  options: GenerateOptions = {},
): { result: RosterResult; isDifferent: boolean } {
  const attempts = 5;
  let last: RosterResult = { feasible: false, slots: [] };

  for (let i = 0; i < attempts; i++) {
    last = generateRoster(signups, format, { ...options, mode: 'shuffle' });
    if (!last.feasible) return { result: last, isDifferent: false };
    if (rosterFingerprint(last.slots) !== currentFingerprint) {
      return { result: last, isDifferent: true };
    }
  }
  return { result: last, isDifferent: false };
}
