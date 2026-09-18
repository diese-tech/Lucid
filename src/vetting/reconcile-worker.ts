/**
 * The live poll loop for VETTING -> SYSTEM -> Discord reconciliation (issue
 * #54, Phase 6) -- started from index.ts, alongside the pickup workers,
 * only when vetting is enabled. Same singleton-guard shape as
 * startAutoFinishWorker/startNotificationWorker: this guard is only against
 * leaking a second interval (whose stop function would become
 * unreachable) if this function is called twice -- it is not what makes
 * concurrent `reconcileGuild` passes safe. That guarantee lives in
 * `reconcileGuild` itself, which serializes every call sharing a guild ID
 * (Half-Shell's PR #65 finding: an interval tick still mid-flight on slow
 * Sheets/Discord I/O could otherwise overlap with a later tick, or with
 * Phase 7's drift repair, which also calls `reconcileGuild`).
 *
 * Polls at `config.pollIntervalSeconds` -- issue #54's own suggested
 * default (120s) and configurable range (60-300s), already validated by
 * config.ts at startup.
 */

import type { Client } from 'discord.js';
import type { VettingConfig } from './config.js';
import { reconcileGuild } from './reconcile.js';
import type { VettingSheetsClient } from './sheets-client.js';

let stopRunningWorker: (() => void) | null = null;

export function startReconciliationWorker(
  client: Client,
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): () => void {
  if (stopRunningWorker) return stopRunningWorker;

  const tick = (): void => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      // Not yet resolvable (e.g. right after login, before GUILD_CREATE has
      // arrived for this guild) -- next tick will find it. Never a reason to
      // stop the loop.
      if (!guild) return;
      try {
        const summary = await reconcileGuild(guild, sheetsClient, config);
        // Quiet on an ordinary "nothing changed" tick -- logged only when
        // this pass actually did something, so the audit trail (issue #54
        // Phase 8) stays readable instead of one line every poll interval
        // forever.
        if (summary.mutated + summary.conflicts + summary.invalidDecisions + summary.errors > 0) {
          console.log(
            `[vetting-reconcile] pass complete: ${summary.mutated} applied, ${summary.conflicts} conflicts, ${summary.invalidDecisions} invalid decisions, ${summary.errors} errors`,
          );
        }
      } catch (error) {
        // A whole-pass Sheets failure -- distinct from a per-player Discord
        // mutation failure, which reconcileGuild already isolates and logs
        // individually without aborting the whole pass. Deliberately not
        // labeled "read failure": reconcileGuild's uncaught throw can come
        // from either its initial getValues() read or its final
        // batchUpdateValues() write (Half-Shell's PR #67 finding -- a role
        // change can succeed and the write recording it can still fail,
        // which a "read failure" label would misreport).
        console.error('[vetting-reconcile] poll tick failed (Sheets operation failure):', error);
      }
    })();
  };

  tick();
  const timer = setInterval(tick, config.pollIntervalSeconds * 1000);
  // The gateway connection is what keeps Lucid alive; a pending poll never
  // should be a reason a shutting-down process stays up.
  timer.unref();

  stopRunningWorker = () => {
    clearInterval(timer);
    stopRunningWorker = null;
  };
  return stopRunningWorker;
}
