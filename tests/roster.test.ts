/**
 * Roster generation.
 *
 * The point of these tests is not "does it return five names" — it is that the
 * matching is genuinely a matching. The first test below is the one that fails
 * loudly if anybody ever replaces the algorithm with counting reactions.
 */

import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from '../src/domain/roles.js';
import {
  generateDifferentRoster,
  generateRoster,
  rosterFingerprint,
  type SignupRecord,
} from '../src/domain/roster.js';

/** Shorthand fixture builder: `signup('alice', 'solo', 1)`. */
function signup(userId: string, role: Role, createdAt: number): SignupRecord {
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
