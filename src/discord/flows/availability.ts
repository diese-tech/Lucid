/**
 * Player-facing availability — Can't Play.
 *
 * A player seated on a published roster says they can no longer make it. This
 * deliberately does NOT remove them: the seat keeps its occupant and is merely
 * flagged, so the roster still shows who was meant to play while staff resolve
 * it, and the organizer is alerted exactly once. Auto-removing (or worse,
 * auto-replacing) would turn a player's honest heads-up into a hole in the
 * roster that nobody owns, minutes before start — issue #36's central decision.
 *
 * The entry button lives on the PUBLIC roster message, so everyone who can see
 * the pickup can see it. There is no staff authorization here — this is the one
 * flow a non-staff player drives — which makes "does this user currently occupy
 * a seat on THIS pickup" the entire access boundary, re-resolved from the
 * database at every step and never carried across one.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { MessageComponentInteraction } from 'discord.js';

import { getDatabase } from '../../db/index.js';
import { PickupEventRepository } from '../../db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../../db/repositories/pickup-notifications.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import type { Pickup, RosterSlot } from '../../db/repositories/types.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { requireCanonicalEntryMessage } from '../permissions.js';
import { slotLabel } from '../render.js';
import { refreshReviewCard, resyncRosterMessage } from './review.js';

const CONFIRM_TEXT =
  "**Can't make this pickup?**\n" +
  'This will keep you on the roster for now and notify the organizer that your seat needs a replacement.';

const NOT_SEATED_MESSAGE =
  'You are not seated on this roster, so there is no seat to flag. This button is only for players who ' +
  'currently hold a slot.';

const STALE_CONTROL_MESSAGE =
  'This roster has changed since that confirmation was opened. Use **Can\'t Play** on the current roster ' +
  'message and try again.';

/**
 * Load the pickup this flow targets, refusing anything it does not apply to.
 *
 * `published` only: before publication the draft still moves on its own with
 * every signup change and nobody has been told they are playing yet, and once
 * the pickup is finished or cancelled there is no roster left to staff.
 *
 * A click carrying a pickup ID from a DIFFERENT guild is answered exactly as
 * one for a pickup that does not exist — whether some other server is running a
 * pickup is not this one's business to confirm.
 */
function loadPublished(guildId: string | null, pickupId: number): { pickup: Pickup } | { error: string } {
  const pickup = new PickupRepository().byId(pickupId);
  if (!pickup || pickup.guildId !== guildId) return { error: 'That pickup no longer exists.' };
  if (pickup.status === 'cancelled') return { error: 'That pickup was cancelled, so there is no roster to change.' };
  if (pickup.status === 'finished') return { error: 'That pickup has already finished.' };
  if (pickup.status !== 'published') {
    return { error: 'That roster has not been published yet, so there is no seat to give up.' };
  }
  return { pickup };
}

/** The seat this user currently holds on this pickup, if any. */
function seatOf(pickupId: number, userId: string): RosterSlot | null {
  return new RosterSlotRepository().forPickup(pickupId).find((slot) => slot.userId === userId) ?? null;
}

export async function handleAvailabilityComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  switch (decoded.action) {
    case Action.Unavailable:
      await promptForConfirmation(interaction, decoded.pickupId);
      return;

    case Action.UnavailableConfirm: {
      const [slotIdRaw, versionRaw, decision] = decoded.args;
      if (decision !== 'yes') {
        await interaction.update({ content: 'No changes made — you are still on the roster.', components: [] });
        return;
      }
      await commitUnavailable(interaction, decoded.pickupId, Number(slotIdRaw), Number(versionRaw));
      return;
    }

    default:
      return;
  }
}

