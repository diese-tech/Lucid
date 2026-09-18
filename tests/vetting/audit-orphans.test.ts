/**
 * Tests for the read-only orphaned-SYSTEM-row audit (not part of any
 * automated pass) -- confirms it flags exactly the rows whose Discord ID
 * doesn't match a member Discord's API currently returns, regardless of
 * that row's own `Active` value, and leaves every current member's row
 * alone. Real data on SYSTEM starts at row 3 (row 1 a title, row 2 the
 * column headers) -- every fixture here reflects that, and a dedicated
 * regression test below reproduces the real header layout directly
 * (Half-Shell's PR #70 finding: an earlier version read from row 2,
 * treating the literal header text as a candidate Discord ID).
 */

import { describe, expect, it, vi } from 'vitest';
import type { VettingConfig } from '../../src/vetting/config.js';
import { findOrphanedSystemRows } from '../../src/vetting/audit-orphans.js';
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
    driftRepairIntervalSeconds: 1800,
    tierRoleIds: TIER_ROLE_IDS,
    googleServiceAccountJson: '{}',
  };
}

function fakeSheetsClient(rows: string[][]): VettingSheetsClient {
  return { getValues: vi.fn().mockResolvedValue(rows) } as unknown as VettingSheetsClient;
}

/**
 * Simulates the actual live sheet layout -- row 1 a title (never read by
 * anything in this codebase), row 2 the real column headers, row 3+ real
 * player data -- by parsing the requested range itself, rather than just
 * returning whatever `dataRows` it's given regardless of range. This is
 * what makes it possible to prove the audit's read boundary genuinely
 * excludes row 2, rather than merely asserting on a fixture that already
 * assumes the fix.
 */
function realisticSheetsClient(dataRows: string[][]): VettingSheetsClient {
  const headerRow = [
    'Discord ID',
    'Username',
    'Display Name',
    'Active',
    'Joined At',
    'Left At',
    'Current Roles',
    'Current Tier Role',
    'Final Decision',
    'Last Applied Tier',
    'Sync Status',
    'Last Synced',
  ];
  // Index 0 of this array is row 2 (the header row); index 1 is row 3, etc.
  const fullSheet = [headerRow, ...dataRows];

  return {
    getValues: vi.fn(async (_sheetName: string, range: string) => {
      const match = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(range);
      if (!match) throw new Error(`unexpected range in test: ${range}`);
      const startRow = Number(match[1]);
      const endRow = Number(match[2]);
      return fullSheet.slice(startRow - 2, endRow - 2 + 1);
    }),
  } as unknown as VettingSheetsClient;
}

/** SYSTEM row: A=id, B=username, C=displayName, D=Active, E=Joined, F=Left, G=Current Roles. */
function systemRow(overrides: {
  id: string;
  username?: string;
  displayName?: string;
  active?: string;
  joinedAt?: string;
  leftAt?: string;
  currentRoles?: string;
}): string[] {
  return [
    overrides.id,
    overrides.username ?? '',
    overrides.displayName ?? '',
    overrides.active ?? 'TRUE',
    overrides.joinedAt ?? '',
    overrides.leftAt ?? '',
    overrides.currentRoles ?? '',
  ];
}

describe('findOrphanedSystemRows', () => {
  it('a row for a current guild member is never flagged, regardless of its Active value', async () => {
    const alice = mockMember({ id: 'alice' });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', active: 'FALSE' })]);

    const orphans = await findOrphanedSystemRows(guild, sheets, config());

    expect(orphans).toEqual([]);
  });

  it('a row whose Discord ID matches no current member is flagged, with its key fields surfaced', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = fakeSheetsClient([
      systemRow({
        id: 'ghost',
        username: 'octopustentacles.',
        displayName: 'OctopusTentacles',
        active: 'FALSE',
        joinedAt: '2026-04-26T14:51:13.388Z',
        leftAt: '2026-09-18T14:13:49.667Z',
        currentRoles: 'Allfather',
      }),
    ]);

    const orphans = await findOrphanedSystemRows(guild, sheets, config());

    expect(orphans).toEqual([
      {
        rowNumber: 3,
        discordId: 'ghost',
        username: 'octopustentacles.',
        displayName: 'OctopusTentacles',
        active: 'FALSE',
        joinedAt: '2026-04-26T14:51:13.388Z',
        leftAt: '2026-09-18T14:13:49.667Z',
        currentRoles: 'Allfather',
      },
    ]);
  });

  it('flags an orphaned row even when Active is TRUE -- never assumes an orphan is always inactive', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = fakeSheetsClient([systemRow({ id: 'ghost', active: 'TRUE' })]);

    const orphans = await findOrphanedSystemRows(guild, sheets, config());

    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.active).toBe('TRUE');
  });

  it('rows with a blank Discord ID are skipped, not reported as orphans', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = fakeSheetsClient([['', '', '', 'FALSE', '', '', '']]);

    const orphans = await findOrphanedSystemRows(guild, sheets, config());

    expect(orphans).toEqual([]);
  });

  it('reports each orphan\'s real row number, accounting for the header offset', async () => {
    const bob = mockMember({ id: 'bob' });
    const guild = mockGuild({ id: 'guild-1', members: [bob] });
    const sheets = fakeSheetsClient([
      systemRow({ id: 'bob' }),
      systemRow({ id: 'ghost-1' }),
      systemRow({ id: 'ghost-2' }),
    ]);

    const orphans = await findOrphanedSystemRows(guild, sheets, config());

    expect(orphans.map((o) => [o.rowNumber, o.discordId])).toEqual([
      [4, 'ghost-1'],
      [5, 'ghost-2'],
    ]);
  });

  it('reads from row 3 onward, never row 2 -- Half-Shell PR #70 finding', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = fakeSheetsClient([]);

    await findOrphanedSystemRows(guild, sheets, config());

    expect(sheets.getValues).toHaveBeenCalledWith('SYSTEM', 'A3:L100000');
  });

  it('never flags the real SYSTEM header row as an orphan, and real players keep correct row numbers -- Half-Shell PR #70 finding', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    // Row 2 (the header row) is baked into realisticSheetsClient itself --
    // this reproduces the exact live-sheet layout that would have
    // triggered the original bug (row 2's literal "Discord ID" header text
    // treated as a candidate Discord ID) if the read range still included it.
    const sheets = realisticSheetsClient([systemRow({ id: 'ghost', currentRoles: 'Allfather' })]);

    const orphans = await findOrphanedSystemRows(guild, sheets, config());

    expect(orphans).toEqual([expect.objectContaining({ rowNumber: 3, discordId: 'ghost' })]);
    expect(orphans.some((o) => o.discordId === 'Discord ID')).toBe(false);
  });
});
