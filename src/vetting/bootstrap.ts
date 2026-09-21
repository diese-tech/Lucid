/**
 * Guild inventory bootstrap (issue #54, Phase 2) -- the permanent operation
 * that keeps the SYSTEM tab in sync with actual Discord membership, not a
 * disposable one-time export. Safe to re-run at any time: an existing row is
 * found by Discord ID and refreshed in place, never duplicated.
 *
 * Deliberately does not touch:
 * - SYSTEM column I (Final Decision) -- a formula reading from VETTING, once
 *   Phase 4 wires up that relational projection.
 * - SYSTEM column J (Last Applied Tier) -- Phase 6's reconciliation owns it.
 * - The VETTING tab at all -- including the issue's own allowance to seed an
 *   existing tiered player's Final Decision during "the initial migration
 *   only". That seeding writes to VETTING, whose relational row-per-player
 *   structure doesn't exist until Phase 4 builds it; doing it now would
 *   write into cells Phase 4 still needs to lay out. Deferred there rather
 *   than built twice.
 */

import type { Guild, GuildMember } from 'discord.js';
import { buildSystemRowValues, detectManagedTier, renderRoleNames } from '../domain/vetting-inventory.js';
import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

/** Wide enough for any guild Lucid realistically manages; Sheets omits trailing empty rows regardless. */
export const SYSTEM_DATA_RANGE = 'A2:L100000';
const SYSTEM_FACTS_APPEND_RANGE = 'A2:H100000';

export interface MemberSystemRow {
  discordId: string;
  /** SYSTEM columns A-H for this member -- see buildSystemRowValues's own doc comment for what it deliberately excludes. */
  rowValues: string[];
  syncStatus: 'Synced' | 'Conflict';
  /** True when this member holds 2+ configured tier roles at once. */
  conflict: boolean;
}

/**
 * The SYSTEM row one guild member's current Discord state produces --
 * shared by the bulk bootstrap loop below and sync.ts's live single-member
 * event handlers (issue #54 Phase 3), so "how a member becomes a row" is
 * computed in exactly one place regardless of which of those triggered it.
 */
export function buildMemberSystemRow(member: GuildMember, guildId: string, config: VettingConfig): MemberSystemRow {
  const roles = member.roles.cache.filter((role) => role.id !== guildId);
  const roleIds = roles.map((role) => role.id);
  const roleNames = roles.map((role) => role.name);

  const detection = detectManagedTier(roleIds, config.tierRoleIds);
  const rowValues = buildSystemRowValues({
    discordId: member.id,
    username: member.user.username,
    displayName: member.displayName,
    joinedAt: member.joinedAt,
    currentRolesText: renderRoleNames(roleNames),
    tier: detection.tier,
  });

  return {
    discordId: member.id,
    rowValues,
    syncStatus: detection.conflict ? 'Conflict' : 'Synced',
    conflict: detection.conflict,
  };
}

export interface BootstrapSummary {
  /** Non-bot members processed. */
  totalMembers: number;
  created: number;
  updated: number;
  /** Discord IDs left with a blank Current Tier Role and Sync Status = Conflict because they hold 2+ configured tier roles. */
  conflicts: string[];
}

interface NewSystemRow {
  rowValues: string[];
  syncStatus: MemberSystemRow['syncStatus'];
  lastSynced: string;
}

/**
 * Creates SYSTEM rows without ever sending values for formula-owned I or
 * reconciliation-owned J. The Sheets append response identifies the rows
 * allocated for A:H, allowing K:L metadata to be written to those exact
 * rows without a second append (which could choose or insert other rows).
 * In particular, do not "simplify" this back to an A:L append padded with
 * empty strings: Google Sheets treats those empties as values that can block
 * the SYSTEM!I ARRAYFORMULA spill (issue #72).
 */
export async function appendNewSystemRows(
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
  rows: NewSystemRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const updatedRange = await sheetsClient.appendValues(
    config.systemSheetName,
    SYSTEM_FACTS_APPEND_RANGE,
    rows.map((row) => row.rowValues),
  );
  const match = /!A(\d+):H(\d+)$/.exec(updatedRange);
  if (!match) throw new Error(`Unexpected SYSTEM append range returned by Google Sheets: ${updatedRange}`);

  const startRow = Number(match[1]);
  const endRow = Number(match[2]);
  if (endRow - startRow + 1 !== rows.length) {
    throw new Error(`SYSTEM append returned ${updatedRange} for ${rows.length} rows`);
  }

  await sheetsClient.batchUpdateValues([
    {
      sheetName: config.systemSheetName,
      cellRange: `K${startRow}:L${endRow}`,
      values: rows.map((row) => [row.syncStatus, row.lastSynced]),
    },
  ]);
}

export async function bootstrapGuildInventory(
  guild: Guild,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<BootstrapSummary> {
  const [members, existingRows] = await Promise.all([
    guild.members.fetch(),
    sheetsClient.getValues(config.systemSheetName, SYSTEM_DATA_RANGE),
  ]);

  // Discord ID (column A) -> the row's real sheet row number, so an update
  // lands on the same row a member was originally recorded at rather than
  // creating a second one. +2: the read range starts at row 2, and `index`
  // is 0-based. This is safe even though the reference template's actual
  // first PLAYER row is row 3 (row 1 is a title, row 2 the column headers,
  // confirmed against the live sheet) -- this code never assumes what's in
  // row 2, it just includes it in the read and computes each match's real
  // row from array position. Row 2's header text never equals a real
  // Discord ID, so it's silently skipped by the lookup above, and
  // `appendValues` (used below) finds the true last-occupied row itself
  // rather than assuming one -- new rows land at row 3 onward regardless.
  const rowNumberByDiscordId = new Map<string, number>();
  existingRows.forEach((row, index) => {
    const discordId = row[0];
    if (discordId) rowNumberByDiscordId.set(discordId, index + 2);
  });

  const updates: { sheetName: string; cellRange: string; values: string[][] }[] = [];
  const newRows: NewSystemRow[] = [];
  const conflicts: string[] = [];
  const now = new Date().toISOString();
  let totalMembers = 0;

  for (const member of members.values()) {
    if (member.user.bot) continue;
    totalMembers++;

    const built = buildMemberSystemRow(member, guild.id, config);
    if (built.conflict) conflicts.push(member.id);

    const existingRowNumber = rowNumberByDiscordId.get(member.id);
    if (existingRowNumber !== undefined) {
      updates.push({
        sheetName: config.systemSheetName,
        cellRange: `A${existingRowNumber}:H${existingRowNumber}`,
        values: [built.rowValues],
      });
      updates.push({
        sheetName: config.systemSheetName,
        cellRange: `K${existingRowNumber}:L${existingRowNumber}`,
        values: [[built.syncStatus, now]],
      });
    } else {
      newRows.push({ rowValues: built.rowValues, syncStatus: built.syncStatus, lastSynced: now });
    }
  }

  if (updates.length > 0) await sheetsClient.batchUpdateValues(updates);
  await appendNewSystemRows(sheetsClient, config, newRows);

  return {
    totalMembers,
    created: newRows.length,
    updated: updates.length / 2,
    conflicts,
  };
}
