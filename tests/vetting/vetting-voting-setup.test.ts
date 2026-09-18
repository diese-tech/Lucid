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
      `=ARRAYFORMULA(IF(A2:A="","",BYROW(D2:K,LAMBDA(r,TEXTJOIN(", ",TRUE,IF(COUNTIF(r,1)>0,"T1:"&COUNTIF(r,1),""),IF(COUNTIF(r,2)>0,"T2:"&COUNTIF(r,2),""),IF(COUNTIF(r,3)>0,"T3:"&COUNTIF(r,3),""),IF(COUNTIF(r,4)>0,"T4:"&COUNTIF(r,4),""),IF(COUNTIF(r,5)>0,"T5:"&COUNTIF(r,5),""),IF(COUNTIF(r,6)>0,"T6:"&COUNTIF(r,6),""),IF(COUNTIF(r,7)>0,"T7:"&COUNTIF(r,7),""))))))`,
      `=ARRAYFORMULA(IF(A2:A="","",BYROW(D2:K,LAMBDA(r,IF(COUNT(r)=0,"",LET(counts,{COUNTIF(r,1),COUNTIF(r,2),COUNTIF(r,3),COUNTIF(r,4),COUNTIF(r,5),COUNTIF(r,6),COUNTIF(r,7)},total,COUNT(r),best,MAX(counts),tier,MATCH(best,counts,0),IF(best=total,"Unanimous "&tier,IF(best*2>total,"Majority "&tier,"Split"))))))))`,
    ]);
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
    expect(formula).toBe(`=ARRAYFORMULA(IF(A2:A="","",'VETTING'!N2:N))`);
  });

  it('quotes a custom VETTING sheet name containing a space', () => {
    const formula = buildFinalDecisionLookupFormula(config({ vettingSheetName: 'Custom Vetting' }));
    expect(formula).toContain(`'Custom Vetting'!N2:N`);
  });

  it('doubles an embedded single quote in a custom sheet name', () => {
    const formula = buildFinalDecisionLookupFormula(config({ vettingSheetName: "O'Brien's Vetting" }));
    expect(formula).toContain(`'O''Brien''s Vetting'!N2:N`);
  });

  it('is never gated on Active -- a departed player\'s last Final Decision must stay visible in SYSTEM', () => {
    const formula = buildFinalDecisionLookupFormula(config());
    expect(formula).not.toContain('D2:D');
  });
});

describe('vote tally / consensus behavior (issue #54 Phase 5 acceptance criteria)', () => {
  // Direct JS translation of the formula's own IF(COUNT=0,"",...)/BYROW/LET
  // semantics -- same purpose as vetting-tab-setup.test.ts's declutter
  // behavior suite: pins the *behavior* the formula text (asserted above)
  // is meant to produce, since nothing here can execute a real spreadsheet
  // formula.
  function tally(votes: (number | null)[]): { voteSummary: string; consensus: string } {
    const cast = votes.filter((v): v is number => v !== null);
    const voteSummary = [1, 2, 3, 4, 5, 6, 7]
      .map((tier) => {
        const count = cast.filter((v) => v === tier).length;
        return count > 0 ? `T${tier}:${count}` : '';
      })
      .filter((s) => s !== '')
      .join(', ');

    if (cast.length === 0) return { voteSummary, consensus: '' };

    const counts = [1, 2, 3, 4, 5, 6, 7].map((tier) => cast.filter((v) => v === tier).length);
    const best = Math.max(...counts);
    const tier = counts.indexOf(best) + 1;
    const total = cast.length;
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
    expect(tally([6, 6, 7, 7, null, null, null, null])).toEqual({ voteSummary: 'T6:2, T7:2', consensus: 'Split' });
  });
});

describe('installVotingWorkflowFormulas', () => {
  it('writes Vote Summary/Consensus to VETTING!L2:M2 and the Final Decision lookup to SYSTEM!I2, using the configured sheet names', async () => {
    const setFormulas = vi.fn().mockResolvedValue(undefined);
    const sheets = { setFormulas } as unknown as VettingSheetsClient;
    const cfg = config({ systemSheetName: 'Custom System', vettingSheetName: 'Custom Vetting' });

    await installVotingWorkflowFormulas(sheets, cfg);

    expect(setFormulas).toHaveBeenCalledWith('Custom Vetting', 'L2:M2', buildVoteConsensusFormulas());
    expect(setFormulas).toHaveBeenCalledWith('Custom System', 'I2:I2', [[buildFinalDecisionLookupFormula(cfg)]]);
    expect(setFormulas).toHaveBeenCalledTimes(2);
  });
});
