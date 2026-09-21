/**
 * One-time (idempotent) install of the human voting workflow's calculated
 * fields (issue #54 Phase 5; hardened by #71/#72): `VETTING`'s Vote
 * Summary/Consensus columns, and the formula that carries a set `Final
 * Decision` back to `SYSTEM` so Lucid can eventually read it there
 * (Phase 6's reconciliation reads `SYSTEM`, never `VETTING`, per the
 * master issue's own "SYSTEM is the stable machine-facing interface"
 * framing).
 *
 * Every VETTING coordinate below (the reviewer/vote-column range, Vote
 * Summary, Consensus, Final Decision) is resolved fresh from VETTING's own
 * row-2 header text via `resolveVettingLayout` (issue #71) rather than
 * hard-coded to `D:K`/`L:M`/`N` -- staff can add, remove, or rename
 * reviewer columns on the live sheet at any time, and the next
 * install/repair run picks up the new width automatically. A malformed
 * header row (missing/duplicate/out-of-order structural headers, or zero
 * reviewer columns) makes the resolver throw `VettingLayoutError` before
 * any clear/write happens here -- this module never guesses a layout.
 *
 * `SYSTEM!I`'s Final Decision lookup is keyed by Discord ID (issue #72
 * Goal A), never by row position: `SYSTEM` and `VETTING` no longer need to
 * stay row-aligned, and a display-name change or an out-of-order VETTING
 * row can never cause one player's Final Decision to surface on another
 * player's SYSTEM row. This reproduces the live-sheet repair formula
 * (issue #72's tracking comment) through Lucid's own setup tooling. A
 * Discord ID that appears more than once in VETTING is surfaced as a
 * distinct, non-numeric "#DUPLICATE" marker rather than silently picking
 * an arbitrary human decision -- reconciliation (reconcile.ts) already
 * treats any non-numeric/out-of-range Final Decision as an invalid tier
 * (error, no mutation), so this can never itself trigger a Discord role
 * change.
 *
 * Lucid never writes to the vetter columns themselves or Final Decision
 * -- those are the one human-edit surface in this whole pipeline. This
 * module only installs the formulas that read them; it never overwrites,
 * requires, or infers a vote from anything else (not even Discord roles),
 * matching the issue's explicit "Lucid does not infer a vote from Discord
 * roles" and "does not require all vetters to vote" rules.
 *
 * Both SYSTEM and VETTING's real data starts at row 3 (row 1 is a title,
 * row 2 the column headers -- confirmed against the live reference sheet,
 * matching vetting-tab-setup.ts's own Phase 4 fix), so every range and
 * install target below is row 3, never row 2.
 *
 * Run with `npm run vetting:setup-voting` -- see
 * src/scripts/vetting-setup-voting.ts. Safe to re-run any time: it always
 * clears then rewrites the exact same formulas to the exact same cells,
 * never touching row 1 or 2 on either sheet, and never touching the
 * reviewer vote block or Final Decision itself.
 */

import { VETTING_TIERS } from './config.js';
import { columnIndexToLetter, readVettingLayout } from './vetting-layout.js';
import { quoteSheetName } from './sheets-client.js';
import type { VettingConfig } from './config.js';
import type { VettingLayout } from './vetting-layout.js';
import type { VettingSheetsClient } from './sheets-client.js';

/** The first row of real data on both SYSTEM and VETTING -- row 1 is a title, row 2 the column headers. */
const FIRST_DATA_ROW = 3;
/** Mirrors vetting-tab-setup.ts's own declutter gate: a row with no Discord ID (blank/inactive) shows no tally either, not just no name/roles. */
const ANCHOR_COLUMN = `A${FIRST_DATA_ROW}:A`;
/** Wide enough for any guild Lucid realistically manages, matching bootstrap.ts's own SYSTEM_DATA_RANGE sizing. */
const CLEAR_ROW_LIMIT = 100000;
/** SYSTEM's install target for the Final Decision lookup, e.g. `I3:I3`. */
const FINAL_DECISION_INSTALL_RANGE = `I${FIRST_DATA_ROW}:I${FIRST_DATA_ROW}`;
const SYSTEM_CLEAR_RANGE = `I${FIRST_DATA_ROW}:I${CLEAR_ROW_LIMIT}`;
/** Non-numeric by construction (`Number("#DUPLICATE...")` is `NaN`) so reconcile.ts's existing "invalid tier -> error, no mutation" path already covers it without any reconciler change. */
const DUPLICATE_DISCORD_ID_MARKER = '#DUPLICATE VETTING DISCORD ID';

