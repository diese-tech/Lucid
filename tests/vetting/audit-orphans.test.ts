/**
 * Tests for the read-only orphaned-SYSTEM-row audit (not part of any
 * automated pass) -- confirms it flags exactly the rows whose Discord ID
 * doesn't match a member Discord's API currently returns, regardless of
 * that row's own `Active` value, and leaves every current member's row
 * alone.
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
        rowNumber: 2,
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
      [3, 'ghost-1'],
      [4, 'ghost-2'],
    ]);
  });
});
