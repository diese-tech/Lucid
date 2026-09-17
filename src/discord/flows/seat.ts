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

import { getDatabase } from '../../db/index.js';
import { PickupEventRepository } from '../../db/repositories/pickup-events.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import type { Pickup } from '../../db/repositories/types.js';
import { ROLE_LABELS, TEAM_LABELS, isRole, isTeam, type Role, type Team } from '../../domain/roles.js';
import { declaredRoleLabels } from '../render.js';
import { candidateRefusalMessage, verifyCurrentCandidate } from '../eligibility.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { PROJECTION_CONFLICT_MESSAGE } from '../projection.js';
import { requireAuthorizedForPickup, requireCanonicalEntryMessage } from '../permissions.js';
import {
  automaticSlotsOf,
  currentWorkingRoster,
  evaluateRosterReady,
  recordWorkingRosterGenerated,
  resolveUnresolvedProjections,
} from './review.js';

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
      // Lives directly on the persistent control card -- every other action
      // in this switch is an ephemeral continuation of its own and must never
      // be checked this way (issue #35's canonical-message-ID binding; see
      // requireCanonicalEntryMessage's own doc comment).
      if (!(await requireCanonicalEntryMessage(interaction, pickup.reviewMessageId))) return;
      await promptForSlot(interaction, decoded.pickupId);
      return;

    case Action.SeatPickSlot:
      await promptForPlayer(interaction, decoded.pickupId, parseLocationValue(selectedValue(interaction)), 0);
      return;

    case Action.SeatNextPlayerPage: {
      const location = parseLocationArgs(decoded.args);
      const page = Number(decoded.args[2]);
      await promptForPlayer(interaction, decoded.pickupId, location, Number.isInteger(page) ? page : 0);
      return;
    }

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

/**
 * Step 2 — which eligible unseated player goes there.
 *
 * `page` pages through `unseatedUserIds` MAX_SELECT_OPTIONS at a time — a
 * heavily oversubscribed role can leave far more than 25 people waiting, and
 * silently dropping everyone past the first page would make them permanently
 * unreachable through this menu (codex review finding on PR #39). The
 * underlying order is the same deterministic earliest-signup-first order
 * generateWorkingRoster itself uses, so a page's contents stay stable across
 * re-renders as long as the pool itself hasn't changed.
 */
