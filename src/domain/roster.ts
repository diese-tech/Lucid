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
 *
 * WORKING ROSTERS AND FIXED SEATS
 * --------------------------------
 * generateWorkingRoster() is the general primitive: it produces the best
 * PARTIAL roster the current signup pool supports, alongside which locations
 * are still open and which eligible players didn't make it in. It also accepts
 * `fixedSlots` — seats staff placed by hand (see flows/seat.ts) — which are
 * pinned exactly as given and excluded from the automatic matching entirely,
 * both as an occupied location the matcher must route around and as a player
 * the matcher must not also try to seat somewhere else.
 *
 * generateRoster() is just generateWorkingRoster() with no fixed slots, whose
 * result is either fully complete or discarded — the pre-Working-Roster
 * behaviour every other caller (Shuffle, Edit Roster, roster-ready detection)
 * still relies on.
 */

import {
  ROLES,
  type PickupFormat,
  type Role,
  type SignupRole,
  type Team,
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

/** One team+role seat on a roster. */
export interface RosterLocation {
  team: Team;
  role: Role;
}

export interface WorkingRosterOptions extends GenerateOptions {
  /**
   * Seats staff placed by hand. Pinned exactly as given: never reassigned,
   * never displaced by the matcher, and excluded from the pool of players the
   * matcher considers for every OTHER seat. Each location and each user may
   * appear at most once — see normalizeFixedSlots.
   */
  fixedSlots?: readonly SlotAssignment[];
}

export interface WorkingRosterResult {
  /** True exactly when every location in the format is occupied. */
  complete: boolean;
  slots: SlotAssignment[];
  missingLocations: RosterLocation[];
  /** Eligible signed-up players (excluding anyone in a fixed slot) not seated anywhere. */
  unseatedUserIds: string[];
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
 * `team:role`, a location's identity for set membership and dedup.
 *
 * Exported so callers that already have a WorkingRosterResult (review.ts,
 * RosterSlotRepository.replaceWorkingRoster) can tell a fixed slot's location
 * apart from an automatic one without duplicating this format.
 */
export function locationKey(location: RosterLocation): string {
  return `${location.team}:${location.role}`;
}

/** Every team+role seat a format has, in fixed ROLES-major, team-minor order. */
function rosterLocations(format: PickupFormat): RosterLocation[] {
  const teams = teamsForFormat(format);
  return ROLES.flatMap((role) => teams.map((team) => ({ team, role })));
}

/**
 * Validate and shape `fixedSlots` for one working-roster computation.
 *
 * Throws on an internally-inconsistent fixed set (the same location claimed
 * twice, or the same user pinned in two places) — that can only mean a caller
 * bug, since Lucid's own roster_slots table enforces UNIQUE(pickup_id, team,
 * role) and the Seat Player flow itself refuses to seat someone already
 * rostered. Never silently drop a conflicting entry; a working roster that
 * looks fine while quietly double-booking a seat is worse than a loud failure.
 */
function normalizeFixedSlots(fixedSlots: readonly SlotAssignment[]): SlotAssignment[] {
  const locations = new Set<string>();
  const users = new Set<string>();
  for (const slot of fixedSlots) {
    const key = locationKey(slot);
    if (locations.has(key)) throw new Error(`Fixed roster location ${key} is duplicated.`);
    if (users.has(slot.userId)) throw new Error(`Fixed roster user ${slot.userId} is duplicated.`);
    locations.add(key);
    users.add(slot.userId);
  }
  return [...fixedSlots];
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
  capacityByRole: ReadonlyMap<Role, number>,
  visited: Set<Role>,
): boolean {
  for (const role of eligibility.get(userId) ?? []) {
    if (visited.has(role)) continue;
    visited.add(role);

    const holders = assignment.get(role)!;
    if (holders.length < (capacityByRole.get(role) ?? 0)) {
      holders.push(userId);
      return true;
    }

    // Role is full. See whether any current holder can move elsewhere.
    for (let i = 0; i < holders.length; i++) {
      const holder = holders[i]!;
      holders.splice(i, 1);
      if (tryAssign(holder, eligibility, assignment, capacityByRole, visited)) {
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
 * Returns role -> userIds, where each role holds at most its available
 * capacity (fewer than the format's normal per-role count when some of that
 * role's locations are already claimed by a fixed slot). `excludeUsers` keeps
 * fixed-slot occupants out of the pool entirely — they are already seated and
 * must not also compete for a second seat.
 */
function match(
  signups: SignupRecord[],
  capacityByRole: ReadonlyMap<Role, number>,
  excludeUsers: ReadonlySet<string>,
  options: GenerateOptions,
): { assignment: Map<Role, string[]>; players: string[] } {
  const mode = options.mode ?? 'deterministic';
  const random = options.random ?? Math.random;

  const eligibility = buildEligibility(signups);
  const earliest = earliestSignupByUser(signups);

  let players = [...eligibility.keys()].filter((userId) => !excludeUsers.has(userId));
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
    tryAssign(userId, eligibility, assignment, capacityByRole, new Set());
  }

  return { assignment, players };
}

/**
 * Place each role's matched holders into that role's still-available
 * locations (i.e. not already claimed by a fixed slot), earliest signup to
 * the earliest location — arbitrary but stable. Lucid is not trying to
 * balance skill here; staff do that by hand with Shuffle and Swap.
 */
function placeIntoLocations(
  assignment: Map<Role, string[]>,
  availableLocations: RosterLocation[],
  signups: SignupRecord[],
  options: GenerateOptions,
): SlotAssignment[] {
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

    const locationsForRole = availableLocations.filter((location) => location.role === role);
    holders.forEach((userId, index) => {
      const location = locationsForRole[index];
      if (location) slots.push({ ...location, userId });
    });
  }
  return slots;
}

/**
 * Compute the best current partial roster: every seat the signup pool can
 * fill given fixed placements, which seats remain open, and which eligible
 * signed-up players didn't make it in.
 *
 * Fixed slots are never regenerated — this is what lets staff hand-place a
 * player and have every later signup change (a new reaction, a withdrawal)
 * keep recalculating around that placement instead of silently overwriting
 * it. Passing the SAME fixed slots on every call is the caller's
 * responsibility (see RosterSlotRepository.replaceWorkingRoster).
 */
export function generateWorkingRoster(
  signups: SignupRecord[],
  format: PickupFormat,
  options: WorkingRosterOptions = {},
): WorkingRosterResult {
  const fixedSlots = normalizeFixedSlots(options.fixedSlots ?? []);
  const fixedUsers = new Set(fixedSlots.map((slot) => slot.userId));
  const fixedLocationKeys = new Set(fixedSlots.map((slot) => locationKey(slot)));

  const allLocations = rosterLocations(format);
  const availableLocations = allLocations.filter((location) => !fixedLocationKeys.has(locationKey(location)));

  const capacityByRole = new Map<Role, number>(
    ROLES.map((role) => [role, availableLocations.filter((l) => l.role === role).length]),
  );

  const { assignment, players } = match(signups, capacityByRole, fixedUsers, options);
  const automaticSlots = placeIntoLocations(assignment, availableLocations, signups, options);

  const slots = [...fixedSlots, ...automaticSlots];
  const occupied = new Set(slots.map((slot) => locationKey(slot)));
  const missingLocations = allLocations.filter((location) => !occupied.has(locationKey(location)));

  const seatedUsers = new Set(slots.map((slot) => slot.userId));
  const unseatedUserIds = players.filter((userId) => !seatedUsers.has(userId));

  return { complete: missingLocations.length === 0, slots, missingLocations, unseatedUserIds };
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
  const working = generateWorkingRoster(signups, format, options);
  return working.complete ? { feasible: true, slots: working.slots } : { feasible: false, slots: [] };
}

/** Convenience wrapper for the roster-ready check, which ignores the assignment. */
export function isRosterReady(signups: SignupRecord[], format: PickupFormat): boolean {
  return generateRoster(signups, format).feasible;
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
