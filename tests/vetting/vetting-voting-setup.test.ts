/**
 * Tests for the human voting workflow's calculated fields (issue #54,
 * Phase 5). Both formula builders are pure -- exact formula text is
 * asserted directly, matching vetting-tab-setup.test.ts's own discipline,
 * plus a JS re-implementation of the same IF/BYROW/LET semantics so the
 * tally/consensus *behavior* (not just the deployed string) is pinned too.
 */

import { describe, expect, it, vi } from 'vitest';
import type { VettingConfig } from '../../src/vetting/config.js';
import {
  buildFinalDecisionLookupFormula,
  buildVoteConsensusFormulas,
  installVotingWorkflowFormulas,
} from '../../src/vetting/vetting-voting-setup.js';
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

describe('buildVoteConsensusFormulas', () => {
  it('produces the exact Vote Summary and Consensus formulas', () => {
    const [row] = buildVoteConsensusFormulas();

    expect(row).toEqual([
      `=ARRAYFORMULA(IF(A3:A="","",BYROW(D3:K,LAMBDA(r,TEXTJOIN(", ",TRUE,IF(COUNTIF(r,1)>0,"T1:"&COUNTIF(r,1),""),IF(COUNTIF(r,2)>0,"T2:"&COUNTIF(r,2),""),IF(COUNTIF(r,3)>0,"T3:"&COUNTIF(r,3),""),IF(COUNTIF(r,4)>0,"T4:"&COUNTIF(r,4),""),IF(COUNTIF(r,5)>0,"T5:"&COUNTIF(r,5),""))))))`,
      `=ARRAYFORMULA(IF(A3:A="","",BYROW(D3:K,LAMBDA(r,LET(counts,{COUNTIF(r,1),COUNTIF(r,2),COUNTIF(r,3),COUNTIF(r,4),COUNTIF(r,5)},total,SUM(counts),best,MAX(counts),tier,MATCH(best,counts,0),IF(total=0,"",IF(best=total,"Unanimous "&tier,IF(best*2>total,"Majority "&tier,"Split"))))))))`,
    ]);
  });

  it('references row 3, never row 2 -- row 1 is a title and row 2 the column headers on both sheets (live-sheet finding)', () => {
    const [row] = buildVoteConsensusFormulas();
    for (const formula of row!) {
      expect(formula).not.toContain('A2:A');
      expect(formula).not.toContain('D2:K');
    }
  });

  it('enumerates tiers from the canonical VETTING_TIERS contract, not a second hard-coded range', () => {
    // Half-Shell's PR #63 finding: an earlier version hard-coded 1-7,
    // disagreeing with config.ts's actual 5-tier VettingTier domain.
    const [row] = buildVoteConsensusFormulas();
    for (const formula of row!) {
      expect(formula).toContain('COUNTIF(r,5)');
      expect(formula).not.toContain('COUNTIF(r,6)');
      expect(formula).not.toContain('COUNTIF(r,7)');
    }
  });

  it("derives the Consensus total from the enumerated tiers' own counts, never COUNT(r)", () => {
    // Half-Shell's other PR #63 finding: COUNT(r) counts every non-blank
    // numeric cell, including an out-of-range value that matches no
    // enumerated tier -- silently inflating the majority denominator
    // without ever appearing in Vote Summary. SUM(counts) can't do that,
    // since counts only ever come from the same per-tier COUNTIFs Vote
    // Summary itself displays.
    const [, consensusFormula] = buildVoteConsensusFormulas()[0]!;
    expect(consensusFormula).toContain('total,SUM(counts)');
    expect(consensusFormula).not.toContain('COUNT(r)');
  });

  it('takes no config -- both formulas self-reference their own sheet, never a config-provided name', () => {
    // buildVoteConsensusFormulas has no parameters at all; this test exists
    // so a future change adding one doesn't silently go untested.
    expect(buildVoteConsensusFormulas).toHaveLength(0);
  });
});

