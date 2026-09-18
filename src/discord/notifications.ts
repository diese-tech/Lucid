/**
 * Delivery of the durable one-shot notifications issue #36 schedules.
 *
 * `pickup_notifications` rows only ever carry ROUTING and identity -- which
 * pickup, which kind, which channel, when. What a message says, and who it
 * pings, is resolved HERE, from live database state, at the moment a worker
 * tick claims the row. A reminder scheduled at publish time therefore
 * reflects a replacement that landed an hour later, and an alert whose seat
 * staff have since resolved reaches delivery as a skip rather than firing a
 * message that is no longer true.
 *
 * Restart-safety is the database's alone: `due()` re-derives what is
 * outstanding on every tick. Nothing here ever arms a per-notification timer,
 * which would not survive the restart this whole substrate exists for.
 *
 * Each kind's specific target -- which slot, which pickup version -- is read
 * back out of the dedupe key rather than from columns only one kind would
 * ever use. The key is already the durable identity of the notification, and
 * every writer of one is a caller in this repository.
 */

import type { Client } from 'discord.js';
import { PickupEventRepository } from '../db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../db/repositories/pickup-notifications.js';
import { PickupRepository } from '../db/repositories/pickups.js';
import { RosterSlotRepository } from '../db/repositories/roster-slots.js';
import type { PickupNotification } from '../db/repositories/types.js';
import { textChannel } from './channels.js';
import { classifyProjectionFailure } from './projection.js';
import {
  renderAvailabilityAlert,
  renderReplacementNotice,
  renderRosterReadyNotice,
  renderRosterReminder,
} from './render.js';

interface NotificationPayload {
  content: string;
  /**
   * Exactly who this message is allowed to ping. Paired with an empty
   * `parse`, never `parse: ['users']` -- a reminder naming ten players must
   * not also ping whoever a jump link or a player's own nickname happens to
   * mention.
   */
  allowedUserIds: string[];
  allowedRoleIds: string[];
}

type NotificationResolution =
  | { status: 'deliver'; payload: NotificationPayload }
  | { status: 'skip'; reason: string };

/**
 * How long past its own `due_at` a T-15 reminder may still fire (codex
 * review finding on PR #50): the message's fixed "starts in 15 minutes"
 * claim is only true near that exact mark, and Discord's own live relative
 * timestamp alongside it would otherwise visibly contradict it -- e.g. a
 * worker down from T-15 to T-5 restarting and sending "15 minutes" next to
 * a timestamp that reads "5 minutes". Generous enough to comfortably cover
 * an ordinary retry of a confirmed rejection a tick or two later, but not
 * the whole remaining window up to kickoff the way the old `pickup.startAt`
 * check alone allowed.
 */
const REMINDER_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * What this notification should say and ping RIGHT NOW, or why sending it is
 * no longer appropriate.
 *
 * Pure read: resolving never mutates anything, so a resolution the caller
 * then loses the claim race for costs nothing. Takes the same `now` the
 * caller is claiming/delivering against, rather than reading the wall clock
 * again here, so "how late is this relative to when it was due" means
 * exactly what the rest of this delivery attempt means by "now".
 */
function resolveNotification(notification: PickupNotification, now: number): NotificationResolution {
  switch (notification.kind) {
    case 'roster_reminder':
      return resolveRosterReminder(notification, now);
    case 'availability_alert':
      return resolveAvailabilityAlert(notification);
    case 'replacement_notice':
      return resolveReplacementNotice(notification);
    case 'roster_ready':
      return resolveRosterReady(notification);
  }
}

/** Key shape: `roster_ready:<pickupId>`. */
function resolveRosterReady(notification: PickupNotification): NotificationResolution {
  const pickup = new PickupRepository().byId(notification.pickupId);
  if (!pickup) return { status: 'skip', reason: 'pickup_gone' };
  // Only meaningful while the draft this notice describes is still the
  // one staff need to look at -- once cancelled, or moved past roster_ready
  // by a publish that beat this notification to delivery, "ready for staff
  // review" would misdirect the creator to a stale claim.
  if (pickup.status !== 'roster_ready') return { status: 'skip', reason: `pickup_${pickup.status}` };

  return {
    status: 'deliver',
    payload: {
      content: renderRosterReadyNotice(pickup),
      allowedUserIds: [pickup.createdBy],
      allowedRoleIds: [],
    },
  };
}

