/**
 * Manual seating — Seat Player.
 *
 * Before a pickup's working roster is complete, authorized staff can place an
 * eligible, currently-unseated signed-up player into an open seat by hand.
 * This mirrors replace.ts's shape (pick a slot, pick a player, confirm,
 * commit) but draws its player list from the working roster's own
 * `unseatedUserIds` rather than a member search — there is no emergency-
 * substitution case here, only "who's already signed up and waiting."
 *
 * The placed seat is marked staff_assigned, exactly like a post-publish
 * Replace Player or an Edit Roster override: it is pinned exactly as placed
 * and excluded from every later automatic recalculation (see
 * domain/roster.ts's generateWorkingRoster and review.ts's
 * replaceWorkingRoster), and exempt from the withdrawn-signup check even if
 * placed off-role.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { Guild, MessageComponentInteraction } from 'discord.js';

import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import type { Pickup } from '../../db/repositories/types.js';
import { ROLE_LABELS, TEAM_LABELS, isRole, isTeam, type Role, type Team } from '../../domain/roles.js';
import { declaredRoleLabels } from '../render.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { requireAuthorizedForPickup } from '../permissions.js';
import { currentWorkingRoster, evaluateRosterReady } from './review.js';

/** Discord allows at most 25 options in a select menu. */
const MAX_SELECT_OPTIONS = 25;

interface Location {
  team: Team;
  role: Role;
}

/**
 * Guard wrapper.
 *
 * `requireAuthorizedForPickup` is typed against discord.js's `Interaction`
 * union, which lists the concrete button/select classes rather than the
 * shared `MessageComponentInteraction` base they all extend. Every component
 * interaction we receive is one of those classes at runtime, so this narrowing
 * cast is safe — it only exists to satisfy the union.
 */
function authorize(interaction: MessageComponentInteraction, pickup: Pickup): Promise<boolean> {
  return requireAuthorizedForPickup(
    interaction as unknown as Parameters<typeof requireAuthorizedForPickup>[0],
    pickup,
  ).then((space) => space !== null);
}

/**
 * Load the pickup a seat action targets, refusing anything not currently
 * `open` — manual seating only makes sense before the roster is either
 * complete (staff use Edit Roster instead) or gone (cancelled/finished).
 */
function loadOpenPickup(pickupId: number): { pickup: Pickup } | { error: string } {
  const pickup = new PickupRepository().byId(pickupId);
  if (!pickup) return { error: 'That pickup no longer exists.' };
  if (pickup.status !== 'open') {
    return {
      error:
        'That pickup is no longer collecting a working roster — it has already become fully seated, ' +
        'been published, cancelled, or finished.',
    };
  }
  return { pickup };
}

/**
 * A human-readable name for a user, for use in select menu option labels.
 *
 * Select options render plain text, so `<@id>` mentions would show as raw
 * numbers there. Message CONTENT can use mentions and does — this helper is
 * only for the places where it cannot.
 */
async function displayNameFor(guild: Guild | null, userId: string): Promise<string> {
  if (!guild) return userId;
  const cached = guild.members.cache.get(userId);
  if (cached) return cached.displayName;
  try {
    const fetched = await guild.members.fetch(userId);
    return fetched.displayName;
  } catch {
    // Left the server, or we simply cannot see them. The ID is still a usable
    // label — better than failing the whole menu over a cosmetic lookup.
    return userId;
  }
}

function selectedValue(interaction: MessageComponentInteraction): string | undefined {
  return interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
}

function locationValue(location: Location): string {
  return `${location.team}:${location.role}`;
}

function parseLocationValue(value: string | undefined): Location | null {
  if (!value) return null;
  const [team, role] = value.split(':');
  if (!team || !role || !isTeam(team) || !isRole(role)) return null;
  return { team, role };
}

function parseLocationArgs(args: readonly string[]): Location | null {
  const [team, role] = args;
  if (!team || !role || !isTeam(team) || !isRole(role)) return null;
  return { team, role };
}

/* -------------------------------------------------------------------------- */
/* Component steps                                                            */
/* -------------------------------------------------------------------------- */

