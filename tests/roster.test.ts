/**
 * Roster generation.
 *
 * The point of these tests is not "does it return five names" — it is that the
 * matching is genuinely a matching. The first test below is the one that fails
 * loudly if anybody ever replaces the algorithm with counting reactions.
 */

import { describe, expect, it } from 'vitest';
import { ROLES, type Role, type SignupRole } from '../src/domain/roles.js';
import {
  generateDifferentRoster,
  generateRoster,
  generateWorkingRoster,
  rosterFingerprint,
  type SignupRecord,
  type SlotAssignment,
} from '../src/domain/roster.js';

/** Shorthand fixture builder: `signup('alice', 'solo', 1)`. */
function signup(userId: string, role: SignupRole, createdAt: number): SignupRecord {
  return { userId, role, createdAt };
}

/**
 * The tempting-but-wrong implementation, written out so we can prove it is
 * wrong on the same fixture the real one handles.
 *
 * It walks players in order and gives each the first role that still has room,
 * never reconsidering an earlier choice. That is exactly the behaviour a
 * "simplification" of the real matcher would collapse into.
 */
function naiveGreedyFilled(signups: SignupRecord[], capacity: number): number {
  const eligibility = new Map<string, Role[]>();
  for (const record of signups) {
    const roles = eligibility.get(record.userId) ?? [];
    if (!roles.includes(record.role)) roles.push(record.role);
    eligibility.set(record.userId, roles);
  }

  const seats = new Map<Role, number>(ROLES.map((role) => [role, 0]));
  for (const [, roles] of eligibility) {
    for (const role of roles) {
      if ((seats.get(role) ?? 0) < capacity) {
        seats.set(role, (seats.get(role) ?? 0) + 1);
        break; // first fit wins, and is never revisited
      }
    }
  }
  return [...seats.values()].reduce((sum, count) => sum + count, 0);
}

function userIds(signups: SignupRecord[]): string[] {
  return [...new Set(signups.map((record) => record.userId))];
}

describe('generateRoster — the flex player counterexample', () => {
  // Alice can play Solo or Jungle; Bob can only play Solo. Everyone else is
  // single-role. Processing Alice first (she signed up first) puts her on Solo
  // and strands Bob, leaving Jungle empty — unless the matcher can go back and
  // move Alice to Jungle so Bob can take Solo.
  const signups: SignupRecord[] = [
    signup('alice', 'solo', 1),
    signup('alice', 'jungle', 2),
    signup('bob', 'solo', 3),
    signup('carl', 'mid', 4),
    signup('dana', 'support', 5),
    signup('erin', 'carry', 6),
  ];

  it('defeats a naive first-fit pass', () => {
    // Five roles, one seat each; first-fit seats only four people.
    expect(naiveGreedyFilled(signups, 1)).toBe(4);
  });

  it('is feasible anyway, because the matcher re-seats Alice', () => {
    const result = generateRoster(signups, 'pickup_vs_premade');

    expect(result.feasible).toBe(true);
    expect(result.slots).toHaveLength(5);

    const byRole = new Map(result.slots.map((slot) => [slot.role, slot.userId]));
    expect(byRole.get('solo')).toBe('bob');
    expect(byRole.get('jungle')).toBe('alice');
  });
});

describe('generateRoster — pool sizes', () => {
  // Exactly ten players, one role each, two per role: the threshold case.
  const exactTen: SignupRecord[] = [
    signup('a1', 'solo', 1),
    signup('a2', 'solo', 2),
    signup('b1', 'jungle', 3),
    signup('b2', 'jungle', 4),
    signup('c1', 'mid', 5),
    signup('c2', 'mid', 6),
    signup('d1', 'support', 7),
    signup('d2', 'support', 8),
    signup('e1', 'carry', 9),
    signup('e2', 'carry', 10),
  ];

  it('fills a pickup vs pickup roster exactly', () => {
    const result = generateRoster(exactTen, 'pickup_vs_pickup');

    expect(result.feasible).toBe(true);
    expect(result.slots).toHaveLength(10);

    // Every player is used exactly once.
    expect(new Set(result.slots.map((slot) => slot.userId)).size).toBe(10);

    // Every role appears twice — once on Order, once on Chaos.
    for (const role of ROLES) {
      const forRole = result.slots.filter((slot) => slot.role === role);
      expect(forRole).toHaveLength(2);
      expect(new Set(forRole.map((slot) => slot.team))).toEqual(new Set(['order', 'chaos']));
    }
  });

  it('is not feasible one player short', () => {
    const nine = exactTen.filter((record) => record.userId !== 'e2');

    const result = generateRoster(nine, 'pickup_vs_pickup');
    expect(result.feasible).toBe(false);
    expect(result.slots).toEqual([]);
  });

  it('is deterministic across runs and across input ordering', () => {
    const first = generateRoster(exactTen, 'pickup_vs_pickup');
    const second = generateRoster(exactTen, 'pickup_vs_pickup');
    const shuffledInput = generateRoster([...exactTen].reverse(), 'pickup_vs_pickup');

    expect(rosterFingerprint(first.slots)).toBe(rosterFingerprint(second.slots));
    expect(rosterFingerprint(shuffledInput.slots)).toBe(rosterFingerprint(first.slots));
  });
});