function resolveRosterReminder(notification: PickupNotification, now: number): NotificationResolution {
  const pickup = new PickupRepository().byId(notification.pickupId);
  if (!pickup) return { status: 'skip', reason: 'pickup_gone' };
  if (pickup.status !== 'published') return { status: 'skip', reason: `pickup_${pickup.status}` };
  if (!pickup.rosterMessageId) return { status: 'skip', reason: 'no_roster_message' };

  // "Starts in 15 minutes" is worthless once it doesn't, so a reminder stops
  // resolving as deliverable the moment its pickup begins. That is also what
  // BOUNDS retries: a confirmed rejection goes back to 'pending' and would
  // otherwise be re-attempted on every tick forever against, say, a channel
  // Lucid permanently lost access to. Here it becomes a terminal 'skipped'
  // row instead -- see PickupNotificationRepository.releaseToPending.
  if (pickup.startAt * 1000 <= now) return { status: 'skip', reason: 'too_late' };

  // A SEPARATE, tighter bound on top of the one above: still well before
  // kickoff is not the same as still near the T-15 mark this row's own
  // content claims. A worker outage spanning T-15 must not resurrect a
  // now-inaccurate reminder just because the pickup hasn't started yet.
  if (now - notification.dueAt > REMINDER_STALE_AFTER_MS) return { status: 'skip', reason: 'reminder_stale' };

  const userIds = new RosterSlotRepository().userIds(pickup.id);
  if (userIds.length === 0) return { status: 'skip', reason: 'empty_roster' };

  return {
    status: 'deliver',
    payload: {
      content: renderRosterReminder({ pickup, userIds }),
      allowedUserIds: userIds,
      allowedRoleIds: [],
    },
  };
}

/** Key shape: `availability_alert:<pickupId>:<slotId>`. */
function resolveAvailabilityAlert(notification: PickupNotification): NotificationResolution {
  const pickup = new PickupRepository().byId(notification.pickupId);
  if (!pickup) return { status: 'skip', reason: 'pickup_gone' };
  if (pickup.status !== 'published') return { status: 'skip', reason: `pickup_${pickup.status}` };

  const slotId = Number(notification.dedupeKey.split(':')[2]);
  const slot = new RosterSlotRepository().byId(slotId);
  // Staff resolving the seat -- replacing the player, or the player saying
  // they can play after all -- clears the flag. An alert that fired anyway
  // would send organizers looking for a problem that no longer exists.
  if (!slot || !slot.replacementNeeded) return { status: 'skip', reason: 'resolved_availability' };

  return {
    status: 'deliver',
    payload: {
      content: renderAvailabilityAlert({ pickup, slot }),
      allowedUserIds: [pickup.createdBy],
      allowedRoleIds: pickup.organizerPingRoleId ? [pickup.organizerPingRoleId] : [],
    },
  };
}

/** Key shape: `replacement_notice:<pickupId>:<slotId>:<pickupVersion>`. */
function resolveReplacementNotice(notification: PickupNotification): NotificationResolution {
  const pickup = new PickupRepository().byId(notification.pickupId);
  if (!pickup) return { status: 'skip', reason: 'pickup_gone' };
  if (pickup.status === 'cancelled' || pickup.status === 'finished') {
    return { status: 'skip', reason: `pickup_${pickup.status}` };
  }

  const [, , rawSlotId, rawVersion] = notification.dedupeKey.split(':');
  const slotId = Number(rawSlotId);
  const pickupVersion = Number(rawVersion);

  // The event, not the seat's current occupant, is the source of truth for
  // WHO replaced WHOM: a second replacement of the same seat has its own
  // notice keyed to its own version, and reading the slot instead would make
  // both notices name the latest player twice.
  const event = new PickupEventRepository()
    .forPickup(pickup.id)
    .find(
      (candidate) =>
        candidate.eventType === 'player_replaced' &&
        candidate.pickupVersion === pickupVersion &&
        candidate.payload.slotId === slotId,
    );
  if (!event) return { status: 'skip', reason: 'replacement_event_missing' };

  const { previousUserId, newUserId } = event.payload;
  if (typeof previousUserId !== 'string' || typeof newUserId !== 'string') {
    return { status: 'skip', reason: 'replacement_event_unreadable' };
  }

  const slot = new RosterSlotRepository().byId(slotId);
  if (!slot) return { status: 'skip', reason: 'slot_gone' };

  return {
    status: 'deliver',
    payload: {
      content: renderReplacementNotice({
        incomingUserId: newUserId,
        outgoingUserId: previousUserId,
        slot,
        pickup,
      }),
      // The outgoing player is named but deliberately not pinged -- they are
      // context for the incoming player, not an audience for this message.
      allowedUserIds: [newUserId],
      allowedRoleIds: [],
    },
  };
}

