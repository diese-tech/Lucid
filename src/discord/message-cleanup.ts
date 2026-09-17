/**
 * Sweeps stale, already-delivered TRANSIENT notification messages (roster
 * reminders, availability alerts, replacement notices -- the one-shot rows
 * `pickup_notifications` tracks) off Discord once they're no longer
 * relevant, so channels don't accumulate clutter from one-off pings nobody
 * will act on any more.
 *
 * Deliberately scoped to exactly that table. The persistent staff card and
 * the public roster/signup posts are edited in place for the life of a
 * pickup by review.ts/signups.ts -- they are never one-shot, never tracked
 * here, and this worker never touches them.
 *
 * Mirrors notifications.ts's own delivery-worker shape: sequential
 * processing with per-item try/catch isolation, and restart-safety left
 * entirely to the database -- `dueForCleanup()` re-derives what's
 * outstanding on every tick rather than this worker ever arming a
 * per-notification timer.
 */

import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import { PickupNotificationRepository } from '../db/repositories/pickup-notifications.js';
import type { PickupNotification } from '../db/repositories/types.js';

/**
 * How long a delivered transient notification's Discord message survives
 * before the sweep deletes it. 24 hours comfortably outlives every reason a
 * player or organizer would still want to see a T-15 reminder, an
 * availability alert, or a replacement notice -- by then the pickup it was
 * about has either started, finished, or moved on -- while still giving
 * plenty of room to look back at a recent one before it's gone.
 */
export const CLEANUP_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Delete one due notification's Discord message, and record that outcome.
 *
 * The row's own `channelId`/`messageId` are all that's needed here -- they
 * are exactly what was actually sent, independent of whatever the pickup
 * they were about has since done. An already-gone message or channel is NOT
 * a failure worth surfacing (the goal state -- "this message is off
 * Discord" -- already holds), so only a CONFIRMED Discord rejection
 * (`DiscordAPIError` coded `UnknownMessage`/`UnknownChannel`, the same
 * `confirmedGone` idiom `resolveRosterMessage` uses in flows/review.ts) is
 * treated as success. Anything else -- a rate limit, a permissions problem,
 * a timeout -- is logged and the row is left exactly as 'sent', so the next
 * tick retries it rather than this worker guessing the delete landed.
 */
async function cleanupNotification(
  client: Client,
  notification: PickupNotification,
  notifications: PickupNotificationRepository,
): Promise<void> {
  if (!notification.messageId) {
    // A 'sent' row should always carry the message it sent -- see
    // PickupNotificationRepository.markSent -- but there is nothing left to
    // delete for one that somehow doesn't, so treat it as already cleaned
    // rather than retrying forever against nothing.
    notifications.markCleaned(notification.id);
    return;
  }

  try {
    const channel = await client.channels.fetch(notification.channelId);
    if (channel && channel.isTextBased() && !channel.isDMBased()) {
      await channel.messages.delete(notification.messageId);
    }
    // A channel that's gone, or isn't a postable text channel any more, has
    // nothing left to delete either -- exactly the goal state.
  } catch (error) {
    const confirmedGone =
      error instanceof DiscordAPIError &&
      (error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownChannel);
    if (!confirmedGone) {
      console.error(
        `[message-cleanup] failed to delete message for notification ${notification.id} (pickup ${notification.pickupId})`,
        error,
      );
      return;
    }
  }

  notifications.markCleaned(notification.id);
}

/**
 * One sweep pass over everything currently due for cleanup.
 *
 * Sequential on purpose, matching processDueNotifications: nothing here
 * strictly requires it (each row's cleanup is independent), but it keeps
 * this worker's shape identical to the one it's modeled on rather than
 * introducing unrelated concurrency.
 */
export async function processMessageCleanup(
  client: Client,
  now = Date.now(),
  retentionMs = CLEANUP_STALE_AFTER_MS,
  limit = 25,
): Promise<void> {
  const notifications = new PickupNotificationRepository();
  for (const notification of notifications.dueForCleanup(now, retentionMs, limit)) {
    try {
      await cleanupNotification(client, notification, notifications);
    } catch (error) {
      // One bad row -- an unexpected throw this function didn't already
      // handle -- must not stop every other due row from being swept,
      // exactly as processDueNotifications isolates one bad notification.
      console.error(`[message-cleanup] failed to clean up notification ${notification.id}`, error);
    }
  }
}

/**
 * The single live sweep loop. Not wired into index.ts here -- that's a
 * separate change, to avoid colliding with other work landing on the ready
 * handler at the same time.
 *
 * Hourly by default: this is purely cosmetic tidiness, not remotely
 * time-sensitive, so there is no reason to poll anywhere near as often as
 * notifications.ts's own 15s delivery loop.
 */
let stopRunningWorker: (() => void) | null = null;

export function startMessageCleanupWorker(
  client: Client,
  { intervalMs = 3_600_000 }: { intervalMs?: number } = {},
): () => void {
  if (stopRunningWorker) return stopRunningWorker;

  const tick = (): void => {
    void processMessageCleanup(client).catch((error) => {
      // A setInterval callback has no caller to propagate to.
      console.error('[message-cleanup] sweep tick failed', error);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  // The gateway connection is what keeps Lucid alive; a pending sweep never
  // should be a reason a shutting-down process stays up.
  timer.unref();

  stopRunningWorker = () => {
    clearInterval(timer);
    stopRunningWorker = null;
  };
  return stopRunningWorker;
}
