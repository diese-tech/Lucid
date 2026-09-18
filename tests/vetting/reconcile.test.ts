/**
 * Tests for VETTING -> SYSTEM -> Discord reconciliation (issue #54, Phase
 * 6). `planReconciliation` is pure -- every issue acceptance criterion for
 * this phase gets a direct unit test. `reconcileGuild` is the orchestration,
 * tested against a fake Sheets client and mocked Discord guild/members
 * (never a live spreadsheet or gateway).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import type { VettingConfig } from '../../src/vetting/config.js';
import { planReconciliation, reconcileGuild } from '../../src/vetting/reconcile.js';
import { startReconciliationWorker } from '../../src/vetting/reconcile-worker.js';
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

describe('planReconciliation', () => {
  it('skips an inactive/departed row -- never mutated as though the player were present', () => {
    expect(planReconciliation({ active: false, finalDecisionRaw: '3', observedTier: null, liveConflict: false })).toEqual({
      type: 'skip',
    });
  });

  it('a blank Final Decision performs no mutation -- "do not change managed tier role based on vetting yet"', () => {
    expect(planReconciliation({ active: true, finalDecisionRaw: '', observedTier: 2, liveConflict: false })).toEqual({
      type: 'blank-decision',
    });
    expect(planReconciliation({ active: true, finalDecisionRaw: '   ', observedTier: null, liveConflict: false })).toEqual({
      type: 'blank-decision',
    });
  });

  it('a live conflict (2+ managed tier roles held right now) is surfaced, never resolved by arbitrary ordering -- even with a valid Final Decision set', () => {
    expect(planReconciliation({ active: true, finalDecisionRaw: '3', observedTier: null, liveConflict: true })).toEqual({
      type: 'conflict',
    });
  });

  it('an invalid tier value performs no mutation and is surfaced as an error, never silently dropped', () => {
    expect(planReconciliation({ active: true, finalDecisionRaw: '9', observedTier: null, liveConflict: false })).toEqual({
      type: 'invalid-decision',
      raw: '9',
    });
    expect(planReconciliation({ active: true, finalDecisionRaw: '0', observedTier: null, liveConflict: false })).toEqual({
      type: 'invalid-decision',
      raw: '0',
    });
    expect(planReconciliation({ active: true, finalDecisionRaw: 'abc', observedTier: null, liveConflict: false })).toEqual({
      type: 'invalid-decision',
      raw: 'abc',
    });
    expect(planReconciliation({ active: true, finalDecisionRaw: '3.5', observedTier: null, liveConflict: false })).toEqual({
      type: 'invalid-decision',
      raw: '3.5',
    });
  });

  it('Final Decision equal to the observed tier is a no-op (in-sync) -- no Discord API write', () => {
    expect(planReconciliation({ active: true, finalDecisionRaw: '3', observedTier: 3, liveConflict: false })).toEqual({
      type: 'in-sync',
      tier: 3,
    });
  });

  it('Final Decision different from the observed tier removes only the observed managed tier role and adds the desired one', () => {
    expect(planReconciliation({ active: true, finalDecisionRaw: '3', observedTier: 5, liveConflict: false })).toEqual({
      type: 'mutate',
      removeTier: 5,
      addTier: 3,
    });
  });

  it('Final Decision set with no current tier role adds the desired role without attempting a remove', () => {
    expect(planReconciliation({ active: true, finalDecisionRaw: '3', observedTier: null, liveConflict: false })).toEqual({
      type: 'mutate',
      removeTier: null,
      addTier: 3,
    });
  });
});

function fakeSheetsClient(
  rows: string[][],
): VettingSheetsClient & { getValues: ReturnType<typeof vi.fn>; batchUpdateValues: ReturnType<typeof vi.fn> } {
  return {
    getValues: vi.fn().mockResolvedValue(rows),
    batchUpdateValues: vi.fn().mockResolvedValue(undefined),
  } as unknown as VettingSheetsClient & { getValues: ReturnType<typeof vi.fn>; batchUpdateValues: ReturnType<typeof vi.fn> };
}

/** SYSTEM row: A=id, B..C blank, D=Active, E..G blank, H=Current Tier Role, I=Final Decision. */
function systemRow(overrides: { id: string; active?: boolean; finalDecision?: string }): string[] {
  return [overrides.id, '', '', overrides.active === false ? 'FALSE' : 'TRUE', '', '', '', '', overrides.finalDecision ?? ''];
}

