/**
 * Periodic full reconciliation / drift repair (issue #54, Phase 7) -- the
 * safety net underneath Phases 2/3/6's event-driven and fast-polled sync:
 * "Discord events and sheet polling improve responsiveness, but the system
 * must not depend on having received every event." If Lucid is offline
 * while a member joins, leaves, or a Final Decision changes, nothing here
 * requires a missed event to ever be replayed -- this pass re-derives
 * correct state from scratch on whatever cadence `driftRepairIntervalSeconds`
 * runs at, entirely independent of what (if anything) was missed.
 *
 * Composes three already-existing, already-idempotent operations rather
 * than re-implementing any of them -- each already carries its own tests
 * for the specific drift it repairs:
 *
 *   1. `bootstrapGuildInventory` (Phase 2) -- re-run against every CURRENT
 *      guild member. Its own find-or-create-by-Discord-ID logic already
 *      covers: a member Lucid never recorded (no SYSTEM row exists yet), a
 *      historical player rejoining (bootstrap always forces `Active=TRUE`
 *      regardless of a row's prior stored value), and username/display
 *      name/Current Roles/Current Tier Role drift for anyone currently
 *      present -- exactly the repairs the issue lists that only apply to
 *      members Discord still confirms are in the guild.
 *   2. `repairDriftedDepartures` (this module, genuinely new) -- the one
 *      direction bootstrap's own member-driven loop structurally can't
 *      cover: a SYSTEM row still marked `Active=TRUE` for a Discord ID no
 *      longer in the guild's live member cache at all (a missed
 *      `GuildMemberRemove` during downtime). Reuses `syncMemberDeparture`
 *      (Phase 3) per drifted ID rather than re-deriving its write shape, so
 *      "what does marking someone departed mean" stays defined in exactly
 *      one place, and its own per-ID mutex naturally serializes against a
 *      concurrent live departure event for the same member.
 *   3. `reconcileGuild` (Phase 6) -- re-run to catch Final Decision drift
 *      (a decision that changed while Lucid was offline) and to verify/
 *      repair Last Applied Tier against actually-observed Discord state.
 *
 * Every step is independently safe to re-run against already-correct
 * state (no duplicate rows, no unnecessary Discord mutations -- each
 * step's own tests already cover that), so running all three back-to-back
 * on a schedule is exactly as safe as running any one of them once.
 */

import type { Guild } from 'discord.js';
import { bootstrapGuildInventory } from './bootstrap.js';
import type { BootstrapSummary } from './bootstrap.js';
import { SYSTEM_DATA_RANGE } from './bootstrap.js';
import type { VettingConfig } from './config.js';
import { reconcileGuild } from './reconcile.js';
import type { ReconciliationSummary } from './reconcile.js';
import type { VettingSheetsClient } from './sheets-client.js';
import { syncMemberDeparture } from './sync.js';

export interface DriftedDeparturesSummary {
  /** SYSTEM rows found Active=TRUE for a Discord ID no longer in the guild's live member cache, successfully repaired. */
  repaired: number;
  /** A repair was attempted and the write itself failed -- left drifted, eligible for the next pass. */
  errors: number;
}

/**
 * The one drift direction `bootstrapGuildInventory` structurally can't
 * repair -- it only ever loops CURRENT Discord members, so a member who
 * left while Lucid was offline (no `GuildMemberRemove` ever fired) is
 * invisible to that loop even though their stale `Active=TRUE` SYSTEM row
 * needs fixing.
 */
export async function repairDriftedDepartures(
  guild: Guild,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<DriftedDeparturesSummary> {
  const rows = await sheetsClient.getValues(config.systemSheetName, SYSTEM_DATA_RANGE);

  const driftedIds = rows
    .filter((row) => row[0] && row[3] === 'TRUE' && !guild.members.cache.has(row[0]!))
    .map((row) => row[0]!);

  let repaired = 0;
  let errors = 0;
  for (const discordId of driftedIds) {
    try {
      // Never a bot -- bootstrap/sync never record one in SYSTEM to begin with.
      await syncMemberDeparture(discordId, false, sheetsClient, config);
      repaired++;
    } catch (error) {
      // Isolated per player -- one bad write must not stop the rest of this
      // pass, or the outer full-repair pass, from finishing. Left drifted,
      // so the next scheduled pass retries it.
      errors++;
      console.error(`[vetting-drift-repair] failed to repair drifted departure for ${discordId}:`, error);
    }
  }

  return { repaired, errors };
}

export interface DriftRepairSummary {
  bootstrap: BootstrapSummary;
  departures: DriftedDeparturesSummary;
  reconciliation: ReconciliationSummary;
}

/** One full drift-repair pass -- see this module's own doc comment for what each step covers and why. */
export async function repairGuildDrift(
  guild: Guild,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<DriftRepairSummary> {
  const bootstrap = await bootstrapGuildInventory(guild, sheetsClient, config);
  const departures = await repairDriftedDepartures(guild, sheetsClient, config);
  const reconciliation = await reconcileGuild(guild, sheetsClient, config);

  return { bootstrap, departures, reconciliation };
}
