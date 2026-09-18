/**
 * Tests for periodic full reconciliation / drift repair (issue #54, Phase
 * 7). Uses a stateful in-memory fake Sheets client (real cell reads/writes
 * against a small in-memory grid, not just call-recording spies) since
 * `repairGuildDrift` composes bootstrap/sync/reconcile -- each of which is
 * already unit-tested against its own boundary -- and what actually needs
 * verifying here is that composition, end to end, against real state
 * transitions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VettingConfig } from '../../src/vetting/config.js';
import { repairDriftedDepartures, repairGuildDrift } from '../../src/vetting/drift-repair.js';
import { startDriftRepairWorker } from '../../src/vetting/drift-repair-worker.js';
import type { VettingSheetsClient } from '../../src/vetting/sheets-client.js';
import { mockGuild, mockMember } from '../helpers/discord-mocks.js';

let stopWorker: (() => void) | null = null;

afterEach(() => {
  stopWorker?.();
  stopWorker = null;
});

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

/** SYSTEM row: A=id, B=username, C=display name, D=Active, E=Joined At, F=Left At, G=roles, H=tier, I=Final Decision. */
function systemRow(overrides: {
  id: string;
  active?: boolean;
  finalDecision?: string;
}): string[] {
  return [
    overrides.id,
    overrides.id,
    overrides.id,
    overrides.active === false ? 'FALSE' : 'TRUE',
    '',
    '',
    '',
    '',
    overrides.finalDecision ?? '',
  ];
}

const COLUMN_LETTERS = 'ABCDEFGHIJKL';

/**
 * A real in-memory grid a range-based read/write can actually round-trip
 * through -- `repairGuildDrift` composes three operations against the same
 * sheet in sequence, so a plain call-recording spy can't exercise what
 * matters here: that one step's write is visible to the next step's read.
 */
function statefulSheetsClient(initialRows: string[][]): VettingSheetsClient {
  // rows[0] corresponds to sheet row 2 (row 1 is the header Lucid's own
  // code never reads/writes -- see bootstrap.ts's own note).
  const rows: string[][] = initialRows.map((row) => [...row]);

  function parseSingleRowRange(cellRange: string): { rowIndex: number; startCol: number; endCol: number } {
    const [start, end] = cellRange.split(':');
    const startCol = COLUMN_LETTERS.indexOf(start!.match(/[A-Z]+/)![0]);
    const startRow = Number(start!.match(/\d+/)![0]);
    const endCol = COLUMN_LETTERS.indexOf((end ?? start)!.match(/[A-Z]+/)![0]);
    return { rowIndex: startRow - 2, startCol, endCol };
  }

  return {
    getValues: vi.fn(async () => rows.map((row) => [...row])),
    batchUpdateValues: vi.fn(async (updates: { cellRange: string; values: string[][] }[]) => {
      for (const update of updates) {
        const { rowIndex, startCol, endCol } = parseSingleRowRange(update.cellRange);
        while (rows.length <= rowIndex) rows.push([]);
        const target = rows[rowIndex]!;
        for (let col = startCol; col <= endCol; col++) {
          target[col] = update.values[0]![col - startCol] ?? '';
        }
      }
    }),
    appendValues: vi.fn(async (_sheet: string, _range: string, newRows: string[][]) => {
      rows.push(...newRows.map((row) => [...row]));
    }),
    setFormulas: vi.fn(),
    clearValues: vi.fn(),
  } as unknown as VettingSheetsClient;
}

describe('repairDriftedDepartures', () => {
  it('marks a SYSTEM row Active=TRUE for a Discord ID no longer in the live guild cache as departed', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice' })]);

    const summary = await repairDriftedDepartures(guild, sheets, config());

    expect(summary.repaired).toBe(1);
    const rows = await sheets.getValues('SYSTEM', 'A2:L100000');
    expect(rows[0]![3]).toBe('FALSE'); // Active
    expect(rows[0]![5]).not.toBe(''); // Left At
  });

  it('leaves an already-inactive row alone -- nothing to repair', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice', active: false })]);

    const summary = await repairDriftedDepartures(guild, sheets, config());

    expect(summary.repaired).toBe(0);
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
  });

  it('leaves an active row alone when the member is still actually present', async () => {
    const alice = mockMember({ id: 'alice' });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice' })]);

    const summary = await repairDriftedDepartures(guild, sheets, config());

    expect(summary.repaired).toBe(0);
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
  });

  it('is idempotent -- running twice in a row against already-repaired state changes nothing further', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice' })]);

    await repairDriftedDepartures(guild, sheets, config());
    (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mockClear();
    const second = await repairDriftedDepartures(guild, sheets, config());

    expect(second.repaired).toBe(0);
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
  });

  it("isolates one player's repair failure from the rest of the pass", async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice' }), systemRow({ id: 'bob' })]);
    let calls = 0;
    const original = (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
      calls++;
      if (calls === 1) throw new Error('transient Sheets failure');
      return original(...(args as Parameters<typeof original>));
    });

    const summary = await repairDriftedDepartures(guild, sheets, config());

    // Alice's write failed (left drifted, retried next pass); bob's still landed.
    expect(summary).toEqual({ repaired: 1, errors: 1 });
    const rows = await sheets.getValues('SYSTEM', 'A2:L100000');
    expect(rows[1]![3]).toBe('FALSE');
  });
});

