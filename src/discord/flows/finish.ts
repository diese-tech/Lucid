/**
 * Finishing a published pickup.
 *
 * Publish is not the end of a pickup's lifecycle — Replace Player stays live
 * on the roster indefinitely, ready for the next dropout, right up until
 * someone tells Lucid the game actually happened. Finish is that explicit
 * signal: a second, separate terminal state from Cancel, reachable only from
 * `published`, that closes both public posts and turns off further roster
 * changes. Modeled on Ratatoskr's "Finish scout" -- see the sibling bot's
 * `scoutFinish.ts` -- adapted to Lucid's simpler single-roster-per-pickup
 * shape (no completion table, no division locks).
 *
 * Deliberately manual only, exactly like Cancel: nothing here ever closes a
 * pickup automatically by elapsed time. Staff say when a game is actually
 * over, not a clock.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { Client, MessageComponentInteraction } from 'discord.js';

import { GuildConfigRepository } from '../../db/repositories/guild-config.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import type { GuildConfig, Pickup } from '../../db/repositories/types.js';
import { publishedRosterRows, reviewCardRows } from '../components.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { requireAuthorized } from '../permissions.js';
import { renderPublicRoster, renderReviewCard } from '../render.js';
import { textChannel } from './cancel.js';

/**
 * A refusal staff should be shown verbatim.
 *
 * Mirrors cancel.ts's CancelRefusedError -- finishPickup does the work and
 * reports nothing on success, so the one thing it needs to communicate lives
 * as a thrown error with a ready-to-display message.
 */
export class FinishRefusedError extends Error {}

function authorize(interaction: MessageComponentInteraction): Promise<GuildConfig | null> {
  return requireAuthorized(interaction as unknown as Parameters<typeof requireAuthorized>[0]);
}

function confirmRow(pickupId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeId(Action.FinishConfirm, pickupId, 'yes'))
      .setLabel('Finish Pickup')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeId(Action.FinishConfirm, pickupId, 'no'))
      .setLabel('Keep It Open')
      .setStyle(ButtonStyle.Secondary),
  );
}

const CONFIRM_TEXT =
  'Finish this pickup? Replace Player will no longer be available and both posts will be marked ' +
  'finished. This cannot be undone.';

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

export async function handleFinishComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  // Re-checked on every step, not just the first click -- the published
  // roster this button lives on is visible to the whole server, matching
  // replace.ts's own re-authorization discipline.
  const config = await authorize(interaction);
  if (!config) return;

  switch (decoded.action) {
    case Action.Finish: {
      const pickup = new PickupRepository().byId(decoded.pickupId);
      if (!pickup) {
        await interaction.reply({ content: 'That pickup no longer exists.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (pickup.status === 'finished') {
        await interaction.reply({ content: 'That pickup is already finished.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (pickup.status !== 'published') {
        await interaction.reply({
          content: 'That roster has not been published yet, so there is nothing to finish.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: CONFIRM_TEXT,
        components: [confirmRow(pickup.id)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case Action.FinishConfirm: {
      if (decoded.args[0] !== 'yes') {
        await interaction.update({ content: 'No changes made. The roster stays open.', components: [] });
        return;
      }

      await interaction.deferUpdate();
      try {
        await finishPickup(interaction.client, decoded.pickupId);
      } catch (error) {
        const message =
          error instanceof FinishRefusedError
            ? error.message
            : 'Something went wrong finishing that pickup. Nothing was changed.';
        await interaction.editReply({ content: message, components: [] });
        return;
      }

      await interaction.editReply({
        content: 'Pickup finished. Both posts have been updated.',
        components: [],
      });
      return;
    }

    default:
      return;
  }
}

/* -------------------------------------------------------------------------- */
/* The work                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Close out a published pickup and update both of its public messages.
 *
 * Throws `FinishRefusedError` when the pickup is not in a finishable state.
 */
export async function finishPickup(client: Client, pickupId: number): Promise<void> {
  const pickups = new PickupRepository();
  const pickup = pickups.byId(pickupId);
  if (!pickup) throw new FinishRefusedError('That pickup no longer exists.');

  // Conditional write, so two coordinators confirming at the same instant
  // cannot both go on to rewrite the roster post.
  const moved = pickups.transitionStatus(pickupId, 'published', 'finished');
  if (!moved) {
    const current = pickups.byId(pickupId);
    if (current?.status === 'finished') {
      throw new FinishRefusedError('That pickup is already finished.');
    }
    throw new FinishRefusedError('That roster has not been published yet, so there is nothing to finish.');
  }

  await writeFinishedMessages(client, pickup);
}

/**
 * Write the finished form of both of a pickup's messages.
 *
 * Split out of finishPickup so startup recovery (see reconcile.ts) can
 * re-apply the exact same edits for a pickup the database already committed
 * to `finished` but whose messages might not reflect that yet -- same
 * reasoning as cancel.ts's writeCancelledMessages, which this mirrors
 * closely. Both edits are pure functions of `pickup` (plus its current
 * roster slots) alone, so repeating them costs nothing when they already
 * succeeded.
 */
export async function writeFinishedMessages(client: Client, pickup: Pickup): Promise<void> {
  const config = new GuildConfigRepository().get(pickup.guildId);
  const slots = new RosterSlotRepository().forPickup(pickup.id);

  // The public roster keeps its content -- unlike a cancelled pickup, a
  // finished one genuinely had a roster worth remembering -- but loses its
  // interactive controls and gains the closing note.
  const rosterChannel = await textChannel(client, config?.rosterChannelId ?? null);
  if (rosterChannel && pickup.rosterMessageId) {
    try {
      const message = await rosterChannel.messages.fetch(pickup.rosterMessageId);
      await message.edit({
        content: renderPublicRoster(pickup, slots, { finished: true }),
        components: publishedRosterRows(pickup.id, { disabled: true }),
      });
    } catch {
      // Someone deleted the post. The pickup is still finished, which is the
      // part that matters.
    }
  }

  // The staff card is already read-only once published; this just makes the
  // closed state explicit there too, for whoever scrolls back to it later.
  const reviewChannel = await textChannel(client, config?.reviewChannelId ?? null);
  if (reviewChannel && pickup.reviewMessageId) {
    try {
      const message = await reviewChannel.messages.fetch(pickup.reviewMessageId);
      await message.edit({
        content: renderReviewCard(pickup, slots, { finished: true }),
        components: reviewCardRows(pickup.id, pickup.version, { disabled: true }),
      });
    } catch {
      // Same as above -- nothing to update is not a failure.
    }
  }
}
