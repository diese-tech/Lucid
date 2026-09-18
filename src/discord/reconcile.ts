/**
 * Startup recovery.
 *
 * A crash or restart landing between committing a database write and the
 * Discord API call that was supposed to confirm it leaves the two out of
 * sync -- a status the database already calls `published` with no public
 * roster message, a control card that still says "Pickup Open" for a pickup
 * the database already moved past. Nothing about Lucid's normal request/
 * response handlers ever revisits that gap once the request that hit it has
 * ended, so without this the pickup sits wrong until a human notices and
 * fixes it by hand.
 *
 * Run once, at startup, from index.ts's ready handler. Bounded to pickups
 * touched recently (see RECONCILE_WINDOW_MS) rather than every pickup a
 * guild has ever run -- the failure this recovers from can only have
 * happened around the bot's last restart, and reprocessing years of settled
 * history on every boot would be pure waste.
 */

import type { Client } from 'discord.js';
import { PickupProjectionRepository } from '../db/repositories/pickup-projections.js';
import { PickupRepository } from '../db/repositories/pickups.js';
import { RosterSlotRepository } from '../db/repositories/roster-slots.js';
import type { Pickup } from '../db/repositories/types.js';
import { generateWorkingRoster } from '../domain/roster.js';
import { textChannel } from './channels.js';
import { controlCardRows, publishedRosterRows } from './components.js';
import { writeCancelledMessages } from './flows/cancel.js';
import { writeFinishedMessages } from './flows/finish.js';
import {
  addSignupPostNavLinks,
  evaluateRosterReady,
  refreshReviewCard,
  resyncRosterMessage,
  sendFirstCompleteNotification,
} from './flows/review.js';
import { findOrRepost } from './message-recovery.js';
import { reconciliationMarker, renderControlCard, renderPublicRoster, rosterNavLinks } from './render.js';

/** How far back to look for pickups that might need recovering. */
const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function reconcileOnStartup(client: Client): Promise<void> {
  const cutoffMs = Date.now() - RECONCILE_WINDOW_MS;
  const repository = new PickupRepository();
  const recent = repository.updatedSince(cutoffMs);

  // Unioned with every still-`open` pickup, however long ago it was last
  // touched -- see PickupRepository.openPickups' own doc comment for why
  // `open` alone needs this. Deduplicated by id since a recently-touched open
  // pickup would otherwise show up in both lists and get reconciled twice.
  const recentIds = new Set(recent.map((pickup) => pickup.id));
  const openOnly = repository.openPickups().filter((pickup) => !recentIds.has(pickup.id));
  for (const pickup of openOnly) recentIds.add(pickup.id);

  // Pickups carrying an unresolved Discord delivery attempt (issue #35) must
  // be retried regardless of age -- resolving/retrying a projection does not
  // itself bump the pickup's own `updated_at`, so a published/cancelled/
  // finished pickup whose only recent activity was a failed delivery attempt
  // could otherwise age out of the window above and never be revisited
  // again (codex review finding on PR #46).
  const unresolvedPickupIds = new Set(
    new PickupProjectionRepository().allUnresolved().map((row) => row.pickupId),
  );
  const stale = [...unresolvedPickupIds]
    .filter((id) => !recentIds.has(id))
    .map((id) => repository.byId(id))
    .filter((pickup): pickup is Pickup => pickup !== null);

  const pickups = [...recent, ...openOnly, ...stale];

  for (const pickup of pickups) {
    try {
      await reconcilePickup(client, pickup, cutoffMs);
    } catch (error) {
      // One bad pickup -- a deleted channel, a permissions change, anything
      // unexpected -- must not stop every other pickup from being checked.
      console.error(`[reconcile] failed to reconcile pickup ${pickup.id}`, error);
    }
  }
}

