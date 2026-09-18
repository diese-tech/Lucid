/**
 * VETTING -> SYSTEM -> Discord reconciliation (issue #54, Phase 6) -- the
 * first point in this pipeline where Lucid actually mutates a Discord role.
 * Everything through Phase 5 only ever read/projected state; this is what
 * makes a human-set `Final Decision` (read from `SYSTEM!I`, Phase 5's own
 * formula lookup from `VETTING!N`) take effect.
 *
 * Desired-state comparison, not a one-off "cell changed" command, per the
 * issue's own framing:
 *
 *   Desired state  = SYSTEM.Final Decision
 *   Observed state = the member's actually-held managed tier role, read
 *                    live from the Discord gateway member cache -- never
 *                    from SYSTEM.Current Tier Role, which could be stale by
 *                    up to a poll interval if a role changed outside this
 *                    reconciler (another bot, a manual admin action, a
 *                    missed event). Acting on stale "observed" state risks
 *                    removing a role the member doesn't actually have
 *                    anymore or leaving one behind that should go -- the
 *                    live gateway cache (already kept current by Phase 3's
 *                    own listeners and Discord's own push updates,
 *                    regardless of this reconciler) is Discord's own
 *                    current truth, at zero extra API cost since it's
 *                    already resident in memory.
 *
 * Reuses `detectManagedTier` (domain/vetting-inventory.ts) for that live
 * read -- the exact same "zero/one/multiple managed tier roles" detection
 * bootstrap.ts and sync.ts already use, so "conflict" means the same thing
 * everywhere in this codebase.
 *
 * `planReconciliation` is pure and covers every Phase 6 acceptance
 * criterion directly; `reconcileGuild` is the orchestration that reads
 * SYSTEM, resolves each row against the live guild member cache, and
 * applies/records the result.
 *
 * `reconcileGuild` serializes passes per guild (Half-Shell's PR #65 finding):
 * without this, an interval tick still mid-flight on slow Sheets/Discord I/O
 * could overlap with a second pass -- from this module's own worker's next
 * tick, or from Phase 7's drift repair, which also calls `reconcileGuild` --
 * started while Final Decision had already changed between the two reads.
 * The two passes would then be enforcing two different desired states over
 * the same member at once, and their remove/add sequences could interleave
 * into exactly the multi-tier-role Conflict state this reconciler otherwise
 * refuses to ever produce by itself. Each individual pass being idempotent
 * (safe to retry once it's *done*) does not make two *simultaneous* passes
 * safe -- serializing every call sharing a guild ID, the same pattern
 * `sync.ts`'s `serializeByDiscordId` already uses, is what closes that gap,
 * and it protects every current and future caller of `reconcileGuild`
 * without either caller needing to know about it.
 */

import { DiscordAPIError } from 'discord.js';
import type { Guild } from 'discord.js';
import { detectManagedTier } from '../domain/vetting-inventory.js';
import { SYSTEM_DATA_RANGE } from './bootstrap.js';
import { VETTING_TIERS } from './config.js';
import type { VettingConfig, VettingTier } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

export interface ReconciliationInput {
  /** SYSTEM.Active for this row. */
  active: boolean;
  /** SYSTEM.Final Decision (a formula-computed value pulled from VETTING!N by Phase 5), unparsed. */
  finalDecisionRaw: string;
  /** The single tier role the member currently, actually holds in Discord -- null if none. */
  observedTier: VettingTier | null;
  /** True when the member currently, actually holds 2+ configured tier roles at once. */
  liveConflict: boolean;
}

export type ReconciliationAction =
  | { type: 'skip' }
  | { type: 'blank-decision' }
  | { type: 'conflict' }
  | { type: 'invalid-decision'; raw: string }
  | { type: 'in-sync'; tier: VettingTier }
  | { type: 'mutate'; removeTier: VettingTier | null; addTier: VettingTier };

/**
 * Decides what, if anything, one player's row calls for -- never touches
 * Discord or Sheets itself, so every branch below is directly testable
 * against the issue's own acceptance criteria without live credentials.
 */
