/**
 * Regression coverage for issue #75: the `vetting:setup-*` scripts once
 * printed a stale, hard-coded coordinate string (`VETTING!A2:C2`,
 * `VETTING!L2:M2`, `SYSTEM!I2`) that had drifted from what the installers
 * actually wrote (row 3, and -- since #71/#72 -- a dynamically resolved
 * column range), because the message was inlined into `main()` where no
 * test could reach it. Pulling each script's success message into its
 * own pure, exported function is what makes that class of drift
 * catchable: these tests pin the exact text against a resolved
 * `VettingLayout`, so a future edit that reintroduces a hard-coded row/
 * column can't pass silently.
 */

import { describe, expect, it } from 'vitest';
import type { VettingConfig } from '../../src/vetting/config.js';
import { resolveVettingLayout } from '../../src/vetting/vetting-layout.js';
import { formatRelationalViewDoneMessage } from '../../src/scripts/vetting-setup-relational-view.js';
import { formatVotingDoneMessage } from '../../src/scripts/vetting-setup-voting.js';

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

function eightReviewerHeaderRow(): string[] {
  return ['Discord ID', 'Player', 'Current Roles', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'Vote Summary', 'Consensus', 'Final Decision', 'OSL', 'BSL'];
}

describe('formatRelationalViewDoneMessage', () => {
  it('prints the real resolved A3:C3-shaped range, never the stale A2:C2', () => {
    const layout = resolveVettingLayout(eightReviewerHeaderRow());
    const message = formatRelationalViewDoneMessage(config(), layout);

    expect(message).toContain('VETTING!A3:C3');
    expect(message).not.toContain('A2:C2');
  });

  it('reflects a shifted layout instead of always reporting A3:C3', () => {
    const header = ['Title', 'Discord ID', 'Player', 'Current Roles', 'R1', 'Vote Summary', 'Consensus', 'Final Decision'];
    const layout = resolveVettingLayout(header);
    const message = formatRelationalViewDoneMessage(config(), layout);

    expect(message).toContain('VETTING!B3:D3');
    expect(message).not.toContain('A3:C3');
  });

  it('uses the configured sheet names, not literal SYSTEM/VETTING', () => {
    const layout = resolveVettingLayout(eightReviewerHeaderRow());
    const message = formatRelationalViewDoneMessage(config({ systemSheetName: 'Custom System', vettingSheetName: 'Custom Vetting' }), layout);

    expect(message).toContain('Custom Vetting!A3:C3');
    expect(message).toContain('mirror Custom System');
  });
});

describe('formatVotingDoneMessage', () => {
  it('prints the real resolved L3:M3 range and I3 Final Decision target for the current 8-reviewer layout, never the stale L2:M2/I2', () => {
    const layout = resolveVettingLayout(eightReviewerHeaderRow());
    const message = formatVotingDoneMessage(config(), layout);

    expect(message).toContain('VETTING!L3:M3');
    expect(message).toContain('SYSTEM!I3');
    expect(message).toContain('tallying 8 reviewer column(s)');
    expect(message).toContain('VETTING!N by Discord ID');
    expect(message).not.toContain('L2:M2');
    expect(message).not.toContain('!I2');
  });

  it('reflects a smaller reviewer layout instead of always reporting the 8-reviewer coordinates', () => {
    const header = ['Discord ID', 'Player', 'Current Roles', 'R1', 'R2', 'R3', 'Vote Summary', 'Consensus', 'Final Decision'];
    const layout = resolveVettingLayout(header);
    const message = formatVotingDoneMessage(config(), layout);

    expect(message).toContain('VETTING!G3:H3');
    expect(message).toContain('tallying 3 reviewer column(s)');
    expect(message).toContain('VETTING!I by Discord ID');
    expect(message).not.toContain('L3:M3');
  });

  it('reflects a reviewer layout wide enough to cross column Z', () => {
    const reviewers = Array.from({ length: 30 }, (_, i) => `R${i + 1}`);
    const header = ['Discord ID', 'Player', 'Current Roles', ...reviewers, 'Vote Summary', 'Consensus', 'Final Decision'];
    const layout = resolveVettingLayout(header);
    const message = formatVotingDoneMessage(config(), layout);

    expect(message).toContain('tallying 30 reviewer column(s)');
    expect(message).toContain('VETTING!AH3:AI3');
  });

  it('uses the configured sheet names, not literal SYSTEM/VETTING', () => {
    const layout = resolveVettingLayout(eightReviewerHeaderRow());
    const message = formatVotingDoneMessage(config({ systemSheetName: 'Custom System', vettingSheetName: 'Custom Vetting' }), layout);

    expect(message).toContain('Custom Vetting!L3:M3');
    expect(message).toContain('Custom System!I3');
  });
});
