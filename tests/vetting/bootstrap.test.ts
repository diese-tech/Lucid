/**
 * Tests for the guild inventory bootstrap orchestration (issue #54, Phase 2).
 * The Sheets client is a set of vi.fn() spies rather than a real
 * VettingSheetsClient -- this suite is about what bootstrap asks the Sheets
 * boundary to do, not about the Sheets API itself (sheets-client.test.ts
 * already covers that).
 */

import { describe, expect, it, vi } from 'vitest';
import type { VettingConfig } from '../../src/vetting/config.js';
import { bootstrapGuildInventory } from '../../src/vetting/bootstrap.js';
import type { VettingSheetsClient } from '../../src/vetting/sheets-client.js';
import { mockGuild, mockMember } from '../helpers/discord-mocks.js';

const TIER_ROLE_IDS = {
  1: 'role-tier-1',
  2: 'role-tier-2',
  3: 'role-tier-3',
  4: 'role-tier-4',
  5: 'role-tier-5',
} as const;

function config(): VettingConfig {
  return {
    enabled: true,
    spreadsheetId: 'sheet-123',
    systemSheetName: 'SYSTEM',
    vettingSheetName: 'VETTING',
    pollIntervalSeconds: 120,
    tierRoleIds: TIER_ROLE_IDS,
    googleServiceAccountJson: '{}',
  };
}

function fakeSheetsClient(existingRows: string[][] = []): VettingSheetsClient {
  return {
    getValues: vi.fn().mockResolvedValue(existingRows),
    batchUpdateValues: vi.fn().mockResolvedValue(undefined),
    appendValues: vi.fn().mockResolvedValue(undefined),
  } as unknown as VettingSheetsClient;
}