/** Step 1 — the public entry button; nothing here mutates anything. */
async function promptForConfirmation(
  interaction: MessageComponentInteraction,
  pickupId: number,
): Promise<void> {
  const loaded = loadPublished(interaction.guildId, pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  const { pickup } = loaded;

  // Lives directly on the published public roster -- the confirm step below is
  // an ephemeral continuation of its own and must never be checked this way
  // (issue #35's canonical-message-ID binding; see requireCanonicalEntryMessage's
  // own doc comment). A pickup with no recorded rosterMessageId fails here too,
  // which is the right answer: there is no canonical surface this click could
  // have come from.
  if (!(await requireCanonicalEntryMessage(interaction, pickup.rosterMessageId))) return;

  const seat = seatOf(pickup.id, interaction.user.id);
  if (!seat) {
    await interaction.reply({ content: NOT_SEATED_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  // The version travels in the custom ID so a confirmation left open across
  // someone else's roster change is refused rather than applied to a roster
  // this player never saw -- the same discipline reviewCardRows follows for
  // Publish.
  const confirm = new ButtonBuilder()
    .setCustomId(encodeId(Action.UnavailableConfirm, pickup.id, seat.id, pickup.version, 'yes'))
    .setLabel('Confirm')
    .setStyle(ButtonStyle.Danger);
  const cancel = new ButtonBuilder()
    .setCustomId(encodeId(Action.UnavailableConfirm, pickup.id, seat.id, pickup.version, 'no'))
    .setLabel('Never mind')
    .setStyle(ButtonStyle.Secondary);

  await interaction.reply({
    content: CONFIRM_TEXT,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)],
    flags: MessageFlags.Ephemeral,
  });
}

/** Step 2 — the only step that changes anything anyone else can see. */
async function commitUnavailable(
  interaction: MessageComponentInteraction,
  pickupId: number,
  slotId: number,
  version: number,
): Promise<void> {
  // Acknowledged before the two surface refreshes below, which are real
  // Discord round-trips well capable of outrunning the 3-second interaction
  // deadline. Every response from here on is editReply, matching the deferral
  // -- same discipline as seat.ts's commitSeat.
  await interaction.deferUpdate();

  const loaded = loadPublished(interaction.guildId, pickupId);
  if ('error' in loaded) {
    await interaction.editReply({ content: loaded.error, components: [] });
    return;
  }
  const { pickup } = loaded;

  // Re-resolved from scratch rather than trusted from the step that rendered
  // this button: a click proves only that someone pressed something carrying
  // these numbers, and this confirmation may have sat on screen for a long
  // time. A roster change since then bumped the version, and a replacement
  // specifically also moved this seat's occupant -- either one alone is enough
  // to refuse.
  if (pickup.version !== version) {
    await interaction.editReply({ content: STALE_CONTROL_MESSAGE, components: [] });
    return;
  }

  const seat = new RosterSlotRepository().byId(slotId);
  if (!seat || seat.pickupId !== pickup.id || seat.userId !== interaction.user.id) {
    await interaction.editReply({ content: STALE_CONTROL_MESSAGE, components: [] });
    return;
  }

  // The flag, its audit event and the organizer's alert all commit together or
  // not at all. A flag whose alert was lost sits unnoticed until someone
  // happens to re-read the roster; an alert whose flag was lost sends staff
  // looking for a seat nothing marks. markReplacementNeeded's own CAS is what
  // makes a repeated confirmation a true no-op -- 'already_flagged' skips both
  // writes, so the organizer is never pinged twice for one unresolved seat.
  const outcome = getDatabase().transaction(() => {
    const result = new RosterSlotRepository().markReplacementNeeded(seat.id, interaction.user.id);
    if (result === 'flagged') {
      new PickupEventRepository().record(pickup.id, interaction.user.id, 'player_unavailable', {
        slotId: seat.id,
        team: seat.team,
        role: seat.role,
      });
      // Routed to this pickup's OWN snapshotted staff channel -- never a DM,
      // never whatever channel the click came from, and never another Pickup
      // Space's. Only null for a pickup that predates migration 005 in a guild
      // whose legacy config was never completed (see the Pickup doc comment),
      // which has no staff surface to alert at all; the flag itself still
      // stands, matching replace.ts's own handling of a missing channel.
      if (pickup.reviewChannelId) {
        new PickupNotificationRepository().schedule({
          pickupId: pickup.id,
          kind: 'availability_alert',
          dedupeKey: `availability_alert:${pickup.id}:${seat.id}`,
          channelId: pickup.reviewChannelId,
          dueAt: Date.now(),
        });
      }
    }
    return result;
  })();

  if (outcome === 'occupant_changed') {
    await interaction.editReply({ content: STALE_CONTROL_MESSAGE, components: [] });
    return;
  }

  if (outcome === 'already_flagged') {
    await interaction.editReply({
      content:
        'Your seat is already marked as needing a replacement, so nothing changed. The organizer was not ' +
        'notified a second time — they already know.',
      components: [],
    });
    return;
  }

  // Both surfaces are redrawn so the flagged seat is actually visible: the
  // public roster for everyone, the staff card for whoever has to resolve it.
  //
  // Caught, not propagated: the flag is already committed, and this
  // interaction is already deferred, so an uncaught throw here would both lose
  // the confirmation below and reach the router's catch too late for its own
  // fallback (which only fires when the interaction is neither replied nor
  // deferred). A player who told us they can't play must never be left
  // thinking it didn't register because a message edit failed.
  let refreshFailed = false;
  try {
    await resyncRosterMessage(interaction.client, pickup);
    await refreshReviewCard(interaction.client, pickup.id);
  } catch (error) {
    refreshFailed = true;
    console.error('[availability] refreshing roster surfaces failed after a committed Can\'t Play flag', error);
  }

  const refreshNote = refreshFailed
    ? ' (The roster posts could not be refreshed just now — they will catch up on the next change.)'
    : '';
  await interaction
    .editReply({
      content:
        `Thanks for the heads-up — your seat at ${slotLabel(seat, pickup.format)} is flagged for a replacement ` +
        `and the organizer has been alerted. You stay on the roster until staff sort it out.${refreshNote}`,
      components: [],
    })
    .catch(() => undefined);
}
