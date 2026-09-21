/**
 * Tests for the shared VETTING layout resolver (issue #71).
 * `resolveVettingLayout` is pure and header-driven, so every case here
 * builds a header row directly rather than mocking the Sheets client --
 * proving the resolver is genuinely width-independent, not just correct
 * for the two previously-hard-coded 8/13-ish shapes.
 */

import { describe, expect, it } from 'vitest';
import {
  columnIndexToLetter,
  columnLetterToIndex,
  columnRange,
  resolveVettingLayout,
  VettingLayoutError,
} from '../../src/vetting/vetting-layout.js';

/**
 * Builds a VETTING row-2 header array: `Discord ID, Player, Current
 * Roles, <reviewerCount reviewer columns>, Vote Summary, Consensus, Final
 * Decision, <trailing>` -- reviewer names are arbitrary/human, matching
 * the issue's "reviewer names themselves remain arbitrary human-editable
 * headers" framing.
 */
function buildHeaderRow(reviewerCount: number, trailing: string[] = []): string[] {
  const reviewers = Array.from({ length: reviewerCount }, (_, i) => `Reviewer ${i + 1}`);
  return ['Discord ID', 'Player', 'Current Roles', ...reviewers, 'Vote Summary', 'Consensus', 'Final Decision', ...trailing];
}

describe('columnIndexToLetter / columnLetterToIndex', () => {
  it('round-trips single-letter columns', () => {
    expect(columnIndexToLetter(1)).toBe('A');
    expect(columnIndexToLetter(4)).toBe('D');
    expect(columnIndexToLetter(26)).toBe('Z');
    expect(columnLetterToIndex('A')).toBe(1);
    expect(columnLetterToIndex('D')).toBe(4);
    expect(columnLetterToIndex('Z')).toBe(26);
  });

  it('crosses the Z -> AA boundary correctly', () => {
    expect(columnIndexToLetter(27)).toBe('AA');
    expect(columnLetterToIndex('AA')).toBe(27);
  });

  it('crosses the AA -> AB boundary and nearby multi-letter columns', () => {
    expect(columnIndexToLetter(28)).toBe('AB');
    expect(columnLetterToIndex('AB')).toBe(28);
    expect(columnIndexToLetter(52)).toBe('AZ');
    expect(columnIndexToLetter(53)).toBe('BA');
    expect(columnLetterToIndex('AZ')).toBe(52);
    expect(columnLetterToIndex('BA')).toBe(53);
  });

  it('round-trips every column from 1 to 800 (well past Z and AA)', () => {
    for (let i = 1; i <= 800; i++) {
      expect(columnLetterToIndex(columnIndexToLetter(i))).toBe(i);
    }
  });

  it('rejects a non-positive or non-integer index', () => {
    expect(() => columnIndexToLetter(0)).toThrow(RangeError);
    expect(() => columnIndexToLetter(-1)).toThrow(RangeError);
    expect(() => columnIndexToLetter(1.5)).toThrow(RangeError);
  });
});

describe('columnRange', () => {
  it('builds an open-ended A1 column range', () => {
    expect(columnRange(4, 11)).toBe('D:K');
    expect(columnRange(27, 28)).toBe('AA:AB');
  });
});

