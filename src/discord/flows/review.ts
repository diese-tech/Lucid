/**
 * Roster-ready detection, the staff review card, and everything staff can do to
 * a draft before it goes public.
 *
 * The shape of this flow matters more than any single function in it:
 *
 *   1. At creation, a control card is posted in the staff channel (Cancel only).
 *   2. When the signup pool can fill every slot, that SAME message is edited in
 *      place into the review card. There is never a second staff message.
 *   3. Staff shuffle / edit / publish from that one message.
 *
 * Keeping it to one message is why a coordinator can always scroll to the
 * bottom of the staff channel and see the current truth for each pickup rather
 * than a trail of superseded drafts.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
} from 'discord.js';
import { GuildConfigRepository } from '../../db/repositories/guild-config.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import { SignupRepository } from '../../db/repositories/signups.js';
import type { GuildConfig, Pickup, RosterSlot } from '../../db/repositories/types.js';
import { ROLES, ROLE_LABELS, TEAMS, isRole } from '../../domain/roles.js';
import {
  generateDifferentRoster,
  generateRoster,
  rosterFingerprint,
} from '../../domain/roster.js';
import { controlCardRows, publishedRosterRows, reviewCardRows } from '../components.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { requireAuthorized } from '../permissions.js';
import { eligibleSignupRecords, resolveEligibleUserIds } from '../eligibility.js';
import {
  renderControlCard,
  renderPublicRoster,
  renderReviewCard,
  slotLabel,
} from '../render.js';

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

const STALE_MESSAGE =
  'This roster changed since you opened it — refresh and try again.';

/** Nothing Lucid edits into the staff channel should ping anybody. */
const SILENT = { parse: [] as const };

// ---------------------------------------------------------------------------
// Message plumbing
// ---------------------------------------------------------------------------

/**
 * Fetch the one staff message for a pickup.
 *
 * Returns null rather than throwing for every ordinary failure — the channel
 * was deleted, the message was deleted, the bot lost access. None of those
 * should abort the database work that already succeeded.
 */
async function fetchStaffMessage(client: Client, pickup: Pickup): Promise<Message | null> {
  if (!pickup.reviewMessageId) return null;

  const config = new GuildConfigRepository().get(pickup.guildId);
  if (!config?.reviewChannelId) return null;

  try {
    const channel = await client.channels.fetch(config.reviewChannelId);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) return null;
    return await channel.messages.fetch(pickup.reviewMessageId);
  } catch {
    return null;
  }
}

/**
 * Guild display names for a set of users, for select-menu labels.
 *
 * Select menu options are plain text — a `<@id>` mention would render as raw
 * markup — so staff need real names here or the menus are unusable.
 */
