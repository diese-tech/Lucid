/**
 * Shared button/select builders.
 *
 * These live in one place because several flows render the same controls — the
 * staff card grows Shuffle/Edit/Publish alongside a Cancel button that was
 * already there, and both the review flow and the cancel flow need to render it
 * consistently.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Action, encodeId } from './ids.js';

export function cancelButton(pickupId: number, disabled = false): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(encodeId(Action.Cancel, pickupId))
    .setLabel('Cancel Pickup')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);
}

/**
 * Controls on the staff card before a roster exists.
 *
 * Only Cancel — this is what makes cancelling reachable by button for a pickup
 * that never fills up, rather than only through the slash command.
 */
export function controlCardRows(
  pickupId: number,
  disabled = false,
): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(cancelButton(pickupId, disabled))];
}

/**
 * Controls once the roster draft exists.
 *
 * Publish carries the roster version it was rendered from, so a click made
 * against a stale card is refused instead of publishing a roster the clicker
 * never actually saw.
 */
export function reviewCardRows(
  pickupId: number,
  version: number,
  options: { disabled?: boolean; publishBlocked?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = options.disabled ?? false;

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Shuffle, pickupId, version))
        .setLabel('Shuffle')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.EditRoster, pickupId, version))
        .setLabel('Edit Roster')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Publish, pickupId, version))
        .setLabel('Publish')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled || (options.publishBlocked ?? false)),
      cancelButton(pickupId, disabled),
    ),
  ];
}

/**
 * Controls on a published roster: Replace Player for emergency subs, Finish
 * to close the pickup out once it's actually happened (see flows/finish.ts).
 * Both grey out together once finished -- a greyed-out control reads as
 * "already done", a vanished one reads as a bug (same principle cancel.ts's
 * controlCardRows follows).
 */
export function publishedRosterRows(
  pickupId: number,
  options: { disabled?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = options.disabled ?? false;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Replace, pickupId))
        .setLabel('Replace Player')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Finish, pickupId))
        .setLabel('Finish')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    ),
  ];
}
