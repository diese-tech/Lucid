/**
 * The automatic T+3h finish worker -- issue #37.
 *
 * Publish is not the end of a pickup's lifecycle (see finish.ts's own doc
 * comment), but staff sometimes never come back to click Finish once the
 * game is over. Three hours past the scheduled start with the roster still
 * `published` is Lucid's own signal that the game is almost certainly done,
 * so this worker closes it out on staff's behalf, attributed as `'timeout'`
 * rather than a human actor.
 *
 * Deliberately NO new scheduling/outbox table, unlike notifications.ts's
 * durable one-shot rows: "due" here is a computed property of state the
 * `pickups` table already durably holds -- `published` and `start_at` old
 * enough -- so there is nothing to schedule at publish time and nothing that
 * can be lost to a crash between scheduling and delivery. Every tick simply
 * re-derives what is currently due, exactly like notifications.ts's `due()`
 * re-derivation, just without a dedicated table to query it from --
 * `PickupRepository.publishedPastAutoFinishDeadline` is the read.
 *
 * All race-safety is `finishWithAttribution`'s own atomic CAS, reached via
 * `finishPickup` -- not this worker. `publishedPastAutoFinishDeadline` is a
 * plain read of a moment that has already passed by the time this file's
 * loop sees it; a manual Finish (or a second, overlapping tick) can move a
 * pickup out of `published` in the gap between that read and this worker's
 * own `finishPickup` call, and `finishWithAttribution`'s WHERE clause -- not
 * any check here -- is what actually decides that race. This worker only
 * needs to treat losing it as unremarkable.
 */

import type { Client } from 'discord.js';
import { PickupRepository } from '../db/repositories/pickups.js';
import { finishPickup, FinishRefusedError } from './flows/finish.js';

/** How long past scheduled start a still-published pickup is closed out automatically. */
const DEFAULT_AUTO_FINISH_THRESHOLD_HOURS = 3;

/**
 * One poll pass over every published pickup past its auto-finish deadline.
 *
 * Sequential on purpose, mirroring processDueNotifications: isolates one bad
 * pickup's failure so it cannot stop every other overdue pickup in the same
 * pass from still being closed out, and there is no throughput reason here to
 * risk interleaving (auto-finish is not remotely time-sensitive -- see
 * startAutoFinishWorker's default interval).
 */
export async function processAutoFinishes(
  client: Client,
  now = Date.now(),
  thresholdHours = DEFAULT_AUTO_FINISH_THRESHOLD_HOURS,
  limit = 25,
): Promise<void> {
  const due = new PickupRepository().publishedPastAutoFinishDeadline(now, thresholdHours).slice(0, limit);

  for (const pickup of due) {
    try {
      // No actor -- nobody clicked anything -- and 'timeout' names exactly
      // why this pickup is being closed rather than pretending a human did.
      await finishPickup(client, pickup.id, null, 'timeout');
    } catch (error) {
      if (error instanceof FinishRefusedError) {
        // Expected and harmless: the read above is already stale by the time
        // finishPickup's own atomic claim runs. Either a coordinator finished
        // it manually in between, or a second overlapping tick's claim won
        // first -- either way the pickup is no longer `published`, which is
        // exactly the outcome this worker wants, just not the one that
        // credits this tick with it.
        continue;
      }
      // Anything else -- a genuine failure -- must not stop the rest of this
      // pass from finishing every other pickup that IS due, exactly as one
      // bad notification never stops processDueNotifications from delivering
      // the rest.
      console.error(`[auto-finish] failed to auto-finish pickup ${pickup.id}`, error);
    }
  }
}

/**
 * The single live poll loop, started from index.ts's ready handler.
 *
 * Same singleton-guard shape as startNotificationWorker: a second concurrent
 * loop would be harmless on its own (finishWithAttribution's CAS already
 * makes overlapping ticks safe), but its stop function would be unreachable,
 * so the interval it owns could never be cleared again -- the second call
 * returns the running loop's own stopper instead of arming another one.
 */
let stopRunningWorker: (() => void) | null = null;

export function startAutoFinishWorker(
  client: Client,
  { intervalMs = 60_000 }: { intervalMs?: number } = {},
): () => void {
  if (stopRunningWorker) return stopRunningWorker;

  const tick = (): void => {
    void processAutoFinishes(client).catch((error) => {
      // A setInterval callback has no caller to propagate to.
      console.error('[auto-finish] poll tick failed', error);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  // The gateway connection is what keeps Lucid alive; a pending poll never
  // should be a reason a shutting-down process stays up.
  timer.unref();

  stopRunningWorker = () => {
    clearInterval(timer);
    stopRunningWorker = null;
  };
  return stopRunningWorker;
}
