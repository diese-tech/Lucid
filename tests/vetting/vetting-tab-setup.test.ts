/**
 * Tests for the SYSTEM -> VETTING relational projection setup (issue #54,
 * Phase 4). buildRelationalProjectionFormulas() is pure -- exact formula
 * text is asserted directly since a wrong cell reference here would
 * silently show the wrong player's name or wrong roles in production.
 */

import { describe, expect, it, vi } from 'vitest';
import type { VettingConfig } from '../../src/vetting/config.js';
import {
  buildRelationalProjectionFormulas,
  installVettingRelationalFormulas,
} from '../../src/vetting/vetting-tab-setup.js';
import { VettingLayoutError } from '../../src/vetting/vetting-layout.js';
import type { VettingSheetsClient } from '../../src/vetting/sheets-client.js';

/** The standard VETTING header row: A-C fixed, 8 reviewer columns, then the calculated columns and OSL/BSL. */
const DEFAULT_HEADER_ROW = [
  'Discord ID',
  'Player',
  'Current Roles',
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'Vote Summary',
  'Consensus',
  'Final Decision',
  'OSL',
  'BSL',
];

function config(overrides: Partial<VettingConfig> = {}): VettingConfig {
  return {
    enabled: true,
    guildId: 'guild-1',
    spreadsheetId: 'sheet-123',
    systemSheetName: 'SYSTEM',
    vettingSheetName: 'VETTING',
    pollIntervalSeconds: 120,
    driftRepairIntervalSeconds: 1800,
    tierRoleIds: { 1: 'r1', 2: 'r2', 3: 'r3', 4: 'r4', 5: 'r5' },
    googleServiceAccountJson: '{}',
    ...overrides,
  };
}

describe('buildRelationalProjectionFormulas', () => {
  it('produces one row of three ARRAYFORMULA cells referencing SYSTEM by column, not by name lookup', () => {
    const [row] = buildRelationalProjectionFormulas(config());

    expect(row).toEqual([
      `=ARRAYFORMULA(IF('SYSTEM'!A3:A="","",IF('SYSTEM'!D3:D="TRUE",'SYSTEM'!A3:A,"")))`,
      `=ARRAYFORMULA(IF('SYSTEM'!A3:A="","",IF('SYSTEM'!D3:D="TRUE",'SYSTEM'!C3:C,"")))`,
      `=ARRAYFORMULA(IF('SYSTEM'!A3:A="","",IF('SYSTEM'!D3:D="TRUE",'SYSTEM'!G3:G,"")))`,
    ]);
  });

  it('references row 3, never row 2 -- row 1 is a title and row 2 the column headers on both sheets (live-sheet finding: an earlier version wrote formulas into VETTING\'s header row)', () => {
    const [row] = buildRelationalProjectionFormulas(config());
    for (const formula of row!) {
      expect(formula).not.toContain('A2:A');
      expect(formula).not.toContain('D2:D');
      expect(formula).not.toContain('C2:C');
      expect(formula).not.toContain('G2:G');
    }
  });

  it('blanks Discord ID too (not just Player/Current Roles) for an inactive row -- issue #54 Phase 4\'s "inactive players do not clutter the active VETTING queue" criterion', () => {
    const [row] = buildRelationalProjectionFormulas(config());
    const [discordIdFormula] = row!;

    expect(discordIdFormula).toContain('D3:D="TRUE"');
  });

  it('quotes a custom SYSTEM sheet name containing a space', () => {
    const [row] = buildRelationalProjectionFormulas(config({ systemSheetName: 'Custom System' }));

    for (const formula of row!) {
      expect(formula).toContain(`'Custom System'!`);
    }
  });

  it('doubles an embedded single quote in a custom sheet name', () => {
    const [row] = buildRelationalProjectionFormulas(config({ systemSheetName: "O'Brien's Sheet" }));

    for (const formula of row!) {
      expect(formula).toContain(`'O''Brien''s Sheet'!`);
    }
  });

  it('references Discord ID (A), Active (D), Display Name (C), and Current Roles (G) -- the exact SYSTEM columns Phase 2/3 write', () => {
    const [row] = buildRelationalProjectionFormulas(config());
    const [discordIdFormula, playerFormula, rolesFormula] = row!;

    expect(discordIdFormula).toContain('A3:A');
    expect(discordIdFormula).toContain('D3:D');
    expect(playerFormula).toContain('D3:D');
    expect(playerFormula).toContain('C3:C');
    expect(rolesFormula).toContain('D3:D');
    expect(rolesFormula).toContain('G3:G');
  });
});

