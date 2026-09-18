/**
 * Live Discord -> SYSTEM synchronization (issue #54, Phase 3) -- keeps a
 * bootstrapped SYSTEM tab current as members join, leave, or change
 * roles/nickname/username, without needing bootstrap re-run by hand.
 * Complements bootstrap.ts rather than replacing it: this only ever touches
 * the ONE member an event names, while bootstrap syncs an entire guild's
 * membership in one pass.
 *
 * Same discipline as bootstrap.ts: never touches column I (Final Decision
 * formula, once Phase 4 exists) or J (Last Applied Tier, Phase 6's) -- a
 * live event is exactly as capable of clobbering human/formula-owned data
 * as a bulk bootstrap run is, so it gets the same two-disjoint-range write.
 *
 * An event-handler failure here must never leave Lucid's core pickup
 * features unusable. That's the caller's job (index.ts catches and logs
 * rather than letting a Sheets/Discord hiccup take anything else down) --
 * this module just does the one sync it was asked for and lets a failure
 * propagate honestly. The periodic reconciler (issue #54 Phase 7, not yet
 * built) is what eventually repairs anything an event genuinely missed.
 */

import type { Guild, GuildMember } from 'discord.js';
import { buildMemberSystemRow, SYSTEM_DATA_RANGE } from './bootstrap.js';
import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

/**
 * Serializes calls sharing the same Discord ID so two near-simultaneous live
 * events for the same member (e.g. `GuildMemberAdd` immediately followed by
 * a welcome bot assigning a role, which fires `GuildMemberUpdate`) can never
 * both read column A before either write lands and both conclude the member
 * is missing -- Half-Shell's PR #61 finding: without this, both would append
 * a row for the same Discord ID, breaking the "same row, never duplicated"
 * guarantee `appendValues`'s own `INSERT_ROWS` only protects the *physical*
 * row for, not the *logical* one.
 *
 * Calls for different Discord IDs still run fully concurrently -- only
 * same-ID calls queue behind each other. An in-process queue is sufficient
 * (not a distributed lock): Lucid runs as a single instance per bot token
 * (see docs/setup.md's "Never run two instances" section), so every event
 * for a given guild's members is already funneled through this one process.
 * Entries are removed once idle, so this never grows unbounded.
 */
const memberSyncTails = new Map<string, Promise<void>>();

function serializeByDiscordId(discordId: string, task: () => Promise<void>): Promise<void> {
  const previousTail = memberSyncTails.get(discordId) ?? Promise.resolve();
  const settled = previousTail.then(task, task);
  const tail = settled.catch(() => undefined);
  memberSyncTails.set(discordId, tail);
  tail.finally(() => {
    if (memberSyncTails.get(discordId) === tail) memberSyncTails.delete(discordId);
  });
  return settled;
}

/**
 * The SYSTEM row for a Discord ID, or null if it has never been recorded.
 * Reads only column A -- cheaper than fetching every column for a single
 * lookup, unlike bootstrap's full-range read (which needs every column
 * anyway, to write full rows for an entire guild in one pass).
 */
async function findSystemRowNumber(
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
  discordId: string,
): Promise<number | null> {
  const ids = await sheetsClient.getValues(config.systemSheetName, 'A2:A100000');
  const index = ids.findIndex((row) => row[0] === discordId);
  // +2: range starts at row 2, index is 0-based. Safe despite row 2 actually
  // holding the column headers (real players start at row 3, see
  // bootstrap.ts's own note) -- header text never matches a real Discord ID.
  return index === -1 ? null : index + 2;
}

/**
 * Refreshes (or creates) one member's SYSTEM row from their current Discord
 * state -- used for a join, a role/nickname change, and a username change
 * alike, since all three want exactly the same result: "here is this
 * member's current state, and they are present." A rejoin lands on the same
 * row as before (found by Discord ID) rather than a new one, and
 * `buildSystemRowValues` always sets `Active = TRUE` and clears `Left At`,
 * so a returning member is correctly reactivated without any special-casing
 * here.
 */
export function syncMemberPresence(
  guild: Guild,
  member: GuildMember,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  return serializeByDiscordId(member.id, () => doSyncMemberPresence(guild, member, sheetsClient, config));
}

async function doSyncMemberPresence(
  guild: Guild,
  member: GuildMember,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  if (member.user.bot) return;

  const built = buildMemberSystemRow(member, guild.id, config);
  const rowNumber = await findSystemRowNumber(sheetsClient, config, member.id);
  const now = new Date().toISOString();

  if (rowNumber !== null) {
    await sheetsClient.batchUpdateValues([
      { sheetName: config.systemSheetName, cellRange: `A${rowNumber}:H${rowNumber}`, values: [built.rowValues] },
      { sheetName: config.systemSheetName, cellRange: `K${rowNumber}:L${rowNumber}`, values: [[built.syncStatus, now]] },
    ]);
  } else {
    await sheetsClient.appendValues(config.systemSheetName, SYSTEM_DATA_RANGE, [
      [...built.rowValues, '', '', built.syncStatus, now],
    ]);
  }
}

/**
 * Marks a departed member inactive -- never deletes their row, and never
 * touches Current Roles/Current Tier Role (their last known values before
 * leaving stand, exactly as the issue asks: "preserve historical votes and
 * final decision", and there's nothing fresher to refresh them with once
 * someone's gone). A no-op if this Discord ID was never recorded in the
 * first place -- there's no row to mark inactive, and nothing lost that a
 * later join or the Phase 7 reconciler couldn't establish from scratch.
 */
export function syncMemberDeparture(
  discordId: string,
  isBot: boolean,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  return serializeByDiscordId(discordId, () => doSyncMemberDeparture(discordId, isBot, sheetsClient, config));
}

async function doSyncMemberDeparture(
  discordId: string,
  isBot: boolean,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<void> {
  if (isBot) return;

  const rowNumber = await findSystemRowNumber(sheetsClient, config, discordId);
  if (rowNumber === null) return;

  const now = new Date().toISOString();
  await sheetsClient.batchUpdateValues([
    { sheetName: config.systemSheetName, cellRange: `D${rowNumber}:D${rowNumber}`, values: [['FALSE']] },
    { sheetName: config.systemSheetName, cellRange: `F${rowNumber}:F${rowNumber}`, values: [[now]] },
    { sheetName: config.systemSheetName, cellRange: `K${rowNumber}:L${rowNumber}`, values: [['Synced', now]] },
  ]);
}
