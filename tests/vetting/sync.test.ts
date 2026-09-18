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
    guildId: 'guild-1',
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

describe('concurrency', () => {
  // Half-Shell's blocking finding on PR #61: syncMemberPresence's
  // find-then-append for a never-seen member is a check-then-act. Two
  // events for the same brand-new member (e.g. GuildMemberAdd immediately
  // followed by a welcome bot's role assignment, which fires
  // GuildMemberUpdate) firing close together could both read column A
  // before either append lands, both conclude the member is missing, and
  // both append a row -- a duplicate identity for the same Discord ID.
  // This fake is stateful (append actually extends what getValues later
  // sees) specifically so this test can tell a real fix from a lucky
  // interleaving: without serialization, both calls' `getValues` reads
  // still race ahead of either `appendValues` write in this same fake.
  function statefulSheetsClient(): VettingSheetsClient {
    let columnA: string[] = [];
    return {
      getValues: vi.fn(async () => columnA.map((id) => [id])),
      batchUpdateValues: vi.fn().mockResolvedValue(undefined),
      appendValues: vi.fn(async (_sheet: string, _range: string, rows: string[][]) => {
        columnA = [...columnA, ...rows.map((row) => row[0]!)];
      }),
    } as unknown as VettingSheetsClient;
  }

  it('never creates two rows for the same Discord ID from two concurrent first-seen presence syncs', async () => {
    const alice = mockMember({ id: 'alice' });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = statefulSheetsClient();

    await Promise.all([
      syncMemberPresence(guild, alice, sheets, config()),
      syncMemberPresence(guild, alice, sheets, config()),
    ]);

    expect(sheets.appendValues).toHaveBeenCalledTimes(1);
    expect(sheets.batchUpdateValues).toHaveBeenCalledTimes(1);
  });

  it('still runs two DIFFERENT members concurrently rather than serializing everything globally', async () => {
    const alice = mockMember({ id: 'alice' });
    const bob = mockMember({ id: 'bob' });
    const guild = mockGuild({ id: 'guild-1', members: [alice, bob] });
    const sheets = statefulSheetsClient();

    await Promise.all([
      syncMemberPresence(guild, alice, sheets, config()),
      syncMemberPresence(guild, bob, sheets, config()),
    ]);

    expect(sheets.appendValues).toHaveBeenCalledTimes(2);
    const appended = (sheets.appendValues as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[2] as string[][])[0]![0],
    );
    expect(new Set(appended)).toEqual(new Set(['alice', 'bob']));
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
