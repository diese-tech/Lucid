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
 * Run with `npm run vetting:setup-relational-view` -- see
 * src/scripts/vetting-setup-relational-view.ts. Safe to re-run any time:
 * it always writes the exact same three formulas to the exact same cells.
 */

import { quoteSheetName } from './sheets-client.js';
import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

/** VETTING!A2:C2 -- ARRAYFORMULA spills these down to cover every row SYSTEM ever gains, with no re-run needed as membership grows. */
export function buildRelationalProjectionFormulas(config: VettingConfig): string[][] {
  const system = quoteSheetName(config.systemSheetName);
  const discordIdColumn = `${system}!A2:A`;
  const activeColumn = `${system}!D2:D`;
  const displayNameColumn = `${system}!C2:C`;
  const currentRolesColumn = `${system}!G2:G`;

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
  await sheetsClient.setFormulas(config.vettingSheetName, 'A2:C2', buildRelationalProjectionFormulas(config));
}
