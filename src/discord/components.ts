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

/**
 * A row of jump-to-message navigation buttons (issue #37) -- Discord Link
 * buttons, which carry a URL directly and fire no interaction at all, so
 * navigation needs no router wiring and grants no authority of its own.
 * Callers pass only the links that actually resolve (see render.ts's
 * rosterMessageLink/signupMessageLink/staffCardLink, each of which returns
 * null rather than invent a link to a message Lucid hasn't recorded);
 * `null` here means "nothing to show", not "render an empty row".
 */
export function navigationRow(
  links: readonly { label: string; url: string }[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (links.length === 0) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    links.map(({ label, url }) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url)),
  );
}

export function cancelButton(pickupId: number, disabled = false): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(encodeId(Action.Cancel, pickupId))
    .setLabel('Cancel Pickup')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);
}

/**
 * Controls on the staff card before a roster is complete.
 *
 * Cancel is always present — reachable by button for a pickup that never
 * fills up, rather than only through the slash command. Seat Player joins it
 * once there is at least one eligible unseated signup AND at least one open
 * seat to place them in — offering it with nothing to seat, or nothing open
 * to seat into, would be a dead click.
 */
export function controlCardRows(
  pickupId: number,
  options: { disabled?: boolean; seatPlayerEnabled?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = options.disabled ?? false;
  const buttons = [cancelButton(pickupId, disabled)];
  if (options.seatPlayerEnabled) {
    buttons.unshift(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.SeatPlayer, pickupId))
        .setLabel('Seat Player')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    );
  }
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
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
 * Staff card controls once a roster has published and every seat is healthy
 * (issue #37) -- just Finish, plus whatever navigation links resolve. Swap
 * only makes sense once a seat actually needs rebalancing (see
 * expandedPublishedCardRows), so it has no place on the compact card.
 */
export function compactPublishedCardRows(
  pickupId: number,
  navLinks: readonly { label: string; url: string }[],
  options: { disabled?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = options.disabled ?? false;
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Finish, pickupId))
        .setLabel('Finish')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    ),
  ];
  const nav = navigationRow(navLinks);
  if (nav) rows.push(nav);
  return rows;
}

/**
 * Staff card controls while one or more published seats need a replacement
 * (issue #37) -- Swap lets staff rebalance already-seated players into the
 * flagged seat(s) without leaving this card; Finish stays available since a
 * pickup can still be closed out with an unresolved flag. Replace Player
 * itself is not duplicated here -- it already lives on the public roster
 * message (see publishedRosterRows) and stays there, unchanged.
 */
export function expandedPublishedCardRows(
  pickupId: number,
  navLinks: readonly { label: string; url: string }[],
  options: { disabled?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = options.disabled ?? false;
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.PublishedSwap, pickupId))
        .setLabel('Swap')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Finish, pickupId))
        .setLabel('Finish')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    ),
  ];
  const nav = navigationRow(navLinks);
  if (nav) rows.push(nav);
  return rows;
}

/**
 * Staff card once a pickup is finished (issue #37) -- a closed-out record has
 * no mutation controls left at all, only navigation.
 */
export function finishedCardRows(
  navLinks: readonly { label: string; url: string }[],
): ActionRowBuilder<ButtonBuilder>[] {
  const nav = navigationRow(navLinks);
  return nav ? [nav] : [];
}

/**
 * Controls on a published roster: Replace Player for emergency subs, Finish
 * to close the pickup out once it's actually happened (see flows/finish.ts),
 * and Can't Play for the seated players themselves (see flows/availability.ts).
 * They all grey out together once finished -- a greyed-out control reads as
 * "already done", a vanished one reads as a bug (same principle cancel.ts's
 * controlCardRows follows).
 *
 * Can't Play is the one control here that is not staff-only. It sits on the
 * same public message regardless, so it is offered to everyone who can see the
 * roster and refuses anyone not currently seated on it — who may click it is
 * decided in the handler, never by which buttons happen to be rendered.
 */
export function publishedRosterRows(
  pickupId: number,
  options: { disabled?: boolean; navLinks?: readonly { label: string; url: string }[] } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = options.disabled ?? false;
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Replace, pickupId))
        .setLabel('Replace Player')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Unavailable, pickupId))
        .setLabel("Can't Play")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.Finish, pickupId))
        .setLabel('Finish')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    ),
  ];
  // [View Signup]/[Manage Pickup] navigation (issue #37) -- omitted entirely
  // when nothing resolves, same as every other navLinks caller.
  const nav = navigationRow(options.navLinks ?? []);
  if (nav) rows.push(nav);
  return rows;
}
