/**
 * Post-publish player replacement.
 *
 * This is the emergency-substitution path: a published roster is already public
 * and someone has dropped out twenty minutes before start. Everything here is
 * ephemeral so the coordinator's fumbling never appears in the channel; only
 * two things ever become public — the edited roster message and one short
 * replacement notice.
 *
 * The outgoing player's team and role are never touched. A replacement inherits
 * the slot exactly as it stood; there is deliberately no "and also move them to
 * Jungle" shortcut here, because that is roster editing and belongs to the
 * pre-publish review flow.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  Guild,
  GuildTextBasedChannel,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from 'discord.js';

import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import { SignupRepository } from '../../db/repositories/signups.js';
import type { GuildConfig, Pickup, RosterSlot } from '../../db/repositories/types.js';
import {
  candidateLabel,
  rankCandidates,
  type MemberCandidate,
} from '../../domain/member-resolver.js';
import { publishedRosterRows } from '../components.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { requireAuthorized } from '../permissions.js';
import { renderPublicRoster, renderReplacementNotice, slotLabel } from '../render.js';
import { hasEligibilityRole, resolveEligibleUserIds } from '../eligibility.js';

/** Discord allows at most 25 options in a select menu. */
const MAX_SELECT_OPTIONS = 25;

type AnyRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
type ReplaceInteraction = MessageComponentInteraction | ModalSubmitInteraction;

/**
 * Guard wrapper.
 *
 * `requireAuthorized` is typed against discord.js's `Interaction` union, which
 * lists the concrete button/select classes rather than the shared
 * `MessageComponentInteraction` base they all extend. Every component
 * interaction we receive is one of those classes at runtime, so this narrowing
 * cast is safe — it only exists to satisfy the union.
 */
function authorize(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<GuildConfig | null> {
  return requireAuthorized(interaction as unknown as Parameters<typeof requireAuthorized>[0]);
}

/**
 * Reply or edit, whichever this interaction is ready for.
 *
 * Some steps of this flow have to defer (they hit Discord's member API), others
 * must not (they end in a modal, which cannot follow a deferral). This keeps the
 * step handlers from each having to care which one they are.
 */
async function say(
  interaction: ReplaceInteraction,
  content: string,
  components: AnyRow[] = [],
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components });
    return;
  }
  await interaction.reply({ content, components, flags: MessageFlags.Ephemeral });
}

function selectedValue(interaction: MessageComponentInteraction): string | undefined {
  return interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
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

async function textChannel(
  interaction: ReplaceInteraction,
  channelId: string | null,
): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
    return channel;
  } catch {
    return null;
  }
}

/**
 * Load the pickup and confirm replacement applies to it.
 *
 * Replacement only exists after publication. Before that, staff have the far
 * richer Edit Roster flow, so pointing them back at the right tool is more
 * useful than silently doing something similar-but-different.
 */
function loadPublished(pickupId: number): { pickup: Pickup } | { error: string } {
  const pickup = new PickupRepository().byId(pickupId);
  if (!pickup) return { error: 'That pickup no longer exists.' };
  if (pickup.status === 'cancelled') {
    return { error: 'That pickup was cancelled, so there is no roster to change.' };
  }
  if (pickup.status !== 'published') {
    return {
      error:
        'That roster has not been published yet. Use **Edit Roster** on the staff review card instead.',
    };
  }
  return { pickup };
}

function loadSlot(pickupId: number, slotId: number): RosterSlot | null {
  const slot = new RosterSlotRepository().byId(slotId);
  if (!slot || slot.pickupId !== pickupId) return null;
  return slot;
}

/* -------------------------------------------------------------------------- */
/* Component steps                                                            */
/* -------------------------------------------------------------------------- */