async function displayNames(
  client: Client,
  guildId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return names;

  try {
    const guild = await client.guilds.fetch(guildId);
    const members = await guild.members.fetch({ user: unique });
    for (const [id, member] of members) names.set(id, member.displayName);
  } catch {
    // Members may have left the server, or the fetch may be rate limited.
    // Falling back to a raw ID keeps the menu usable instead of empty.
  }

  for (const id of unique) {
    if (!names.has(id)) names.set(id, `Unknown member (${id})`);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

/**
 * User IDs sitting in a roster slot whose matching signup no longer exists.
 *
 * A player can un-react at any time, including after staff have a draft in
 * front of them. Publishing a roster that @-mentions somebody who withdrew is
 * the single most embarrassing thing Lucid could do, so the drafted roster is
 * always compared back against live signups rather than trusted as-is.
 *
 * A staff-assigned slot (Change Role Assignment) is exempt from the specific
 * "signed up for THIS role" check — that mismatch is the whole point of the
 * override, not evidence of anything wrong. It is NOT exempt from having any
 * signup at all: if that player later removes every reaction and leaves the
 * pickup entirely, the override doesn't excuse that, and Publish must still
 * catch it. Without this distinction, staff-assigning someone once would
 * permanently exempt them from ever being flagged again, even after they
 * fully quit the pickup.
 */
export function withdrawnUserIds(pickupId: number): Set<string> {
  const slots = new RosterSlotRepository().forPickup(pickupId);
  const signups = new SignupRepository();

  const withdrawn = new Set<string>();
  for (const slot of slots) {
    const stillInPickup = slot.staffAssigned
      ? signups.hasAnySignup(pickupId, slot.userId)
      : signups.hasSignedUpFor(pickupId, slot.userId, slot.role);

    if (!stillInPickup) withdrawn.add(slot.userId);
  }
  return withdrawn;
}

async function ineligibleRosterUserIds(client: Client, pickup: Pickup): Promise<Set<string>> {
  if (!pickup.eligibilityRoleId) return new Set();
  const slots = new RosterSlotRepository().forPickup(pickup.id);
  try {
    const guild = await client.guilds.fetch(pickup.guildId);
    const eligible = await resolveEligibleUserIds(
      guild, slots.map((slot) => slot.userId), pickup.eligibilityRoleId,
    );
    return new Set(slots.map((slot) => slot.userId).filter((userId) => !eligible.has(userId)));
  } catch {
    return new Set(slots.map((slot) => slot.userId));
  }
}

/**
 * Redraw the staff card as a review card (roster draft + Shuffle/Edit/Publish).
 *
 * Buttons go dead once the pickup is published or cancelled — the card stays
 * readable as a record, but it is no longer a control surface.
 */
export async function refreshReviewCard(client: Client, pickupId: number): Promise<void> {
  const pickup = new PickupRepository().byId(pickupId);
  if (!pickup) return;

  const slots = new RosterSlotRepository().forPickup(pickupId);
  const withdrawn = withdrawnUserIds(pickupId);
  const ineligible = await ineligibleRosterUserIds(client, pickup);

  const message = await fetchStaffMessage(client, pickup);
  if (!message) return;

  await message.edit({
    content: renderReviewCard(pickup, slots, { withdrawnUserIds: withdrawn, ineligibleUserIds: ineligible }),
    components: reviewCardRows(pickup.id, pickup.version, {
      disabled: pickup.status === 'published' || pickup.status === 'cancelled',
      // Publish is greyed out, not merely refused, so staff can see at a glance
      // why they cannot publish yet.
      publishBlocked: withdrawn.size > 0 || ineligible.size > 0,
    }),
    allowedMentions: SILENT,
  });
}

/**
 * Redraw the staff card as the pre-roster control card (signup count + Cancel).
 *
 * The status guard is load-bearing: reaction handlers call this right after
 * evaluateRosterReady, and if the pickup just became roster-ready, rewriting
 * the message as a control card would wipe out the review card that was posted
 * microseconds earlier.
 */
export async function refreshControlCard(client: Client, pickupId: number): Promise<void> {
  const pickup = new PickupRepository().byId(pickupId);
  if (!pickup || pickup.status !== 'open') return;

  const signupCount = new SignupRepository().forPickup(pickupId).length;

  const message = await fetchStaffMessage(client, pickup);
  if (!message) return;

  await message.edit({
    content: renderControlCard(pickup, signupCount),
    components: controlCardRows(pickup.id),
    allowedMentions: SILENT,
  });
}

// ---------------------------------------------------------------------------
// Roster-ready detection
// ---------------------------------------------------------------------------

/**
 * Re-evaluate a pickup after any signup change.
 *
 * Called from both reaction handlers, so it must be cheap and safe to call
 * dozens of times for a pickup that never becomes ready.
 */
export async function evaluateRosterReady(client: Client, pickupId: number): Promise<void> {
  const pickups = new PickupRepository();
  const pickup = pickups.byId(pickupId);
  if (!pickup) return;

  if (pickup.status !== 'open') {
    // THE DRAFT IS FROZEN once it exists. Later signup changes never
    // regenerate it, because staff may already have hand-edited the roster and
    // silently replacing their work would be worse than showing them a stale
    // name with a withdrawal warning next to it. We only redraw so the warning
    // and the Publish button reflect the current signup pool.
    if (pickup.status === 'roster_ready') await refreshReviewCard(client, pickupId);
    return;
  }

  const records = await eligibleSignupRecords(
    client,
    pickup.guildId,
    new SignupRepository().recordsForPickup(pickupId),
    pickup.eligibilityRoleId,
  );
  const result = generateRoster(records, pickup.format);

  if (!result.feasible) {
    // Still collecting. Note that "not feasible" is a matching result, not a
    // headcount — see src/domain/roster.ts for why counting reactions is wrong.
    await refreshControlCard(client, pickupId);
    return;
  }

  // CONDITIONAL WRITE, ON PURPOSE. Two reactions arriving in the same tick can
  // both compute a feasible roster. Only the transition that actually changed
  // the row proceeds to write slots and post the review card; the loser sees
  // false and stops here. Without this, one pickup could produce two rosters
  // and two review cards.
  if (!pickups.transitionStatus(pickupId, 'open', 'roster_ready')) return;

  new RosterSlotRepository().replaceAll(pickupId, result.slots);

  // Edits the EXISTING staff message in place — same message ID before and
  // after roster-ready. Do not post a second message here.
  await refreshReviewCard(client, pickupId);
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

/**
 * Reply, or edit the reply, depending on whether we already acknowledged.
 *
 * CAREFUL: after `deferUpdate()`, editReply edits the message the component sat
 * on. That is what we want for the ephemeral edit menus (they should be
 * replaced in place), but it means respond() must never be called after
 * deferring an interaction that came from the review card message itself —
 * that would overwrite the roster with a one-line status message. Shuffle,
 * which is the one such case, uses followUp instead.
 */
async function respond(
  interaction: MessageComponentInteraction,
  content: string,
  components: Row[] = [],
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components, allowedMentions: SILENT });
    return;
  }
  await interaction.reply({
    content,
    components,
    allowedMentions: SILENT,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Refuse a click made against a card that has since changed.
 *
 * Returns true when the caller should stop. Staff often have the same card open
 * on two devices; without this, the second click would silently overwrite work
 * done by the first.
 */
async function isStale(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<boolean> {
  const expected = Number(decoded.args[0]);
  if (!Number.isInteger(expected) || expected === pickup.version) return false;

  await respond(interaction, STALE_MESSAGE);
  await refreshReviewCard(interaction.client, pickup.id);
  return true;
}

/** The version this component was rendered from. */
function versionOf(decoded: DecodedId): number {
  const expected = Number(decoded.args[0]);
  return Number.isInteger(expected) ? expected : 0;
}

/**
 * Atomically claim the version a mutation is about to make, immediately before
 * making it.
 *
 * MUST be called right next to the roster-slot write it guards — not earlier,
 * and never with an `await` in between the two. `isStale()` above is only a
 * cheap early exit for menu navigation that doesn't write anything; it reads
 * the version without claiming it, so two concurrent interactions can both
 * pass it and both reach a mutation. This function is what actually prevents
 * that: `claimVersionIfEditable` is one atomic SQL statement, so only one
 * concurrent caller can ever win it for a given expected version. The loser
 * gets told the roster changed and must not proceed to mutate anything.
 */
async function claimVersion(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<boolean> {
  const claimed = new PickupRepository().claimVersionIfEditable(pickup.id, versionOf(decoded));
  if (!claimed) {
    await respond(interaction, STALE_MESSAGE);
    await refreshReviewCard(interaction.client, pickup.id);
  }
  return claimed;
}

function selectedValue(interaction: MessageComponentInteraction): string | null {
  if (!interaction.isStringSelectMenu()) return null;
  return interaction.values[0] ?? null;
}

/** Every staff action on the review card ends the same way, once the mutation is done. */
async function commitEdit(
  interaction: MessageComponentInteraction,
  pickupId: number,
  message: string,
): Promise<void> {
  await refreshReviewCard(interaction.client, pickupId);
  await respond(interaction, message);
}

// ---------------------------------------------------------------------------
// Edit Roster menus
// ---------------------------------------------------------------------------

function editMenuRows(pickup: Pickup, version: number): Row[] {
  const swapOnlyMakesSenseHere = pickup.format === 'pickup_vs_pickup';

  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.EditSwap, pickup.id, version))
        .setLabel('Swap Players')
        .setStyle(ButtonStyle.Secondary)
        // Pickup vs Premade has one team, so there is no second side to swap
        // a player with. The button stays visible but inert rather than
        // appearing and disappearing between formats.
        .setDisabled(!swapOnlyMakesSenseHere),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.EditChangeRole, pickup.id, version))
        .setLabel('Change Role Assignment')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.EditReplaceSlot, pickup.id, version))
        .setLabel('Replace a Roster Slot')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const EDIT_MENU_TEXT = [
  '**Edit Roster**',
  '',
  '• **Swap Players** — exchange the two players at one role between Order and Chaos.',
  '• **Change Role Assignment** — exchange the players sitting in any two slots.',
  '• **Replace a Roster Slot** — seat a benched signup in place of the current player.',
].join('\n');