describe('resolveVettingLayout -- fixed cases', () => {
  it('resolves the existing 8-reviewer layout (D:K / L / M / N) unchanged', () => {
    const layout = resolveVettingLayout(buildHeaderRow(8, ['OSL', 'BSL']));
    expect(layout).toEqual({
      discordIdColumn: 1,
      displayNameColumn: 2,
      currentRolesColumn: 3,
      reviewerStartColumn: 4,
      reviewerEndColumn: 11,
      reviewerCount: 8,
      voteSummaryColumn: 12,
      consensusColumn: 13,
      finalDecisionColumn: 14,
    });
    expect(columnIndexToLetter(layout.reviewerStartColumn)).toBe('D');
    expect(columnIndexToLetter(layout.reviewerEndColumn)).toBe('K');
    expect(columnIndexToLetter(layout.voteSummaryColumn)).toBe('L');
    expect(columnIndexToLetter(layout.consensusColumn)).toBe('M');
    expect(columnIndexToLetter(layout.finalDecisionColumn)).toBe('N');
  });

  it('resolves a small 4-reviewer layout (Ratatoskr-like)', () => {
    const layout = resolveVettingLayout(buildHeaderRow(4));
    expect(layout.reviewerCount).toBe(4);
    expect(columnIndexToLetter(layout.reviewerStartColumn)).toBe('D');
    expect(columnIndexToLetter(layout.reviewerEndColumn)).toBe('G');
    expect(columnIndexToLetter(layout.voteSummaryColumn)).toBe('H');
    expect(columnIndexToLetter(layout.consensusColumn)).toBe('I');
    expect(columnIndexToLetter(layout.finalDecisionColumn)).toBe('J');
  });

  it('resolves a large 13-reviewer layout (Dream Walkers-like)', () => {
    const layout = resolveVettingLayout(buildHeaderRow(13));
    expect(layout.reviewerCount).toBe(13);
    expect(columnIndexToLetter(layout.reviewerStartColumn)).toBe('D');
    expect(columnIndexToLetter(layout.reviewerEndColumn)).toBe('P');
    expect(columnIndexToLetter(layout.voteSummaryColumn)).toBe('Q');
    expect(columnIndexToLetter(layout.consensusColumn)).toBe('R');
    expect(columnIndexToLetter(layout.finalDecisionColumn)).toBe('S');
  });

  it('reviewer names are arbitrary and never affect the resolved layout', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'Alice', 'Bob (Lead)', "O'Brien", 'Vote Summary', 'Consensus', 'Final Decision'];
    const layout = resolveVettingLayout(header);
    expect(layout.reviewerCount).toBe(3);
  });
});

describe('resolveVettingLayout -- column-letter boundary stress cases', () => {
  it('supports a reviewer count large enough to push Vote Summary/Consensus/Final Decision past Z', () => {
    // 3 fixed + N reviewers + 3 calculated must land beyond column Z (26).
    const reviewerCount = 30;
    const layout = resolveVettingLayout(buildHeaderRow(reviewerCount));
    expect(layout.reviewerCount).toBe(reviewerCount);
    expect(columnIndexToLetter(layout.voteSummaryColumn).length).toBeGreaterThan(1);
    expect(columnIndexToLetter(layout.consensusColumn).length).toBeGreaterThan(1);
    expect(columnIndexToLetter(layout.finalDecisionColumn).length).toBeGreaterThan(1);
  });

  it('resolves a layout whose calculated columns straddle Z -> AA exactly', () => {
    // currentRolesColumn = 3, so reviewerEnd = 3 + reviewerCount; choose a
    // count that lands Vote Summary exactly on AA (27).
    const reviewerCount = 23; // reviewerStart=4, reviewerEnd=26 (Z), voteSummary=27 (AA)
    const layout = resolveVettingLayout(buildHeaderRow(reviewerCount));
    expect(columnIndexToLetter(layout.reviewerEndColumn)).toBe('Z');
    expect(columnIndexToLetter(layout.voteSummaryColumn)).toBe('AA');
    expect(columnIndexToLetter(layout.consensusColumn)).toBe('AB');
    expect(columnIndexToLetter(layout.finalDecisionColumn)).toBe('AC');
  });
});

describe('resolveVettingLayout -- deterministic randomized coverage', () => {
  // Fixed-seed mulberry32 PRNG so a failure is reproducible without
  // depending on Math.random() or any test-runner seeding feature.
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function assertInvariants(reviewerCount: number): void {
    const layout = resolveVettingLayout(buildHeaderRow(reviewerCount, ['OSL', 'BSL']));
    expect(layout.reviewerCount).toBe(reviewerCount);
    expect(layout.reviewerStartColumn).toBe(layout.currentRolesColumn + 1);
    expect(layout.reviewerEndColumn).toBe(layout.reviewerStartColumn + reviewerCount - 1);
    expect(layout.voteSummaryColumn).toBe(layout.reviewerEndColumn + 1);
    expect(layout.consensusColumn).toBe(layout.voteSummaryColumn + 1);
    expect(layout.finalDecisionColumn).toBe(layout.consensusColumn + 1);
  }

  it('holds for random reviewer counts between 4 and 13', () => {
    const rand = mulberry32(0x54_71_74_54); // "Tt" 71 74 in hex-ish, arbitrary fixed seed
    for (let i = 0; i < 25; i++) {
      const reviewerCount = 4 + Math.floor(rand() * 10); // 4..13
      assertInvariants(reviewerCount);
    }
  });

  it('holds for random reviewer counts greater than 13, including ones crossing column Z', () => {
    const rand = mulberry32(0x37_31_72_31);
    for (let i = 0; i < 25; i++) {
      const reviewerCount = 14 + Math.floor(rand() * 40); // 14..53
      assertInvariants(reviewerCount);
    }
  });
});