export async function handleReplaceComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  // Re-checked at EVERY step, not just on the first click. The published roster
  // is visible to the whole server, so the Replace Player button is too.
  const config = await authorize(interaction);
  if (!config) return;

  switch (decoded.action) {
    case Action.Replace:
      await promptForSlot(interaction, decoded.pickupId);
      return;

    case Action.ReplacePickSlot:
      await promptForReplacement(interaction, decoded.pickupId, Number(selectedValue(interaction)));
      return;

    case Action.ReplaceSearch:
      await openSearchModal(interaction, decoded.pickupId, Number(decoded.args[0]));
      return;

    case Action.ReplacePickBench:
    case Action.ReplacePickCandidate:
      await promptForConfirmation(
        interaction,
        decoded.pickupId,
        Number(decoded.args[0]),
        selectedValue(interaction),
      );
      return;

    case Action.ReplaceConfirm: {
      const [slotIdRaw, newUserId, decision] = decoded.args;
      if (decision !== 'yes') {
        await interaction.update({
          content: 'No changes made. The roster is unchanged.',
          components: [],
        });
        return;
      }
      await commitReplacement(interaction, config, decoded.pickupId, Number(slotIdRaw), newUserId);
      return;
    }

    default:
      return;
  }
}

/** Step 1 — which slot is being vacated. */
async function promptForSlot(
  interaction: MessageComponentInteraction,
  pickupId: number,
): Promise<void> {
  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  const { pickup } = loaded;

  const slots = new RosterSlotRepository().forPickup(pickupId);
  if (slots.length === 0) {
    await interaction.reply({ content: 'That roster has no slots to replace.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Resolving the current occupants' names needs Discord API calls, so take the
  // extra second rather than risking the 3-second interaction deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const options = [];
  for (const slot of slots.slice(0, MAX_SELECT_OPTIONS)) {
    const name = await displayNameFor(interaction.guild, slot.userId);
    options.push({
      label: `${slotLabel(slot, pickup.format)} — @${name}`.slice(0, 100),
      value: String(slot.id),
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.ReplacePickSlot, pickupId))
    .setPlaceholder('Select the player being replaced')
    .addOptions(options);

  await interaction.editReply({
    content: 'Which player are you replacing?',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

/**
 * Step 2 — BENCH FIRST, then search.
 *
 * Someone who already reacted for this role wanted to play it and knows the
 * pickup is happening, so they are the best replacement available. We offer that
 * short list before opening the flow up to the entire server.
 *
 * But when nobody is on the bench, showing an empty menu would just be a dead
 * step to click through — so in that case we jump straight to the search modal.
 * The extra step only appears when it has something to offer.
 */
async function promptForReplacement(
  interaction: MessageComponentInteraction,
  pickupId: number,
  slotId: number,
): Promise<void> {
  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  const { pickup } = loaded;

  const slot = loadSlot(pickupId, slotId);
  if (!slot) {
    await interaction.reply({
      content: 'That roster slot no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rostered = new Set(new RosterSlotRepository().userIds(pickupId));
  let bench = new SignupRepository()
    .usersForRole(pickupId, slot.role)
    .filter((userId) => !rostered.has(userId));
  if (pickup.eligibilityRoleId) {
    const eligible = interaction.guild
      ? await resolveEligibleUserIds(interaction.guild, bench, pickup.eligibilityRoleId)
      : new Set<string>();
    bench = bench.filter((userId) => eligible.has(userId));
  }

  if (bench.length === 0) {
    // Nothing to choose from — skip the empty menu entirely. A modal cannot be
    // shown after deferring, which is why no await touched Discord above.
    await showSearchModal(interaction, pickupId, slotId);
    return;
  }

  await interaction.deferUpdate();

  const benchOptions = [];
  for (const userId of bench.slice(0, MAX_SELECT_OPTIONS)) {
    const name = await displayNameFor(interaction.guild, userId);
    benchOptions.push({ label: `@${name}`.slice(0, 100), value: userId });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.ReplacePickBench, pickupId, slotId))
    .setPlaceholder('Players who signed up for this role')
    .addOptions(benchOptions);

  const searchButton = new ButtonBuilder()
    .setCustomId(encodeId(Action.ReplaceSearch, pickupId, slotId))
    .setLabel('Search a different player')
    .setStyle(ButtonStyle.Secondary);

  await interaction.editReply({
    content: `Replacing <@${slot.userId}> at ${slotLabel(slot, pickup.format)}. These players signed up for the role:`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(searchButton),
    ],
  });
}

/** Step 3 — the "Search a different player" button. */
async function openSearchModal(
  interaction: MessageComponentInteraction,
  pickupId: number,
  slotId: number,
): Promise<void> {
  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  await showSearchModal(interaction, pickupId, slotId);
}

async function showSearchModal(
  interaction: MessageComponentInteraction,
  pickupId: number,
  slotId: number,
): Promise<void> {
  const input = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Replacement player')
    .setPlaceholder('Discord username or display name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const modal = new ModalBuilder()
    .setCustomId(encodeId(Action.ReplaceSearchModal, pickupId, slotId))
    .setTitle('Find a replacement')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

  await interaction.showModal(modal);
}

/* -------------------------------------------------------------------------- */
/* Modal step                                                                 */
/* -------------------------------------------------------------------------- */

export async function handleReplaceModal(
  interaction: ModalSubmitInteraction,
  decoded: DecodedId,
): Promise<void> {
  const config = await authorize(interaction);
  if (!config) return;

  const pickupId = decoded.pickupId;
  const slotId = Number(decoded.args[0]);

  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  const { pickup } = loaded;

  const slot = loadSlot(pickupId, slotId);
  if (!slot) {
    await interaction.reply({
      content: 'That roster slot no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const query = interaction.fields.getTextInputValue('query').trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Searching the member list requires the privileged GUILD_MEMBERS intent —
  // it must be enabled on the application in the Discord developer portal, or
  // this query comes back empty for everyone who is not already cached.
  let candidates: MemberCandidate[] = [];
  if (interaction.guild) {
    try {
      const members = await interaction.guild.members.fetch({ query, limit: 25 });
      candidates = members
        .filter((member) => hasEligibilityRole(member.roles.cache, pickup.eligibilityRoleId))
        .map((member) => ({
        userId: member.id,
        username: member.user.username,
        displayName: member.user.globalName,
        nickname: member.nickname,
        isBot: member.user.bot,
        }));
    } catch {
      candidates = [];
    }
  }

  // A replacement found by search may be ANY guild member — they do not need to
  // have signed up. That is deliberately broader than pre-publish roster
  // editing: at this point the pickup is minutes away and staff need to be able
  // to grab whoever is actually online. The one hard rule is that they cannot
  // already hold another slot, which rankCandidates enforces by exclusion (and
  // which we re-check before committing, since time passes in between).
  const rostered = new RosterSlotRepository().userIds(pickupId);
  const ranked = rankCandidates(query, candidates, rostered);

  if (ranked.length === 0) {
    // Not a dead end — the ephemeral Search button is still on their previous
    // message, so they can simply try a different spelling.
    await interaction.editReply({
      content: `No member found matching \`${query}\`. Try again.`,
      components: [],
    });
    return;
  }

  if (ranked.length === 1) {
    // One clear match: asking them to pick from a list of one is pure friction.
    await sendConfirmation(interaction, pickup, slot, ranked[0]!.userId);
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.ReplacePickCandidate, pickupId, slotId))
    .setPlaceholder('Select the replacement player')
    .addOptions(
      ranked.map((candidate) => ({
        label: candidateLabel(candidate).slice(0, 100),
        value: candidate.userId,
      })),
    );

  await interaction.editReply({
    content: `Several members match \`${query}\`. Which one did you mean?`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

/* -------------------------------------------------------------------------- */
/* Confirmation and commit                                                    */
/* -------------------------------------------------------------------------- */

async function promptForConfirmation(
  interaction: MessageComponentInteraction,
  pickupId: number,
  slotId: number,
  newUserId: string | undefined,
): Promise<void> {
  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }

  const slot = loadSlot(pickupId, slotId);
  if (!slot || !newUserId) {
    await interaction.reply({
      content: 'That roster slot no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  await sendConfirmation(interaction, loaded.pickup, slot, newUserId);
}

/** Step 5 — always confirm; this edits a message the whole server can see. */
async function sendConfirmation(
  interaction: ReplaceInteraction,
  pickup: Pickup,
  slot: RosterSlot,
  newUserId: string,
): Promise<void> {
  const confirm = new ButtonBuilder()
    .setCustomId(encodeId(Action.ReplaceConfirm, pickup.id, slot.id, newUserId, 'yes'))
    .setLabel('Confirm')
    .setStyle(ButtonStyle.Success);

  const cancel = new ButtonBuilder()
    .setCustomId(encodeId(Action.ReplaceConfirm, pickup.id, slot.id, newUserId, 'no'))
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  await say(
    interaction,
    `Replace <@${slot.userId}> with <@${newUserId}> at ${slotLabel(slot, pickup.format)}?`,
    [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)],
  );
}

/** Step 6 — the only step that changes anything anyone else can see. */
async function commitReplacement(
  interaction: MessageComponentInteraction,
  config: GuildConfig,
  pickupId: number,
  slotId: number,
  newUserId: string | undefined,
): Promise<void> {
  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.update({ content: loaded.error, components: [] });
    return;
  }
  const { pickup } = loaded;

  const slots = new RosterSlotRepository();
  const slot = loadSlot(pickupId, slotId);
  if (!slot || !newUserId) {
    await interaction.update({ content: 'That roster slot no longer exists.', components: [] });
    return;
  }

  // Re-check rather than trusting the exclusion done when the list was built:
  // another coordinator may have seated this player somewhere else while this
  // confirmation sat on screen. Nobody may hold two slots.
  if (slots.userIds(pickupId).includes(newUserId)) {
    await interaction.update({
      content: `<@${newUserId}> already holds a slot on this roster. Pick someone else.`,
      components: [],
    });
    return;
  }

  if (pickup.eligibilityRoleId) {
    const replacement = interaction.guild
      ? await interaction.guild.members.fetch(newUserId).catch(() => null)
      : null;
    if (!replacement || replacement.user.bot || !hasEligibilityRole(replacement.roles.cache, pickup.eligibilityRoleId)) {
      await interaction.update({ content: 'That player does not hold this pickup\'s eligibility role.', components: [] });
      return;
    }
  }

  // Claim the version first. If someone else edited the roster since this
  // confirmation was rendered, their bump already landed and ours fails, so we
  // refuse instead of overwriting work the clicker never saw.
  if (!new PickupRepository().bumpVersion(pickup.id, pickup.version)) {
    await interaction.update({
      content:
        'Someone else changed this roster a moment ago. Reopen **Replace Player** and try again.',
      components: [],
    });
    return;
  }

  await interaction.deferUpdate().catch(() => undefined);

  const oldUserId = slot.userId;
  // Team and role are inherited untouched — only the occupant changes.
  // Marked as a staff assignment. A replacement found by member search need
  // never have signed up at all — that is the emergency-sub path working as
  // intended — so this slot must not be treated as a withdrawal afterwards.
  slots.setOccupant(slot.id, newUserId, true);

  const channel = await textChannel(interaction, config.rosterChannelId);
  const updated = slots.forPickup(pickupId);

  if (channel && pickup.rosterMessageId) {
    try {
      const message = await channel.messages.fetch(pickup.rosterMessageId);
      // Edited in place, keeping the Replace Player button, so the roster stays
      // one message players can scroll back to rather than a growing thread.
      await message.edit({
        content: renderPublicRoster(pickup, updated),
        components: publishedRosterRows(pickup.id),
      });
    } catch {
      // The roster message was deleted. The data change still stands.
    }
  }

  if (channel) {
    // Short public notice, worded exactly as the spec fixes it.
    await channel
      .send(renderReplacementNotice(newUserId, oldUserId, slot.role))
      .catch(() => undefined);
  }

  await interaction.editReply({
    content: `Done — <@${newUserId}> replaces <@${oldUserId}> at ${slotLabel(slot, pickup.format)}.`,
    components: [],
  });
}