/** Option list for "pick a roster slot", labelled with who currently holds it. */
function slotOptions(
  slots: RosterSlot[],
  pickup: Pickup,
  names: Map<string, string>,
  exclude?: number,
): StringSelectMenuOptionBuilder[] {
  return slots
    .filter((slot) => slot.id !== exclude)
    .map((slot) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(slotLabel(slot, pickup.format).slice(0, 100))
        .setDescription((names.get(slot.userId) ?? slot.userId).slice(0, 100))
        .setValue(String(slot.id)),
    );
}

/**
 * Roster slots in the order they are presented everywhere else: Order before
 * Chaos, then the canonical role order. Menus that list slots in a different
 * order than the card above them are a reliable way to make staff misclick.
 */
function orderedSlots(pickupId: number): RosterSlot[] {
  const slots = new RosterSlotRepository().forPickup(pickupId);
  return [...slots].sort((a, b) => {
    if (a.team !== b.team) return TEAMS.indexOf(a.team) - TEAMS.indexOf(b.team);
    return ROLES.indexOf(a.role) - ROLES.indexOf(b.role);
  });
}

function selectRow(select: StringSelectMenuBuilder): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Run the staff guard.
 *
 * requireAuthorized accepts discord.js's RepliableInteraction union, and the
 * abstract MessageComponentInteraction base class is not one of its members, so
 * we hand it the concrete button or select subtype the router actually
 * delivered. Buttons and selects are the only components this flow renders.
 */