describe('generateRoster — Fill', () => {
  it('uses Fill for any missing standard role without creating a Fill slot', () => {
    const result = generateRoster([
      signup('solo', 'solo', 2),
      signup('jungle', 'jungle', 3),
      signup('mid', 'mid', 4),
      signup('support', 'support', 5),
      signup('flex', 'fill', 1),
    ], 'pickup_vs_premade');

    expect(result.feasible).toBe(true);
    expect(result.slots.find((slot) => slot.userId === 'flex')?.role).toBe('carry');
    expect(result.slots.map((slot) => slot.role)).toEqual(expect.arrayContaining([...ROLES]));
  });

  it('prefers explicit role signups over earlier Fill-only signups', () => {
    const result = generateRoster([
      signup('flex', 'fill', 1),
      signup('solo', 'solo', 2),
      signup('jungle', 'jungle', 3),
      signup('mid', 'mid', 4),
      signup('support', 'support', 5),
      signup('carry', 'carry', 6),
    ], 'pickup_vs_premade');

    expect(result.feasible).toBe(true);
    expect(result.slots.some((slot) => slot.userId === 'flex')).toBe(false);
  });
});

describe('generateRoster — oversubscribed roles', () => {
  // Three people want Solo but there is one Solo seat. The two who miss out
  // simply do not play; the pickup is still perfectly feasible.
  const signups: SignupRecord[] = [
    signup('early', 'solo', 100),
    signup('middle', 'solo', 200),
    signup('late', 'solo', 300),
    signup('jay', 'jungle', 400),
    signup('mia', 'mid', 500),
    signup('sam', 'support', 600),
    signup('cam', 'carry', 700),
  ];

  it('stays feasible and seats the earliest signup', () => {
    const result = generateRoster(signups, 'pickup_vs_premade');

    expect(result.feasible).toBe(true);
    expect(result.slots).toHaveLength(5);

    const solo = result.slots.find((slot) => slot.role === 'solo');
    expect(solo?.userId).toBe('early');
  });

  it('never seats one player in two slots', () => {
    const flexHeavy: SignupRecord[] = [
      signup('alice', 'solo', 1),
      signup('alice', 'jungle', 2),
      signup('bob', 'jungle', 3),
      signup('bob', 'mid', 4),
      signup('carl', 'mid', 5),
      signup('carl', 'support', 6),
      signup('dana', 'support', 7),
      signup('dana', 'carry', 8),
      signup('erin', 'carry', 9),
      signup('erin', 'solo', 10),
    ];

    const result = generateRoster(flexHeavy, 'pickup_vs_premade');

    expect(result.feasible).toBe(true);
    const seated = result.slots.map((slot) => slot.userId);
    expect(new Set(seated).size).toBe(seated.length);
    expect(seated).toHaveLength(5);
    expect(userIds(flexHeavy)).toHaveLength(5);
  });
});