describe('buildFinalDecisionLookupFormula', () => {
  it('pulls VETTING!N by row position, gated on SYSTEM having a row at all', () => {
    const formula = buildFinalDecisionLookupFormula(config());
    expect(formula).toBe(`=ARRAYFORMULA(IF(A3:A="","",'VETTING'!N3:N))`);
  });

  it('quotes a custom VETTING sheet name containing a space', () => {
    const formula = buildFinalDecisionLookupFormula(config({ vettingSheetName: 'Custom Vetting' }));
    expect(formula).toContain(`'Custom Vetting'!N3:N`);
  });

  it('doubles an embedded single quote in a custom sheet name', () => {
    const formula = buildFinalDecisionLookupFormula(config({ vettingSheetName: "O'Brien's Vetting" }));
    expect(formula).toContain(`'O''Brien''s Vetting'!N3:N`);
  });

  it('is never gated on Active -- a departed player\'s last Final Decision must stay visible in SYSTEM', () => {
    const formula = buildFinalDecisionLookupFormula(config());
    expect(formula).not.toContain('D3:D');
  });

  it('references row 3, never row 2', () => {
    const formula = buildFinalDecisionLookupFormula(config());
    expect(formula).not.toContain('A2:A');
    expect(formula).not.toContain('N2:N');
  });
});

describe('vote tally / consensus behavior (issue #54 Phase 5 acceptance criteria)', () => {
  // Direct JS translation of the formula's own BYROW/LET semantics -- same
  // purpose as vetting-tab-setup.test.ts's declutter behavior suite: pins
  // the *behavior* the formula text (asserted above) is meant to produce,
  // since nothing here can execute a real spreadsheet formula. Tiers match
  // config.ts's actual VETTING_TIERS (1-5), and `total` is deliberately the
  // sum of only the enumerated tiers' own counts -- never every non-blank
  // cell -- matching the fix for Half-Shell's PR #63 finding below.
  const TIERS = [1, 2, 3, 4, 5];

  function tally(votes: (number | null)[]): { voteSummary: string; consensus: string } {
    const counts = TIERS.map((tier) => votes.filter((v) => v === tier).length);
    const voteSummary = TIERS.map((tier, i) => (counts[i]! > 0 ? `T${tier}:${counts[i]}` : ''))
      .filter((s) => s !== '')
      .join(', ');

    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) return { voteSummary, consensus: '' };

    const best = Math.max(...counts);
    const tier = TIERS[counts.indexOf(best)];
    const consensus = best === total ? `Unanimous ${tier}` : best * 2 > total ? `Majority ${tier}` : 'Split';

    return { voteSummary, consensus };
  }

  it('no votes cast yet produces a blank summary and blank consensus', () => {
    expect(tally([null, null, null, null, null, null, null, null])).toEqual({ voteSummary: '', consensus: '' });
  });

  it('four identical votes display Unanimous N', () => {
    expect(tally([3, 3, 3, 3, null, null, null, null])).toEqual({ voteSummary: 'T3:4', consensus: 'Unanimous 3' });
  });

  it('a single vote is trivially unanimous', () => {
    expect(tally([5, null, null, null, null, null, null, null])).toEqual({ voteSummary: 'T5:1', consensus: 'Unanimous 5' });
  });

  it('a 3-1 vote displays Majority N', () => {
    expect(tally([2, 2, 2, 4, null, null, null, null])).toEqual({ voteSummary: 'T2:3, T4:1', consensus: 'Majority 2' });
  });

  it('a 2-2 split vote remains non-authoritative (Split, not a false majority)', () => {
    expect(tally([1, 1, 4, 4, null, null, null, null])).toEqual({ voteSummary: 'T1:2, T4:2', consensus: 'Split' });
  });

  it('a three-way split with no strict majority is Split even with a plurality leader', () => {
    // 2-2-1 of 5 votes: tier 1 leads with 2, but 2 is not a strict majority of 5.
    expect(tally([1, 1, 3, 3, 5])).toEqual({ voteSummary: 'T1:2, T3:2, T5:1', consensus: 'Split' });
  });

  it('exactly half the votes is not a strict majority', () => {
    // 2-2 of 4 votes: neither tier exceeds half of the total.
    expect(tally([3, 3, 4, 4, null, null, null, null])).toEqual({ voteSummary: 'T3:2, T4:2', consensus: 'Split' });
  });

  it('an out-of-range numeric vote never appears in Vote Summary and never inflates the Consensus denominator', () => {
    // Half-Shell's PR #63 finding: since Lucid never installs data
    // validation on the vetter columns, a stray out-of-range value (e.g. a
    // leftover "9" from before the tier range narrowed to 1-5) must not
    // silently participate in the majority math while staying invisible in
    // Vote Summary. Two valid tier-1 votes plus two garbage "9"s: the old
    // COUNT(r)-based total would have read 4 (all non-blank cells),
    // producing best*2=4, which is NOT > 4 -- a false "Split" despite both
    // real votes agreeing completely. The fixed total (2, from only the
    // enumerated tiers) correctly reads this as unanimous.
    expect(tally([1, 1, 9, 9, null, null, null, null])).toEqual({ voteSummary: 'T1:2', consensus: 'Unanimous 1' });
  });

  it('only out-of-range numeric votes produce a blank summary and blank consensus, same as no votes at all', () => {
    expect(tally([9, 9, 9, null, null, null, null, null])).toEqual({ voteSummary: '', consensus: '' });
  });
});