describe('resolveVettingLayout -- OSL/BSL-like trailing custom fields', () => {
  it('never counts a post-Final-Decision column as a reviewer', () => {
    const layout = resolveVettingLayout(buildHeaderRow(8, ['OSL', 'BSL']));
    expect(layout.reviewerCount).toBe(8);
    // OSL/BSL live at finalDecisionColumn + 1 and + 2, entirely outside
    // every field the layout resolves.
    const values = Object.values(layout);
    expect(values).not.toContain(layout.finalDecisionColumn + 1);
    expect(values).not.toContain(layout.finalDecisionColumn + 2);
  });

  it('adding a reviewer column before Vote Summary does not change OSL/BSL semantic ownership -- they just shift right with the sheet', () => {
    const before = resolveVettingLayout(buildHeaderRow(8, ['OSL', 'BSL']));
    const after = resolveVettingLayout(buildHeaderRow(9, ['OSL', 'BSL']));
    expect(after.reviewerCount).toBe(before.reviewerCount + 1);
    expect(after.finalDecisionColumn).toBe(before.finalDecisionColumn + 1);
  });
});

describe('resolveVettingLayout -- invalid/malformed layouts fail closed', () => {
  it('rejects a header row missing Vote Summary', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'R2', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(VettingLayoutError);
    expect(() => resolveVettingLayout(header)).toThrow(/Vote Summary/);
  });

  it('rejects a duplicated Vote Summary header', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Vote Summary', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(VettingLayoutError);
    expect(() => resolveVettingLayout(header)).toThrow(/duplicated/);
  });

  it('rejects a header row missing Consensus', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/Consensus/);
  });

  it('rejects a duplicated Consensus header', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/duplicated/);
  });

  it('rejects a header row missing Final Decision', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Consensus'];
    expect(() => resolveVettingLayout(header)).toThrow(/Final Decision/);
  });

  it('rejects a duplicated Final Decision header', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Final Decision', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/duplicated/);
  });

  it('rejects Consensus not immediately after Vote Summary', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Extra', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/immediately after "Vote Summary"/);
  });

  it('rejects Final Decision not immediately after Consensus', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Extra', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/immediately after "Consensus"/);
  });

  it('rejects calculated columns given entirely out of order', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Final Decision', 'Consensus', 'Vote Summary'];
    expect(() => resolveVettingLayout(header)).toThrow(VettingLayoutError);
  });

  it('rejects zero reviewer columns between Current Roles and Vote Summary', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'Vote Summary', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/reviewer column/);
  });

  it('rejects a missing Current Roles header', () => {
    const header = ['Discord ID', 'Player', 'R1', 'R2', 'Vote Summary', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/Current Roles/);
  });

  it('rejects a duplicated Current Roles header', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(/duplicated/);
  });

  it('rejects a missing Discord ID or Player header', () => {
    expect(() => resolveVettingLayout(['Player', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Final Decision'])).toThrow(/Discord ID/);
    expect(() => resolveVettingLayout(['Discord ID', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Final Decision'])).toThrow(/Player/);
  });

  it('a staff typo (renaming Vote Summary to "Votes") produces a safe layout error, not shifted writes', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'R2', 'Votes', 'Consensus', 'Final Decision'];
    expect(() => resolveVettingLayout(header)).toThrow(VettingLayoutError);
  });

  it('an invalid layout never returns a partial/best-guess result', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'Vote Summary', 'Consensus', 'Final Decision'];
    let thrown = false;
    try {
      resolveVettingLayout(header);
    } catch (error) {
      thrown = true;
      expect(error).toBeInstanceOf(VettingLayoutError);
    }
    expect(thrown).toBe(true);
  });
});