describe('active-queue declutter behavior (issue #54 Phase 4, Half-Shell PR #62 finding)', () => {
  // The three formulas are IF(id="", "", IF(active="TRUE", <value>, "")) --
  // a direct, mechanical translation into JS lets these tests exercise the
  // exact semantics buildRelationalProjectionFormulas emits (declutter on
  // departure, restore on rejoin, same physical row throughout) without a
  // live spreadsheet. The formula-text tests above are what actually pin
  // the deployed string; this pins its *behavior*.
  interface SystemRow {
    discordId: string;
    active: boolean;
    displayName: string;
    currentRoles: string;
  }

  function projectVettingRow(row: SystemRow): { discordId: string; player: string; currentRoles: string } {
    if (row.discordId === '') return { discordId: '', player: '', currentRoles: '' };
    if (!row.active) return { discordId: '', player: '', currentRoles: '' };
    return { discordId: row.discordId, player: row.displayName, currentRoles: row.currentRoles };
  }

  it('shows an active player in the queue', () => {
    const projected = projectVettingRow({ discordId: 'alice', active: true, displayName: 'Alice', currentRoles: 'Verified' });
    expect(projected).toEqual({ discordId: 'alice', player: 'Alice', currentRoles: 'Verified' });
  });

  it('a departed player disappears entirely from the active queue -- not just their name/roles', () => {
    const projected = projectVettingRow({ discordId: 'alice', active: false, displayName: 'Alice', currentRoles: 'Verified' });
    expect(projected).toEqual({ discordId: '', player: '', currentRoles: '' });
  });

  it('rejoining (same SYSTEM row, Active flips back to TRUE) restores the same player to the queue', () => {
    const row: SystemRow = { discordId: 'alice', active: false, displayName: 'Alice', currentRoles: 'Verified' };
    expect(projectVettingRow(row)).toEqual({ discordId: '', player: '', currentRoles: '' });

    // bootstrap/sync reactivate the SAME SYSTEM row on rejoin (never a new
    // one) -- simulated here by flipping this row's own Active flag, never
    // by constructing a second row.
    row.active = true;
    expect(projectVettingRow(row)).toEqual({ discordId: 'alice', player: 'Alice', currentRoles: 'Verified' });
  });
});

describe('installVettingRelationalFormulas', () => {
  function sheets(headerRow: string[] = DEFAULT_HEADER_ROW) {
    const setFormulas = vi.fn().mockResolvedValue(undefined);
    const clearValues = vi.fn().mockResolvedValue(undefined);
    const getValues = vi.fn().mockResolvedValue([headerRow]);
    return {
      client: { setFormulas, clearValues, getValues } as unknown as VettingSheetsClient,
      setFormulas,
      clearValues,
      getValues,
    };
  }

  it('reads the VETTING header row before writing anything', async () => {
    const { client, getValues } = sheets();

    await installVettingRelationalFormulas(client, config({ vettingSheetName: 'Custom Vetting' }));

    expect(getValues).toHaveBeenCalledWith('Custom Vetting', '2:2');
  });

  it('writes the formulas to VETTING!A3:C3 using the configured VETTING sheet name', async () => {
    const { client, setFormulas } = sheets();

    await installVettingRelationalFormulas(client, config({ vettingSheetName: 'Custom Vetting' }));

    expect(setFormulas).toHaveBeenCalledWith('Custom Vetting', 'A3:C3', buildRelationalProjectionFormulas(config({ vettingSheetName: 'Custom Vetting' })));
  });

  it('clears the spill destination before writing, and never touches row 1 or 2', async () => {
    // Live-sheet finding: ARRAYFORMULA silently fails (#REF!) if anything
    // already occupies the range it would spill into -- a stale previous
    // install, leftover template content, anything. Clearing first is what
    // makes re-running this safe. Never A1/A2 (or row 2 at all) -- those
    // hold the title and human-owned column headers.
    const { client, setFormulas, clearValues } = sheets();

    await installVettingRelationalFormulas(client, config({ vettingSheetName: 'Custom Vetting' }));

    expect(clearValues).toHaveBeenCalledWith('Custom Vetting', 'A3:C100000');
    expect(clearValues).toHaveBeenCalledTimes(1);
    // clearValues must run before setFormulas, or the clear would wipe out
    // the formula it just wrote.
    const clearOrder = clearValues.mock.invocationCallOrder[0]!;
    const setOrder = setFormulas.mock.invocationCallOrder[0]!;
    expect(clearOrder).toBeLessThan(setOrder);
  });

  it('derives the install/clear range from a different VETTING layout instead of assuming A:C', async () => {
    // Discord ID/Player/Current Roles pushed one column right of A/B/C.
    const header = ['Title', 'Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Final Decision'];
    const { client, setFormulas, clearValues } = sheets(header);

    await installVettingRelationalFormulas(client, config({ vettingSheetName: 'Custom Vetting' }));

    expect(clearValues).toHaveBeenCalledWith('Custom Vetting', 'B3:D100000');
    expect(setFormulas).toHaveBeenCalledWith('Custom Vetting', 'B3:D3', expect.anything());
  });

  it('fails closed on a malformed VETTING header row -- no clear or write happens at all (issue #71)', async () => {
    const malformedHeader = ['Discord ID', 'Player', 'Current Roles', 'R1', 'Votes', 'Consensus', 'Final Decision'];
    const { client, setFormulas, clearValues } = sheets(malformedHeader);

    await expect(installVettingRelationalFormulas(client, config({ vettingSheetName: 'Custom Vetting' }))).rejects.toThrow(
      VettingLayoutError,
    );

    expect(clearValues).not.toHaveBeenCalled();
    expect(setFormulas).not.toHaveBeenCalled();
  });
});