async function authorize(
  interaction: MessageComponentInteraction,
): Promise<GuildConfig | null> {
  if (interaction.isButton()) return requireAuthorized(interaction);
  if (interaction.isStringSelectMenu()) return requireAuthorized(interaction);
  return null;
}

export async function handleReviewComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  try {
    // AUTHORIZATION IS RE-CHECKED ON EVERY ACTION. The review card lives in a
    // staff-only channel, but channel visibility is not an authorization
    // boundary: permissions change, channels get re-permissioned, and custom
    // IDs survive restarts. Each branch below runs through this same guard.
    const config = await authorize(interaction);
    if (!config) return;

    const pickups = new PickupRepository();
    const pickup = pickups.byId(decoded.pickupId);
    if (!pickup) {
      await respond(interaction, 'That pickup no longer exists.');
      return;
    }

    switch (decoded.action) {
      case Action.Shuffle:
        await handleShuffle(interaction, pickup, decoded);
        return;
      case Action.EditRoster:
        await handleEditRoster(interaction, pickup, decoded);
        return;
      case Action.EditBack:
        await handleEditRoster(interaction, pickup, decoded);
        return;
      case Action.EditSwap:
        await handleEditSwapMenu(interaction, pickup, decoded);
        return;
      case Action.EditChangeRole:
        await handleSlotPickerMenu(interaction, pickup, decoded, 'role');
        return;
      case Action.EditReplaceSlot:
        await handleSlotPickerMenu(interaction, pickup, decoded, 'replace');
        return;
      case Action.EditPickSlot:
        await handlePickSlot(interaction, pickup, decoded);
        return;
      case Action.EditPickTarget:
        await handlePickTarget(interaction, pickup, decoded);
        return;
      case Action.Publish:
        await handlePublish(interaction, pickup, decoded);
        return;
      case Action.PublishConfirm:
        await handlePublishConfirm(interaction, pickup, decoded);
        return;
      case Action.PublishBack:
        await handlePublishBack(interaction, pickup, decoded);
        return;
      default:
        return;
    }
  } catch (error) {
    console.error('[review] interaction failed', error);
    // Never leave the click hanging — an unanswered interaction shows the
    // player-facing "This interaction failed" error with no explanation.
    //
    // A follow-up rather than an edited reply: after deferUpdate() on a button
    // that lives on the review card itself, editing the reply would overwrite
    // the review card with this error text and destroy the roster staff were
    // looking at.
    const content = 'Something went wrong handling that. The roster was not changed.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // The interaction token may already be spent or expired.
    }
  }
}

/** Staff actions only make sense while a draft is live and unpublished. */
async function requireEditableDraft(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
): Promise<boolean> {
  if (pickup.status === 'roster_ready') return true;

  const reason =
    pickup.status === 'published'
      ? 'This roster has already been published. Use Replace Player on the public roster instead.'
      : pickup.status === 'cancelled'
        ? 'This pickup was cancelled.'
        : 'There is no roster draft for this pickup yet.';
  await respond(interaction, reason);
  return false;
}

// ---------------------------------------------------------------------------
// Shuffle
// ---------------------------------------------------------------------------

