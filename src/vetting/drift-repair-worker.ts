/**
 * The periodic full drift-repair poll loop (issue #54, Phase 7) -- same
 * shape as reconcile-worker.ts's Phase 6 loop, just at its own, slower
 * `driftRepairIntervalSeconds` cadence (see config.ts's own doc comment on
 * why these are deliberately separate).
 */

import type { Client } from 'discord.js';
import type { VettingConfig } from './config.js';
import { repairGuildDrift } from './drift-repair.js';
import type { VettingSheetsClient } from './sheets-client.js';

let stopRunningWorker: (() => void) | null = null;

export function startDriftRepairWorker(
  client: Client,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): () => void {
  if (stopRunningWorker) return stopRunningWorker;

  const tick = (): void => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild) return;
      try {
        const summary = await repairGuildDrift(guild, sheetsClient, config);
        // Quiet on an ordinary "nothing drifted" pass -- logged only when
        // this pass actually found something worth knowing about (issue #54
        // Phase 8's own "clear audit trail suitable for debugging who/what
        // changed"). Deliberately excludes bootstrap.updated from that
        // check: bootstrapGuildInventory unconditionally rewrites every
        // existing active member's row on every call rather than diffing
        // first, so it's >0 on essentially every pass regardless of whether
        // anything actually changed -- a routine refresh, not a repair.
        const { bootstrap, departures } = summary;
        if (bootstrap.created > 0 || bootstrap.conflicts.length > 0 || departures.repaired > 0 || departures.errors > 0) {
          console.log(
            `[vetting-drift-repair] pass complete: ${bootstrap.created} created, ${bootstrap.updated} updated, ${bootstrap.conflicts.length} conflicts, ${departures.repaired} departures repaired, ${departures.errors} departure-repair errors`,
          );
        }
      } catch (error) {
        console.error('[vetting-drift-repair] poll tick failed (Sheets/Discord read failure):', error);
      }
    })();
  };

  tick();
  const timer = setInterval(tick, config.driftRepairIntervalSeconds * 1000);
  timer.unref();

  stopRunningWorker = () => {
    clearInterval(timer);
    stopRunningWorker = null;
  };
  return stopRunningWorker;
}