/**
 * Resolve, claim, and attempt one due notification.
 *
 * The claim comes AFTER resolving and immediately BEFORE sending, so a tick
 * that loses the race has mutated nothing, and the frozen payload snapshot
 * records what this process was genuinely about to send rather than what it
 * guessed hours earlier.
 */
export async function deliverNotification(
  client: Client,
  notification: PickupNotification,
  now: number,
): Promise<void> {
  const notifications = new PickupNotificationRepository();

  const resolution = resolveNotification(notification, now);
  if (resolution.status === 'skip') {
    notifications.skip(notification.id, resolution.reason);
    return;
  }

  const { payload } = resolution;
  if (!notifications.claimDue(notification.id, now, JSON.stringify(payload))) return;

  try {
    const channel = await textChannel(client, notification.channelId);
    // A channel Lucid cannot fetch or cannot post in is a CONFIRMED negative:
    // nothing went out, so this is safe to put back on the queue rather than
    // leaving it permanently unknown.
    if (!channel || !channel.isSendable()) {
      notifications.releaseToPending(notification.id, 'channel-not-sendable');
      return;
    }

    const message = await channel.send({
      content: payload.content,
      allowedMentions: { parse: [], users: payload.allowedUserIds, roles: payload.allowedRoleIds },
    });
    notifications.markSent(notification.id, message.id);
  } catch (error) {
    const { status, note } = classifyProjectionFailure(error);
    if (status === 'uncertain') {
      console.error(
        `[notifications] uncertain outcome sending '${notification.kind}' for pickup ${notification.pickupId}`,
        error,
      );
      notifications.markUncertain(notification.id, note);
      return;
    }
    notifications.releaseToPending(notification.id, note);
  }
}

/**
 * One poll pass over everything currently due.
 *
 * Sequential on purpose: two notifications for the same pickup (a
 * replacement notice and the roster reminder right behind it) must not
 * interleave their resolve-then-claim windows against the same rows.
 */
export async function processDueNotifications(
  client: Client,
  now = Date.now(),
  limit = 25,
): Promise<void> {
  for (const notification of new PickupNotificationRepository().due(now, limit)) {
    try {
      await deliverNotification(client, notification, now);
    } catch (error) {
      // One bad notification -- a deleted channel, an unexpected render
      // failure -- must not stop every other due notification from going
      // out, exactly as reconcileOnStartup isolates one bad pickup.
      console.error(`[notifications] failed to deliver notification ${notification.id}`, error);
    }
  }
}

/**
 * Surface every terminally-uncertain delivery so a human can decide what to
 * do about it. Never resends: that is the whole point of 'uncertain' -- the
 * message may well have gone out already.
 */
function reportUncertainNotifications(): void {
  for (const notification of new PickupNotificationRepository().allUncertain()) {
    console.error(
      `[notifications] uncertain delivery needs review: id=${notification.id} kind=${notification.kind} ` +
        `pickup=${notification.pickupId} key=${notification.dedupeKey} ` +
        `context=${notification.errorContext ?? '(none)'} payload=${notification.payloadSnapshot ?? '(none)'}`,
    );
  }
}

/**
 * The single live poll loop, started from index.ts's ready handler.
 *
 * A second concurrent loop would be harmless (claimDue's CAS already makes
 * overlapping ticks safe) but its stop function would be unreachable, so the
 * interval it owns could never be cleared again -- the second call returns
 * the running loop's own stopper instead of arming another one.
 */
let stopRunningWorker: (() => void) | null = null;

export function startNotificationWorker(
  client: Client,
  { intervalMs = 15_000 }: { intervalMs?: number } = {},
): () => void {
  if (stopRunningWorker) return stopRunningWorker;

  // Before anything reads `due()`: a row still sitting in 'attempted' cannot
  // be an in-flight send from this process, which has not sent anything yet
  // -- it is a delivery a crash left with no known outcome, and it must be
  // reported rather than silently re-queued.
  new PickupNotificationRepository().reconcileStaleAttempts();
  reportUncertainNotifications();

  const tick = (): void => {
    void processDueNotifications(client).catch((error) => {
      // A setInterval callback has no caller to propagate to.
      console.error('[notifications] poll tick failed', error);
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
