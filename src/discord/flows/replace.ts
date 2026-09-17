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

import { getDatabase } from '../../db/index.js';
import { PickupEventRepository } from '../../db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../../db/repositories/pickup-notifications.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import { SignupRepository } from '../../db/repositories/signups.js';
import type { Pickup, RosterSlot, Signup } from '../../db/repositories/types.js';
import {
  candidateLabel,
  rankCandidates,
  type MemberCandidate,
} from '../../domain/member-resolver.js';
import {
  rankReplacementCandidates,
  type ReplacementCandidate,
} from '../../domain/replacement-candidates.js';
import { ROLE_LABELS, SIGNUP_ROLE_LABELS, type Role } from '../../domain/roles.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { PROJECTION_CONFLICT_MESSAGE } from '../projection.js';
import { requireAuthorizedForPickup, requireCanonicalEntryMessage } from '../permissions.js';
import { renderReplacementNotice, slotLabel } from '../render.js';
import {
  candidateRefusalMessage,
  hasEligibilityRole,
  resolveEligibleUserIds,
  verifyCurrentCandidate,
} from '../eligibility.js';
import { refreshReviewCard, resolveUnresolvedProjections, resyncRosterMessage } from './review.js';

/** Discord allows at most 25 options in a select menu. */
const MAX_SELECT_OPTIONS = 25;

type AnyRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
type ReplaceInteraction = MessageComponentInteraction | ModalSubmitInteraction;

/**
 * Guard wrapper.
 *
 * `requireAuthorizedForPickup` is typed against discord.js's `Interaction`
 * union, which lists the concrete button/select classes rather than the
 * shared `MessageComponentInteraction` base they all extend. Every component
 * interaction we receive is one of those classes at runtime, so this narrowing
 * cast is safe — it only exists to satisfy the union.
 */
function authorize(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  pickup: Pickup,
): Promise<boolean> {
  return requireAuthorizedForPickup(
    interaction as unknown as Parameters<typeof requireAuthorizedForPickup>[0],
    pickup,
  ).then((space) => space !== null);
}

