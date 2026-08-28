/**
 * Cancelling a pickup.
 *
 * Cancelling is destructive in the only sense that matters here: it rewrites a
 * message players have already reacted to, and it closes signups for good. So
 * the flow is built around one rule — there is ALWAYS exactly one confirmation
 * step, no matter how the coordinator got here.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import type {
  ChatInputCommandInteraction,
  Client,
  GuildTextBasedChannel,
  MessageComponentInteraction,
} from 'discord.js';

import { GuildConfigRepository } from '../../db/repositories/guild-config.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import type { GuildConfig, Pickup } from '../../db/repositories/types.js';
import type { PickupFormat } from '../../domain/roles.js';
import { shortLabel } from '../../domain/time.js';
import { controlCardRows } from '../components.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { requireAuthorized } from '../permissions.js';
import { renderCancelledCard, renderSignupPost } from '../render.js';

const MAX_SELECT_OPTIONS = 25;

const FORMAT_LABELS: Record<PickupFormat, string> = {
  pickup_vs_pickup: 'Pickup vs Pickup',
  pickup_vs_premade: 'Pickup vs Premade',
};

/**
 * A refusal the coordinator should be shown verbatim.
 *
 * `cancelPickup` does the work and reports nothing on success, so the one thing
 * it does need to communicate — "you cannot cancel this one, and here is why" —
 * travels as a thrown error with a ready-to-display message.
 */
export class CancelRefusedError extends Error {}

/**
 * Guard wrapper.
 *
 * `requireAuthorized` is typed against discord.js's `Interaction` union, which
 * lists the concrete button/select classes rather than the shared
 * `MessageComponentInteraction` base they all extend. Every component
 * interaction we receive is one of those classes at runtime, so this narrowing
 * cast is safe — it only exists to satisfy the union.
 */
function authorize(interaction: MessageComponentInteraction): Promise<GuildConfig | null> {
  return requireAuthorized(interaction as unknown as Parameters<typeof requireAuthorized>[0]);
}

function pickupLabel(pickup: Pickup, timezone: string): string {
  return `${FORMAT_LABELS[pickup.format]} — ${shortLabel(pickup.startAt, timezone)}`;
}

async function textChannel(
  client: Client,
  channelId: string | null,
): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
    return channel;
  } catch {
    return null;
  }
}

function confirmRow(pickupId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeId(Action.CancelConfirm, pickupId, 'yes'))
      .setLabel('Cancel Pickup')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeId(Action.CancelConfirm, pickupId, 'no'))
      .setLabel('Keep It')
      .setStyle(ButtonStyle.Secondary),
  );
}

