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
 * Both SYSTEM and VETTING's real data starts at row 3 (row 1 is a title,
 * row 2 the column headers -- confirmed against the live reference sheet,
 * matching vetting-tab-setup.ts's own Phase 4 fix), so every range and
 * install target below is row 3, never row 2.
 *
 * Run with `npm run vetting:setup-voting` -- see
 * src/scripts/vetting-setup-voting.ts. Safe to re-run any time: it always
 * clears then rewrites the exact same formulas to the exact same cells,
 * never touching row 1 or 2 on either sheet.
 */

import { VETTING_TIERS } from './config.js';
import { quoteSheetName } from './sheets-client.js';
import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

/** The first row of real data on both SYSTEM and VETTING -- row 1 is a title, row 2 the column headers. */
const FIRST_DATA_ROW = 3;
/** The 8 unnamed vetter columns (D-K) every row's tally is computed over -- fixed by the spreadsheet contract, never staff's per-column header names. */
const VOTE_COLUMNS_RANGE = `D${FIRST_DATA_ROW}:K`;
/** Mirrors vetting-tab-setup.ts's own declutter gate: a row with no Discord ID (blank/inactive) shows no tally either, not just no name/roles. */
const ANCHOR_COLUMN = `A${FIRST_DATA_ROW}:A`;
/** VETTING's install target for Vote Summary/Consensus, e.g. `L3:M3`. */
const VOTING_INSTALL_RANGE = `L${FIRST_DATA_ROW}:M${FIRST_DATA_ROW}`;
/** Wide enough for any guild Lucid realistically manages, matching bootstrap.ts's own SYSTEM_DATA_RANGE sizing. */
const VETTING_CLEAR_RANGE = `L${FIRST_DATA_ROW}:M100000`;
/** SYSTEM's install target for the Final Decision lookup, e.g. `I3:I3`. */
const FINAL_DECISION_INSTALL_RANGE = `I${FIRST_DATA_ROW}:I${FIRST_DATA_ROW}`;
const SYSTEM_CLEAR_RANGE = `I${FIRST_DATA_ROW}:I100000`;

/**
 * VETTING!L2:M2 -- ARRAYFORMULA + BYROW spills these down per row, so each
 * row's Vote Summary/Consensus is computed only from THAT row's own D:K
 * votes (BYROW/LAMBDA, not a column-wise ARRAYFORMULA broadcast, since this
 * is a per-row aggregation rather than Phase 4's simple column mirror).
 * Blank when nobody has voted yet on that row -- Lucid never guesses a
 * result out of zero votes.
 *
 * Tier enumeration comes from `VETTING_TIERS` (config.ts's own canonical
 * list, currently 1-5), never a second hard-coded range -- Half-Shell's PR
 * #63 finding: an earlier version hard-coded 1-7, disagreeing with the
 * runtime's actual configured tier domain.
 *
 * `total` is the SUM of only the enumerated tiers' own counts, never
 * `COUNT(r)` (every non-blank numeric cell) -- Half-Shell's other PR #63
 * finding: since this module deliberately never installs data-validation
 * on the vetter columns (docs/setup.md), an out-of-range numeric entry
 * (e.g. a stray "9") is invisible in Vote Summary (it matches no
 * enumerated tier) but would otherwise still inflate the majority
 * denominator via `COUNT(r)`, silently skewing Consensus. Deriving `total`
 * from the same per-tier counts Vote Summary itself displays keeps both
 * cells operating over the exact same vote set.
 */
export function buildVoteConsensusFormulas(): string[][] {
  const perTierCounts = VETTING_TIERS.map(
    (tier) => `IF(COUNTIF(r,${tier})>0,"T${tier}:"&COUNTIF(r,${tier}),"")`,
  ).join(',');
  const voteSummaryFormula = `=ARRAYFORMULA(IF(${ANCHOR_COLUMN}="","",BYROW(${VOTE_COLUMNS_RANGE},LAMBDA(r,TEXTJOIN(", ",TRUE,${perTierCounts})))))`;

  const countsArray = `{${VETTING_TIERS.map((tier) => `COUNTIF(r,${tier})`).join(',')}}`;
  const consensusFormula =
    `=ARRAYFORMULA(IF(${ANCHOR_COLUMN}="","",BYROW(${VOTE_COLUMNS_RANGE},LAMBDA(r,` +
    `LET(counts,${countsArray},total,SUM(counts),best,MAX(counts),tier,MATCH(best,counts,0),` +
    `IF(total=0,"",IF(best=total,"Unanimous "&tier,IF(best*2>total,"Majority "&tier,"Split"))))))))`;

  return [[voteSummaryFormula, consensusFormula]];
}

/**
 * SYSTEM!I3 -- carries a set `Final Decision` back across from `VETTING!N`
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
  const finalDecisionColumn = `${quoteSheetName(config.vettingSheetName)}!N${FIRST_DATA_ROW}:N`;
  return `=ARRAYFORMULA(IF(A${FIRST_DATA_ROW}:A="","",${finalDecisionColumn}))`;
}

export async function installVotingWorkflowFormulas(
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  // Clears each spill destination first -- see vetting-tab-setup.ts's own
  // installVettingRelationalFormulas for why (ARRAYFORMULA refuses to
  // expand into an already-occupied range).
  await sheetsClient.clearValues(config.vettingSheetName, VETTING_CLEAR_RANGE);
  await sheetsClient.setFormulas(config.vettingSheetName, VOTING_INSTALL_RANGE, buildVoteConsensusFormulas());
  await sheetsClient.clearValues(config.systemSheetName, SYSTEM_CLEAR_RANGE);
  await sheetsClient.setFormulas(config.systemSheetName, FINAL_DECISION_INSTALL_RANGE, [
    [buildFinalDecisionLookupFormula(config)],
  ]);
}