/**
 * VETTING!<voteSummary><row>:<consensus><row> -- ARRAYFORMULA + BYROW
 * spills these down per row, so each row's Vote Summary/Consensus is
 * computed only from THAT row's own resolved reviewer columns (BYROW/
 * LAMBDA, not a column-wise ARRAYFORMULA broadcast, since this is a
 * per-row aggregation rather than Phase 4's simple column mirror). Blank
 * when nobody has voted yet on that row -- Lucid never guesses a result
 * out of zero votes.
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
export function buildVoteConsensusFormulas(layout: VettingLayout): string[][] {
  const voteColumnsRange = `${columnIndexToLetter(layout.reviewerStartColumn)}${FIRST_DATA_ROW}:${columnIndexToLetter(layout.reviewerEndColumn)}`;

  const perTierCounts = VETTING_TIERS.map(
    (tier) => `IF(COUNTIF(r,${tier})>0,"T${tier}:"&COUNTIF(r,${tier}),"")`,
  ).join(',');
  const voteSummaryFormula = `=ARRAYFORMULA(IF(${ANCHOR_COLUMN}="","",BYROW(${voteColumnsRange},LAMBDA(r,TEXTJOIN(", ",TRUE,${perTierCounts})))))`;

  const countsArray = `{${VETTING_TIERS.map((tier) => `COUNTIF(r,${tier})`).join(',')}}`;
  const consensusFormula =
    `=ARRAYFORMULA(IF(${ANCHOR_COLUMN}="","",BYROW(${voteColumnsRange},LAMBDA(r,` +
    `LET(counts,${countsArray},total,SUM(counts),best,MAX(counts),tier,MATCH(best,counts,0),` +
    `IF(total=0,"",IF(best=total,"Unanimous "&tier,IF(best*2>total,"Majority "&tier,"Split"))))))))`;

  return [[voteSummaryFormula, consensusFormula]];
}

/**
 * SYSTEM!I3 -- looks up a set `Final Decision` from `VETTING` by Discord
 * ID (issue #72 Goal A), never by row position and never by display name:
 * `VLOOKUP(SYSTEM's own Discord ID, {VETTING Discord ID column, VETTING's
 * resolved Final Decision column}, 2, FALSE)`. Blank SYSTEM Discord ID, or
 * no matching VETTING Discord ID, both resolve to blank (`IFERROR(...,"")`)
 * -- never gated on SYSTEM.Active either, since a departed player's last
 * Final Decision must stay visible in SYSTEM (Phase 6 is what skips
 * inactive players when reconciling, not this formula).
 *
 * A Discord ID appearing more than once in VETTING is surfaced as
 * `DUPLICATE_DISCORD_ID_MARKER` instead of silently resolving to whichever
 * row VLOOKUP happens to find first -- issue #72's explicit "duplicate
 * Discord IDs in VETTING are surfaced... rather than silently selecting an
 * arbitrary human decision" requirement. The marker is deliberately
 * non-numeric so reconcile.ts's existing tier validation rejects it as an
 * invalid Final Decision (error, no mutation) with no reconciler change
 * needed.
 */
export function buildFinalDecisionLookupFormula(config: VettingConfig, layout: VettingLayout): string {
  const vetting = quoteSheetName(config.vettingSheetName);
  const vettingDiscordIdColumn = columnIndexToLetter(layout.discordIdColumn);
  const vettingFinalDecisionColumn = columnIndexToLetter(layout.finalDecisionColumn);
  const vettingDiscordIdRange = `${vetting}!${vettingDiscordIdColumn}${FIRST_DATA_ROW}:${vettingDiscordIdColumn}`;
  const vettingFinalDecisionRange = `${vetting}!${vettingFinalDecisionColumn}${FIRST_DATA_ROW}:${vettingFinalDecisionColumn}`;

  return (
    `=ARRAYFORMULA(IF(A${FIRST_DATA_ROW}:A="","",` +
    `IF(COUNTIF(${vettingDiscordIdRange},A${FIRST_DATA_ROW}:A)>1,"${DUPLICATE_DISCORD_ID_MARKER}",` +
    `IFERROR(VLOOKUP(A${FIRST_DATA_ROW}:A,{${vettingDiscordIdRange},${vettingFinalDecisionRange}},2,FALSE),""))))`
  );
}

export async function installVotingWorkflowFormulas(
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  // Resolved before any clear/write -- a malformed VETTING header row
  // throws here and this function performs no destructive Sheets
  // operation at all (issue #71's fail-closed requirement).
  const layout = await readVettingLayout(sheetsClient, config);

  const voteSummaryLetter = columnIndexToLetter(layout.voteSummaryColumn);
  const consensusLetter = columnIndexToLetter(layout.consensusColumn);
  const votingInstallRange = `${voteSummaryLetter}${FIRST_DATA_ROW}:${consensusLetter}${FIRST_DATA_ROW}`;
  const votingClearRange = `${voteSummaryLetter}${FIRST_DATA_ROW}:${consensusLetter}${CLEAR_ROW_LIMIT}`;

  // Clears each spill destination first -- see vetting-tab-setup.ts's own
  // installVettingRelationalFormulas for why (ARRAYFORMULA refuses to
  // expand into an already-occupied range). Only the resolved
  // formula-owned Vote Summary/Consensus columns are cleared -- never the
  // reviewer vote block or Final Decision, whatever the current layout is.
  await sheetsClient.clearValues(config.vettingSheetName, votingClearRange);
  await sheetsClient.setFormulas(config.vettingSheetName, votingInstallRange, buildVoteConsensusFormulas(layout));
  await sheetsClient.clearValues(config.systemSheetName, SYSTEM_CLEAR_RANGE);
  await sheetsClient.setFormulas(config.systemSheetName, FINAL_DECISION_INSTALL_RANGE, [
    [buildFinalDecisionLookupFormula(config, layout)],
  ]);
}
