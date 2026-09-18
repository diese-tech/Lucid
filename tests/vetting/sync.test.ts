/**
 * Tests for live Discord -> SYSTEM synchronization (issue #54, Phase 3).
 * The Sheets client is a set of vi.fn() spies -- this suite is about what
 * sync asks the Sheets boundary to do, matching bootstrap.test.ts's own
 * approach (sheets-client.test.ts covers the Sheets API itself).
 */

import { describe, expect, it, vi } from 'vitest';
import type { VettingConfig } from '../../src/vetting/config.js';
import { syncMemberDeparture, syncMemberPresence } from '../../src/vetting/sync.js';
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

function fakeSheetsClient(existingColumnA: string[] = []): VettingSheetsClient {
  return {
    getValues: vi.fn().mockResolvedValue(existingColumnA.map((id) => [id])),
    batchUpdateValues: vi.fn().mockResolvedValue(undefined),
    appendValues: vi.fn().mockResolvedValue(undefined),
  } as unknown as VettingSheetsClient;
}

describe('syncMemberPresence', () => {
  it('appends a brand-new row for a member with no existing SYSTEM row (join)', async () => {
    const alice = mockMember({
      id: 'alice',
      username: 'alice_smith',
      displayName: 'Alice',
      roles: [{ id: 'role-verified', name: 'Verified' }],
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([]);

    await syncMemberPresence(guild, alice, sheets, config());

    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
    expect(sheets.appendValues).toHaveBeenCalledWith('SYSTEM', 'A2:L100000', [
      ['alice', 'alice_smith', 'Alice', 'TRUE', '2026-01-01T00:00:00.000Z', '', 'Verified', '', '', '', 'Synced', expect.any(String)],
    ]);
  });

  it('does nothing for a bot', async () => {
    const bot = mockMember({ id: 'lucid', bot: true });
    const guild = mockGuild({ id: 'guild-1', members: [bot] });
    const sheets = fakeSheetsClient([]);

    await syncMemberPresence(guild, bot, sheets, config());

    expect(sheets.getValues).not.toHaveBeenCalled();
    expect(sheets.appendValues).not.toHaveBeenCalled();
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
  });

  it('updates an existing row in place by Discord ID (rejoin/role change/nickname change), never a duplicate', async () => {
    const alice = mockMember({
      id: 'alice',
      username: 'alice_new_name',
      displayName: 'Alice New',
      roles: [{ id: 'role-verified', name: 'Verified' }],
    });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    // Existing SYSTEM has 'bob' then 'alice' -- alice is the second data row.
    const sheets = fakeSheetsClient(['bob', 'alice']);

    await syncMemberPresence(guild, alice, sheets, config());

    expect(sheets.appendValues).not.toHaveBeenCalled();
    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      {
        sheetName: 'SYSTEM',
        cellRange: 'A3:H3',
        values: [['alice', 'alice_new_name', 'Alice New', 'TRUE', '', '', 'Verified', '']],
      },
      {
        sheetName: 'SYSTEM',
        cellRange: 'K3:L3',
        values: [['Synced', expect.any(String)]],
      },
    ]);
  });

  it('reactivates a rejoining member -- Active TRUE, Left At cleared -- on the same row', async () => {
    const alice = mockMember({ id: 'alice' });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient(['alice']);

    await syncMemberPresence(guild, alice, sheets, config());

    const [update] = (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      values: string[][];
    }[];
    expect(update!.values[0]![3]).toBe('TRUE'); // Active
    expect(update!.values[0]![5]).toBe(''); // Left At
  });

  it('flags a conflict and leaves Current Tier Role blank for a member holding two managed tier roles', async () => {
    const alice = mockMember({
      id: 'alice',
      roles: [
        { id: 'role-tier-1', name: 'Tier 1' },
        { id: 'role-tier-4', name: 'Tier 4' },
      ],
    });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([]);

    await syncMemberPresence(guild, alice, sheets, config());

    const [, , rows] = (sheets.appendValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(rows[0][7]).toBe(''); // Current Tier Role
    expect(rows[0][10]).toBe('Conflict'); // Sync Status
  });
});

describe('syncMemberDeparture', () => {
  it('marks an existing row inactive with a Left At timestamp, without touching roles/tier', async () => {
    const sheets = fakeSheetsClient(['bob', 'alice']);

    await syncMemberDeparture('alice', false, sheets, config());

    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      { sheetName: 'SYSTEM', cellRange: 'D3:D3', values: [['FALSE']] },
      { sheetName: 'SYSTEM', cellRange: 'F3:F3', values: [[expect.any(String)]] },
      { sheetName: 'SYSTEM', cellRange: 'K3:L3', values: [['Synced', expect.any(String)]] },
    ]);
  });

  it('is a no-op for a Discord ID that was never recorded', async () => {
    const sheets = fakeSheetsClient([]);

    await syncMemberDeparture('never-seen', false, sheets, config());

    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
  });

  it('does nothing for a bot', async () => {
    const sheets = fakeSheetsClient(['lucid']);

    await syncMemberDeparture('lucid', true, sheets, config());

    expect(sheets.getValues).not.toHaveBeenCalled();
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
  });
});
