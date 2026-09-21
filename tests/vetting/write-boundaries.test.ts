/**
 * Cross-cutting regression guards for issue #54 Phase 10's own required
 * scenarios that don't belong to any single phase's test file:
 *
 *   - "Human vote cells are never overwritten by normal system sync."
 *   - "Final Decision is never inferred from majority/unanimity after
 *     bootstrap."
 *
 * Both are already true by construction -- bootstrap.ts/sync.ts/reconcile.ts/
 * drift-repair.ts never reference `config.vettingSheetName` in any write
 * call at all, and nothing anywhere ever computes or writes a value for
 * `VETTING!N` (Final Decision is exclusively human-owned; Phase 5's Vote
 * Summary/Consensus are read-only projections). This file makes that an
 * explicit, executable invariant across every write path in this
 * subsystem, rather than something only implied by each phase's own
 * narrower tests never happening to exercise a VETTING write.
 */

import { describe, expect, it, vi } from 'vitest';
import { bootstrapGuildInventory } from '../../src/vetting/bootstrap.js';
import type { VettingConfig } from '../../src/vetting/config.js';
import { repairGuildDrift } from '../../src/vetting/drift-repair.js';
import { reconcileGuild } from '../../src/vetting/reconcile.js';
import { syncMemberDeparture, syncMemberPresence } from '../../src/vetting/sync.js';
import { installVettingRelationalFormulas } from '../../src/vetting/vetting-tab-setup.js';
import { buildVoteConsensusFormulas, installVotingWorkflowFormulas } from '../../src/vetting/vetting-voting-setup.js';
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

function systemRow(overrides: { id: string; active?: boolean; finalDecision?: string }): string[] {
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

/** Every write call any of these modules made, across every fake-client method. */
function collectWriteCalls(sheets: VettingSheetsClient): { method: string; sheetName: unknown; cellRange: unknown }[] {
  const calls: { method: string; sheetName: unknown; cellRange: unknown }[] = [];
  for (const method of ['updateValues', 'batchUpdateValues', 'appendValues', 'setFormulas', 'clearValues'] as const) {
    const fn = sheets[method] as unknown as ReturnType<typeof vi.fn> | undefined;
    if (!fn?.mock) continue;
    for (const call of fn.mock.calls) {
      if (method === 'batchUpdateValues') {
        // A single array-of-updates argument, each carrying its own sheetName/cellRange.
        const updates = call[0] as { sheetName: unknown; cellRange: unknown }[];
        for (const update of updates) calls.push({ method, sheetName: update.sheetName, cellRange: update.cellRange });
      } else {
        calls.push({ method, sheetName: call[0], cellRange: call[1] });
      }
    }
  }
  return calls;
}

function fakeSheetsClient(rows: string[][] = []): VettingSheetsClient {
  return {
    getValues: vi.fn().mockResolvedValue(rows),
    updateValues: vi.fn().mockResolvedValue(undefined),
    batchUpdateValues: vi.fn().mockResolvedValue(undefined),
    appendValues: vi.fn().mockResolvedValue("'SYSTEM'!A3:H3"),
    setFormulas: vi.fn().mockResolvedValue(undefined),
    clearValues: vi.fn().mockResolvedValue(undefined),
  } as unknown as VettingSheetsClient;
}

describe('human vote cells are never overwritten by normal system sync (issue #54 Phase 10)', () => {
  it('bootstrapGuildInventory never writes to the VETTING sheet', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-3'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice' })]);

    await bootstrapGuildInventory(guild, sheets, config());

    const calls = collectWriteCalls(sheets);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.sheetName === 'SYSTEM')).toBe(true);
  });

  it('syncMemberPresence never writes to the VETTING sheet', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-3'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([]);

    await syncMemberPresence(guild, alice, sheets, config());

    const calls = collectWriteCalls(sheets);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.sheetName === 'SYSTEM')).toBe(true);
  });

  it('syncMemberDeparture never writes to the VETTING sheet', async () => {
    const sheets = fakeSheetsClient([systemRow({ id: 'bob' })]);

    await syncMemberDeparture('bob', false, sheets, config());

    const calls = collectWriteCalls(sheets);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.sheetName === 'SYSTEM')).toBe(true);
  });

  it('reconcileGuild never writes to the VETTING sheet -- Final Decision flows one way, SYSTEM to Discord, never back', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await reconcileGuild(guild, sheets, config());

    const calls = collectWriteCalls(sheets);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.sheetName === 'SYSTEM')).toBe(true);
  });

  it('repairGuildDrift (bootstrap + departure repair + reconciliation, composed) never writes to the VETTING sheet', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await repairGuildDrift(guild, sheets, config());

    const calls = collectWriteCalls(sheets);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.sheetName === 'SYSTEM')).toBe(true);
  });
});

describe('Final Decision is never inferred from majority/unanimity or anything else (issue #54 Phase 10)', () => {
  it('the Vote Summary/Consensus formula install never writes column N (Final Decision)', () => {
    // buildVoteConsensusFormulas only ever returns L2:M2-shaped content
    // (Vote Summary, Consensus) -- never a Final Decision value, and
    // nothing in this codebase computes one from votes at all.
    const [row] = buildVoteConsensusFormulas();
    expect(row).toHaveLength(2);
  });

  it('no module in the vetting subsystem ever references VETTING!N in a write call -- including the Phase 4/5 formula installers themselves', async () => {
    // Half-Shell's PR #69 finding: the earlier version of this test only
    // exercised bootstrapGuildInventory/repairGuildDrift -- never the actual
    // Phase 4/5 setup scripts, which are the highest-risk place for a future
    // ownership regression since they write directly adjacent to VETTING's
    // human-owned D-K/N columns. A future installer change adding e.g. a
    // `setFormulas(..., 'N3:N3', ...)` or `clearValues(..., 'N3:N...')` call
    // would have stayed invisible to this suite; now it's exercised through
    // the identical collected-write boundary as every other caller.
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await bootstrapGuildInventory(guild, sheets, config());
    await repairGuildDrift(guild, sheets, config());
    await installVettingRelationalFormulas(sheets, config());
    await installVotingWorkflowFormulas(sheets, config());

    const calls = collectWriteCalls(sheets);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const cellRange = typeof call.cellRange === 'string' ? call.cellRange : '';
      expect(cellRange).not.toMatch(/^N\d/);
    }
  });

  it('the Phase 4/5 formula installers never target VETTING\'s human-owned vetter columns (D-K) either', async () => {
    const sheets = fakeSheetsClient([]);

    await installVettingRelationalFormulas(sheets, config());
    await installVotingWorkflowFormulas(sheets, config());

    const calls = collectWriteCalls(sheets);
    const vettingCalls = calls.filter((call) => call.sheetName === 'VETTING');
    expect(vettingCalls.length).toBeGreaterThan(0);
    for (const call of vettingCalls) {
      const cellRange = typeof call.cellRange === 'string' ? call.cellRange : '';
      expect(cellRange).not.toMatch(/^[D-K]\d/);
    }
  });
});
