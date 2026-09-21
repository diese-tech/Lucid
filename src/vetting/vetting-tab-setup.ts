/**
 * One-time (idempotent) install of the SYSTEM -> VETTING relational
 * projection (issue #54, Phase 4): `ARRAYFORMULA` cells in VETTING's
 * Discord ID/Player/Current Roles columns that mirror SYSTEM by row
 * position, keyed by Discord ID -- never by display name, per the issue's
 * own explicit "spreadsheet formulas must not depend on matching display
 * names" requirement. Because SYSTEM's own row-per-member position is
 * stable (bootstrap and sync.ts always find-or-append the SAME row for a
 * given Discord ID, see bootstrap.ts's own doc comment), a display-name
 * change, a leave/rejoin, or two members who happen to share a name can
 * never move, lose, or cross-link a row's human-entered votes: the row
 * itself never moves, only the formula-driven cells in it re-evaluate.
 *
 * Deliberately covers only columns A-C. Vote Summary/Consensus (Phase 5)
 * and Final Decision are human/formula-owned territory this module never
 * touches, and the unnamed vetter columns (D-K) are staff's to name later
 * -- the issue explicitly says not to hard-code them here.
 *
 * An inactive (departed) SYSTEM row blanks all three cells here, not just
 * Player/Current Roles -- issue #54 Phase 4's own "inactive players do not
 * clutter the active VETTING queue" criterion (Half-Shell's PR #62 finding:
 * leaving Discord ID visible with a blank name looked like an unresolved
 * row needing attention, the opposite of decluttered). The row position
 * itself never moves -- only the formula-driven cells in it go blank -- so
 * this stays purely a display change: a departed player's historical vote
 * cells (D onward, human-owned) are untouched and land on the exact same
 * row again if they rejoin, per SYSTEM's own stable row-per-Discord-ID
 * guarantee (bootstrap.ts/sync.ts).
 *
 * Both SYSTEM and VETTING's real data starts at row 3 (row 1 is a title,
 * row 2 the column headers -- confirmed against the live reference sheet),
 * so every reference below, and this module's install target, is row 3.
 * An earlier version of this module used row 2 throughout, which wrote its
 * formulas directly into VETTING's header row and read SYSTEM's own header
 * row as if it were a player, producing a `#REF!`/"Array result was not
 * expanded because it would overwrite data" failure and destroying the
 * VETTING header text that used to live in A2:C2.
 *
 * VETTING's own Discord ID/Player/Current Roles columns are resolved from
 * its row-2 header text via `resolveVettingLayout` (issue #71) rather than
 * assumed to be literally A/B/C -- in practice they always are today, but
 * resolving them the same way every other vetting component does means
 * this module never carries its own, potentially-drifting copy of VETTING's
 * layout. A malformed VETTING header row throws before any clear/write
 * happens here, same as vetting-voting-setup.ts.
 *
 * Run with `npm run vetting:setup-relational-view` -- see
 * src/scripts/vetting-setup-relational-view.ts. Safe to re-run any time:
 * it always clears then rewrites the exact same three formulas to the
 * exact same cells, never touching row 1 or 2 on either sheet.
 */

import { columnIndexToLetter, readVettingLayout } from './vetting-layout.js';
import { quoteSheetName } from './sheets-client.js';
import type { VettingConfig } from './config.js';
import type { VettingLayout } from './vetting-layout.js';
import type { VettingSheetsClient } from './sheets-client.js';

/** The first row of real data on both SYSTEM and VETTING -- row 1 is a title, row 2 the column headers. */
const FIRST_DATA_ROW = 3;
/** Wide enough for any guild Lucid realistically manages, matching bootstrap.ts's own SYSTEM_DATA_RANGE sizing. */
const CLEAR_ROW_LIMIT = 100000;

/** The 3 formulas installed at VETTING's resolved Discord ID/Player/Current Roles columns, e.g. `A3:C3` -- ARRAYFORMULA spills these down to cover every row SYSTEM ever gains, with no re-run needed as membership grows. Reads only from SYSTEM's own fixed columns (A/D/C/G), unaffected by VETTING's resolved layout. */
export function buildRelationalProjectionFormulas(config: VettingConfig): string[][] {
  const system = quoteSheetName(config.systemSheetName);
  const discordIdColumn = `${system}!A${FIRST_DATA_ROW}:A`;
  const activeColumn = `${system}!D${FIRST_DATA_ROW}:D`;
  const displayNameColumn = `${system}!C${FIRST_DATA_ROW}:C`;
  const currentRolesColumn = `${system}!G${FIRST_DATA_ROW}:G`;

  return [
    [
      `=ARRAYFORMULA(IF(${discordIdColumn}="","",IF(${activeColumn}="TRUE",${discordIdColumn},"")))`,
      `=ARRAYFORMULA(IF(${discordIdColumn}="","",IF(${activeColumn}="TRUE",${displayNameColumn},"")))`,
      `=ARRAYFORMULA(IF(${discordIdColumn}="","",IF(${activeColumn}="TRUE",${currentRolesColumn},"")))`,
    ],
  ];
}

export async function installVettingRelationalFormulas(
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  // Resolved before any clear/write -- a malformed VETTING header row
  // throws here and this function performs no destructive Sheets
  // operation at all (issue #71's fail-closed requirement).
  const layout: VettingLayout = await readVettingLayout(sheetsClient, config);
  const discordIdLetter = columnIndexToLetter(layout.discordIdColumn);
  const currentRolesLetter = columnIndexToLetter(layout.currentRolesColumn);
  const installRange = `${discordIdLetter}${FIRST_DATA_ROW}:${currentRolesLetter}${FIRST_DATA_ROW}`;
  const clearRange = `${discordIdLetter}${FIRST_DATA_ROW}:${currentRolesLetter}${CLEAR_ROW_LIMIT}`;

  // Clears the spill destination first -- ARRAYFORMULA refuses to expand
  // into a range that already holds a value or another formula (a stale
  // previous install, leftover template content, anything), silently
  // failing with #REF! instead. A no-op the first time this ever runs
  // against a truly empty range, and the reason re-running this is safe
  // even after a partial/earlier install left something behind.
  await sheetsClient.clearValues(config.vettingSheetName, clearRange);
  await sheetsClient.setFormulas(config.vettingSheetName, installRange, buildRelationalProjectionFormulas(config));
}