describe('reconcileGuild', () => {
  it('a Sheets write failure propagates rather than silently reporting success -- issue #54 Phase 10', async () => {
    // The single batchUpdateValues call at the end of a pass is the only
    // place any status is ever actually persisted; if it throws, nothing
    // was written at all -- never a false "Synced" for a row that failed.
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);
    (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Sheets API unavailable'));

    await expect(reconcileGuild(guild, sheets, config())).rejects.toThrow('Sheets API unavailable');
  });

  it('running twice against already-synced state is idempotent -- no further mutations or writes', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-3'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    const first = await reconcileGuild(guild, sheets, config());
    (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mockClear();
    const second = await reconcileGuild(guild, sheets, config());

    expect(first.mutated).toBe(0);
    expect(second.mutated).toBe(0);
    expect(alice.roles.add).not.toHaveBeenCalled();
    expect(alice.roles.remove).not.toHaveBeenCalled();
    // Still re-confirms Synced both times -- a no-op in Discord terms, but
    // not literally skipped, matching in-sync's own documented behavior.
    expect(sheets.batchUpdateValues).toHaveBeenCalledTimes(1);
  });

  it('Final Decision 3 + observed tier 5 removes tier 5 and adds tier 3', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(alice.roles.remove).toHaveBeenCalledWith('role-tier-5', 'Lucid vetting reconciliation');
    expect(alice.roles.add).toHaveBeenCalledWith('role-tier-3', 'Lucid vetting reconciliation');
    expect(summary).toEqual({ processed: 1, mutated: 1, conflicts: 0, invalidDecisions: 0, errors: 0 });
    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      { sheetName: 'SYSTEM', cellRange: 'J2:L2', values: [['3', 'Synced', expect.any(String)]] },
    ]);
  });

  it('logs a role-transition audit line on a successful mutation -- issue #54 Phase 8', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await reconcileGuild(guild, sheets, config());

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('alice: tier 5 -> 3 applied'));
    logSpy.mockRestore();
  });

  it('Final Decision 3 + observed tier 3 results in no Discord API write', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-3'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await reconcileGuild(guild, sheets, config());

    expect(alice.roles.add).not.toHaveBeenCalled();
    expect(alice.roles.remove).not.toHaveBeenCalled();
    // Still confirms the synced state in the sheet.
    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      { sheetName: 'SYSTEM', cellRange: 'J2:L2', values: [['3', 'Synced', expect.any(String)]] },
    ]);
  });

  it('a blank Final Decision results in no tier-role mutation and no sheet write at all', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-3'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '' })]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(alice.roles.add).not.toHaveBeenCalled();
    expect(alice.roles.remove).not.toHaveBeenCalled();
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
    expect(summary).toEqual({ processed: 0, mutated: 0, conflicts: 0, invalidDecisions: 0, errors: 0 });
  });

  it('two observed managed tier roles are surfaced as a conflict and resolved only per explicit policy, never arbitrary ordering', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-1', 'role-tier-4'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(alice.roles.add).not.toHaveBeenCalled();
    expect(alice.roles.remove).not.toHaveBeenCalled();
    expect(summary.conflicts).toBe(1);
    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      { sheetName: 'SYSTEM', cellRange: 'K2:L2', values: [['Conflict', expect.any(String)]] },
    ]);
  });

  it('an invalid Final Decision performs no mutation and records Error without touching Last Applied Tier', async () => {
    const alice = mockMember({ id: 'alice', roleIds: [] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '9' })]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(alice.roles.add).not.toHaveBeenCalled();
    expect(summary.invalidDecisions).toBe(1);
    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      { sheetName: 'SYSTEM', cellRange: 'K2:L2', values: [['Error', expect.any(String)]] },
    ]);
  });

  it('inactive/departed players are not mutated as though present', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', active: false, finalDecision: '3' })]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(alice.roles.add).not.toHaveBeenCalled();
    expect(alice.roles.remove).not.toHaveBeenCalled();
    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
    expect(summary).toEqual({ processed: 0, mutated: 0, conflicts: 0, invalidDecisions: 0, errors: 0 });
  });

  it('a member no longer resolvable in the live guild cache is skipped, not guessed at', async () => {
    const guild = mockGuild({ id: 'guild-1', members: [] });
    const sheets = fakeSheetsClient([systemRow({ id: 'ghost', finalDecision: '3' })]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(sheets.batchUpdateValues).not.toHaveBeenCalled();
    expect(summary).toEqual({ processed: 0, mutated: 0, conflicts: 0, invalidDecisions: 0, errors: 0 });
  });

  it('a transient Discord API failure leaves the row eligible for retry instead of falsely marking it Synced', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    (alice.roles.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rate limited'));
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(summary.errors).toBe(1);
    expect(sheets.batchUpdateValues).toHaveBeenCalledWith([
      { sheetName: 'SYSTEM', cellRange: 'K2:L2', values: [['Error', expect.any(String)]] },
    ]);
    // Never J2 -- Last Applied Tier must not advance on a failed mutation.
    const [update] = (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { cellRange: string }[];
    expect(update!.cellRange).not.toContain('J2');
  });

  it('a missing-permission Discord failure is distinguishable in logs from a generic failure -- issue #54 Phase 8', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    (alice.roles.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DiscordAPIError(
        { message: 'Missing Permissions', code: RESTJSONErrorCodes.MissingPermissions },
        RESTJSONErrorCodes.MissingPermissions,
        403,
        'PUT',
        '/guilds/guild-1/members/alice/roles/role-tier-3',
        {},
      ),
    );
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await reconcileGuild(guild, sheets, config());

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Discord API error ${RESTJSONErrorCodes.MissingPermissions}`),
    );
    errorSpy.mockRestore();
  });

  it('non-vetting roles survive reconciliation byte-for-byte -- only the managed tier roles are ever touched', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5', 'role-moderator', 'role-captain'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    await reconcileGuild(guild, sheets, config());

    expect(alice.roles.remove).toHaveBeenCalledTimes(1);
    expect(alice.roles.remove).toHaveBeenCalledWith('role-tier-5', expect.any(String));
    expect(alice.roles.add).toHaveBeenCalledTimes(1);
    expect(alice.roles.add).toHaveBeenCalledWith('role-tier-3', expect.any(String));
  });

  it('processes multiple rows in one pass and writes every outcome in a single batched call', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const bob = mockMember({ id: 'bob', roleIds: [] });
    const guild = mockGuild({ id: 'guild-1', members: [alice, bob] });
    const sheets = fakeSheetsClient([
      systemRow({ id: 'alice', finalDecision: '3' }),
      systemRow({ id: 'bob', finalDecision: '1' }),
    ]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(summary.mutated).toBe(2);
    expect(sheets.batchUpdateValues).toHaveBeenCalledTimes(1);
    const [updates] = (sheets.batchUpdateValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(updates).toHaveLength(2);
  });

  it('one player\'s Discord API failure does not stop the rest of the pass', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    (alice.roles.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const bob = mockMember({ id: 'bob', roleIds: [] });
    const guild = mockGuild({ id: 'guild-1', members: [alice, bob] });
    const sheets = fakeSheetsClient([
      systemRow({ id: 'alice', finalDecision: '3' }),
      systemRow({ id: 'bob', finalDecision: '1' }),
    ]);

    const summary = await reconcileGuild(guild, sheets, config());

    expect(summary.errors).toBe(1);
    expect(summary.mutated).toBe(1);
    expect(bob.roles.add).toHaveBeenCalledWith('role-tier-1', expect.any(String));
  });

  it('serializes two passes for the same guild -- a second call never starts reading until the first has fully finished (Half-Shell PR #65 finding)', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const sheets = fakeSheetsClient([]);

    const callOrder: string[] = [];
    let resolveFirstRead!: (rows: string[][]) => void;
    const firstRead = new Promise<string[][]>((resolve) => {
      resolveFirstRead = resolve;
    });

    (sheets.getValues as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        callOrder.push('first-read-start');
        const rows = await firstRead;
        callOrder.push('first-read-end');
        return rows;
      })
      .mockImplementationOnce(async () => {
        callOrder.push('second-read-start');
        return [systemRow({ id: 'alice', finalDecision: '3' })];
      });

    const firstCall = reconcileGuild(guild, sheets, config());
    // Give the first call a chance to start (but not finish) its Sheets read.
    await Promise.resolve();
    await Promise.resolve();
    const secondCall = reconcileGuild(guild, sheets, config());
    await Promise.resolve();
    await Promise.resolve();

    // The second pass's read must not have started while the first pass was
    // still mid-flight -- proving two interval ticks (or a tick and a
    // concurrent Phase 7 drift-repair pass) cannot overlap for the same guild.
    expect(callOrder).toEqual(['first-read-start']);

    resolveFirstRead([systemRow({ id: 'alice', finalDecision: '3' })]);
    await firstCall;
    await secondCall;

    expect(callOrder).toEqual(['first-read-start', 'first-read-end', 'second-read-start']);
  });

  it('serializes reconcileGuild calls for different guilds independently -- one guild never blocks on another', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guildA = mockGuild({ id: 'guild-a', members: [alice] });
    const bob = mockMember({ id: 'bob', roleIds: [] });
    const guildB = mockGuild({ id: 'guild-b', members: [bob] });

    const sheetsA = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);
    const sheetsB = fakeSheetsClient([systemRow({ id: 'bob', finalDecision: '1' })]);

    let resolveFirstRead!: (rows: string[][]) => void;
    const firstRead = new Promise<string[][]>((resolve) => {
      resolveFirstRead = resolve;
    });
    (sheetsA.getValues as ReturnType<typeof vi.fn>).mockImplementationOnce(() => firstRead);

    const guildACall = reconcileGuild(guildA, sheetsA, config());
    await Promise.resolve();
    await Promise.resolve();

    // guildB's pass completes fully even though guildA's is still stuck mid-read.
    const guildBSummary = await reconcileGuild(guildB, sheetsB, config());
    expect(guildBSummary.mutated).toBe(1);
    expect(bob.roles.add).toHaveBeenCalledWith('role-tier-1', expect.any(String));

    resolveFirstRead([systemRow({ id: 'alice', finalDecision: '3' })]);
    await guildACall;
  });
});

describe('startReconciliationWorker', () => {
  it('reconciles on an initial synchronous tick, before the interval ever fires', async () => {
    const alice = mockMember({ id: 'alice', roleIds: ['role-tier-5'] });
    const guild = mockGuild({ id: 'guild-1', members: [alice] });
    const client = { guilds: { cache: new Map([['guild-1', guild]]) } };
    const sheets = fakeSheetsClient([systemRow({ id: 'alice', finalDecision: '3' })]);

    stopWorker = startReconciliationWorker(client as never, sheets, config());
    // The initial tick is fire-and-forget, so let its microtasks/awaits settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(alice.roles.add).toHaveBeenCalledWith('role-tier-3', expect.any(String));
  });

  it('does nothing (and does not throw) when the configured guild is not yet resolvable', async () => {
    const client = { guilds: { cache: new Map() } };
    const sheets = fakeSheetsClient([]);

    stopWorker = startReconciliationWorker(client as never, sheets, config());
    await Promise.resolve();
    await Promise.resolve();

    expect(sheets.getValues).not.toHaveBeenCalled();
  });

  it('runs one loop per process and stops cleanly -- a second call returns the same stopper', () => {
    const client = { guilds: { cache: new Map() } };
    const sheets = fakeSheetsClient([]);

    stopWorker = startReconciliationWorker(client as never, sheets, config());
    const second = startReconciliationWorker(client as never, sheets, config());

    expect(second).toBe(stopWorker);
  });
});