describe('generateDifferentRoster', () => {
  it('reports no alternative when only one arrangement exists', () => {
    // Five players, one role each, one team. Every seat is forced and there is
    // no second team to shuffle anyone into, so no re-roll can differ.
    const forced: SignupRecord[] = [
      signup('alice', 'solo', 1),
      signup('bob', 'jungle', 2),
      signup('carl', 'mid', 3),
      signup('dana', 'support', 4),
      signup('erin', 'carry', 5),
    ];

    const current = generateRoster(forced, 'pickup_vs_premade');
    expect(current.feasible).toBe(true);

    const next = generateDifferentRoster(
      forced,
      'pickup_vs_premade',
      rosterFingerprint(current.slots),
    );

    expect(next.isDifferent).toBe(false);
    expect(next.result.feasible).toBe(true);
    expect(rosterFingerprint(next.result.slots)).toBe(rosterFingerprint(current.slots));
  });

  it('finds a different arrangement when the pool has slack', () => {
    const withSpares: SignupRecord[] = [
      signup('a1', 'solo', 1),
      signup('a2', 'solo', 2),
      signup('a3', 'solo', 3),
      signup('b1', 'jungle', 4),
      signup('b2', 'jungle', 5),
      signup('c1', 'mid', 6),
      signup('c2', 'mid', 7),
      signup('d1', 'support', 8),
      signup('d2', 'support', 9),
      signup('e1', 'carry', 10),
      signup('e2', 'carry', 11),
    ];

    const current = generateRoster(withSpares, 'pickup_vs_pickup');
    expect(current.feasible).toBe(true);

    // Fixed randomness so this cannot flake: this sequence reorders players.
    let tick = 0;
    const next = generateDifferentRoster(
      withSpares,
      'pickup_vs_pickup',
      rosterFingerprint(current.slots),
      { random: () => ((tick = (tick + 7) % 11), tick / 11) },
    );

    expect(next.result.feasible).toBe(true);
    expect(next.isDifferent).toBe(true);
    expect(rosterFingerprint(next.result.slots)).not.toBe(rosterFingerprint(current.slots));
  });
});

describe('generateWorkingRoster — partial pools', () => {
  it('reports every location missing for an empty signup pool', () => {
    const result = generateWorkingRoster([], 'pickup_vs_pickup');

    expect(result.complete).toBe(false);
    expect(result.slots).toEqual([]);
    expect(result.unseatedUserIds).toEqual([]);
    expect(result.missingLocations).toHaveLength(10);
    for (const role of ROLES) {
      const forRole = result.missingLocations.filter((loc) => loc.role === role);
      expect(forRole.map((loc) => loc.team).sort()).toEqual(['chaos', 'order']);
    }
  });

  it('seats who it can and reports the rest as missing, never invents a slot', () => {
    const result = generateWorkingRoster(
      [
        signup('alice', 'solo', 1),
        signup('bob', 'jungle', 2),
        signup('carl', 'mid', 3),
      ],
      'pickup_vs_pickup',
    );

    expect(result.complete).toBe(false);
    expect(result.slots).toHaveLength(3);
    expect(new Set(result.slots.map((slot) => slot.userId))).toEqual(new Set(['alice', 'bob', 'carl']));
    // One seat per role filled (2 needed), so each role appears once in missingLocations.
    expect(result.missingLocations).toHaveLength(7);
    expect(result.missingLocations.filter((loc) => loc.role === 'solo')).toHaveLength(1);
    expect(result.unseatedUserIds).toEqual([]);
  });

  it('lists an eligible signed-up player who could not be seated as unseated', () => {
    // Three players all want Solo; the format has room for two.
    const result = generateWorkingRoster(
      [
        signup('early', 'solo', 1),
        signup('middle', 'solo', 2),
        signup('late', 'solo', 3),
      ],
      'pickup_vs_pickup',
    );

    expect(result.slots.map((slot) => slot.userId).sort()).toEqual(['early', 'middle']);
    expect(result.unseatedUserIds).toEqual(['late']);
  });

  it('matches generateRoster exactly once the pool is complete', () => {
    const signups: SignupRecord[] = [
      signup('a1', 'solo', 1),
      signup('a2', 'solo', 2),
      signup('b1', 'jungle', 3),
      signup('b2', 'jungle', 4),
      signup('c1', 'mid', 5),
      signup('c2', 'mid', 6),
      signup('d1', 'support', 7),
      signup('d2', 'support', 8),
      signup('e1', 'carry', 9),
      signup('e2', 'carry', 10),
    ];

    const working = generateWorkingRoster(signups, 'pickup_vs_pickup');
    const full = generateRoster(signups, 'pickup_vs_pickup');

    expect(working.complete).toBe(true);
    expect(working.missingLocations).toEqual([]);
    expect(rosterFingerprint(working.slots)).toBe(rosterFingerprint(full.slots));
  });
});