describe('installVotingWorkflowFormulas', () => {
  function sheets() {
    const setFormulas = vi.fn().mockResolvedValue(undefined);
    const clearValues = vi.fn().mockResolvedValue(undefined);
    return { client: { setFormulas, clearValues } as unknown as VettingSheetsClient, setFormulas, clearValues };
  }

  it('writes Vote Summary/Consensus to VETTING!L3:M3 and the Final Decision lookup to SYSTEM!I3, using the configured sheet names', async () => {
    const { client, setFormulas } = sheets();
    const cfg = config({ systemSheetName: 'Custom System', vettingSheetName: 'Custom Vetting' });

    await installVotingWorkflowFormulas(client, cfg);

    expect(setFormulas).toHaveBeenCalledWith('Custom Vetting', 'L3:M3', buildVoteConsensusFormulas());
    expect(setFormulas).toHaveBeenCalledWith('Custom System', 'I3:I3', [[buildFinalDecisionLookupFormula(cfg)]]);
    expect(setFormulas).toHaveBeenCalledTimes(2);
  });

  it('clears each spill destination before writing to it, and never touches row 1 or 2', async () => {
    const { client, setFormulas, clearValues } = sheets();
    const cfg = config({ systemSheetName: 'Custom System', vettingSheetName: 'Custom Vetting' });

    await installVotingWorkflowFormulas(client, cfg);

    expect(clearValues).toHaveBeenCalledWith('Custom Vetting', 'L3:M100000');
    expect(clearValues).toHaveBeenCalledWith('Custom System', 'I3:I100000');
    expect(clearValues).toHaveBeenCalledTimes(2);

    // Each clear must run before the setFormulas call for that same sheet,
    // or the clear would wipe out the formula it just wrote.
    const vettingClearOrder = clearValues.mock.invocationCallOrder[0]!;
    const vettingSetOrder = setFormulas.mock.calls.findIndex((call) => call[0] === 'Custom Vetting');
    const systemClearOrder = clearValues.mock.invocationCallOrder[1]!;
    const systemSetOrder = setFormulas.mock.calls.findIndex((call) => call[0] === 'Custom System');
    expect(vettingClearOrder).toBeLessThan(setFormulas.mock.invocationCallOrder[vettingSetOrder]!);
    expect(systemClearOrder).toBeLessThan(setFormulas.mock.invocationCallOrder[systemSetOrder]!);
  });
});
