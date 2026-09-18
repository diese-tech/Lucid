/**
 * Read-only diagnostic, not part of any automated pass: lists every SYSTEM
 * row whose Discord ID doesn't match a member Discord's own API currently
 * returns for the guild. Every automated pass in this codebase only ever
 * acts on rows it wrote itself from real Discord state -- bootstrap/sync
 * only touch rows for CURRENT members, and drift-repair's departure check
 * only catches a row that was `Active=TRUE` with no matching current
 * member. None of them ever look at a row that started `Active=FALSE` (or
 * anything else) from data Lucid didn't write -- e.g. rows carried over
 * into the same spreadsheet from a prior system's own export, which have
 * no Discord API call that would ever surface them again on their own.
 *
 * This surfaces exactly those rows for a human to eyeball and decide what
 * to do with by hand; it never writes anything itself. A row showing up
 * here is not automatically "fake" -- a real player who has genuinely left
 * the server looks identical from SYSTEM's data alone. The point is giving
 * a human a short, complete list to check against what they actually know
 * about their own community, rather than scrolling hundreds of rows by eye.
 *
 * Deliberately does NOT reuse bootstrap.ts's own `SYSTEM_DATA_RANGE`
 * (`A2:L100000`), even though every other module in this file's family
 * does. That range including row 2 is harmless for bootstrap/sync, since
 * they only ever match a row by an exact Discord ID lookup and the header
 * text there (`Discord ID`) never equals a real one. This audit has no
 * such lookup -- it treats ANY nonblank column A value as a candidate ID,
 * so including row 2 would report the header row itself as an orphan on
 * every single run (Half-Shell's PR #70 finding). Reads from row 3
 * onward instead, matching vetting-tab-setup.ts/vetting-voting-setup.ts's
 * own `FIRST_DATA_ROW` convention.
 */

import type { Guild } from 'discord.js';
import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

/** The first row of real data on SYSTEM -- row 1 is a title, row 2 the column headers. */
const FIRST_DATA_ROW = 3;
/** Wide enough for any guild Lucid realistically manages, matching bootstrap.ts's own SYSTEM_DATA_RANGE sizing. */
const AUDIT_DATA_RANGE = `A${FIRST_DATA_ROW}:L100000`;

export interface OrphanedSystemRow {
  rowNumber: number;
  discordId: string;
  username: string;
  displayName: string;
  active: string;
  joinedAt: string;
  leftAt: string;
  currentRoles: string;
}

export async function findOrphanedSystemRows(
  guild: Guild,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<OrphanedSystemRow[]> {
  const [members, rows] = await Promise.all([
    guild.members.fetch(),
    sheetsClient.getValues(config.systemSheetName, AUDIT_DATA_RANGE),
  ]);

  const orphans: OrphanedSystemRow[] = [];
  rows.forEach((row, index) => {
    const discordId = row[0];
    if (!discordId) return;
    if (members.has(discordId)) return;

    orphans.push({
      // +3: this read starts at row 3 (FIRST_DATA_ROW) and `index` is 0-based.
      rowNumber: index + FIRST_DATA_ROW,
      discordId,
      username: row[1] ?? '',
      displayName: row[2] ?? '',
      active: row[3] ?? '',
      joinedAt: row[4] ?? '',
      leftAt: row[5] ?? '',
      currentRoles: row[6] ?? '',
    });
  });

  return orphans;
}
