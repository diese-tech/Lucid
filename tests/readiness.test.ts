/**
 * Unit tests for src/domain/readiness.ts.
 *
 * This module never talks to Discord or the database -- callers are
 * responsible for handing it a signup pool already filtered to
 * currently-eligible players (see src/discord/eligibility.ts). These tests
 * therefore never need a guild or a member: "restricted" and "unrestricted"
 * pickups look identical here, because filtering already happened upstream.
 */

import { describe, expect, it } from 'vitest';
import { computeReadiness } from '../src/domain/readiness.js';
import type { SignupRecord } from '../src/domain/roster.js';

function signup(userId: string, role: SignupRecord['role'], createdAt = 0): SignupRecord {
  return { userId, role, createdAt };
}

describe('computeReadiness', () => {
  it('reports a fully empty pool for Pickup vs Pickup', () => {
    const readiness = computeReadiness([], 'pickup_vs_pickup');
    expect(readiness.eligibleCount).toBe(0);
    expect(readiness.targetPlayers).toBe(10);
    expect(readiness.fillCount).toBe(0);
    expect(readiness.roleCounts).toEqual([
      { role: 'solo', count: 0, capacity: 2 },
      { role: 'jungle', count: 0, capacity: 2 },
      { role: 'mid', count: 0, capacity: 2 },
      { role: 'support', count: 0, capacity: 2 },
      { role: 'carry', count: 0, capacity: 2 },
    ]);
    expect(readiness.blocker).toEqual({ kind: 'shortage', roles: ['solo', 'jungle', 'mid', 'support', 'carry'] });
  });

  it('uses a 5-player target and 1-capacity roles for Pickup vs Premade', () => {
    const readiness = computeReadiness([], 'pickup_vs_premade');
    expect(readiness.targetPlayers).toBe(5);
    expect(readiness.roleCounts.every((rc) => rc.capacity === 1)).toBe(true);
  });

  it('counts each player once per role regardless of duplicate rows', () => {
    // Shouldn't happen in practice (the repo enforces uniqueness), but the
    // counting logic itself should not double count if it ever did.
    const readiness = computeReadiness(
      [signup('alice', 'solo'), signup('alice', 'solo')],
      'pickup_vs_pickup',
    );
    expect(readiness.roleCounts.find((rc) => rc.role === 'solo')?.count).toBe(1);
    expect(readiness.eligibleCount).toBe(1);
  });

  it('surfaces a straightforward shortage, naming only the short role(s)', () => {
    const signups: SignupRecord[] = [
      signup('solo-a', 'solo'), signup('solo-b', 'solo'),
      signup('jungle-a', 'jungle'), signup('jungle-b', 'jungle'),
      signup('mid-a', 'mid'), signup('mid-b', 'mid'),
      signup('carry-a', 'carry'), signup('carry-b', 'carry'),
      signup('support-a', 'support'), // only one Support signup
    ];
    const readiness = computeReadiness(signups, 'pickup_vs_pickup');
    expect(readiness.eligibleCount).toBe(9);
    expect(readiness.blocker).toEqual({ kind: 'shortage', roles: ['support'] });
  });

  it("flags flex-player role overlap when every role's raw count looks sufficient but matching still fails", () => {
    // Solo and Jungle need 2+2=4 seats between them, but only three people
    // (alice/bob/carol) are eligible for either -- each shows up in BOTH
    // roles' raw counts, so Solo and Jungle each display 3/2 (well over
    // capacity) while the other three roles are filled cleanly. The pool
    // still can't produce 10 unique assignments: one of the four Solo/Jungle
    // seats has nobody left to fill it once the other three are seated.
    const signups: SignupRecord[] = [
      signup('alice', 'solo'), signup('alice', 'jungle'),
      signup('bob', 'solo'), signup('bob', 'jungle'),
      signup('carol', 'solo'), signup('carol', 'jungle'),
      signup('d', 'mid'), signup('e', 'mid'), signup('j', 'mid'),
      signup('f', 'support'), signup('g', 'support'),
      signup('h', 'carry'), signup('i', 'carry'),
    ];
    const readiness = computeReadiness(signups, 'pickup_vs_pickup');
    expect(readiness.eligibleCount).toBe(10);
    expect(readiness.roleCounts).toEqual(
      expect.arrayContaining([
        { role: 'solo', count: 3, capacity: 2 },
        { role: 'jungle', count: 3, capacity: 2 },
      ]),
    );
    // No role shows below capacity, yet the pool is not actually feasible.
    expect(readiness.roleCounts.every((rc) => rc.count >= rc.capacity)).toBe(true);
    expect(readiness.blocker).toEqual({ kind: 'overlap' });
  });

  it("returns no blocker once the pool is actually feasible", () => {
    const signups: SignupRecord[] = (['solo', 'jungle', 'mid', 'support', 'carry'] as const).flatMap(
      (role) => [signup(`${role}-a`, role), signup(`${role}-b`, role)],
    );
    const readiness = computeReadiness(signups, 'pickup_vs_pickup');
    expect(readiness.blocker).toBeNull();
    expect(readiness.eligibleCount).toBe(10);
  });

  it('names the real blocker, not a role Fill already covers, when Fill can resolve a visible shortage', () => {
    // Codex review finding on PR #31: 3 dual Solo/Jungle players, 3 Mid, 2
    // Carry, 1 Support, 1 Fill. Support's raw count (1) looks short, but
    // Solo+Jungle need 4 seats for only 3 dedicated candidates -- the real
    // maximum matching routes Fill to bridge Solo/Jungle (filling both to
    // capacity), leaving Support as the one role actually still short.
    // "Waiting on: Support" is genuinely correct here, and must stay correct
    // rather than being right by coincidence of raw-count math.
    const signups: SignupRecord[] = [
      signup('a', 'solo'), signup('a', 'jungle'),
      signup('b', 'solo'), signup('b', 'jungle'),
      signup('c', 'solo'), signup('c', 'jungle'),
      signup('m1', 'mid'), signup('m2', 'mid'), signup('m3', 'mid'),
      signup('cy1', 'carry'), signup('cy2', 'carry'),
      signup('s1', 'support'),
      signup('f1', 'fill'),
    ];
    const readiness = computeReadiness(signups, 'pickup_vs_pickup');
    expect(readiness.blocker).toEqual({ kind: 'shortage', roles: ['support'] });
  });

  it('reports overlap, not a misleading single-role fix, when a visible shortage co-occurs with hidden overlap', () => {
    // Same Solo/Jungle-overlap pool as above, but WITHOUT the Fill player.
    // Support's raw count is still short (1/2), but even a second Support
    // signup would not make this roster feasible -- Solo/Jungle only has 3
    // candidates for 4 seats and nothing here can bridge that gap. Naming
    // "Waiting on: Support" alone would be actively misleading.
    const signups: SignupRecord[] = [
      signup('a', 'solo'), signup('a', 'jungle'),
      signup('b', 'solo'), signup('b', 'jungle'),
      signup('c', 'solo'), signup('c', 'jungle'),
      signup('m1', 'mid'), signup('m2', 'mid'),
      signup('cy1', 'carry'), signup('cy2', 'carry'),
      signup('s1', 'support'),
    ];
    const readiness = computeReadiness(signups, 'pickup_vs_pickup');
    expect(readiness.blocker).toEqual({ kind: 'overlap' });
  });

  it('reports overlap, not two independent shortages, when both short roles share the same flexible candidate', () => {
    // Second codex review finding on PR #31: one Solo/Jungle dual player plus
    // two dedicated players for each other role. Solo and Jungle both show
    // 1/2 raw -- but only one physical person is available to either of
    // them, so topping each up independently (one dedicated Solo signup, one
    // dedicated Jungle signup) still leaves only 3 candidates for 4 seats.
    // "Waiting on: Solo 1/2, Jungle 1/2" would be a fix that doesn't fix it.
    const signups: SignupRecord[] = [
      signup('dual', 'solo'), signup('dual', 'jungle'),
      signup('m1', 'mid'), signup('m2', 'mid'),
      signup('s1', 'support'), signup('s2', 'support'),
      signup('cy1', 'carry'), signup('cy2', 'carry'),
    ];
    const readiness = computeReadiness(signups, 'pickup_vs_pickup');
    expect(readiness.roleCounts).toEqual(
      expect.arrayContaining([
        { role: 'solo', count: 1, capacity: 2 },
        { role: 'jungle', count: 1, capacity: 2 },
      ]),
    );
    expect(readiness.blocker).toEqual({ kind: 'overlap' });
  });

  it('counts Fill signups separately from any role numerator', () => {
    const signups: SignupRecord[] = [signup('a', 'solo'), signup('b', 'fill'), signup('c', 'fill')];
    const readiness = computeReadiness(signups, 'pickup_vs_pickup');
    expect(readiness.fillCount).toBe(2);
    expect(readiness.roleCounts.find((rc) => rc.role === 'solo')?.count).toBe(1);
    // Fill never inflates a role's raw numerator -- it is compatibility, not
    // a role selection, and the matching engine (not this display module)
    // is what decides whether a Fill player ends up seated somewhere.
    expect(readiness.roleCounts.find((rc) => rc.role === 'jungle')?.count).toBe(0);
  });
});
