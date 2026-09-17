/**
 * Find-or-repost a canonical Lucid message by its reconciliation marker.
 *
 * Shared by startup recovery (reconcile.ts) and any later, live recovery of
 * a canonical message (review.ts's resyncRosterMessage) -- both need the
 * exact same duplicate-post safety: a crash, or an earlier uncertain
 * outcome, can land after Discord already accepted a send and before Lucid
 * recorded (or kept) its message ID, and blindly resending in that case
 * posts the same roster or control card twice, pinging players a second
 * time in the worst case. Searching first turns that into "find the one
 * that's already there."
 */

import type { Client, GuildTextBasedChannel, Message } from 'discord.js';

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

/**
 * Search channel history for a message carrying `marker`, sent by Lucid
 * itself, before sending a new one -- the whole point of this module.
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
export async function searchHistory(
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
      console.error('[message-recovery] could not search channel history', error);
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

  console.error(`[message-recovery] gave up searching for marker "${marker}" after ${MAX_SEARCH_PAGES} pages`);
  return 'inconclusive';
}

/**
 * Find the already-sent canonical message by its marker, or repost it only
 * once the search comes back definitively empty.
 */
export async function findOrRepost(
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
    console.error('[message-recovery] repost failed', error);
    return null;
  }
}