/** Load the pickup a replace action targets, or null if it's gone. */
function loadPickupForAuth(pickupId: number): Pickup | null {
  return new PickupRepository().byId(pickupId);
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
  if (pickup.status === 'finished') {
    return { error: 'That pickup has already finished, so its roster is closed to further changes.' };
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

/**
 * This pickup's signups, the target role's own hoisted to the front.
 *
 * rankReplacementCandidates separates on-role from off-role and nothing else,
 * stably — so this input order is what puts the players who explicitly asked
 * for this role ahead of the Fill players who merely cover it.
 */
function roleFirstSignups(pickupId: number, role: Role): Signup[] {
  const signups = new SignupRepository().forPickup(pickupId);
  return [
    ...signups.filter((signup) => signup.role === role),
    ...signups.filter((signup) => signup.role !== role),
  ];
}

/**
 * "@Name — Solo, Fill", marked when none of those roles cover the seat.
 *
 * Off-role players are offered on purpose (issue #36), but under time pressure
 * this menu is the last thing staff read before confirming, so it must never
 * let one pass for someone who asked to play the role.
 */
function benchOptionLabel(name: string, candidate: ReplacementCandidate): string {
  const roles = candidate.roles.map((role) => SIGNUP_ROLE_LABELS[role]).join(', ');
  return `@${name} — ${roles}${candidate.offRole ? ' · off-role' : ''}`.slice(0, 100);
}

/**
 * Would this replacement place someone outside the roles they signed up for?
 *
 * False for a player with no signups at all: reaching past the signup list
 * entirely is what the emergency search exists for, and treating that as an
 * off-role override would put a warning on every single use of it.
 */
function isOffRole(pickupId: number, role: Role, userId: string): boolean {
  const rostered = new Set(new RosterSlotRepository().userIds(pickupId));
  return rankReplacementCandidates(new SignupRepository().forPickup(pickupId), rostered, role).some(
    (candidate) => candidate.userId === userId && candidate.offRole,
  );
}

/* -------------------------------------------------------------------------- */
/* Component steps                                                            */
/* -------------------------------------------------------------------------- */

export async function handleReplaceComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  const pickup = loadPickupForAuth(decoded.pickupId);
  if (!pickup) {
    await interaction.reply({ content: 'That pickup no longer exists.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Re-checked at EVERY step, not just on the first click. The published roster
  // is visible to the whole server, so the Replace Player button is too.
  if (!(await authorize(interaction, pickup))) return;

  switch (decoded.action) {
    case Action.Replace:
      // Lives directly on the published public roster -- every other action
      // in this switch is an ephemeral continuation of its own and must never
      // be checked this way (issue #35's canonical-message-ID binding; see
      // requireCanonicalEntryMessage's own doc comment).
      if (!(await requireCanonicalEntryMessage(interaction, pickup.rosterMessageId))) return;
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
      await commitReplacement(interaction, decoded.pickupId, Number(slotIdRaw), newUserId);
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
 * Someone who already reacted wanted to play and knows the pickup is happening,
 * so they are the best replacement available — most of all the ones who asked
 * for this exact role, which is why the menu is ordered rather than flat
 * (issue #36). We offer that short list before opening the flow up to the
 * entire server.
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
  let bench = rankReplacementCandidates(roleFirstSignups(pickupId, slot.role), rostered, slot.role);
  if (pickup.eligibilityRoleIds.length > 0) {
    const eligible = interaction.guild
      ? await resolveEligibleUserIds(
          interaction.guild,
          bench.map((candidate) => candidate.userId),
          pickup.eligibilityRoleIds,
        )
      : new Set<string>();
    bench = bench.filter((candidate) => eligible.has(candidate.userId));
  }

  if (bench.length === 0) {
    // Nothing to choose from — skip the empty menu entirely. A modal cannot be
    // shown after deferring, which is why no await touched Discord above.
    await showSearchModal(interaction, pickupId, slotId);
    return;
  }

  await interaction.deferUpdate();

  const benchOptions = [];
  for (const candidate of bench.slice(0, MAX_SELECT_OPTIONS)) {
    const name = await displayNameFor(interaction.guild, candidate.userId);
    benchOptions.push({ label: benchOptionLabel(name, candidate), value: candidate.userId });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.ReplacePickBench, pickupId, slotId))
    .setPlaceholder('Players who signed up for this pickup')
    .addOptions(benchOptions);

  const searchButton = new ButtonBuilder()
    .setCustomId(encodeId(Action.ReplaceSearch, pickupId, slotId))
    .setLabel('Search a different player')
    .setStyle(ButtonStyle.Secondary);

  await interaction.editReply({
    content: `Replacing <@${slot.userId}> at ${slotLabel(slot, pickup.format)}. Signed-up players, role matches first:`,
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
  const pickupId = decoded.pickupId;
  const slotId = Number(decoded.args[0]);

  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.reply({ content: loaded.error, flags: MessageFlags.Ephemeral });
    return;
  }
  const { pickup } = loaded;

  if (!(await authorize(interaction, pickup))) return;

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
        .filter((member) => hasEligibilityRole(member.roles.cache, pickup.eligibilityRoleIds))
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

/**
 * Step 5 — always confirm; this edits a message the whole server can see.
 *
 * An off-role choice has to be confirmed as the override it is, rather than
 * slipping through on the same green button as a player who asked for the
 * role — the same warning semantics the manual seat flow established.
 */
async function sendConfirmation(
  interaction: ReplaceInteraction,
  pickup: Pickup,
  slot: RosterSlot,
  newUserId: string,
): Promise<void> {
  const offRole = isOffRole(pickup.id, slot.role, newUserId);

  const confirm = new ButtonBuilder()
    .setCustomId(encodeId(Action.ReplaceConfirm, pickup.id, slot.id, newUserId, 'yes'))
    .setLabel(offRole ? 'Replace Anyway' : 'Confirm')
    .setStyle(offRole ? ButtonStyle.Danger : ButtonStyle.Success);

  const cancel = new ButtonBuilder()
    .setCustomId(encodeId(Action.ReplaceConfirm, pickup.id, slot.id, newUserId, 'no'))
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  const warning = offRole
    ? `\n\n⚠️ ${ROLE_LABELS[slot.role]} is outside <@${newUserId}>'s declared roles. ` +
      'This replaces them in anyway as a staff override.'
    : '';

  await say(
    interaction,
    `Replace <@${slot.userId}> with <@${newUserId}> at ${slotLabel(slot, pickup.format)}?${warning}`,
    [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)],
  );
}

/** Step 6 — the only step that changes anything anyone else can see. */
async function commitReplacement(
  interaction: MessageComponentInteraction,
  pickupId: number,
  slotId: number,
  newUserId: string | undefined,
): Promise<void> {
  // Acknowledged immediately, before any of the checks below -- verifyCurrentCandidate
  // just below is a real, forced (cache-bypassing) Discord REST call, and Discord
  // invalidates an interaction's token if it goes unacknowledged for 3 seconds
  // (codex review finding on PR #44). Every response from here on is editReply,
  // matching the deferral -- same discipline as seat.ts's commitSeat.
  await interaction.deferUpdate();

  const loaded = loadPublished(pickupId);
  if ('error' in loaded) {
    await interaction.editReply({ content: loaded.error, components: [] });
    return;
  }
  const { pickup } = loaded;

  const slots = new RosterSlotRepository();
  const slot = loadSlot(pickupId, slotId);
  if (!slot || !newUserId) {
    await interaction.editReply({ content: 'That roster slot no longer exists.', components: [] });
    return;
  }

  // Re-check rather than trusting the exclusion done when the list was built:
  // another coordinator may have seated this player somewhere else while this
  // confirmation sat on screen. Nobody may hold two slots.
  if (slots.userIds(pickupId).includes(newUserId)) {
    await interaction.editReply({
      content: `<@${newUserId}> already holds a slot on this roster. Pick someone else.`,
      components: [],
    });
    return;
  }

  // Re-verified unconditionally, not only when eligibility roles are
  // configured -- issue #35's commit-time target revalidation. A departed
  // member or a bot account must never be replaced in regardless of whether
  // this pickup restricts eligibility at all; see verifyCurrentCandidate's
  // own doc comment for why the eligibility-roles-configured gate alone
  // isn't enough.
  const verification = await verifyCurrentCandidate(interaction.guild, newUserId, pickup.eligibilityRoleIds);
  if (!verification.ok) {
    await interaction.editReply({ content: candidateRefusalMessage(verification.reason, newUserId), components: [] });
    return;
  }

  // Re-checked again, synchronously -- verifyCurrentCandidate just above is
  // a real network wait, during which another coordinator could still seat
  // this same player elsewhere; nothing async stands between this read and
  // the claim/write below (codex review finding on PR #44).
  if (slots.userIds(pickupId).includes(newUserId)) {
    await interaction.editReply({
      content: `<@${newUserId}> already holds a slot on this roster. Pick someone else.`,
      components: [],
    });
    return;
  }

  // Issue #35 requirement 7: never layer a new replacement onto a delivery
  // Lucid cannot yet confirm landed -- try to resolve it live first, and
  // refuse rather than proceed if it's still unresolved.
  if (!(await resolveUnresolvedProjections(interaction.client, pickup))) {
    await interaction.editReply({ content: PROJECTION_CONFLICT_MESSAGE, components: [] });
    return;
  }

  // Claim the version first. If someone else edited the roster since this
  // confirmation was rendered, their bump already landed and ours fails, so we
  // refuse instead of overwriting work the clicker never saw. Folded into the
  // same atomic statement: the pickup must still be `published` -- codex
  // review finding on PR #33 -- a plain version bump alone can't see a
  // concurrent Finish, which never touches `version`, the same gap
  // claimVersionIfEditable already closes for a concurrent Publish.
  //
  // The mutation below is the very next line, not merely the next statement
  // that awaits anything: claim and write are both synchronous better-sqlite3
  // calls with nothing async between them, so nothing can interleave and
  // finish the pickup in the gap. See the same discipline in
  // SignupRepository.add's own doc comment.
  if (!new PickupRepository().claimVersionIfPublished(pickup.id, pickup.version)) {
    await interaction.editReply({
      content:
        'Someone else changed this roster a moment ago. Reopen **Replace Player** and try again.',
      components: [],
    });
    return;
  }

  const oldUserId = slot.userId;
  // Team and role are inherited untouched — only the occupant changes.
  // Marked as a staff assignment. A replacement found by member search need
  // never have signed up at all — that is the emergency-sub path working as
  // intended — so this slot must not be treated as a withdrawal afterwards.
  // The audit event AND the notice's own scheduling both happen in the same
  // transaction as the occupant write, not after -- a crash between them
  // could otherwise commit the replacement with no durable record left to
  // ever notify the incoming player (codex review finding on PR #50):
  // startup recovery only redrives EXISTING notification rows, it cannot
  // reconstruct one that was never scheduled.
  getDatabase().transaction(() => {
    slots.setOccupant(slot.id, newUserId, true);
    new PickupEventRepository().record(pickup.id, interaction.user.id, 'player_replaced', {
      slotId: slot.id,
      previousUserId: oldUserId,
      newUserId,
    });
    if (!pickup.rosterChannelId) return;
    new PickupNotificationRepository().schedule({
      pickupId: pickup.id,
      kind: 'replacement_notice',
      // Keyed on the slot AND the version this replacement produced, so one
      // replacement means exactly one notice, while a LATER replacement of
      // the same seat still gets its own.
      dedupeKey: `replacement_notice:${pickup.id}:${slot.id}:${pickup.version + 1}`,
      channelId: pickup.rosterChannelId,
      dueAt: Date.now(),
    });
  })();

  // Re-renders from CURRENT state and durably tracks the attempt (issue #35's
  // delivery recovery) -- replaces this flow's own former inline re-read-
  // then-edit-then-swallow, now shared with startup/interaction-time
  // reconciliation so there is exactly one place that knows how to redraw
  // this surface.
  await resyncRosterMessage(interaction.client, pickup);

  // setOccupant just above clears replacement_needed on the slot this
  // replacement filled (codex review finding on PR #51). Without this, a
  // Replace Player that resolves the LAST flagged seat would leave the staff
  // card stuck showing the expanded "Replacement Needed" view -- with a now-
  // pointless Swap control -- until some unrelated later mutation happened
  // to trigger another refresh. refreshReviewCard re-reads live slot state
  // itself, so this is correct whether this replacement resolved the last
  // flagged seat (the card collapses back to compact) or one of several
  // (it stays expanded, just with one fewer flag).
  await refreshReviewCard(interaction.client, pickup.id);

  await interaction.editReply({
    content: `Done — <@${newUserId}> replaces <@${oldUserId}> at ${slotLabel(slot, pickup.format)}.`,
    components: [],
  });
}