describe('generateWorkingRoster — fixed (staff-assigned) slots', () => {
  it('pins a fixed slot exactly as given and excludes it from missing locations', () => {
    const fixedSlots: SlotAssignment[] = [{ team: 'order', role: 'solo', userId: 'coach-pick' }];

    const result = generateWorkingRoster([], 'pickup_vs_pickup', { fixedSlots });

    expect(result.slots).toEqual(fixedSlots);
    expect(result.missingLocations).toHaveLength(9);
    expect(result.missingLocations.some((loc) => loc.team === 'order' && loc.role === 'solo')).toBe(false);
  });

  it('excludes a fixed occupant from the automatic pool even if they also signed up', () => {
    // 'coach-pick' signed up for Jungle but staff hand-placed them at Solo/Order.
    // The matcher must not also try to seat them at Jungle.
    const fixedSlots: SlotAssignment[] = [{ team: 'order', role: 'solo', userId: 'coach-pick' }];
    const result = generateWorkingRoster(
      [signup('coach-pick', 'jungle', 1), signup('other', 'jungle', 2)],
      'pickup_vs_pickup',
      { fixedSlots },
    );

    const jungleSlots = result.slots.filter((slot) => slot.role === 'jungle');
    expect(jungleSlots.map((slot) => slot.userId)).toEqual(['other']);
    expect(result.unseatedUserIds).toEqual([]);
  });

  it('routes automatic seating around a fixed slot instead of double-booking it', () => {
    // Order/Solo is pinned to 'coach-pick'. Two other Solo signups compete for
    // the one remaining Solo seat (Chaos/Solo).
    const fixedSlots: SlotAssignment[] = [{ team: 'order', role: 'solo', userId: 'coach-pick' }];
    const result = generateWorkingRoster(
      [signup('early', 'solo', 1), signup('late', 'solo', 2)],
      'pickup_vs_pickup',
      { fixedSlots },
    );

    const soloSlots = result.slots.filter((slot) => slot.role === 'solo');
    expect(soloSlots).toHaveLength(2);
    expect(soloSlots.find((slot) => slot.team === 'order')?.userId).toBe('coach-pick');
    expect(soloSlots.find((slot) => slot.team === 'chaos')?.userId).toBe('early');
    expect(result.unseatedUserIds).toEqual(['late']);
  });

  it('reaches complete with fixed slots filling in alongside automatic ones', () => {
    const fixedSlots: SlotAssignment[] = [
      { team: 'order', role: 'solo', userId: 'coach-pick-1' },
      { team: 'chaos', role: 'carry', userId: 'coach-pick-2' },
    ];
    const result = generateWorkingRoster(
      [
        signup('a2', 'solo', 1),
        signup('b1', 'jungle', 2),
        signup('b2', 'jungle', 3),
        signup('c1', 'mid', 4),
        signup('c2', 'mid', 5),
        signup('d1', 'support', 6),
        signup('d2', 'support', 7),
        signup('e1', 'carry', 8),
      ],
      'pickup_vs_pickup',
      { fixedSlots },
    );

    expect(result.complete).toBe(true);
    expect(result.slots).toHaveLength(10);
    expect(result.slots.filter((slot) => slot.userId === 'coach-pick-1' || slot.userId === 'coach-pick-2')).toEqual(
      fixedSlots,
    );
  });

  it('throws when two fixed slots claim the same location', () => {
    expect(() =>
      generateWorkingRoster([], 'pickup_vs_pickup', {
        fixedSlots: [
          { team: 'order', role: 'solo', userId: 'a' },
          { team: 'order', role: 'solo', userId: 'b' },
        ],
      }),
    ).toThrow(/duplicated/);
  });

  it('throws when the same user is pinned to two fixed slots', () => {
    expect(() =>
      generateWorkingRoster([], 'pickup_vs_pickup', {
        fixedSlots: [
          { team: 'order', role: 'solo', userId: 'dupe' },
          { team: 'chaos', role: 'jungle', userId: 'dupe' },
        ],
      }),
    ).toThrow(/duplicated/);
  });
});