async function handleShuffle(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  await interaction.deferUpdate();

  const slotRepo = new RosterSlotRepository();
  const current = slotRepo.forPickup(pickup.id);
  const records = await eligibleSignupRecords(
    interaction.client,
    pickup.guildId,
    new SignupRepository().recordsForPickup(pickup.id),
    pickup.eligibilityRoleId,
  );

  // Shuffle re-rolls from the CURRENT signup pool rather than permuting the
  // existing draft. Two consequences staff rely on: players who signed up after
  // the first draft can appear, and any manual edits made so far are fully
  // replaced. That is the intended trade — Shuffle is "give me a different
  // roster", not "nudge this one".
  const { result, isDifferent } = generateDifferentRoster(
    records,
    pickup.format,
    rosterFingerprint(current),
  );

  if (!result.feasible) {
    await interaction.followUp({
      content: 'Not enough current signups to generate an alternative roster.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isDifferent) {
    await interaction.followUp({
      content: 'No alternative roster is possible with the current signups.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Claimed right here, immediately before the write it guards — not any
  // earlier (see claimVersion's comment). Uses followUp rather than the shared
  // claimVersion() helper because Shuffle's button lives directly on the
  // shared review card, not behind an ephemeral sub-menu like the Edit Roster
  // actions below — editing the card in place with plain status text would
  // flash over what the rest of the staff channel is looking at, same reason
  // the two checks above this one use followUp instead of respond().
  const claimed = new PickupRepository().claimVersionIfEditable(pickup.id, versionOf(decoded));
  if (!claimed) {
    await interaction.followUp({ content: STALE_MESSAGE, flags: MessageFlags.Ephemeral });
    await refreshReviewCard(interaction.client, pickup.id);
    return;
  }

  slotRepo.replaceAll(pickup.id, result.slots);
  await refreshReviewCard(interaction.client, pickup.id);
}

// ---------------------------------------------------------------------------
// Edit Roster
// ---------------------------------------------------------------------------

async function handleEditRoster(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  const rows = editMenuRows(pickup, pickup.version);

  // The menu is ephemeral so one coordinator poking at options never changes
  // what the rest of the staff channel sees on the review card.
  if (decoded.action === Action.EditBack) {
    await interaction.update({ content: EDIT_MENU_TEXT, components: rows });
    return;
  }
  await respond(interaction, EDIT_MENU_TEXT, rows);
}

async function handleEditSwapMenu(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  if (pickup.format !== 'pickup_vs_pickup') {
    await respond(
      interaction,
      'Swapping players between teams only applies to Pickup vs Pickup — this pickup has a single team.',
    );
    return;
  }

  await interaction.deferUpdate();

  const slots = orderedSlots(pickup.id);
  const names = await displayNames(
    interaction.client,
    pickup.guildId,
    slots.map((slot) => slot.userId),
  );

  const options = ROLES.map((role) => {
    const order = slots.find((slot) => slot.role === role && slot.team === 'order');
    const chaos = slots.find((slot) => slot.role === role && slot.team === 'chaos');
    const left = order ? (names.get(order.userId) ?? order.userId) : 'empty';
    const right = chaos ? (names.get(chaos.userId) ?? chaos.userId) : 'empty';
    return new StringSelectMenuOptionBuilder()
      .setLabel(ROLE_LABELS[role])
      .setDescription(`${left} ⇄ ${right}`.slice(0, 100))
      .setValue(role);
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.EditPickSlot, pickup.id, versionOf(decoded), 'swap'))
    .setPlaceholder('Which role should swap sides?')
    .addOptions(options);

  await interaction.editReply({
    content: '**Swap Players** — the Order and Chaos players at the chosen role trade places.',
    components: [selectRow(select), backRow(pickup.id, versionOf(decoded))],
  });
}

function backRow(pickupId: number, version: number): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeId(Action.EditBack, pickupId, version))
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Step one of both "Change Role Assignment" and "Replace a Roster Slot". */
async function handleSlotPickerMenu(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
  mode: 'role' | 'replace',
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  await interaction.deferUpdate();

  const slots = orderedSlots(pickup.id);
  if (slots.length === 0) {
    await interaction.editReply({ content: 'This pickup has no roster slots yet.', components: [] });
    return;
  }

  const names = await displayNames(
    interaction.client,
    pickup.guildId,
    slots.map((slot) => slot.userId),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.EditPickSlot, pickup.id, versionOf(decoded), mode))
    .setPlaceholder(mode === 'role' ? 'Pick the first slot' : 'Pick the slot to replace')
    .addOptions(slotOptions(slots, pickup, names));

  const content =
    mode === 'role'
      ? '**Change Role Assignment** — pick two slots and their players trade places.'
      : '**Replace a Roster Slot** — pick the slot you want to hand to a benched signup.';

  await interaction.editReply({
    content,
    components: [selectRow(select), backRow(pickup.id, versionOf(decoded))],
  });
}

/**
 * A slot (or role) was chosen. What happens next depends on the mode carried in
 * the custom ID: swap finishes here, the other two need a second choice.
 */
async function handlePickSlot(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  const mode = decoded.args[1];
  const value = selectedValue(interaction);
  if (!value) {
    await respond(interaction, 'Nothing was selected.');
    return;
  }

  const version = versionOf(decoded);
  const slotRepo = new RosterSlotRepository();

  if (mode === 'swap') {
    if (!isRole(value)) {
      await respond(interaction, 'That role is no longer part of this roster.');
      return;
    }
    await interaction.deferUpdate();

    const slots = slotRepo.forPickup(pickup.id);
    const order = slots.find((slot) => slot.role === value && slot.team === 'order');
    const chaos = slots.find((slot) => slot.role === value && slot.team === 'chaos');
    if (!order || !chaos) {
      await interaction.editReply({
        content: `Both teams need a ${ROLE_LABELS[value]} before they can swap.`,
        components: [],
      });
      return;
    }

    // Claimed immediately before the write — see claimVersion's comment.
    if (!(await claimVersion(interaction, pickup, decoded))) return;

    // Same role on both sides, so eligibility is unaffected by definition:
    // each player was already eligible for the role they keep playing.
    slotRepo.swapOccupants(order.id, chaos.id);
    await commitEdit(
      interaction,
      pickup.id,
      `Swapped the Order and Chaos ${ROLE_LABELS[value]} players.`,
    );
    return;
  }

  const slotId = Number(value);
  const slot = slotRepo.byId(slotId);
  if (!slot || slot.pickupId !== pickup.id) {
    await respond(interaction, 'That roster slot no longer exists.');
    return;
  }

  await interaction.deferUpdate();

  if (mode === 'role') {
    const others = orderedSlots(pickup.id).filter((other) => other.id !== slot.id);
    if (others.length === 0) {
      await interaction.editReply({
        content: 'There is no other slot to exchange with.',
        components: [],
      });
      return;
    }

    const names = await displayNames(interaction.client, pickup.guildId, [
      slot.userId,
      ...others.map((other) => other.userId),
    ]);

    const select = new StringSelectMenuBuilder()
      .setCustomId(encodeId(Action.EditPickTarget, pickup.id, version, 'role', slot.id))
      .setPlaceholder('Pick the slot to exchange with')
      .addOptions(slotOptions(others, pickup, names, slot.id));

    await interaction.editReply({
      content:
        `Exchanging **${slotLabel(slot, pickup.format)}** ` +
        `(${names.get(slot.userId) ?? slot.userId}) with which slot?`,
      components: [selectRow(select), backRow(pickup.id, version)],
    });
    return;
  }

  if (mode === 'replace') {
    // POOL-RESTRICTED, unlike Change Role Assignment: the bench is only players
    // who actually signed up for this slot's role and are not already rostered
    // somewhere else. Replacing a slot is the routine "swap in a sub" action,
    // so it stays inside the signup pool.
    let bench = new SignupRepository()
      .usersForRole(pickup.id, slot.role)
      .filter((userId) => !slotRepo.isUserRostered(pickup.id, userId));
    if (pickup.eligibilityRoleId) {
      const eligible = interaction.guild
        ? await resolveEligibleUserIds(interaction.guild, bench, pickup.eligibilityRoleId)
        : new Set<string>();
      bench = bench.filter((userId) => eligible.has(userId));
    }

    if (bench.length === 0) {
      await interaction.editReply({
        content:
          `Nobody is available for ${ROLE_LABELS[slot.role]} — everyone who signed up for that ` +
          'role is already on the roster.',
        components: [backRow(pickup.id, version)],
      });
      return;
    }

    const names = await displayNames(interaction.client, pickup.guildId, [slot.userId, ...bench]);
    const select = new StringSelectMenuBuilder()
      .setCustomId(encodeId(Action.EditPickTarget, pickup.id, version, 'replace', slot.id))
      .setPlaceholder('Pick the replacement')
      .addOptions(
        bench.slice(0, 25).map((userId) =>
          new StringSelectMenuOptionBuilder()
            .setLabel((names.get(userId) ?? userId).slice(0, 100))
            .setValue(userId),
        ),
      );

    await interaction.editReply({
      content:
        `Who should take **${slotLabel(slot, pickup.format)}** from ` +
        `${names.get(slot.userId) ?? slot.userId}?`,
      components: [selectRow(select), backRow(pickup.id, version)],
    });
    return;
  }

  await interaction.editReply({ content: 'That edit action is no longer available.', components: [] });
}

/** The second choice: finish a role exchange or a slot replacement. */
async function handlePickTarget(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  const mode = decoded.args[1];
  const sourceId = Number(decoded.args[2]);
  const value = selectedValue(interaction);
  if (!value || !Number.isInteger(sourceId)) {
    await respond(interaction, 'Nothing was selected.');
    return;
  }

  const version = versionOf(decoded);
  const slotRepo = new RosterSlotRepository();
  const source = slotRepo.byId(sourceId);
  if (!source || source.pickupId !== pickup.id) {
    await respond(interaction, 'That roster slot no longer exists.');
    return;
  }

  await interaction.deferUpdate();

  if (mode === 'role') {
    const target = slotRepo.byId(Number(value));
    if (!target || target.pickupId !== pickup.id) {
      await interaction.editReply({
        content: 'That roster slot no longer exists.',
        components: [],
      });
      return;
    }

    // NO ELIGIBILITY CHECK HERE, DELIBERATELY. Staff may move a player into a
    // role they never reacted for — late scratches and "just put him mid" are
    // exactly why this action exists, and Lucid does not second-guess a
    // coordinator standing in front of the players. Do not add a validation
    // gate to this branch.
    //
    // Safety still holds structurally: because this is an exchange of two
    // occupied slots, no slot is left empty and nobody ends up seated twice.
    // Claimed immediately before the write — see claimVersion's comment. Note
    // this runs after deferUpdate() above, which is fine: this whole picker
    // flow lives inside its own ephemeral message (opened by handleEditRoster),
    // so editReply here targets that private message, not the shared card.
    if (!(await claimVersion(interaction, pickup, decoded))) return;

    // Marked as a staff assignment: either player may now sit in a role they
    // never signed up for, which is the point of this action. The marker keeps
    // the withdrawn-signup check from reading that as someone dropping out and
    // blocking Publish.
    slotRepo.swapOccupants(source.id, target.id, true);

    await commitEdit(
      interaction,
      pickup.id,
      `Exchanged ${slotLabel(source, pickup.format)} and ${slotLabel(target, pickup.format)}.`,
    );
    return;
  }

  if (mode === 'replace') {
    if (slotRepo.isUserRostered(pickup.id, value)) {
      // Between opening the menu and picking, that player may have been seated
      // elsewhere. Seating them twice would silently drop somebody.
      await interaction.editReply({
        content: 'That player is already on this roster.',
        components: [],
      });
      return;
    }
    if (!new SignupRepository().hasSignedUpFor(pickup.id, value, source.role)) {
      await interaction.editReply({
        content: 'That player is no longer signed up for this role or Fill.',
        components: [],
      });
      return;
    }
    if (pickup.eligibilityRoleId) {
      const eligible = interaction.guild
        ? await resolveEligibleUserIds(interaction.guild, [value], pickup.eligibilityRoleId)
        : new Set<string>();
      if (!eligible.has(value)) {
        await interaction.editReply({
          content: 'That player no longer holds this pickup\'s eligibility role.',
          components: [],
        });
        return;
      }
    }

    // Claimed immediately before the write — see claimVersion's comment.
    if (!(await claimVersion(interaction, pickup, decoded))) return;

    slotRepo.setOccupant(source.id, value);
    await commitEdit(
      interaction,
      pickup.id,
      `<@${value}> now holds ${slotLabel(source, pickup.format)}.`,
    );
    return;
  }

  await interaction.editReply({ content: 'That edit action is no longer available.', components: [] });
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function withdrawnList(withdrawn: Set<string>): string {
  return [...withdrawn].map((userId) => `<@${userId}>`).join(', ');
}

async function handlePublish(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  // PUBLISH IS BLOCKED ON WITHDRAWALS. The published roster @-mentions every
  // player on it; mentioning somebody who removed their reaction tells the
  // server they are playing when they said they are not. Staff must resolve it
  // with Shuffle or Edit Roster first — Lucid will not quietly drop the player
  // or publish anyway.
  const withdrawn = withdrawnUserIds(pickup.id);
  if (withdrawn.size > 0) {
    await respond(
      interaction,
      `Can't publish yet — ${withdrawnList(withdrawn)} withdrew after this draft was made. ` +
        'Use Shuffle or Edit Roster to fill those slots first.',
    );
    return;
  }
  const ineligible = await ineligibleRosterUserIds(interaction.client, pickup);
  if (ineligible.size > 0) {
    await respond(
      interaction,
      `Can't publish yet — ${withdrawnList(ineligible)} no longer hold the eligibility role. Use Shuffle or Edit Roster first.`,
    );
    return;
  }

  const config = new GuildConfigRepository().get(pickup.guildId);
  if (!config?.rosterChannelId) {
    await respond(
      interaction,
      'No public roster channel is configured. Set one with `/pickup config` first.',
    );
    return;
  }

  const version = versionOf(decoded);
  const rows: Row[] = [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Action.PublishConfirm, pickup.id, version))
        .setLabel('Publish')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(encodeId(Action.PublishBack, pickup.id, version))
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  await respond(interaction, `Publish this roster to <#${config.rosterChannelId}>?`, rows);
}

async function handlePublishConfirm(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (!(await requireEditableDraft(interaction, pickup))) return;
  if (await isStale(interaction, pickup, decoded)) return;

  // Re-checked at the moment of publication, not just when the confirmation was
  // shown — somebody can un-react while the dialog sits open.
  const withdrawn = withdrawnUserIds(pickup.id);
  if (withdrawn.size > 0) {
    await respond(
      interaction,
      `Can't publish — ${withdrawnList(withdrawn)} withdrew. Fix the roster and try again.`,
    );
    return;
  }
  const ineligible = await ineligibleRosterUserIds(interaction.client, pickup);
  if (ineligible.size > 0) {
    await respond(interaction, `Can't publish — ${withdrawnList(ineligible)} no longer hold the eligibility role.`);
    return;
  }

  const config = new GuildConfigRepository().get(pickup.guildId);
  if (!config?.rosterChannelId) {
    await respond(interaction, 'No public roster channel is configured.');
    return;
  }

  await interaction.deferUpdate();

  const pickups = new PickupRepository();

  // Claim the publish BEFORE posting anything. If two coordinators hit Publish
  // together, only one transition succeeds, so only one public roster is ever
  // posted.
  if (!pickups.transitionStatus(pickup.id, 'roster_ready', 'published')) {
    await interaction.editReply({
      content: 'This roster was already published.',
      components: [],
    });
    return;
  }

  const slots = new RosterSlotRepository().forPickup(pickup.id);

  try {
    const channel = await interaction.client.channels.fetch(config.rosterChannelId);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      throw new Error('Roster channel is not a channel Lucid can post in.');
    }

    const posted = await channel.send({
      content: renderPublicRoster(pickup, slots),
      components: publishedRosterRows(pickup.id),
      // The public roster is the one place mentions are intended: players are
      // meant to be pinged that they are playing.
      allowedMentions: { parse: ['users'] },
    });

    pickups.setMessageIds(pickup.id, { rosterMessageId: posted.id });
  } catch (error) {
    // Posting failed after we claimed the publish; hand the pickup back so
    // staff can retry rather than leaving it stuck in a published state with
    // no public message.
    pickups.transitionStatus(pickup.id, 'published', 'roster_ready');
    await refreshReviewCard(interaction.client, pickup.id);
    console.error('[review] publish failed', error);
    await interaction.editReply({
      content: `Couldn't post to <#${config.rosterChannelId}>. Check Lucid's permissions there and try again.`,
      components: [],
    });
    return;
  }

  // The staff card stays as a record, with its controls disabled.
  await refreshReviewCard(interaction.client, pickup.id);
  await interaction.editReply({
    content: `Roster published to <#${config.rosterChannelId}>.`,
    components: [],
  });
}

async function handlePublishBack(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  decoded: DecodedId,
): Promise<void> {
  if (await isStale(interaction, pickup, decoded)) return;

  await interaction.deferUpdate();
  await refreshReviewCard(interaction.client, pickup.id);
  await interaction.editReply({
    content: 'Publishing cancelled — the review card above is unchanged.',
    components: [],
  });
}
