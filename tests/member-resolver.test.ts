/**
 * "Who did the coordinator mean?" ranking.
 *
 * The ordering rules here are what stop Lucid from guessing wrong under time
 * pressure, so they are pinned down explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_CANDIDATES,
  candidateLabel,
  rankCandidates,
  type MemberCandidate,
} from '../src/domain/member-resolver.js';

function member(partial: Partial<MemberCandidate> & { userId: string; username: string }): MemberCandidate {
  return { displayName: null, nickname: null, isBot: false, ...partial };
}

describe('rankCandidates', () => {
  it('puts an exact match above starts-with, and starts-with above contains', () => {
    const members = [
      member({ userId: '3', username: 'thedreamerx' }), // contains
      member({ userId: '2', username: 'dreamer123' }), // starts with
      member({ userId: '1', username: 'dreamer' }), // exact
    ];

    const ranked = rankCandidates('dreamer', members);

    expect(ranked.map((candidate) => candidate.userId)).toEqual(['1', '2', '3']);
    expect(ranked.map((candidate) => candidate.rank)).toEqual([0, 1, 2]);
  });

  it('matches nicknames and display names, not just usernames', () => {
    const members = [
      member({ userId: 'nick', username: 'xk3d', nickname: 'Dreamer' }),
      member({ userId: 'global', username: 'q7v2', displayName: 'Dreamer Two' }),
      member({ userId: 'nope', username: 'unrelated' }),
    ];

    const ranked = rankCandidates('dreamer', members);

    expect(ranked.map((candidate) => candidate.userId).sort()).toEqual(['global', 'nick']);
    // The nickname is an exact hit; the display name only starts with the query.
    expect(ranked.find((candidate) => candidate.userId === 'nick')?.rank).toBe(0);
    expect(ranked.find((candidate) => candidate.userId === 'global')?.rank).toBe(1);
  });

  it('never offers a bot', () => {
    const members = [
      member({ userId: 'bot', username: 'dreamerbot', isBot: true }),
      member({ userId: 'human', username: 'dreamerhuman' }),
    ];

    expect(rankCandidates('dreamer', members).map((c) => c.userId)).toEqual(['human']);
  });

  it('drops anyone already holding a roster slot', () => {
    const members = [
      member({ userId: 'seated', username: 'dreamer1' }),
      member({ userId: 'free', username: 'dreamer2' }),
    ];

    expect(rankCandidates('dreamer', members, ['seated']).map((c) => c.userId)).toEqual(['free']);
  });

  it('caps the list so the select menu stays readable', () => {
    const members = Array.from({ length: 20 }, (_, index) =>
      member({ userId: String(index), username: `dreamer${String(index).padStart(2, '0')}` }),
    );

    const ranked = rankCandidates('dreamer', members);

    expect(MAX_CANDIDATES).toBe(8);
    expect(ranked).toHaveLength(8);
  });

  it('returns nothing for an empty or blank query', () => {
    const members = [member({ userId: '1', username: 'dreamer' })];

    expect(rankCandidates('', members)).toEqual([]);
    expect(rankCandidates('   ', members)).toEqual([]);
  });

  it('is case-insensitive', () => {
    const members = [member({ userId: '1', username: 'Dreamer' })];
    expect(rankCandidates('dReAmEr', members)).toHaveLength(1);
  });
});

describe('candidateLabel', () => {
  it('shows the display name alongside the handle when they differ', () => {
    expect(candidateLabel(member({ userId: '1', username: 'xk3d', nickname: 'Dreamer' }))).toBe(
      'Dreamer (@xk3d)',
    );
  });

  it('shows the handle alone when there is nothing to add', () => {
    expect(candidateLabel(member({ userId: '1', username: 'dreamer' }))).toBe('@dreamer');
  });
});
