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
import type { VettingSheetsClient } from '../../src/vetting/sheets-client.js';

function config(overrides: Partial<VettingConfig> = {}): VettingConfig {
  return {
    enabled: true,
    guildId: 'guild-1',
    spreadsheetId: 'sheet-123',
    systemSheetName: 'SYSTEM',
    vettingSheetName: 'VETTING',
    pollIntervalSeconds: 120,
    tierRoleIds: { 1: 'r1', 2: 'r2', 3: 'r3', 4: 'r4', 5: 'r5' },
    googleServiceAccountJson: '{}',
    ...overrides,
  };
}

describe('buildRelationalProjectionFormulas', () => {
  it('produces one row of three ARRAYFORMULA cells referencing SYSTEM by column, not by name lookup', () => {
    const [row] = buildRelationalProjectionFormulas(config());

    expect(row).toEqual([
      `=ARRAYFORMULA(IF('SYSTEM'!A2:A="","",'SYSTEM'!A2:A))`,
      `=ARRAYFORMULA(IF('SYSTEM'!A2:A="","",IF('SYSTEM'!D2:D="TRUE",'SYSTEM'!C2:C,"")))`,
      `=ARRAYFORMULA(IF('SYSTEM'!A2:A="","",IF('SYSTEM'!D2:D="TRUE",'SYSTEM'!G2:G,"")))`,
    ]);
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

    expect(discordIdFormula).toContain('A2:A');
    expect(playerFormula).toContain('D2:D');
    expect(playerFormula).toContain('C2:C');
    expect(rolesFormula).toContain('D2:D');
    expect(rolesFormula).toContain('G2:G');
  });
});

describe('installVettingRelationalFormulas', () => {
  it('writes the formulas to VETTING!A2:C2 using the configured VETTING sheet name', async () => {
    const setFormulas = vi.fn().mockResolvedValue(undefined);
    const sheets = { setFormulas } as unknown as VettingSheetsClient;

    await installVettingRelationalFormulas(sheets, config({ vettingSheetName: 'Custom Vetting' }));

    expect(setFormulas).toHaveBeenCalledWith('Custom Vetting', 'A2:C2', buildRelationalProjectionFormulas(config({ vettingSheetName: 'Custom Vetting' })));
  });
});
