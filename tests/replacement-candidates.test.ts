/**
 * Role-aware ordering of post-publish replacement candidates.
 *
 * Staff pick from this list minutes before a pickup starts, so which player
 * the menu offers first -- and which one it flags as an override -- is pinned
 * down explicitly here.
 */

import { describe, expect, it } from 'vitest';
import type { Signup } from '../src/db/repositories/types.js';
import type { SignupRole } from '../src/domain/roles.js';
import { rankReplacementCandidates } from '../src/domain/replacement-candidates.js';

let nextSignupId = 0;

/** Signups are handed to the ranking in the order the caller lists them. */
function signup(userId: string, role: SignupRole): Signup {
  nextSignupId += 1;
  return { id: nextSignupId, pickupId: 1, userId, role, createdAt: nextSignupId };
}

describe('rankReplacementCandidates', () => {
  it('puts players whose signups cover the role ahead of everyone else', () => {
    const signups = [
      signup('off-role', 'mid'),
      signup('filler', 'fill'),
      signup('exact', 'solo'),
    ];

    const ranked = rankReplacementCandidates(signups, new Set(), 'solo');

    expect(ranked.map((candidate) => candidate.userId)).toEqual(['filler', 'exact', 'off-role']);
    expect(ranked.map((candidate) => candidate.offRole)).toEqual([false, false, true]);
  });

  it('leaves exact-role-before-Fill to the caller, by sorting stably within each group', () => {
    const signups = [signup('filler', 'fill'), signup('exact', 'solo')];

    // The same two players, handed over in the opposite order, come back in
    // that opposite order -- both cover Solo, so nothing here separates them.
    expect(
      rankReplacementCandidates([...signups].reverse(), new Set(), 'solo').map((c) => c.userId),
    ).toEqual(['exact', 'filler']);
    expect(rankReplacementCandidates(signups, new Set(), 'solo').map((c) => c.userId)).toEqual([
      'filler',
      'exact',
    ]);
  });

  it('collapses a player\'s several signups into one candidate carrying each distinct role', () => {
    const signups = [
      signup('multi', 'mid'),
      signup('multi', 'fill'),
      signup('multi', 'mid'),
    ];

    const ranked = rankReplacementCandidates(signups, new Set(), 'solo');

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.roles).toEqual(['mid', 'fill']);
    // Fill covers Solo, so the Mid signup alone does not make them off-role.
    expect(ranked[0]!.offRole).toBe(false);
  });

  it('is off-role only when not one of the player\'s signups covers the role', () => {
    const signups = [signup('multi', 'mid'), signup('multi', 'carry')];

    expect(rankReplacementCandidates(signups, new Set(), 'solo')[0]!.offRole).toBe(true);
    expect(rankReplacementCandidates(signups, new Set(), 'carry')[0]!.offRole).toBe(false);
  });

  it('never offers someone who already holds a seat on this roster', () => {
    const signups = [signup('seated', 'solo'), signup('free', 'solo')];

    expect(
      rankReplacementCandidates(signups, new Set(['seated']), 'solo').map((c) => c.userId),
    ).toEqual(['free']);
  });

  it('returns nothing for a pickup nobody signed up for', () => {
    expect(rankReplacementCandidates([], new Set(), 'solo')).toEqual([]);
  });
});