export function planReconciliation(input: ReconciliationInput): ReconciliationAction {
  // Inactive/departed players are not mutated as though they were present --
  // their last Final Decision stays intact in SYSTEM (Phase 5's lookup
  // formula), but Phase 6 never acts on it. Reconciling a departure's roles
  // is meaningless (they're gone) and not this module's job either way.
  if (!input.active) return { type: 'skip' };

  // A member holding 2+ managed tier roles right now is a conflict, full
  // stop -- "resolved only according to explicit reconciliation policy,
  // never by arbitrary role ordering" means never guessing which one to
  // keep. Checked before the desired-state comparison so a conflict is
  // never silently overwritten by whatever Final Decision happens to say.
  if (input.liveConflict) return { type: 'conflict' };

  const raw = input.finalDecisionRaw.trim();
  // Blank Final Decision means "do not change managed tier role based on
  // vetting yet" -- explicitly not an error, and not evidence of anything.
  if (raw === '') return { type: 'blank-decision' };

  const desired = Number(raw);
  if (!Number.isInteger(desired) || !(VETTING_TIERS as readonly number[]).includes(desired)) {
    return { type: 'invalid-decision', raw };
  }
  const desiredTier = desired as VettingTier;

  if (desiredTier === input.observedTier) return { type: 'in-sync', tier: desiredTier };

  return { type: 'mutate', removeTier: input.observedTier, addTier: desiredTier };
}

/**
 * Distinguishes a Discord API failure's actual cause (a numeric
 * `RESTJSONErrorCodes` value like "missing permissions" or "unknown role")
 * from a generic JS error -- issue #54 Phase 8's own "a missing configured
 * Discord role is distinguishable from a Google API failure" criterion.
 * Every error this can see already came from `member.roles.add/remove`
 * exclusively (the only calls inside this module's try/catch), so there is
 * no Sheets-side ambiguity to resolve here -- a Sheets failure instead
 * propagates out of `reconcileGuild` entirely (its `getValues` call is
 * outside any per-player try/catch), surfacing distinctly at the worker's
 * own poll-tick log line instead.
 */
function describeDiscordError(error: unknown): string {
  if (error instanceof DiscordAPIError) return `Discord API error ${error.code} (${error.message})`;
  return error instanceof Error ? error.message : String(error);
}

export interface ReconciliationSummary {
  /** Active rows with a valid Final Decision this pass actually looked at (skip/blank-decision excluded). */
  processed: number;
  mutated: number;
  conflicts: number;
  invalidDecisions: number;
  /** A mutation was attempted and the Discord API call itself failed. */
  errors: number;
}

/**
 * Serializes calls sharing the same guild ID so a slow-to-finish pass (a
 * tick still awaiting Sheets/Discord I/O) can never overlap with a second
 * pass over the same guild -- see this module's own doc comment for why
 * that matters now that reconciliation mutates Discord. Same in-process
 * queue pattern as `sync.ts`'s `serializeByDiscordId`: entries are removed
 * once idle, so this never grows unbounded, and a single Lucid instance per
 * bot token (docs/setup.md's "Never run two instances") is what makes an
 * in-process queue sufficient rather than needing a distributed lock.
 */
const reconciliationTails = new Map<string, Promise<unknown>>();

function serializeByGuildId<T>(guildId: string, task: () => Promise<T>): Promise<T> {
  const previousTail = reconciliationTails.get(guildId) ?? Promise.resolve();
  const settled = previousTail.then(task, task);
  const tail = settled.catch(() => undefined);
  reconciliationTails.set(guildId, tail);
  tail.finally(() => {
    if (reconciliationTails.get(guildId) === tail) reconciliationTails.delete(guildId);
  });
  return settled;
}

/**
 * One full pass over every SYSTEM row for `guild`. Isolates one player's
 * failure from the rest of the pass (a single bad Discord API call must not
 * stop reconciling everyone else), and writes every row's outcome in a
 * single `batchUpdateValues` call so a guild with hundreds of players costs
 * one Sheets API request per poll regardless of how many rows changed.
 */
