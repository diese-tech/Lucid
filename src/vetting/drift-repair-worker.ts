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
        await repairGuildDrift(guild, sheetsClient, config);
      } catch (error) {
        console.error('[vetting-drift-repair] poll tick failed', error);
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