async function reconcilePickup(client: Client, pickup: Pickup, cutoffMs: number): Promise<void> {
  switch (pickup.status) {
    case 'open':
      // evaluateRosterReady, not refreshControlCard: a crash can land after a
      // Seat Player commit (or any other signup change) completed the
      // working roster but before the completeness check that follows it
      // ever ran, leaving the pickup `open` in the database with a full
      // roster already sitting in roster_slots. refreshControlCard only
      // redraws the pre-roster card and would leave that pickup stuck --
      // never transitioning to roster_ready -- until some future signup
      // change happened to trigger evaluation again. evaluateRosterReady
      // owns the staff card refresh for every outcome (see its own doc
      // comment), including this one, so it's the right recovery call here
      // too (codex review finding on PR #39).
      await ensureReviewMessage(client, pickup, cutoffMs);
      await evaluateRosterReady(client, pickup.id);
      return;

    case 'roster_ready':
      await ensureReviewMessage(client, pickup, cutoffMs);
      await refreshReviewCard(client, pickup.id);
      // Defensive retry: a crash (or a rejected refreshReviewCard) landing
      // between the roster_ready transition and the courtesy DM would
      // otherwise leave ready_notified_at permanently null with nothing left
      // to ever retry it -- claimReadyNotification's own atomic, one-time
      // claim is what makes attempting this on every startup revisit safe
      // (codex review finding on PR #39, round 9).
      await sendFirstCompleteNotification(client, pickup);
      return;

    case 'published':
      await ensureReviewMessage(client, pickup, cutoffMs);
      await ensureRosterMessage(client, pickup, cutoffMs);
      // Re-syncs the roster message's CONTENT against an already-known ID --
      // ensureRosterMessage just above only repairs a missing one. Without
      // this, a Replace Player (or Publish's own initial send) whose edit
      // landed 'uncertain' or was left 'pending' by a confirmed-but-safe-to-
      // retry rejection would never actually be retried by startup recovery
      // (issue #35's delivery-recovery contract) -- the exact gap that
      // motivated `pickup_projection_updates` in the first place.
      await resyncRosterMessage(client, new PickupRepository().byId(pickup.id) ?? pickup);
      await refreshReviewCard(client, pickup.id);
      // Re-read fresh, not `pickup` -- ensureReviewMessage/ensureRosterMessage
      // above may have just recovered a reviewMessageId/rosterMessageId this
      // call started without, and addSignupPostNavLinks needs the CURRENT
      // ones to compute correct links. Idempotent and cheap regardless of
      // whether the buttons were already there (codex/Half-Shell review
      // findings on PR #51: the publish-time edit is best-effort with
      // nothing else to recover it, so reconciliation is what actually
      // guarantees issue #37's signup/roster navigation contract holds after
      // a crash or restart).
      await addSignupPostNavLinks(client, new PickupRepository().byId(pickup.id) ?? pickup);
      return;

    case 'cancelled': {
      // Recover an orphaned control card first (postControlCard can send
      // successfully and still fail to record the ID, exactly like the other
      // statuses) -- otherwise a pickup cancelled before that ID was ever
      // recovered would leave the orphan looking like a live, open pickup
      // forever, since writeCancelledMessages has nothing to edit without an
      // ID. Both edits below are pure functions of the pickup row alone, so
      // repeating them costs nothing on the (common) case where they already
      // landed.
      await ensureReviewMessage(client, pickup, cutoffMs);
      const current = new PickupRepository().byId(pickup.id) ?? pickup;
      await writeCancelledMessages(client, current);
      return;
    }

    case 'finished': {
      // Same reasoning as 'cancelled' just above, plus the roster message --
      // a pickup can reach `finished` with either ID still unrecorded if an
      // earlier crash hit `published` and this one hit `finished` before
      // recovery ever ran for the first.
      await ensureReviewMessage(client, pickup, cutoffMs);
      await ensureRosterMessage(client, pickup, cutoffMs);
      const current = new PickupRepository().byId(pickup.id) ?? pickup;
      await writeFinishedMessages(client, current);
      return;
    }
  }
}

/**
 * Recover a pickup's staff card if `postControlCard` (create.ts) claimed the
 * pickup row but never recorded having posted it.
 *
 * The reposted content is only ever a placeholder -- every caller above
 * immediately follows this with evaluateRosterReady, refreshReviewCard, or
 * writeCancelledMessages, which redraws it into whatever the pickup's
 * CURRENT status actually calls for. This just needs to guarantee a message
 * exists to redraw.
 */
async function ensureReviewMessage(
  client: Client,
  pickup: Pickup,
  cutoffMs: number,
): Promise<void> {
  if (pickup.reviewMessageId || !pickup.reviewChannelId) return;

  const channel = await textChannel(client, pickup.reviewChannelId);
  if (!channel) return;

  // Never later than this pickup's own creation -- the control card, if it
  // exists at all, was posted at creation time (see create.ts's
  // postControlCard). For most pickups that's within cutoffMs anyway, but
  // openPickups() (see PickupRepository) now feeds reconcileOnStartup
  // pickups arbitrarily older than the recovery window -- using the plain
  // window cutoff for one of those would make searchHistory give up and
  // conclude "not found" long before it ever reached the actual message,
  // reposting a genuine duplicate (codex review finding on PR #39, round 11).
  const searchCutoffMs = Math.min(cutoffMs, pickup.createdAt);

  const message = await findOrRepost(
    channel,
    client,
    reconciliationMarker('control', pickup.id),
    searchCutoffMs,
    () =>
      channel.send({
        content: reconciliationMarker('control', pickup.id),
        // No signups exist in this placeholder -- matches create.ts's own
        // postControlCard, and gets redrawn into the real working roster
        // immediately after by refreshControlCard/refreshReviewCard anyway.
        embeds: [renderControlCard(pickup, generateWorkingRoster([], pickup.format), [])],
        components: controlCardRows(pickup.id),
        allowedMentions: { parse: [] },
      }),
  );
  if (!message) return;
  new PickupRepository().setMessageIds(pickup.id, { reviewMessageId: message.id });
}

/** Recover a published pickup's public roster post if it was never recorded. */
async function ensureRosterMessage(
  client: Client,
  pickup: Pickup,
  cutoffMs: number,
): Promise<void> {
  if (pickup.rosterMessageId || !pickup.rosterChannelId) return;

  const channel = await textChannel(client, pickup.rosterChannelId);
  if (!channel) return;

  // Never later than this pickup's own creation, same reasoning as
  // ensureReviewMessage's own comment: openPickups()/the new unresolved-
  // projection sweep above can both feed reconcileOnStartup a pickup far
  // older than the plain recovery window, and the roster can never have
  // been posted before the pickup itself existed.
  const searchCutoffMs = Math.min(cutoffMs, pickup.createdAt);

  const slots = new RosterSlotRepository().forPickup(pickup.id);
  const message = await findOrRepost(
    channel,
    client,
    reconciliationMarker('roster', pickup.id),
    searchCutoffMs,
    () =>
      channel.send({
        content: renderPublicRoster(pickup, slots),
        components: publishedRosterRows(pickup.id, { navLinks: rosterNavLinks(pickup) }),
        // Only reached when the search below found no existing post, meaning
        // this really is the first time the roster is going out -- the same
        // ping behaviour handlePublishConfirm's own send already uses.
        allowedMentions: { parse: ['users'] },
      }),
  );
  if (!message) return;
  new PickupRepository().setMessageIds(pickup.id, { rosterMessageId: message.id });
}
