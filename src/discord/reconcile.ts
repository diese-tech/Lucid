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

import type { Client, GuildTextBasedChannel, Message } from 'discord.js';
import { GuildConfigRepository } from '../db/repositories/guild-config.js';
import { PickupRepository } from '../db/repositories/pickups.js';
import { RosterSlotRepository } from '../db/repositories/roster-slots.js';
import type { GuildConfig, Pickup } from '../db/repositories/types.js';
import { controlCardRows, publishedRosterRows } from './components.js';
import { textChannel, writeCancelledMessages } from './flows/cancel.js';
import { refreshControlCard, refreshReviewCard } from './flows/review.js';
import { reconciliationMarker, renderControlCard, renderPublicRoster } from './render.js';

/** How far back to look for pickups that might need recovering. */
const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many recent channel messages to search for an existing marker before
 * concluding a message was genuinely never sent. Recovery only ever runs for
 * something touched within RECONCILE_WINDOW_MS, so the message being
 * searched for -- if it exists at all -- is always near the top of history.
 */
const SEARCH_LIMIT = 50;

export async function reconcileOnStartup(client: Client): Promise<void> {
  const cutoff = Date.now() - RECONCILE_WINDOW_MS;
  const pickups = new PickupRepository().updatedSince(cutoff);

  for (const pickup of pickups) {
    try {
      await reconcilePickup(client, pickup);
    } catch (error) {
      // One bad pickup -- a deleted channel, a permissions change, anything
      // unexpected -- must not stop every other pickup from being checked.
      console.error(`[reconcile] failed to reconcile pickup ${pickup.id}`, error);
    }
  }
}

async function reconcilePickup(client: Client, pickup: Pickup): Promise<void> {
  const config = new GuildConfigRepository().get(pickup.guildId);
  if (!config) return;

  switch (pickup.status) {
    case 'open':
      await ensureReviewMessage(client, pickup, config);
      await refreshControlCard(client, pickup.id);
      return;

    case 'roster_ready':
      await ensureReviewMessage(client, pickup, config);
      await refreshReviewCard(client, pickup.id);
      return;

    case 'published':
      await ensureReviewMessage(client, pickup, config);
      await ensureRosterMessage(client, pickup, config);
      await refreshReviewCard(client, pickup.id);
      return;

    case 'cancelled':
      // Both edits below are pure functions of `pickup` alone, so repeating
      // them costs nothing on the (common) case where they already landed.
      await writeCancelledMessages(client, pickup);
      return;
  }
}

/**
 * Recover a pickup's staff card if `postControlCard` (create.ts) claimed the
 * pickup row but never recorded having posted it.
 *
 * The reposted content is only ever a placeholder -- every caller above
 * immediately follows this with refreshControlCard or refreshReviewCard,
 * which redraws it into whatever the pickup's CURRENT status actually calls
 * for. This just needs to guarantee a message exists to redraw.
 */
async function ensureReviewMessage(client: Client, pickup: Pickup, config: GuildConfig): Promise<void> {
  if (pickup.reviewMessageId || !config.reviewChannelId) return;

  const channel = await textChannel(client, config.reviewChannelId);
  if (!channel) return;

  const message = await findOrRepost(channel, reconciliationMarker('control', pickup.id), () =>
    channel.send({
      content: renderControlCard(pickup, 0),
      components: controlCardRows(pickup.id),
      allowedMentions: { parse: [] },
    }),
  );
  if (!message) return;
  new PickupRepository().setMessageIds(pickup.id, { reviewMessageId: message.id });
}

/** Recover a published pickup's public roster post if it was never recorded. */
async function ensureRosterMessage(client: Client, pickup: Pickup, config: GuildConfig): Promise<void> {
  if (pickup.rosterMessageId || !config.rosterChannelId) return;

  const channel = await textChannel(client, config.rosterChannelId);
  if (!channel) return;

  const slots = new RosterSlotRepository().forPickup(pickup.id);
  const message = await findOrRepost(channel, reconciliationMarker('roster', pickup.id), () =>
    channel.send({
      content: renderPublicRoster(pickup, slots),
      components: publishedRosterRows(pickup.id),
      // Only reached when the search below found no existing post, meaning
      // this really is the first time the roster is going out -- the same
      // ping behaviour handlePublishConfirm's own send already uses.
      allowedMentions: { parse: ['users'] },
    }),
  );
  if (!message) return;
  new PickupRepository().setMessageIds(pickup.id, { rosterMessageId: message.id });
}

/**
 * Search recent channel history for a message carrying `marker` before
 * sending a new one -- the whole point of this module. A crash can land
 * after Discord has already accepted a send and before Lucid recorded its
 * message ID; blindly resending in that case posts the same roster or
 * control card twice, pinging players a second time in the worst case.
 * Searching first turns that into "find the one that's already there."
 */
async function findOrRepost(
  channel: GuildTextBasedChannel,
  marker: string,
  repost: () => Promise<Message>,
): Promise<Message | null> {
  try {
    const recent = await channel.messages.fetch({ limit: SEARCH_LIMIT });
    const existing = recent.find((message) => message.content.includes(marker));
    if (existing) return existing;
  } catch (error) {
    // If Lucid can't even read history, sending on top of a message it can
    // no longer see would risk a duplicate it has no way to detect -- bail
    // rather than guess.
    console.error('[reconcile] could not search channel history', error);
    return null;
  }

  try {
    return await repost();
  } catch (error) {
    console.error('[reconcile] repost failed', error);
    return null;
  }
}
