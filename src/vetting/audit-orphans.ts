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
 */

import type { Guild } from 'discord.js';
import { SYSTEM_DATA_RANGE } from './bootstrap.js';
import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

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
    sheetsClient.getValues(config.systemSheetName, SYSTEM_DATA_RANGE),
  ]);

  const orphans: OrphanedSystemRow[] = [];
  rows.forEach((row, index) => {
    const discordId = row[0];
    if (!discordId) return;
    if (members.has(discordId)) return;

    orphans.push({
      // +2: this read starts at row 2 and `index` is 0-based -- see
      // bootstrap.ts's own note on why that's safe despite row 2 actually
      // holding SYSTEM's column headers rather than a player.
      rowNumber: index + 2,
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
