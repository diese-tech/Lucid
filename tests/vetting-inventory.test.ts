/**
 * Tests for the pure logic behind issue #54 Phase 2's guild inventory
 * bootstrap -- tier detection, role-name rendering, and the SYSTEM row shape.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSystemRowValues,
  detectManagedTier,
  renderRoleNames,
} from '../src/domain/vetting-inventory.js';

const TIER_ROLE_IDS = {
  1: 'role-tier-1',
  2: 'role-tier-2',
  3: 'role-tier-3',
  4: 'role-tier-4',
  5: 'role-tier-5',
} as const;

describe('detectManagedTier', () => {
  it('returns no tier and no conflict for a member with no managed role', () => {
    expect(detectManagedTier(['some-other-role'], TIER_ROLE_IDS)).toEqual({
      tier: null,
      conflict: false,
    });
  });

  it('detects the single tier a member holds', () => {
    expect(detectManagedTier(['unrelated', 'role-tier-3'], TIER_ROLE_IDS)).toEqual({
      tier: 3,
      conflict: false,
    });
  });

  it('flags a conflict, and picks no tier, when a member holds two managed roles', () => {
    expect(detectManagedTier(['role-tier-1', 'role-tier-4'], TIER_ROLE_IDS)).toEqual({
      tier: null,
      conflict: true,
    });
  });

  it('flags a conflict for all five managed roles at once', () => {
    expect(detectManagedTier(Object.values(TIER_ROLE_IDS), TIER_ROLE_IDS)).toEqual({
      tier: null,
      conflict: true,
    });
  });
});

describe('renderRoleNames', () => {
  it('joins role names alphabetically, regardless of input order', () => {
    expect(renderRoleNames(['Zebra', 'Alpha', 'Mid'])).toBe('Alpha, Mid, Zebra');
  });

  it('returns an empty string for a member with no roles', () => {
    expect(renderRoleNames([])).toBe('');
  });
});

describe('buildSystemRowValues', () => {
  it('always marks Active TRUE and leaves Left At blank', () => {
    const row = buildSystemRowValues({
      discordId: '123',
      username: 'alice',
      displayName: 'Alice',
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
      currentRolesText: 'Captain, Verified',
      tier: 2,
    });

    expect(row).toEqual([
      '123',
      'alice',
      'Alice',
      'TRUE',
      '2026-01-01T00:00:00.000Z',
      '',
      'Captain, Verified',
      '2',
    ]);
  });

  it('writes an empty Current Tier Role for a member with no managed tier', () => {
    const row = buildSystemRowValues({
      discordId: '123',
      username: 'alice',
      displayName: 'Alice',
      joinedAt: null,
      currentRolesText: '',
      tier: null,
    });

    expect(row[4]).toBe('');
    expect(row[7]).toBe('');
  });
});