export async function handleSeatComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  const pickup = new PickupRepository().byId(decoded.pickupId);
  if (!pickup) {
    await interaction.reply({ content: 'That pickup no longer exists.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Re-checked at EVERY step, not just on the first click — same discipline
  // replace.ts follows, and for the same reason: who can see a control is not
  // an access boundary.
  if (!(await authorize(interaction, pickup))) return;

  switch (decoded.action) {
    case Action.SeatPlayer:
      await promptForSlot(interaction, decoded.pickupId);
      return;

    case Action.SeatPickSlot:
      await promptForPlayer(interaction, decoded.pickupId, parseLocationValue(selectedValue(interaction)));
      return;

    case Action.SeatPickPlayer:
      await promptForConfirmation(
        interaction,
        decoded.pickupId,
        parseLocationArgs(decoded.args),
        selectedValue(interaction),
      );
      return;

    case Action.SeatConfirm: {
      const location = parseLocationArgs(decoded.args);
      const [, , userId, decision] = decoded.args;
      if (!location || !userId) {
        await interaction.update({ content: 'That selection is no longer valid.', components: [] });
        return;
      }
      if (decision !== 'yes') {
        await interaction.update({ content: 'No changes made. The roster is unchanged.', components: [] });
        return;
      }
      await commitSeat(interaction, decoded.pickupId, location, userId);
      return;
    }

    default:
      return;
  }
}

/** Step 1 — which open seat is being filled. */
async function promptForSlot(interaction: MessageComponentInteraction, pickupId: number): Promise<void> {
  const loaded = loadOpenPickup(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }

  // Resolving eligibility needs Discord API calls, so take the extra second
  // rather than risking the 3-second interaction deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { working } = await currentWorkingRoster(interaction.client, loaded.pickup);

  if (working.complete) {
    await interaction.editReply({ content: 'This roster is already complete — there is nothing left to seat.' });
    return;
  }
  if (working.unseatedUserIds.length === 0) {
    await interaction.editReply({
      content: 'No eligible signed-up players are waiting to be seated right now.',
    });
    return;
  }

  // Every format has at most 10 locations total, well under Discord's cap —
  // the slice is defensive, not load-bearing.
  const options = working.missingLocations.slice(0, MAX_SELECT_OPTIONS).map((location) => ({
    label: `${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]}`,
    value: locationValue(location),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.SeatPickSlot, pickupId))
    .setPlaceholder('Select the open seat to fill')
    .addOptions(options);

  await interaction.editReply({
    content: 'Which seat are you filling?',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

/** Step 2 — which eligible unseated player goes there. */
async function promptForPlayer(
  interaction: MessageComponentInteraction,
  pickupId: number,
  location: Location | null,
): Promise<void> {
  const loaded = loadOpenPickup(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!location) {
    await interaction.reply({ content: 'That selection is no longer valid.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const { working, eligibleRecords } = await currentWorkingRoster(interaction.client, loaded.pickup);

  // Someone else may have filled this exact seat, or the pool may have
  // emptied out, in the moment since the slot menu was rendered.
  const stillOpen = working.missingLocations.some(
    (loc) => loc.team === location.team && loc.role === location.role,
  );
  if (!stillOpen) {
    await interaction.editReply({
      content: `${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]} was just filled. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }
  if (working.unseatedUserIds.length === 0) {
    await interaction.editReply({
      content: 'No eligible signed-up players are waiting to be seated right now.',
      components: [],
    });
    return;
  }

  const options = [];
  for (const userId of working.unseatedUserIds.slice(0, MAX_SELECT_OPTIONS)) {
    const name = await displayNameFor(interaction.guild, userId);
    const roles = declaredRoleLabels(eligibleRecords, userId);
    options.push({ label: `@${name}${roles ? ` — ${roles}` : ''}`.slice(0, 100), value: userId });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.SeatPickPlayer, pickupId, location.team, location.role))
    .setPlaceholder('Select the player to seat')
    .addOptions(options);

  await interaction.editReply({
    content: `Filling ${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]}. Eligible unseated signups:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

/** Step 3 — always confirm; an off-role placement gets an explicit warning first. */
async function promptForConfirmation(
  interaction: MessageComponentInteraction,
  pickupId: number,
  location: Location | null,
  userId: string | undefined,
): Promise<void> {
  const loaded = loadOpenPickup(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!location || !userId) {
    await interaction.reply({ content: 'That selection is no longer valid.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const { eligibleRecords } = await currentWorkingRoster(interaction.client, loaded.pickup);
  const declared = eligibleRecords.filter((record) => record.userId === userId).map((record) => record.role);
  const onRole = declared.includes(location.role) || declared.includes('fill');

  const name = await displayNameFor(interaction.guild, userId);
  const confirm = new ButtonBuilder()
    .setCustomId(encodeId(Action.SeatConfirm, pickupId, location.team, location.role, userId, 'yes'))
    .setLabel(onRole ? 'Confirm' : 'Seat Anyway')
    .setStyle(onRole ? ButtonStyle.Success : ButtonStyle.Danger);
  const cancel = new ButtonBuilder()
    .setCustomId(encodeId(Action.SeatConfirm, pickupId, location.team, location.role, userId, 'no'))
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  const warning = onRole
    ? ''
    : `\n\n⚠️ @${name} did not sign up for ${ROLE_LABELS[location.role]} (and did not select Fill). ` +
      'This places them there anyway as a staff override.';

  await interaction.editReply({
    content: `Seat @${name} at ${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]}?${warning}`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)],
  });
}

/** Step 4 — the only step that changes anything staff outside this menu can see. */
async function commitSeat(
  interaction: MessageComponentInteraction,
  pickupId: number,
  location: Location,
  userId: string,
): Promise<void> {
  const loaded = loadOpenPickup(pickupId);
  if ('error' in loaded) {
    await interaction.update({ content: loaded.error, components: [] });
    return;
  }
  const { pickup } = loaded;

  // Re-check eligibility fresh — time has passed since confirmation was
  // rendered, and a player who lost their eligibility role or withdrew every
  // reaction in that window must not be seatable anyway.
  const { working } = await currentWorkingRoster(interaction.client, pickup);
  if (!working.unseatedUserIds.includes(userId)) {
    await interaction.update({
      content: `<@${userId}> is no longer an eligible unseated signup for this pickup. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }

  // The actual write, plus its own fresh re-check of both conflicts inside
  // one synchronous transaction — see RosterSlotRepository.addFixedSlot.
  const outcome = new RosterSlotRepository().addFixedSlot(pickup.id, location.team, location.role, userId);
  if (outcome.status === 'location_taken') {
    await interaction.update({
      content: `${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]} was just filled. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }
  if (outcome.status === 'user_already_rostered') {
    await interaction.update({
      content: `<@${userId}> already holds a seat on this roster. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }

  await interaction.update({
    content: `Done — <@${userId}> is seated at ${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]}.`,
    components: [],
  });

  // Redraws the control card around the new fixed slot, or freezes into
  // roster_ready and posts the review card if this placement completes it —
  // the exact same path every other signup change takes.
  await evaluateRosterReady(interaction.client, pickup.id);
}