describe('repairGuildDrift', () => {
  it('can be offline while a member joins and repair SYSTEM after restart -- bootstrap adds the missing row', async () => {
    const alice = mockMember({ id: 'alice', roleIds: [] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = statefulSheetsClient([]);

    const summary = await repairGuildDrift(guild, sheets, config());

    expect(summary.bootstrap.created).toBe(1);
    const rows = await sheets.getValues('SYSTEM', 'A2:L100000');
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe('alice');
  });

  it('can be offline while a member leaves and repair SYSTEM after restart -- drifted departure is marked inactive', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice' })]);

    const summary = await repairGuildDrift(guild, sheets, config());

    expect(summary.departures.repaired).toBe(1);
    const rows = await sheets.getValues('SYSTEM', 'A2:L100000');
    expect(rows[0]![3]).toBe('FALSE');
  });

  it('can be offline while a Final Decision changes and apply it after restart -- reconciliation picks it up', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    const summary = await repairGuildDrift(guild, sheets, config());

    expect(summary.reconciliation.mutated).toBe(1);
    expect(alice.roles.add).toHaveBeenCalledWith('role-tier-3', expect.any(String));
  });

  it('a historical (inactive) player rejoining is reactivated on the same row, not duplicated', async () => {
    const alice = mockMember({ id: 'alice', roleIds: [] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice', active: false })]);

    const summary = await repairGuildDrift(guild, sheets, config());

    expect(summary.bootstrap.updated).toBe(1);
    expect(summary.bootstrap.created).toBe(0);
    const rows = await sheets.getValues('SYSTEM', 'A2:L100000');
    expect(rows).toHaveLength(1);
    expect(rows[0]![3]).toBe('TRUE');
  });

  it('running repeatedly against already-correct state produces no duplicate rows and no unnecessary Discord mutations', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-3'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = statefulSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await repairGuildDrift(guild, sheets, config());
    (alice.roles.add as ReturnType<typeof vi.fn>).mockClear();
    (alice.roles.remove as ReturnType<typeof vi.fn>).mockClear();

    const second = await repairGuildDrift(guild, sheets, config());

    const rows = await sheets.getValues('SYSTEM', 'A2:L100000');
    expect(rows).toHaveLength(1);
    expect(second.bootstrap.created).toBe(0);
    expect(second.departures.repaired).toBe(0);
    expect(alice.roles.add).not.toHaveBeenCalled();
    expect(alice.roles.remove).not.toHaveBeenCalled();
  });
});

describe('startDriftRepairWorker', () => {
  it('repairs on an initial synchronous tick, before the interval ever fires', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const client = { guilds: { cache: new Map([['guild-1', guild]]) } };
    const sheets = statefulSheetsClient([systemRow({ id: 'alice' })]);

    stopWorker = startDriftRepairWorker(client as never, sheets, config());
    // The initial tick chains three sequential async operations
    // (bootstrap -> departure repair -> reconciliation), so give its
    // microtasks more room to settle than a single-step worker would need.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = await sheets.getValues('SYSTEM', 'A2:L100000');
    expect(rows[0]![3]).toBe('FALSE');
  });

  it('does nothing (and does not throw) when the configured guild is not yet resolvable', async () => {
    const client = { guilds: { cache: new Map() } };
    const sheets = statefulSheetsClient([]);

    stopWorker = startDriftRepairWorker(client as never, sheets, config());
    await Promise.resolve();
    await Promise.resolve();

    expect(sheets.getValues).not.toHaveBeenCalled();
  });

  it('runs one loop per process and stops cleanly -- a second call returns the same stopper', () => {
    const client = { guilds: { cache: new Map() } };
    const sheets = statefulSheetsClient([]);

    stopWorker = startDriftRepairWorker(client as never, sheets, config());
    const second = startDriftRepairWorker(client as never, sheets, config());

    expect(second).toBe(stopWorker);
  });
});
