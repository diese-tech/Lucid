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
import { computeReadiness } from '../domain/readiness.js';
import { controlCardRows, publishedRosterRows } from './components.js';
import { textChannel, writeCancelledMessages } from './flows/cancel.js';
import { refreshControlCard, refreshReviewCard } from './flows/review.js';
import { reconciliationMarker, renderControlCard, renderPublicRoster } from './render.js';

/** How far back to look for pickups that might need recovering. */
const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Search history in pages of this size, backward, until either the marker
 * turns up or a message older than the recovery cutoff is reached.
 */
const SEARCH_PAGE_SIZE = 100;

/**
 * Hard cap on how many pages to search before giving up. A channel this busy
 * between the original send and this restart is unusual, but if it happens
 * we still must not guess -- see searchHistory's own comment.
 */
const MAX_SEARCH_PAGES = 20;

export async function reconcileOnStartup(client: Client): Promise<void> {
  const cutoffMs = Date.now() - RECONCILE_WINDOW_MS;
  const pickups = new PickupRepository().updatedSince(cutoffMs);

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
  const config = new GuildConfigRepository().get(pickup.guildId);
  if (!config) return;

  switch (pickup.status) {
    case 'open':
      await ensureReviewMessage(client, pickup, config, cutoffMs);
      await refreshControlCard(client, pickup.id);
      return;

    case 'roster_ready':
      await ensureReviewMessage(client, pickup, config, cutoffMs);
      await refreshReviewCard(client, pickup.id);
      return;

    case 'published':
      await ensureReviewMessage(client, pickup, config, cutoffMs);
      await ensureRosterMessage(client, pickup, config, cutoffMs);
      await refreshReviewCard(client, pickup.id);
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
      await ensureReviewMessage(client, pickup, config, cutoffMs);
      const current = new PickupRepository().byId(pickup.id) ?? pickup;
      await writeCancelledMessages(client, current);
      return;
    }
  }
}

/**
 * Recover a pickup's staff card if `postControlCard` (create.ts) claimed the
 * pickup row but never recorded having posted it.
 *
 * The reposted content is only ever a placeholder -- every caller above
 * immediately follows this with refreshControlCard, refreshReviewCard, or
 * writeCancelledMessages, which redraws it into whatever the pickup's
 * CURRENT status actually calls for. This just needs to guarantee a message
 * exists to redraw.
 */
async function ensureReviewMessage(
  client: Client,
  pickup: Pickup,
  config: GuildConfig,
  cutoffMs: number,
): Promise<void> {
  if (pickup.reviewMessageId || !config.reviewChannelId) return;

  const channel = await textChannel(client, config.reviewChannelId);
  if (!channel) return;

  const message = await findOrRepost(
    channel,
    client,
    reconciliationMarker('control', pickup.id),
    cutoffMs,
    () =>
      channel.send({
        // No signups exist in this placeholder -- matches create.ts's own
        // postControlCard, and gets redrawn into real telemetry immediately
        // after by refreshControlCard/refreshReviewCard anyway.
        content: renderControlCard(pickup, computeReadiness([], pickup.format)),
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
  config: GuildConfig,
  cutoffMs: number,
): Promise<void> {
  if (pickup.rosterMessageId || !config.rosterChannelId) return;

  const channel = await textChannel(client, config.rosterChannelId);
  if (!channel) return;

  const slots = new RosterSlotRepository().forPickup(pickup.id);
  const message = await findOrRepost(
    channel,
    client,
    reconciliationMarker('roster', pickup.id),
    cutoffMs,
    () =>
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
 * Search channel history for a message carrying `marker`, sent by Lucid
 * itself, before sending a new one -- the whole point of this module. A
 * crash can land after Discord has already accepted a send and before Lucid
 * recorded its message ID; blindly resending in that case posts the same
 * roster or control card twice, pinging players a second time in the worst
 * case. Searching first turns that into "find the one that's already there."
 */
async function findOrRepost(
  channel: GuildTextBasedChannel,
  client: Client,
  marker: string,
  cutoffMs: number,
  repost: () => Promise<Message>,
): Promise<Message | null> {
  const found = await searchHistory(channel, client, marker, cutoffMs);
  if (found === 'inconclusive') return null;
  if (found) return found;

  try {
    return await repost();
  } catch (error) {
    console.error('[reconcile] repost failed', error);
    return null;
  }
}

/**
 * Page backward through history looking for `marker` on a message this
 * client actually sent, stopping once a page reaches a message older than
 * `cutoffMs` (nothing relevant to this recovery pass could be older than
 * that) or the channel's own start.
 *
 * A single page is not enough: if 100+ unrelated messages have landed in the
 * channel since the original send, an unpaged search would conclude "never
 * sent" and repost a genuine duplicate -- pinging every player a second
 * time. Checking `message.author.id` matters too, independent of paging: a
 * marker is a plain, visible substring (see render.ts's reconciliationMarker
 * doc comment), so anything else that happens to contain it -- another
 * bot, a staff member quoting an old card while troubleshooting -- must not
 * be mistaken for Lucid's own message; recording the wrong ID would make
 * every future edit fail (Lucid does not own that message) while the
 * genuinely-missing one never gets posted at all.
 *
 * Returns 'inconclusive' when the search can't reach a definitive answer
 * (a fetch failed, or the page budget ran out before the cutoff) -- callers
 * must treat that as "do nothing", never as "not found", since reposting on
 * an inconclusive search risks the exact duplicate this module exists to
 * prevent.
 */
async function searchHistory(
  channel: GuildTextBasedChannel,
  client: Client,
  marker: string,
  cutoffMs: number,
): Promise<Message | null | 'inconclusive'> {
  let before: string | undefined;

  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    let batch;
    try {
      batch = await channel.messages.fetch(before ? { limit: SEARCH_PAGE_SIZE, before } : { limit: SEARCH_PAGE_SIZE });
    } catch (error) {
      console.error('[reconcile] could not search channel history', error);
      return 'inconclusive';
    }
    if (batch.size === 0) return null; // reached the start of the channel

    const match = batch.find(
      (message) => message.author?.id === client.user?.id && message.content.includes(marker),
    );
    if (match) return match;

    let oldest = batch.first()!;
    for (const message of batch.values()) {
      if (message.createdTimestamp < oldest.createdTimestamp) oldest = message;
    }
    if (oldest.createdTimestamp <= cutoffMs) return null; // searched back far enough

    before = oldest.id;
  }

  console.error(`[reconcile] gave up searching for marker "${marker}" after ${MAX_SEARCH_PAGES} pages`);
  return 'inconclusive';
}