export function reconcileGuild(
  guild: Guild,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<ReconciliationSummary> {
  return serializeByGuildId(guild.id, () => reconcileGuildOnce(guild, sheetsClient, config));
}

async function reconcileGuildOnce(
  guild: Guild,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<ReconciliationSummary> {
  const rows = await sheetsClient.getValues(config.systemSheetName, SYSTEM_DATA_RANGE);

  const summary: ReconciliationSummary = { processed: 0, mutated: 0, conflicts: 0, invalidDecisions: 0, errors: 0 };
  const updates: { sheetName: string; cellRange: string; values: string[][] }[] = [];
  const now = new Date().toISOString();

  for (const [index, row] of rows.entries()) {
    const discordId = row[0];
    if (!discordId) continue;
    // +2: this read starts at row 2 and `index` is 0-based -- see
    // bootstrap.ts's own note on why that's safe despite row 2 actually
    // holding SYSTEM's column headers rather than a player.
    const rowNumber = index + 2;

    // Resolved from the gateway's own live member cache, never a fresh
    // fetch -- see this module's doc comment for why that's both correct
    // (Discord's own current truth) and free (already resident in memory).
    // Unresolvable here means "not currently a cached member of this
    // guild" -- treated the same as inactive: Phase 3's own departure sync
    // (or Phase 7's drift repair) is what corrects SYSTEM.Active for a
    // member Lucid can no longer see, not this reconciler.
    const member = guild.members.cache.get(discordId);
    const detection = member
      ? detectManagedTier(member.roles.cache.map((role) => role.id), config.tierRoleIds)
      : { tier: null, conflict: false };

    const action = planReconciliation({
      active: row[3] === 'TRUE' && member !== undefined,
      finalDecisionRaw: row[8] ?? '',
      observedTier: detection.tier,
      liveConflict: detection.conflict,
    });

    if (action.type === 'skip' || action.type === 'blank-decision') continue;
    summary.processed++;

    if (action.type === 'conflict') {
      summary.conflicts++;
      updates.push({ sheetName: config.systemSheetName, cellRange: `K${rowNumber}:L${rowNumber}`, values: [['Conflict', now]] });
      continue;
    }

    if (action.type === 'invalid-decision') {
      summary.invalidDecisions++;
      console.error(`[vetting-reconcile] ${discordId}'s Final Decision ("${action.raw}") is not a configured tier -- no mutation applied.`);
      updates.push({ sheetName: config.systemSheetName, cellRange: `K${rowNumber}:L${rowNumber}`, values: [['Error', now]] });
      continue;
    }

    if (action.type === 'in-sync') {
      updates.push({
        sheetName: config.systemSheetName,
        cellRange: `J${rowNumber}:L${rowNumber}`,
        values: [[String(action.tier), 'Synced', now]],
      });
      continue;
    }

    // mutate -- remove the old managed tier role (if any) then add the
    // desired one, exactly the order the issue itself describes. Retrying
    // this whole sequence on a later pass after a partial failure is safe:
    // removing a role the member no longer has, or adding one they already
    // do, is a no-op to Discord's own API, never an error.
    try {
      if (action.removeTier !== null) {
        await member!.roles.remove(config.tierRoleIds[action.removeTier], 'Lucid vetting reconciliation');
      }
      await member!.roles.add(config.tierRoleIds[action.addTier], 'Lucid vetting reconciliation');
      summary.mutated++;
      // Audit trail (issue #54 Phase 8: "log role transitions as old managed
      // tier -> new managed tier", "produces a clear audit trail suitable
      // for debugging who/what changed") -- non-sensitive: a Discord ID and
      // two tier numbers, never anything from the service-account key.
      console.log(`[vetting-reconcile] ${discordId}: tier ${action.removeTier ?? 'none'} -> ${action.addTier} applied`);
      updates.push({
        sheetName: config.systemSheetName,
        cellRange: `J${rowNumber}:L${rowNumber}`,
        values: [[String(action.addTier), 'Synced', now]],
      });
    } catch (error) {
      summary.errors++;
      console.error(
        `[vetting-reconcile] failed to apply tier ${action.addTier} to ${discordId}: ${describeDiscordError(error)}`,
      );
      // Last Applied Tier deliberately untouched -- a transient failure must
      // leave this row eligible for retry on the next pass, never falsely
      // advance as if the mutation had succeeded.
      updates.push({ sheetName: config.systemSheetName, cellRange: `K${rowNumber}:L${rowNumber}`, values: [['Error', now]] });
    }
  }

  if (updates.length > 0) await sheetsClient.batchUpdateValues(updates);
  return summary;
}
