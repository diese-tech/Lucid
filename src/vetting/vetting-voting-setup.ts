/**
 * One-time (idempotent) install of the human voting workflow's calculated
 * fields (issue #54, Phase 5): `VETTING`'s Vote Summary/Consensus columns,
 * and the formula that carries a set `Final Decision` back to `SYSTEM` so
 * Lucid can eventually read it there (Phase 6's reconciliation reads
 * `SYSTEM`, never `VETTING`, per the master issue's own "SYSTEM is the
 * stable machine-facing interface" framing).
 *
 * Lucid never writes to the vetter columns (D-K) or Final Decision (N)
 * themselves -- those are the one human-edit surface in this whole
 * pipeline. This module only installs the formulas that read them; it
 * never overwrites, requires, or infers a vote from anything else (not
 * even Discord roles), matching the issue's explicit "Lucid does not
 * infer a vote from Discord roles" and "does not require all vetters to
 * vote" rules.
 *
 * Run with `npm run vetting:setup-voting` -- see
 * src/scripts/vetting-setup-voting.ts. Safe to re-run any time: it always
 * writes the exact same formulas to the exact same cells.
 */

import { quoteSheetName } from './sheets-client.js';
import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

/** The 8 unnamed vetter columns (D-K) every row's tally is computed over -- fixed by the spreadsheet contract, never staff's per-column header names. */
const VOTE_COLUMNS_RANGE = 'D2:K';
/** Mirrors vetting-tab-setup.ts's own declutter gate: a row with no Discord ID (blank/inactive) shows no tally either, not just no name/roles. */
const ANCHOR_COLUMN = 'A2:A';

/**
 * VETTING!L2:M2 -- ARRAYFORMULA + BYROW spills these down per row, so each
 * row's Vote Summary/Consensus is computed only from THAT row's own D:K
 * votes (BYROW/LAMBDA, not a column-wise ARRAYFORMULA broadcast, since this
 * is a per-row aggregation rather than Phase 4's simple column mirror).
 * Blank when nobody has voted yet on that row -- Lucid never guesses a
 * result out of zero votes.
 */
export function buildVoteConsensusFormulas(): string[][] {
  const perTierCounts = [1, 2, 3, 4, 5, 6, 7]
    .map((tier) => `IF(COUNTIF(r,${tier})>0,"T${tier}:"&COUNTIF(r,${tier}),"")`)
    .join(',');
  const voteSummaryFormula = `=ARRAYFORMULA(IF(${ANCHOR_COLUMN}="","",BYROW(${VOTE_COLUMNS_RANGE},LAMBDA(r,TEXTJOIN(", ",TRUE,${perTierCounts})))))`;

  const countsArray = `{${[1, 2, 3, 4, 5, 6, 7].map((tier) => `COUNTIF(r,${tier})`).join(',')}}`;
  const consensusFormula =
    `=ARRAYFORMULA(IF(${ANCHOR_COLUMN}="","",BYROW(${VOTE_COLUMNS_RANGE},LAMBDA(r,` +
    `IF(COUNT(r)=0,"",` +
    `LET(counts,${countsArray},total,COUNT(r),best,MAX(counts),tier,MATCH(best,counts,0),` +
    `IF(best=total,"Unanimous "&tier,IF(best*2>total,"Majority "&tier,"Split"))))))))`;

  return [[voteSummaryFormula, consensusFormula]];
}

/**
 * SYSTEM!I2 -- carries a set `Final Decision` back across from `VETTING!N`
 * by row POSITION, not an actual by-ID lookup (VLOOKUP/INDEX-MATCH):
 * Phase 4's own relational projection already guarantees VETTING's row N
 * is always the same physical row as SYSTEM's row N for a given Discord ID
 * (VETTING!A-C mirror SYSTEM row-for-row), so a positional pull is exactly
 * equivalent to an ID-keyed lookup here, at a fraction of the formula
 * complexity. Never gated on SYSTEM.Active -- a departed player's last
 * Final Decision must stay visible in SYSTEM (Phase 6 is what skips
 * inactive players when reconciling, not this formula).
 */
export function buildFinalDecisionLookupFormula(config: VettingConfig): string {
  const finalDecisionColumn = `${quoteSheetName(config.vettingSheetName)}!N2:N`;
  return `=ARRAYFORMULA(IF(A2:A="","",${finalDecisionColumn}))`;
}

export async function installVotingWorkflowFormulas(
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  await sheetsClient.setFormulas(config.vettingSheetName, 'L2:M2', buildVoteConsensusFormulas());
  await sheetsClient.setFormulas(config.systemSheetName, 'I2:I2', [[buildFinalDecisionLookupFormula(config)]]);
}