describe('bootstrapGuildInventory', () => {
  it('appends a brand-new row for a member with no existing SYSTEM row', async () => {
    const alice = mockMember({
      id: 'alice',
      username: 'alice_smith',
      displayName: 'Alice',
      roles: [{ id: 'role-verified', name: 'Verified' }],
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const guild = mockGuild({ members: [alice] });
    const sheets = fakeSheetsClient([]);

    const summary = await bootstrapGuildInventory(guild, sheets, config());

    expect(summary).toEqual({ totalMembers: 1, created: 1, updated: 0, conflicts: [] });
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
    expect(sheets.appendValues).toHaveBeenCalledWith('SYSTEM', 'A2:L100000', [
      ['alice', 'alice_smith', 'Alice', 'TRUE', '2026-01-01T00:00:00.000Z', '', 'Verified', '', '', '', 'Synced', expect.any(String)],
    ]);
  });

  it('excludes bots', async () => {
    const bot = mockMember({ id: 'lucid', bot: true });
    const human = mockMember({ id: 'alice' });
    const guild = mockGuild({ members: [bot, human] });
    const sheets = fakeSheetsClient([]);

    const summary = await bootstrapGuildInventory(guild, sheets, config());

    expect(summary.totalMembers).toBe(1);
    const [, , rows] = (sheets.appendValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe('alice');
  });

  it('updates an existing row in place by Discord ID rather than creating a duplicate', async () => {
    const alice = mockMember({
      id: 'alice',
      username: 'alice_new_name',
      displayName: 'Alice New',
      roles: [{ id: 'role-verified', name: 'Verified' }],
    });
    const guild = mockGuild({ members: [alice] });
    // Existing SYSTEM data: row 2 (first data row) is alice's old record.
    const sheets = fakeSheetsClient([
      ['alice', 'alice_old_name', 'Alice Old', 'TRUE', '', '', 'Old Role', '', '=VLOOKUP(...)', '3', 'Synced', '2026-01-01T00:00:00.000Z'],
    ]);

    const summary = await bootstrapGuildInventory(guild, sheets, config());

    expect(summary).toEqual({ totalMembers: 1, created: 0, updated: 1, conflicts: [] });
    expect(sheets.appendValues).not.toHaveBeenCalled();
    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      {
        sheetName: 'SYSTEM',
        cellRange: 'A2:H2',
        values: [['alice', 'alice_new_name', 'Alice New', 'TRUE', '', '', 'Verified', '']],
      },
      {
        sheetName: 'SYSTEM',
        cellRange: 'K2:L2',
        values: [['Synced', expect.any(String)]],
      },
    ]);
  });

  it('never touches column I (Final Decision formula) or J (Last Applied Tier) on an existing row', async () => {
    const alice = mockMember({ id: 'alice' });
    const guild = mockGuild({ members: [alice] });
    const sheets = fakeSheetsClient([
      ['alice', 'alice', 'alice', 'TRUE', '', '', '', '', '=SOME_FORMULA', '4', 'Synced', ''],
    ]);

    await bootstrapGuildInventory(guild, sheets, config());

    const calls = (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      cellRange: string;
    }[];
    const ranges = calls.map((c) => c.cellRange);
    expect(ranges).toEqual(['A2:H2', 'K2:L2']);
    expect(ranges.join(',')).not.toMatch(/[IJ]2/);
  });

  it('renders current roles as human-readable names, not Discord role IDs', async () => {
    const alice = mockMember({
      id: 'alice',
      roles: [
        { id: 'role-1', name: 'Captain' },
        { id: 'role-2', name: 'Verified' },
      ],
    });
    const guild = mockGuild({ members: [alice] });
    const sheets = fakeSheetsClient([]);

    await bootstrapGuildInventory(guild, sheets, config());

    const [, , rows] = (sheets.appendValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(rows[0][6]).toBe('Captain, Verified');
    expect(rows[0][6]).not.toContain('role-1');
    expect(rows[0][6]).not.toContain('role-2');
  });

  it('excludes the @everyone role from current roles and tier detection', async () => {
    const alice = mockMember({ id: 'alice', roles: [{ id: 'guild-1', name: '@everyone' }] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([]);

    await bootstrapGuildInventory(guild, sheets, config());

    const [, , rows] = (sheets.appendValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(rows[0][6]).toBe('');
  });

  it('represents a member holding exactly one managed tier role with the correct numeric tier', async () => {
    const alice = mockMember({ id: 'alice', roles: [{ id: 'role-tier-3', name: 'Tier 3' }] });
    const guild = mockGuild({ members: [alice] });
    const sheets = fakeSheetsClient([]);

    await bootstrapGuildInventory(guild, sheets, config());

    const [, , rows] = (sheets.appendValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(rows[0][7]).toBe('3');
    expect(rows[0][10]).toBe('Synced');
  });

  it('flags a member holding two managed tier roles as a conflict, choosing neither', async () => {
    const alice = mockMember({
      id: 'alice',
      roles: [
        { id: 'role-tier-1', name: 'Tier 1' },
        { id: 'role-tier-4', name: 'Tier 4' },
      ],
    });
    const guild = mockGuild({ members: [alice] });
    const sheets = fakeSheetsClient([]);

    const summary = await bootstrapGuildInventory(guild, sheets, config());

    expect(summary.conflicts).toEqual(['alice']);
    const [, , rows] = (sheets.appendValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(rows[0][7]).toBe(''); // Current Tier Role left blank
    expect(rows[0][10]).toBe('Conflict'); // Sync Status
  });

  it('is idempotent: re-running against a guild whose members already have SYSTEM rows updates rather than duplicates', async () => {
    const alice = mockMember({ id: 'alice' });
    const bob = mockMember({ id: 'bob' });
    const guild = mockGuild({ members: [alice, bob] });
    const sheets = fakeSheetsClient([
      ['alice', 'alice', 'alice', 'TRUE', '', '', '', '', '', '', 'Synced', ''],
      ['bob', 'bob', 'bob', 'TRUE', '', '', '', '', '', '', 'Synced', ''],
    ]);

    const summary = await bootstrapGuildInventory(guild, sheets, config());

    expect(summary).toEqual({ totalMembers: 2, created: 0, updated: 2, conflicts: [] });
    expect(sheets.appendValues).not.toHaveBeenCalled();
  });
});