function confirmText(pickup: Pickup, timezone: string): string {
  return [
    `Cancel **${pickupLabel(pickup, timezone)}**?`,
    '',
    'The public signup post will be struck through and signups will close. This cannot be undone.',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Slash command                                                              */
/* -------------------------------------------------------------------------- */

/** `/pickup cancel` — no arguments; Lucid works out what there is to cancel. */
export async function handleCancelCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = await requireAuthorized(interaction);
  if (!config || !interaction.guildId) return;

  const open = new PickupRepository().cancellable(interaction.guildId);

  if (open.length === 0) {
    await interaction.reply({
      content: 'There are no open pickups to cancel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (open.length === 1) {
    // With only one candidate there is nothing to disambiguate, so the picker
    // would be a menu of one. Skip it and go straight to the confirmation —
    // which is never skipped.
    const pickup = open[0]!;
    await interaction.reply({
      content: confirmText(pickup, config.timezone),
      components: [confirmRow(pickup.id)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    // Several pickups can run at once, so the picker is keyed on the pickup the
    // coordinator chooses here rather than on anything about this message.
    .setCustomId(encodeId(Action.CancelPick, 0))
    .setPlaceholder('Select the pickup to cancel')
    .addOptions(
      open.slice(0, MAX_SELECT_OPTIONS).map((pickup) => ({
        label: pickupLabel(pickup, config.timezone).slice(0, 100),
        value: String(pickup.id),
      })),
    );

  await interaction.reply({
    content: 'Which pickup do you want to cancel?',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

export async function handleCancelComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  const config = await authorize(interaction);
  if (!config) return;

  const pickups = new PickupRepository();

  switch (decoded.action) {
    case Action.Cancel: {
      // The Cancel button on the staff card. That card is a normal channel
      // message, so we answer ephemerally instead of editing it out from under
      // everyone reading it.
      const pickup = pickups.byId(decoded.pickupId);
      if (!pickup) {
        await interaction.reply({ content: 'That pickup no longer exists.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({
        content: confirmText(pickup, config.timezone),
        components: [confirmRow(pickup.id)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case Action.CancelPick: {
      const chosen = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
      const pickup = chosen ? pickups.byId(Number(chosen)) : null;
      if (!pickup) {
        await interaction.update({ content: 'That pickup no longer exists.', components: [] });
        return;
      }
      await interaction.update({
        content: confirmText(pickup, config.timezone),
        components: [confirmRow(pickup.id)],
      });
      return;
    }

    case Action.CancelConfirm: {
      if (decoded.args[0] !== 'yes') {
        await interaction.update({
          content: 'No changes made. The pickup is still open.',
          components: [],
        });
        return;
      }

      await interaction.deferUpdate();
      try {
        await cancelPickup(interaction.client, decoded.pickupId);
      } catch (error) {
        const message =
          error instanceof CancelRefusedError
            ? error.message
            : 'Something went wrong cancelling that pickup. Nothing was changed.';
        await interaction.editReply({ content: message, components: [] });
        return;
      }

      await interaction.editReply({
        content: 'Pickup cancelled. The signup post has been updated.',
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
 * Close a pickup and update both of its messages.
 *
 * Throws `CancelRefusedError` when the pickup is not in a cancellable state.
 */
export async function cancelPickup(client: Client, pickupId: number): Promise<void> {
  const pickups = new PickupRepository();
  const pickup = pickups.byId(pickupId);
  if (!pickup) throw new CancelRefusedError('That pickup no longer exists.');

  // Conditional write, so two coordinators confirming at the same instant
  // cannot both go on to rewrite the signup post.
  const moved = pickups.transitionStatusFromAny(pickupId, ['open', 'roster_ready'], 'cancelled');
  if (!moved) {
    const current = pickups.byId(pickupId);
    if (current?.status === 'published') {
      // A published roster is already public and people are organising around
      // it. Pulling it out from under them is not what "cancel" should do here.
      throw new CancelRefusedError(
        'That roster has already been published, so it can no longer be cancelled. Use **Replace Player** on the published roster to swap someone out.',
      );
    }
    throw new CancelRefusedError('That pickup has already been cancelled.');
  }

  const config = new GuildConfigRepository().get(pickup.guildId);

  // The public signup post becomes the cancelled form: struck-through title and
  // one plain line. Reaction handlers already ignore cancelled pickups, so
  // leftover reactions on it are harmless.
  const signupChannel = await textChannel(client, config?.signupChannelId ?? null);
  if (signupChannel && pickup.signupMessageId) {
    try {
      const message = await signupChannel.messages.fetch(pickup.signupMessageId);
      await message.edit({ content: renderSignupPost({ ...pickup, cancelled: true }) });
    } catch {
      // Someone deleted the post. The pickup is still closed, which is the part
      // that matters.
    }
  }

  // The staff card keeps its buttons, disabled, rather than losing them — a
  // greyed-out control reads as "already done", a vanished one reads as a bug.
  const reviewChannel = await textChannel(client, config?.reviewChannelId ?? null);
  if (reviewChannel && pickup.reviewMessageId) {
    try {
      const message = await reviewChannel.messages.fetch(pickup.reviewMessageId);
      await message.edit({
        content: renderCancelledCard(pickup),
        components: controlCardRows(pickup.id, true),
      });
    } catch {
      // Same as above — nothing to update is not a failure.
    }
  }
}