async function promptForPlayer(
  interaction: MessageComponentInteraction,
  pickupId: number,
  location: Location | null,
  page: number,
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

  // A page beyond what the (possibly since-shrunk) pool still has falls back
  // to the first page rather than rendering an empty menu.
  const pageCount = Math.ceil(working.unseatedUserIds.length / MAX_SELECT_OPTIONS);
  const currentPage = page >= 0 && page < pageCount ? page : 0;
  const pageStart = currentPage * MAX_SELECT_OPTIONS;
  const pageOfUsers = working.unseatedUserIds.slice(pageStart, pageStart + MAX_SELECT_OPTIONS);

  const options = [];
  for (const userId of pageOfUsers) {
    const name = await displayNameFor(interaction.guild, userId);
    const roles = declaredRoleLabels(eligibleRecords, userId);
    options.push({ label: `@${name}${roles ? ` — ${roles}` : ''}`.slice(0, 100), value: userId });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId(Action.SeatPickPlayer, pickupId, location.team, location.role))
    .setPlaceholder('Select the player to seat')
    .addOptions(options);

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(menu),
  ];
  if (pageCount > 1) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            encodeId(Action.SeatNextPlayerPage, pickupId, location.team, location.role, (currentPage + 1) % pageCount),
          )
          .setLabel(`Next page (${currentPage + 1}/${pageCount})`)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  await interaction.editReply({
    content: `Filling ${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]}. Eligible unseated signups:`,
    components: rows,
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

  // Acknowledged immediately, before any of the network I/O below —
  // currentWorkingRoster's eligibility resolution and evaluateRosterReady's
  // own control-card redraw can both take a while on a restricted pickup,
  // long enough to blow Discord's 3-second interaction-response deadline if
  // this click were left unacknowledged until the very end (codex review
  // finding on PR #39). Every response from here on is editReply, matching
  // the deferral.
  await interaction.deferUpdate();

  // Re-verified unconditionally, not only when eligibility roles are
  // configured -- issue #35's commit-time target revalidation. Signing up
  // (a reaction) requires being a real, non-bot guild member at that
  // moment, but nothing removes a signup when the signer later leaves --
  // and currentWorkingRoster's own eligibility pass below only re-checks
  // guild membership at all when this pickup has eligibility roles
  // configured. A departed member must never be seated on the strength of a
  // stale signup alone, with or without eligibility roles in play.
  //
  // Deliberately run BEFORE currentWorkingRoster, not after: this is
  // another real network wait, and the working-roster snapshot it captures
  // below must be computed AFTER every such wait has already resolved, not
  // before -- otherwise a concurrent seat/reaction landing during THIS
  // fetch would go unseen by the reconciliation step further down, which
  // trusts that snapshot as current (codex review finding on PR #44).
  const verification = await verifyCurrentCandidate(interaction.guild, userId, pickup.eligibilityRoleIds);
  if (!verification.ok) {
    await interaction.editReply({ content: candidateRefusalMessage(verification.reason, userId), components: [] });
    return;
  }

  // Re-check eligibility fresh — time has passed since confirmation was
  // rendered, and a player who lost their eligibility role or withdrew every
  // reaction in that window must not be seatable anyway. This is a fast,
  // friendly early check, not the actual guarantee: it reads signups BEFORE
  // the network wait below, so a cancellation or withdrawal landing DURING
  // that wait would slip past it — addFixedSlot's own transactional re-check
  // just below is what actually closes that window.
  const { working, fixedSlots } = await currentWorkingRoster(interaction.client, pickup);
  if (!working.unseatedUserIds.includes(userId)) {
    await interaction.editReply({
      content: `<@${userId}> is no longer an eligible unseated signup for this pickup. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }

  // Reconcile the AUTOMATIC portion of the roster to this fresh computation
  // before attempting the insert below. Without this, a player who lost
  // eligibility (or withdrew) without ever changing a reaction leaves their
  // stale automatic row sitting in roster_slots untouched -- nothing but a
  // signup CHANGE triggers evaluateRosterReady's own recompute, so a pure
  // role change alone never clears it. The picker above (built from this
  // same `working`) would then keep advertising that location as open while
  // addFixedSlot's own conflict check keeps finding the stale occupant and
  // refusing the seat, with no way out short of an unrelated signup event
  // (codex review finding on PR #39, round 12). Only ever touches
  // staff_assigned = 0 rows -- a genuine fixed-seat conflict below is
  // unaffected and still refuses correctly.
  //
  // Guarded by a status check read fresh, immediately before, with nothing
  // async in between -- same discipline as pruneAndReadFixedSlots in
  // review.ts. THE DRAFT IS FROZEN once a pickup reaches roster_ready: a
  // concurrent reaction can complete and freeze the roster while
  // currentWorkingRoster's own await above was still resolving, and this
  // call's `working`/`fixedSlots` would then be a stale, partial snapshot
  // computed before that freeze. Writing it unconditionally would delete the
  // now-finalized automatic slots and replace them with the older partial
  // ones -- addFixedSlot's own status check below would then correctly
  // refuse the manual seat, but by then the frozen roster is already
  // corrupted, with nothing left to ever regenerate it (codex review finding
  // on PR #39, round 13).
  if (new PickupRepository().byId(pickup.id)?.status === 'open') {
    // Live read is correct here (unlike review.ts's own callers, which must
    // capture "before" ahead of their own prune call) -- nothing between
    // currentWorkingRoster's return above and this line mutates roster_slots,
    // so nothing has silently moved the baseline out from under this read.
    const before = new RosterSlotRepository()
      .forPickup(pickup.id)
      .map((slot) => ({ team: slot.team, role: slot.role, userId: slot.userId }));
    recordWorkingRosterGenerated(pickup.id, working, before, fixedSlots, automaticSlotsOf(working, fixedSlots));
  }

  // Issue #35 requirement 7: never layer a new manual seating onto a
  // delivery Lucid cannot yet confirm landed -- try to resolve it live
  // first, and refuse rather than proceed if it's still unresolved. Reads
  // the pickup fresh, matching the same discipline as the block just above.
  const currentPickup = new PickupRepository().byId(pickup.id) ?? pickup;
  if (!(await resolveUnresolvedProjections(interaction.client, currentPickup))) {
    await interaction.editReply({ content: PROJECTION_CONFLICT_MESSAGE, components: [] });
    return;
  }

  // The actual write, plus its own fresh re-check of pickup status, the
  // player's signup, and both seat conflicts, all inside one synchronous
  // transaction — see RosterSlotRepository.addFixedSlot. The audit event is
  // written in the SAME outer transaction, only when the seat actually landed,
  // so a crash between the two can never leave one without the other.
  const outcome = getDatabase().transaction(() => {
    const result = new RosterSlotRepository().addFixedSlot(pickup.id, location.team, location.role, userId);
    if (result.status === 'added') {
      new PickupEventRepository().record(pickup.id, interaction.user.id, 'player_seated', {
        team: location.team,
        role: location.role,
        userId,
      });
    }
    return result;
  })();
  if (outcome.status === 'pickup_not_open') {
    await interaction.editReply({
      content: 'This pickup is no longer collecting a working roster. Nothing was seated.',
      components: [],
    });
    return;
  }
  if (outcome.status === 'user_withdrawn') {
    await interaction.editReply({
      content: `<@${userId}> withdrew their signup a moment ago and can no longer be seated. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }
  if (outcome.status === 'location_taken') {
    await interaction.editReply({
      content: `${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]} was just filled. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }
  if (outcome.status === 'user_already_rostered') {
    await interaction.editReply({
      content: `<@${userId}> already holds a seat on this roster. Reopen **Seat Player** and try again.`,
      components: [],
    });
    return;
  }

  // Redraws the control card around the new fixed slot, or freezes into
  // roster_ready and posts the review card if this placement completes it —
  // the exact same path every other signup change takes. Run BEFORE the
  // confirmation reply below, not after: the seat is already committed to
  // the database at this point, and that shared state matters to every
  // other staff member regardless of whether this one ephemeral reply can
  // still be delivered (codex review finding on PR #39) — a failure in the
  // confirmation below must never skip it.
  //
  // Caught, not propagated: this interaction was already deferred above, so
  // an uncaught throw here would skip the confirmation reply just below AND
  // reach the router's own catch too late to send its own fallback (that
  // fallback only fires when the interaction is neither replied NOR
  // deferred). Without this, a transient failure in the shared card's own
  // Discord call would leave the coordinator staring at a permanently
  // "failed" interaction despite their seat having genuinely committed
  // (codex review finding on PR #39).
  let refreshFailed = false;
  try {
    await evaluateRosterReady(interaction.client, pickup.id);
  } catch (error) {
    refreshFailed = true;
    console.error('[seat] evaluateRosterReady failed after a successful manual seat', error);
  }

  // evaluateRosterReady just ran its OWN independent eligibility lookup, a
  // real network round-trip separate from the one currentWorkingRoster did a
  // moment ago to build this very picker -- the player can genuinely have
  // lost the pickup's eligibility role in the gap between the two, in which
  // case that evaluation correctly pruned the seat this call just placed.
  // Confirming "seated" unconditionally here would tell the coordinator
  // something the database no longer agrees with (codex review finding on
  // PR #39) -- re-check before claiming success.
  const stillSeated = new RosterSlotRepository()
    .forPickup(pickup.id)
    .some((slot) => slot.team === location.team && slot.role === location.role && slot.userId === userId);

  const refreshNote = refreshFailed
    ? ' (The shared roster card could not be refreshed just now — it will catch up on the next signup change.)'
    : '';
  const content = stillSeated
    ? `Done — <@${userId}> is seated at ${TEAM_LABELS[location.team]} — ${ROLE_LABELS[location.role]}.${refreshNote}`
    : `<@${userId}> was seated, but the roster refresh immediately found them no longer eligible and removed the seat. Reopen **Seat Player** and try again.`;
  await interaction.editReply({ content, components: [] }).catch(() => undefined);
}
