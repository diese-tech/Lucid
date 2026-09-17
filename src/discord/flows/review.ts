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
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
} from 'discord.js';
import { getDatabase } from '../../db/index.js';
import { PickupEventRepository } from '../../db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../../db/repositories/pickup-notifications.js';
import { PickupProjectionRepository } from '../../db/repositories/pickup-projections.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import { SignupRepository } from '../../db/repositories/signups.js';
import type { Pickup, PickupProjectionUpdate, RosterSlot } from '../../db/repositories/types.js';
import { ROLES, ROLE_LABELS, TEAMS, isRole } from '../../domain/roles.js';
import {
  generateDifferentRoster,
  generateRoster,
  generateWorkingRoster,
  locationKey,
  rosterFingerprint,
  type SignupRecord,
  type SlotAssignment,
  type WorkingRosterResult,
} from '../../domain/roster.js';
import { discordRelative, discordShortTime } from '../../domain/time.js';
import { controlCardRows, publishedRosterRows, reviewCardRows } from '../components.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { requireAuthorizedForPickup, requireCanonicalEntryMessage } from '../permissions.js';
import {
  candidateRefusalMessage,
  eligibilityRolesExist,
  eligibleSignupRecordsChecked,
  resolveEligibleUserIds,
  resolveEligibleUserIdsChecked,
  verifyCurrentCandidate,
} from '../eligibility.js';
import { findOrRepost } from '../message-recovery.js';
import { PROJECTION_CONFLICT_MESSAGE, projectSurface } from '../projection.js';
import { textChannel } from '../channels.js';
import {
  reconciliationMarker,
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
  if (!pickup.reviewMessageId || !pickup.reviewChannelId) return null;

  try {
    const channel = await client.channels.fetch(pickup.reviewChannelId);
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

/** Why the control card can't show a normal readiness reading right now. */
export type EligibilityError = 'role-missing' | 'lookup-failed';

/**
 * Resolve a pickup's signup pool down to currently-eligible players, plus
 * whether staff need to see an error instead of a normal readiness reading.
 *
 * One guild fetch serves both underlying checks. The two failure modes are
 * NOT the same fact and must not be reported identically: 'role-missing'
 * means Lucid successfully checked and the role is genuinely gone (a staff
 * configuration problem); 'lookup-failed' means Lucid couldn't check at all
 * (a transient API error) and the eligible count is NOT a confirmed zero,
 * even though it renders as one — collapsing the two would make a temporary
 * hiccup look like an empty signup pool, or worse, like broken config.
 */
async function eligibilityContext(
  client: Client,
  pickup: Pick<Pickup, 'guildId' | 'eligibilityRoleIds'>,
  records: SignupRecord[],
): Promise<{ eligibleRecords: SignupRecord[]; eligibilityError: EligibilityError | null }> {
  if (pickup.eligibilityRoleIds.length === 0) return { eligibleRecords: records, eligibilityError: null };

  try {
    const guild = await client.guilds.fetch(pickup.guildId);
    const [roleLookup, memberLookup] = await Promise.all([
      eligibilityRolesExist(guild, pickup.eligibilityRoleIds),
      resolveEligibleUserIdsChecked(guild, records.map((record) => record.userId), pickup.eligibilityRoleIds),
    ]);

    // A confirmed 'missing' role is reported even if the member lookup also
    // failed — it's the more actionable of the two. An unresolved role
    // lookup ('unknown') must never fall through to 'role-missing' just
    // because roleLookup !== 'exists'; check for the confirmed negative
    // explicitly instead of treating anything-but-exists as gone.
    if (roleLookup === 'missing') return { eligibleRecords: [], eligibilityError: 'role-missing' };
    if (roleLookup === 'unknown' || !memberLookup.ok) {
      return { eligibleRecords: [], eligibilityError: 'lookup-failed' };
    }
    return {
      eligibleRecords: records.filter((record) => memberLookup.eligible.has(record.userId)),
      eligibilityError: null,
    };
  } catch {
    // The guild fetch itself failed — Lucid checked nothing, so this can
    // only be 'lookup-failed', never a confirmed 'role-missing'.
    return { eligibleRecords: [], eligibilityError: 'lookup-failed' };
  }
}

async function ineligibleRosterUserIds(client: Client, pickup: Pickup): Promise<Set<string>> {
  if (pickup.eligibilityRoleIds.length === 0) return new Set();
  const slots = new RosterSlotRepository().forPickup(pickup.id);
  try {
    const guild = await client.guilds.fetch(pickup.guildId);
    const eligible = await resolveEligibleUserIds(
      guild, slots.map((slot) => slot.userId), pickup.eligibilityRoleIds,
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
  const ticket = drawReviewCardTicket(pickupId);

  const pickup = new PickupRepository().byId(pickupId);
  if (!pickup) return;

  const ineligible = await ineligibleRosterUserIds(client, pickup);

  const message = await fetchStaffMessage(client, pickup);
  if (!message) return;

  // Re-read immediately before the write, not any earlier: ineligibleRosterUserIds
  // and fetchStaffMessage above are real network waits another call to this same
  // function can race past -- e.g. a reaction-triggered refresh started here can
  // still be resolving these while staff completes an Edit Roster commit and its
  // own (faster) refresh already shows the new occupant. Re-reading the pickup,
  // its slots, and its withdrawals right here means this call's content always
  // reflects genuinely-current state rather than whatever was true when it
  // started. The ticket check right after catches the remaining case: this
  // call's own edit was itself drawn from a snapshot older than one a newer,
  // still-in-flight call already committed.
  const current = new PickupRepository().byId(pickupId);
  if (!current) return;

  // THE PICKUP IS CANCELLED. cancel.ts's writeCancelledMessages is the sole
  // owner of this message's content from that point on -- it writes
  // directly, with no ticket coordination of its own, so a refresh already
  // in flight when a cancellation lands can resume afterward and reach this
  // point anyway. renderReviewCard has no cancelled-specific rendering at
  // all (unlike 'finished', which gets an explicit banner), so writing here
  // would silently replace the correct "Cancelled" content with a stale
  // "Pickup Ready" one, even though the buttons happen to still read
  // correctly disabled since that part is computed from this same fresh
  // status read. Defer to cancel's own write instead of racing it (codex
  // review finding on PR #39, round 9).
  if (current.status === 'cancelled') return;

  const slots = new RosterSlotRepository().forPickup(pickupId);
  const withdrawn = withdrawnUserIds(pickupId);

  if (reviewCardTicket.get(pickupId) !== ticket) return;

  // Durably tracked, not a bare edit -- issue #35's delivery recovery. Every
  // staff mutation funnels its 'review' surface redraw through this one
  // function, so instrumenting it here covers Seat Player, Shuffle, and every
  // Edit Roster action without touching each of their commit sites.
  const status = await projectSurface({
    pickupId: current.id,
    surface: 'review',
    messageId: current.reviewMessageId,
    edit: () =>
      message.edit({
        content: renderReviewCard(current, slots, {
          withdrawnUserIds: withdrawn,
          ineligibleUserIds: ineligible,
          // codex review finding on PR #33: this refresh can still be resolving
          // (e.g. a reaction-triggered one, awaiting Discord) when a concurrent
          // Finish completes -- without this, its edit would disable the
          // buttons correctly but drop the finished note the same edit is
          // supposed to be adding.
          finished: current.status === 'finished',
        }),
        components: reviewCardRows(current.id, current.version, {
          // 'cancelled' never reaches here -- see the early return above.
          disabled: current.status === 'published' || current.status === 'finished',
          // Publish is greyed out, not merely refused, so staff can see at a glance
          // why they cannot publish yet.
          publishBlocked: withdrawn.size > 0 || ineligible.size > 0,
        }),
        allowedMentions: SILENT,
      }),
  });
  // Restores this function's pre-existing propagate-on-failure contract --
  // projectSurface itself never throws (it durably records the attempt
  // either way), but several callers (commitSeat among them) specifically
  // catch a throw from this function to know their own mutation committed
  // even though the shared card could not be confirmed refreshed.
  if (status !== 'applied') throw new Error(`refreshReviewCard: 'review' surface left ${status}`);
}

/**
 * Per-pickup counter guarding refreshReviewCard the same way controlCardTicket
 * guards the pre-roster card -- see that map's doc comment for the underlying
 * mechanism (draw before the first await, only the most recent ticket holder
 * may act). Kept as a SEPARATE map because the two guard different messages
 * with different lifetimes: controlCardTicket's entries are deleted once a
 * pickup leaves `open`, since no control card is ever written again after
 * that. A pickup's review card, by contrast, can be redrawn indefinitely after
 * that point -- Shuffle, every Edit Roster commit, Publish/PublishBack, a
 * stale-version click -- so there is no safe moment to delete an entry here.
 * That is a deliberate tradeoff, not an oversight: one integer per pickup ever
 * created is not memory pressure worth chasing, and losing it on restart is
 * exactly as harmless as every other in-memory map in this file.
 */
const reviewCardTicket = new Map<number, number>();

function drawReviewCardTicket(pickupId: number): number {
  const ticket = (reviewCardTicket.get(pickupId) ?? 0) + 1;
  reviewCardTicket.set(pickupId, ticket);
  return ticket;
}

/**
 * Per-pickup counter guarding against a superseded evaluation acting on
 * stale data — whether that's writing the control card, or freezing a
 * roster_ready draft from a pool that has since changed.
 *
 * Two reactions on the same restricted, still-open pickup can each start an
 * evaluation whose eligibility lookup (a real network round-trip) then
 * completes in EITHER order. Without this, whichever one happens to finish
 * last wins, even if it started first and is now working from an older
 * signup snapshot than the other evaluation already acted on — e.g. an
 * evaluation that saw a since-completed roster as feasible could still
 * freeze it after a newer evaluation already saw the same player withdraw
 * again. Each caller draws a ticket before starting its lookup; only the
 * holder of the most recently drawn ticket for that pickup is allowed to act
 * on its result. Deliberately in-memory and never persisted — like the
 * drafts/bindSessions maps elsewhere in this codebase, losing it on restart
 * is harmless (there are no in-flight evaluations to protect immediately
 * after one). Entries are removed once a pickup leaves `open` (see the two
 * delete() calls below); until then the map holds at most one entry per
 * currently-open pickup, not one per reaction, so it does not grow with
 * reaction volume.
 */
const controlCardTicket = new Map<number, number>();

function drawControlCardTicket(pickupId: number): number {
  const ticket = (controlCardTicket.get(pickupId) ?? 0) + 1;
  controlCardTicket.set(pickupId, ticket);
  return ticket;
}

/** currentFixedSlots' `eligibleUserIds` input: null exactly when eligibility couldn't be confirmed this round. */
function eligibleUserIdsOrNull(
  eligibleRecords: SignupRecord[],
  eligibilityError: EligibilityError | null,
): ReadonlySet<string> | null {
  return eligibilityError ? null : new Set(eligibleRecords.map((r) => r.userId));
}

/**
 * Every hand-placed (staff-assigned) seat currently on this pickup's roster,
 * shaped as generateWorkingRoster's `fixedSlots` input. Pure read, no side
 * effects — safe to call from anywhere, at any staleness, at any time.
 *
 * Used by currentWorkingRoster (see its own doc comment for why): that
 * function is documented as callable without a ticket, purely to build
 * seat.ts's pickers, so nothing it calls may mutate roster_slots. A moment of
 * staleness here — a since-ineligible occupant still shown seated for one
 * picker render — is harmless and self-corrects on the very next call.
 */
function readFixedSlots(pickupId: number): SlotAssignment[] {
  return new RosterSlotRepository()
    .forPickup(pickupId)
    .filter((slot) => slot.staffAssigned)
    .map((slot) => ({ team: slot.team, role: slot.role, userId: slot.userId }));
}

/**
 * Same as readFixedSlots, but first prunes any hand-placed seat whose
 * occupant has failed `eligibleUserIds` — i.e. withdrawn their last signup or
 * lost the pickup's eligibility role since being manually placed. Pruning
 * that stale row here — not just excluding it from the return value — is
 * load-bearing: leaving it in the database would keep its location
 * permanently unavailable to everyone else too, both to the automatic
 * matcher and to a later Seat Player placement, via the very
 * UNIQUE(pickup_id, team, role) constraint that's supposed to prevent
 * double-booking a seat that's actually still open (codex review finding on
 * PR #39).
 *
 * `eligibleUserIds` is `null` when eligibility could not be confirmed this
 * round (eligibilityContext's error state) — `eligibleRecords` is then an
 * intentionally empty fail-closed set for NEW signups, not a confirmed "no
 * one qualifies" for players ALREADY placed. Pruning against that empty set
 * would delete every manually-placed seat over a transient Discord hiccup,
 * with no way to bring them back once gone. Skip pruning entirely in that
 * state instead — every existing fixed slot stands as-is until eligibility
 * can genuinely be re-confirmed (codex review finding on PR #39).
 *
 * DESTRUCTIVE — only call this from a path that has already re-validated, in
 * the same synchronous stretch as this call with nothing async in between,
 * that (a) the pickup is still confirmably `open` (THE DRAFT IS FROZEN once a
 * pickup reaches roster_ready — see evaluateRosterReady's own doc comment)
 * and (b) this evaluation still holds the most recently drawn
 * controlCardTicket for it. Without (a), a slower evaluation resuming after a
 * faster one already froze the roster could delete a staff-assigned seat from
 * an already-frozen draft (codex review finding on PR #39, round 4). Without
 * (b), a stale/superseded evaluation whose lookup simply took longer than a
 * newer one could still delete a currently-valid manually-placed seat using
 * an outdated snapshot even while the pickup remains `open` throughout —
 * (a) alone does not catch this, because status never changes in that case
 * (codex review finding on PR #39, round 5). writeControlCard and
 * evaluateRosterReady both check (b) immediately before calling this — (a) is
 * enforced internally, above. Both are the only two functions that ever draw
 * a controlCardTicket at all; do not add a third, independent ticket-drawing
 * caller of this (or of drawControlCardTicket) without first reading
 * currentWorkingRoster's own doc comment on review.ts, which explains why a
 * second, differently-timed ticket source silently breaks the first one's
 * ordering guarantee (codex review finding on PR #41, round 15).
 */
/**
 * The prune's DELETE and the audit event describing it commit in the SAME
 * transaction (issue #35, codex review finding on PR #42, round 4): the
 * DELETE used to run as its own already-committed statement, well before
 * whatever eventually called recordWorkingRosterGenerated -- a crash, or a
 * thrown error in the real async work (fetchStaffMessage's Discord call, in
 * writeControlCard's case) landing in that gap could leave a seat gone from
 * the database forever with no event ever describing why. Recording it here,
 * atomically with the delete itself, closes that gap regardless of what
 * happens afterward in the caller -- independent of, and in addition to, the
 * later recordWorkingRosterGenerated event describing the resulting full
 * roster once the automatic recompute finishes.
 */
function pruneAndReadFixedSlots(pickupId: number, eligibleUserIds: ReadonlySet<string> | null): SlotAssignment[] {
  if (eligibleUserIds && new PickupRepository().byId(pickupId)?.status === 'open') {
    const db = getDatabase();
    db.transaction(() => {
      const before = readFixedSlots(pickupId);
      new RosterSlotRepository(db).pruneStaleFixedSlots(pickupId, eligibleUserIds);
      const after = readFixedSlots(pickupId);
      if (rosterFingerprint(before) !== rosterFingerprint(after)) {
        new PickupEventRepository(db).record(pickupId, null, 'working_roster_generated', {
          prunedStaleFixedSlots: true,
          fixedSlots: after,
        });
      }
    })();
  }
  return readFixedSlots(pickupId);
}

/** The portion of a working roster's slots this recompute actually owns writing. */
export function automaticSlotsOf(working: { slots: SlotAssignment[] }, fixedSlots: SlotAssignment[]): SlotAssignment[] {
  const fixedKeys = new Set(fixedSlots.map((slot) => locationKey(slot)));
  return working.slots.filter((slot) => !fixedKeys.has(locationKey(slot)));
}

/**
 * Persist a recomputed automatic roster and record the durable audit event
 * describing it (issue #35) in the SAME transaction, so a crash between the
 * two can never leave one without the other. Shared by writeControlCard
 * (still-collecting/error redraws) and evaluateRosterReady (the freeze-time
 * recompute) — both are automatic regenerations triggered by a signup
 * reaction, not a staff click, so actor is always null here; see
 * PickupEventType's own doc comment.
 *
 * The event payload carries the full CURRENT roster -- `fixedSlots` AND
 * `automaticSlots` together, not just the automatic portion or a count.
 * replaceWorkingRoster deletes and recreates every automatic row on each
 * call, so the CURRENT roster_slots table only ever reflects the latest
 * generation; without the actual assignments in the event itself, the next
 * regeneration or Shuffle would permanently erase who occupied which seat in
 * this one. `fixedSlots` specifically matters too: pruneAndReadFixedSlots can
 * have already deleted a stale staff-assigned seat (an occupant who withdrew
 * or lost eligibility) by the time this runs, and a payload that only ever
 * recorded automatic slots would never show that a location became vacant
 * because of a prune, not because nobody was ever seated there (codex review
 * findings on PR #42).
 *
 * Records NOTHING -- neither the slot write nor the event -- when the
 * resulting roster is identical to what's already persisted: every step of
 * Seat Player's picker re-runs a full evaluateRosterReady as a pre-warm (see
 * currentWorkingRoster's own doc comment), which reaches this function on
 * every menu step even when nothing has actually changed. Without this
 * check, simply opening the picker on an incomplete restricted pickup would
 * flood the audit trail with duplicate null-actor events describing no real
 * mutation at all (codex review finding on PR #42).
 *
 * `before` MUST be captured by the caller before it calls
 * pruneAndReadFixedSlots (directly, or indirectly through this same
 * evaluation) -- not read fresh from the database in here. A prune's DELETE
 * is its own already-committed statement, run before this function is ever
 * invoked, so reading "before" from the database at this point would already
 * reflect that prune's result; comparing it against `after` (which also
 * reflects the same prune, via `fixedSlots`) would then see no difference at
 * all and silently skip recording a real, meaningful mutation -- the exact
 * gap this function's fixedSlots handling exists to close (codex review
 * finding on PR #42).
 */
export function recordWorkingRosterGenerated(
  pickupId: number,
  working: WorkingRosterResult,
  before: SlotAssignment[],
  fixedSlots: SlotAssignment[],
  automaticSlots: SlotAssignment[],
): void {
  const db = getDatabase();
  db.transaction(() => {
    const slotRepo = new RosterSlotRepository(db);
    const after = [...fixedSlots, ...automaticSlots];
    if (rosterFingerprint(before) === rosterFingerprint(after)) return;

    slotRepo.replaceWorkingRoster(pickupId, automaticSlots);
    new PickupEventRepository(db).record(pickupId, null, 'working_roster_generated', {
      complete: working.complete,
      slots: after,
      unseatedUserIds: working.unseatedUserIds,
    });
  })();
}

/**
 * Write the control card from an ALREADY-RESOLVED eligibility snapshot.
 *
 * Takes the snapshot as a parameter, rather than resolving eligibility
 * itself, purely so evaluateRosterReady can reuse the one lookup it already
 * did for the completeness check instead of resolving membership a second
 * time independently. Two separate lookups are two separate snapshots of
 * Discord state — a role granted (or a transient failure on only one of
 * them) in the gap between them could make the completeness check and the
 * rendered card disagree, e.g. the evaluator leaving the pickup `open` while
 * the card it draws right after claims a complete roster. Passing one
 * snapshot through closes that gap entirely rather than narrowing it.
 *
 * Also OWNS persisting the recomputed working roster: fixedSlots is read
 * fresh and the automatic slots written here, in the same synchronous stretch
 * as the ticket/status re-check right below — nothing async separates the
 * read from the write, so a concurrent Seat Player commit can only ever land
 * strictly before or strictly after this call, never during it.
 */
async function writeControlCard(
  client: Client,
  pickup: Pickup,
  eligibleRecords: SignupRecord[],
  eligibilityError: EligibilityError | null,
  ticket: number,
  beforeSlots: SlotAssignment[],
): Promise<void> {
  const message = await fetchStaffMessage(client, pickup);
  if (!message) return;

  // Re-checked immediately before the write, not any earlier: `pickup` can be
  // stale by now — eligibilityContext's guild/role/member fetches and the
  // fetchStaffMessage call just above are all real network waits staff can
  // act during (Cancel, most obviously). Writing a "Pickup Open" card with a
  // live Cancel button over a message that already shows cancelled would
  // silently resurrect controls for a pickup the database says is dead.
  const current = new PickupRepository().byId(pickup.id);
  if (!current || current.status !== 'open') {
    controlCardTicket.delete(pickup.id);
    return;
  }

  // A newer evaluation (a later reaction on the same pickup) has already
  // drawn a ticket, meaning this one's `eligibleRecords` is now stale — that
  // newer evaluation owns the next write. Writing anyway here would let the
  // older snapshot overwrite it, undoing signups that already landed.
  if (controlCardTicket.get(pickup.id) !== ticket) return;

  const fixedSlots = pruneAndReadFixedSlots(current.id, eligibleUserIdsOrNull(eligibleRecords, eligibilityError));
  const working = generateWorkingRoster(eligibleRecords, current.format, { fixedSlots });
  recordWorkingRosterGenerated(current.id, working, beforeSlots, fixedSlots, automaticSlotsOf(working, fixedSlots));

  // Durably tracked -- see refreshReviewCard's matching comment; this is the
  // other of the two functions every staff/automatic 'review' surface redraw
  // funnels through.
  const status = await projectSurface({
    pickupId: current.id,
    surface: 'review',
    messageId: current.reviewMessageId,
    edit: () =>
      message.edit({
        content: renderControlCard(current, working, eligibleRecords, { eligibilityError }),
        components: controlCardRows(current.id, {
          seatPlayerEnabled: !working.complete && working.unseatedUserIds.length > 0,
        }),
        allowedMentions: SILENT,
      }),
  });
  // See refreshReviewCard's matching comment -- restores this function's
  // pre-existing propagate-on-failure contract.
  if (status !== 'applied') throw new Error(`writeControlCard: 'review' surface left ${status}`);
}

export interface CurrentWorkingRoster {
  working: WorkingRosterResult;
  eligibleRecords: SignupRecord[];
  eligibilityError: EligibilityError | null;
  fixedSlots: SlotAssignment[];
}

/**
 * The working roster exactly as staff currently see it on the control card —
 * same eligibility resolution, same fixed-slot snapshot, computed the same
 * way writeControlCard computes its own. Used by flows/seat.ts to build its
 * slot/player pickers from that identical state rather than recomputing
 * independently and risking the two disagreeing about what's open.
 *
 * Calls evaluateRosterReady FIRST, unconditionally, before reading anything
 * itself — this is the second attempt at letting Seat Player reclaim a fixed
 * seat whose occupant lost eligibility without ever changing a reaction (see
 * migration history below); the first attempt made this function draw its
 * own controlCardTicket to gate a direct prune, which reused the SAME ticket
 * pool evaluateRosterReady itself relies on to know whether it's still the
 * most recent evaluation. That let a Seat Player click silently steal an
 * in-flight evaluateRosterReady's ticket: the evaluation would correctly see
 * itself superseded and defer "the newer ticket holder will finish the job,"
 * but the newer ticket holder was this function, which never redraws the
 * control card or completes a newly-finished roster — so a genuinely
 * complete pickup could stay stuck `open` indefinitely with a stale control
 * card, until an unrelated signup event happened to trigger a real
 * evaluation again (codex review finding on PR #41, round 15).
 *
 * Delegating to evaluateRosterReady instead sidesteps the whole class of
 * problem: it is the ONE function that ever draws a controlCardTicket, so
 * there is no second ticket pool to desynchronize from it, and every call
 * here gets its full, already-battle-tested guarantees (ticket-ordered,
 * status-guarded, never touches an already-frozen draft) for free, INCLUDING
 * pruning a stale fixed seat as a side effect of its ordinary redraw. What
 * follows below is then a plain, side-effect-free read against whatever
 * state that call left behind — this function itself makes no claim and
 * blocks behind nothing, exactly as it always has; it just no longer tries
 * to duplicate evaluateRosterReady's own prune logic under weaker
 * coordination. A slightly heavier cost (a second eligibility lookup makes
 * every Seat Player step do two Discord round-trips instead of one) buys
 * genuine correctness instead of a second, subtly incompatible ticket
 * scheme.
 */
export async function currentWorkingRoster(client: Client, pickup: Pickup): Promise<CurrentWorkingRoster> {
  // Caught, not propagated: this is a best-effort pre-warm, and every caller
  // (seat.ts's picker-building steps, commitSeat) tolerates the read below
  // being slightly stale already. Letting a transient failure here (a
  // Discord edit rejecting inside evaluateRosterReady's own card refresh)
  // propagate would abort the ENTIRE picker/commit flow over a problem that
  // has nothing to do with what the caller actually asked for.
  try {
    await evaluateRosterReady(client, pickup.id);
  } catch (error) {
    console.error('[review] evaluateRosterReady pre-warm failed inside currentWorkingRoster', error);
  }
  const records = new SignupRepository().recordsForPickup(pickup.id);
  const { eligibleRecords, eligibilityError } = await eligibilityContext(client, pickup, records);
  const fixedSlots = readFixedSlots(pickup.id);
  const working = generateWorkingRoster(eligibleRecords, pickup.format, { fixedSlots });
  return { working, eligibleRecords, eligibilityError, fixedSlots };
}

/**
 * Locate the canonical public roster message, recovering it via marker
 * search/repost first if it's missing entirely -- either because
 * `handlePublishConfirm`'s own send never landed a message ID (a failed or
 * uncertain first publish), or because the message Lucid HAD recorded was
 * confirmed deleted out from under it.
 *
 * Without this fallback, either case leaves `pickup_projection_updates`
 * carrying a 'roster' row that can NEVER resolve: a null ID never gets
 * anything to edit, and a stale-but-non-null ID just fails the same fetch
 * forever -- which does not merely leave the card stale, it permanently
 * refuses every future Replace Player/Finish for this pickup, since
 * `resolveUnresolvedProjections` treats that unresolved row as blocking
 * (codex review findings on PR #46). Marker search first, exactly like
 * reconcile.ts's own `ensureRosterMessage`, is what makes reposting safe --
 * see message-recovery.ts's own doc comment.
 */
async function resolveRosterMessage(
  client: Client,
  channel: GuildTextBasedChannel,
  pickup: Pickup,
): Promise<Message | null> {
  if (pickup.rosterMessageId) {
    try {
      return await channel.messages.fetch(pickup.rosterMessageId);
    } catch (error) {
      const confirmedGone =
        error instanceof DiscordAPIError &&
        (error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownChannel);
      // Anything else (a rate limit, a timeout) is not a confirmed absence --
      // rethrow so the caller's projectSurface classifies it as 'uncertain'
      // rather than this function guessing it's safe to search/repost.
      if (!confirmedGone) throw error;
    }
  }

  const slots = new RosterSlotRepository().forPickup(pickup.id);
  const finished = pickup.status === 'finished';
  const found = await findOrRepost(
    channel,
    client,
    reconciliationMarker('roster', pickup.id),
    // Never later than this pickup's own creation -- the roster can never
    // have been posted before the pickup existed. Same reasoning as
    // reconcile.ts's ensureReviewMessage/ensureRosterMessage.
    pickup.createdAt,
    () =>
      channel.send({
        content: renderPublicRoster(pickup, slots, { finished }),
        components: publishedRosterRows(pickup.id, { disabled: finished }),
        allowedMentions: { parse: ['users'] },
      }),
  );
  if (found && found.id !== pickup.rosterMessageId) {
    new PickupRepository().setMessageIds(pickup.id, { rosterMessageId: found.id });
  }
  return found;
}

/**
 * Re-render a published/finished pickup's public roster message from CURRENT
 * state and attempt to edit it in place, durably tracking the attempt (issue
 * #35's delivery recovery). This is the one place that redraws the 'roster'
 * surface -- commitReplacement's own post-mutation edit and
 * startup/interaction-time reconciliation all call this rather than each
 * carrying their own copy of the render-and-edit logic.
 *
 * A no-op only when there is no configured roster channel at all -- a
 * missing or confirmed-deleted message ID is recovered via
 * `resolveRosterMessage` above, not treated as nothing to do.
 */
export async function resyncRosterMessage(client: Client, pickup: Pickup): Promise<void> {
  // Read fresh, not the possibly-stale `pickup` a caller is holding -- but
  // NOT relied on for the write itself; see the re-read inside `edit` below.
  const initial = new PickupRepository().byId(pickup.id) ?? pickup;
  if (!initial.rosterChannelId) return;

  const channel = await textChannel(client, initial.rosterChannelId);
  if (!channel) return;

  await projectSurface({
    pickupId: initial.id,
    surface: 'roster',
    messageId: initial.rosterMessageId,
    edit: async () => {
      const message = await resolveRosterMessage(client, channel, initial);
      if (!message) throw new Error('Could not locate or repost the canonical roster message.');

      // Re-read immediately before the write, not any earlier -- codex
      // review findings on PR #33, three rounds running: textChannel and
      // resolveRosterMessage above are each real network waits a concurrent
      // Finish confirmation can complete during, *after* whatever mutation
      // this resync follows already safely landed. Putting the re-read here,
      // with nothing left to await before the edit call itself, is what
      // actually closes that gap -- the same discipline
      // writeControlCard/refreshReviewCard already follow for this exact
      // class of bug. Harmless even when resolveRosterMessage just reposted:
      // this second edit against content it only just sent is a no-op in
      // the common case, and guarantees this write reflects genuinely
      // current state either way.
      const current = new PickupRepository().byId(initial.id) ?? initial;
      const slots = new RosterSlotRepository().forPickup(current.id);
      const finished = current.status === 'finished';

      await message.edit({
        content: renderPublicRoster(current, slots, { finished }),
        components: publishedRosterRows(current.id, { disabled: finished }),
      });
    },
  });
}

/**
 * Attempt to resolve an unresolved 'roster' delivery attempt for this
 * pickup's CURRENT version before a new mutation is allowed to layer on top
 * of it -- issue #35's requirement that conflicting mutations be
 * blocked/serialized while a projection recovery is outstanding, rather than
 * compounding an already-uncertain delivery with a second change nobody
 * could later reconcile safely.
 *
 * Deliberately does NOT consider the 'review' surface, even though it goes
 * through the same durable tracking (projectSurface, in writeControlCard and
 * refreshReviewCard): every write to that surface is an edit-in-place
 * against an already-known message ID, and refreshReviewCard's own ticket
 * ordering (reviewCardTicket) already stops a slower, superseded redraw from
 * ever clobbering a newer one -- there is no genuine duplicate-post or
 * stale-overwrite risk left for a fresh mutation to make "unsafe to
 * recover". Blocking on it anyway would actively fight several flows' own
 * documented design: a broken/uncertain review-card refresh must never stop
 * a legitimate roster mutation from committing (see e.g. commitSeat in
 * seat.ts). 'roster' surface writes carry the real risk this guards against
 * instead -- handlePublishConfirm's first send can genuinely duplicate-post,
 * and commitReplacement has no ticket-equivalent ordering guard of its own,
 * so two concurrent replacements' edits could otherwise complete out of
 * order and let a slower, stale one clobber a newer one's content. 'signup'
 * is excluded too: it is written exactly once, by Cancel, which is itself
 * always one of these guarded commit points, and cancellation is terminal.
 *
 * Returns true once nothing is left unresolved for this version, whether
 * because there was nothing to do or because retrying just now succeeded.
 */
export async function resolveUnresolvedProjections(client: Client, pickup: Pickup): Promise<boolean> {
  const projections = new PickupProjectionRepository();
  const isBlocking = (row: PickupProjectionUpdate): boolean =>
    row.pickupVersion === pickup.version && row.surface === 'roster';

  const unresolved = projections.unresolvedForPickup(pickup.id).filter(isBlocking);
  if (unresolved.length === 0) return true;

  await resyncRosterMessage(client, pickup);

  return projections.unresolvedForPickup(pickup.id).filter(isBlocking).length === 0;
}

// ---------------------------------------------------------------------------
// Roster-ready detection
// ---------------------------------------------------------------------------

/**
 * Re-evaluate a pickup after any signup change.
 *
 * Called from both reaction handlers, so it must be cheap and safe to call
 * dozens of times for a pickup that never becomes ready. This function OWNS
 * the staff card refresh for every outcome (still collecting, just became
 * roster_ready, already roster_ready, or nothing to do) — callers must not
 * also call refreshReviewCard themselves afterward for the `open` case (see
 * signups.ts's ineligible-reaction path for why even a call that added
 * nothing must still route through here rather than a separately-ticketed
 * refresh: codex review finding on PR #41, round 16).
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
    if (pickup.status === 'roster_ready') {
      await refreshReviewCard(client, pickupId);
      // Defensive retry, not a fresh freeze -- see sendFirstCompleteNotification's
      // own doc comment for why every revisit of an already-roster_ready
      // pickup must attempt this (codex review finding on PR #39, round 9).
      await sendFirstCompleteNotification(client, pickup);
    }
    return;
  }

  // Ticket drawn before the lookup, not after — see writeControlCard's doc
  // comment. It orders evaluations by when each STARTED, so a slower-to-
  // resolve older evaluation can detect a newer one has already taken over
  // and skip its now-stale write instead of undoing it.
  const ticket = drawControlCardTicket(pickupId);

  // Resolved ONCE and reused for both the completeness check and the card
  // below — see writeControlCard's doc comment for why a second independent
  // lookup here would be a real (if narrow) correctness bug, not just waste.
  const records = new SignupRepository().recordsForPickup(pickupId);
  const { eligibleRecords, eligibilityError } = await eligibilityContext(client, pickup, records);

  // Re-validated immediately after the only await above, BEFORE this
  // evaluation is allowed to prune anything — see pruneAndReadFixedSlots' doc
  // comment. If a newer evaluation has been drawn since this one started —
  // e.g. the player who'd complete this roster already withdrew again, or a
  // Seat Player commit landed — this evaluation's eligibleRecords snapshot is
  // stale. Without this check here, a stale/superseded evaluation could still
  // delete a currently-valid manually-placed seat using that outdated
  // snapshot even though the pickup remains `open` throughout the whole race
  // (codex review finding on PR #39, round 5). Defer entirely: the newer
  // evaluation will reach its own correct conclusion on its own.
  if (controlCardTicket.get(pickupId) !== ticket) return;

  // Captured before pruneAndReadFixedSlots (the very next line) can delete
  // anything -- see recordWorkingRosterGenerated's own doc comment for why
  // reading "before" any later than this would already reflect that prune's
  // result and silently hide it from the audit trail (codex review finding
  // on PR #42).
  const beforeSlots = new RosterSlotRepository()
    .forPickup(pickupId)
    .map((slot) => ({ team: slot.team, role: slot.role, userId: slot.userId }));

  // fixedSlots read here, not any earlier, and nothing async separates this
  // from the transition/persist below — see writeControlCard's matching
  // comment. A Seat Player commit must be reflected in the very computation
  // that decides whether this pickup is complete, not silently overwritten by
  // one that started before it landed.
  const fixedSlots = pruneAndReadFixedSlots(pickupId, eligibleUserIdsOrNull(eligibleRecords, eligibilityError));
  const working = generateWorkingRoster(eligibleRecords, pickup.format, { fixedSlots });

  if (!working.complete || eligibilityError) {
    // Still collecting, OR eligibility couldn't be confirmed this round.
    // "Not complete" is a matching result, not a headcount — see
    // src/domain/roster.ts for why counting reactions is wrong. The
    // eligibilityError check is separate and just as load-bearing: in that
    // state eligibleRecords is intentionally empty (eligibilityContext's
    // fail-closed error set) and so can never itself contribute an automatic
    // slot, yet fixedSlots is deliberately preserved as-is (see
    // pruneAndReadFixedSlots) rather than pruned. A pickup filled ENTIRELY by
    // staff-assigned seats can therefore still read as `working.complete`
    // even though nobody's current eligibility was actually verified this
    // round — freezing on that would post a roster nobody confirmed and DM
    // the creator it's ready. Show the error state instead and let the next
    // successful lookup decide (codex review finding on PR #39, round 8).
    await writeControlCard(client, pickup, eligibleRecords, eligibilityError, ticket, beforeSlots);
    return;
  }

  // Kept as defense-in-depth: redundant with the check above since nothing
  // async separates them, but cheap, and it guards against a future refactor
  // reintroducing an await between them.
  if (controlCardTicket.get(pickupId) !== ticket) return;

  // CONDITIONAL WRITE, ON PURPOSE. Two reactions arriving in the same tick can
  // both compute a complete roster. Only the transition that actually changed
  // the row proceeds to write slots and post the review card; the loser sees
  // false and stops here. Without this, one pickup could produce two rosters
  // and two review cards.
  //
  // The transition, the slot replacement, and the audit event all commit in
  // ONE transaction (recordWorkingRosterGenerated's own db.transaction() nests
  // as a SAVEPOINT inside this one) -- not three separate statements. Without
  // that, a crash or a thrown error between the transition and the slot write
  // could leave the pickup frozen as roster_ready with the working roster
  // never actually persisted and no event describing what happened, with no
  // future evaluateRosterReady call ever retrying it (an already-roster_ready
  // pickup takes the branch above instead, which never re-attempts the write)
  // (codex review finding on PR #42).
  const frozen = getDatabase().transaction(() => {
    if (!pickups.transitionStatus(pickupId, 'open', 'roster_ready')) return false;
    // replaceWorkingRoster, not replaceAll: fixed (staff-assigned) seats are
    // already correct in the database from the Seat Player commit that placed
    // them, and replaceAll would reset their staff_assigned marker to 0 on
    // freeze, quietly re-subjecting a deliberate off-role placement to the
    // withdrawn-signup check it was exempted from.
    recordWorkingRosterGenerated(pickupId, working, beforeSlots, fixedSlots, automaticSlotsOf(working, fixedSlots));
    return true;
  })();
  if (!frozen) return;

  // No more control cards will ever be written for this pickup — every
  // future evaluateRosterReady call takes the roster_ready branch above
  // instead, and never reaches drawControlCardTicket again.
  controlCardTicket.delete(pickupId);

  // Edits the EXISTING staff message in place — same message ID before and
  // after roster-ready. Do not post a second message here.
  //
  // Run BEFORE the courtesy DM below, not after: this is the source-of-truth
  // staff card, and it must reflect the transition before any OTHER network
  // wait gives a concurrent action room to land first. Most notably, Cancel
  // writes its own cancelled-form edit to this same message with no ticket
  // coordination of its own (see cancel.ts's writeCancelledMessages) — if
  // this refresh were still pending behind the DM send when a cancellation
  // landed and wrote its card, this call would resume afterward and silently
  // overwrite it: renderReviewCard has no cancelled-specific rendering at
  // all, so the result would be a stale "Pickup Ready" card even though the
  // buttons happen to (confusingly) still read disabled, since this call
  // re-reads status fresh for THAT part right before its own write. Calling
  // this first, before any other await gets a chance to run, closes that
  // window down to just this call's own two network waits instead of also
  // waiting out the DM's (codex review finding on PR #39).
  await refreshReviewCard(client, pickupId);

  await sendFirstCompleteNotification(client, pickup);
}

/**
 * DM the pickup's creator once, the first time its working roster becomes
 * complete — see migration 008 and PickupRepository.claimReadyNotification.
 *
 * Claims the notification BEFORE sending, not after: a DM that fails midway
 * (Discord API error) must not leave the claim unset and retry-spam the
 * creator on every subsequent signup change — a missed one-time courtesy
 * notice is a much smaller problem than a repeated one. The review card
 * itself, not this DM, is the actual source of truth staff act on.
 *
 * Exported so every caller that touches an already-`roster_ready` pickup can
 * retry this — not just the one call site that freezes it. A crash, or a
 * rejected refreshReviewCard, landing between the transition and this call
 * would otherwise leave `ready_notified_at` permanently null with nothing
 * left to ever retry it: neither evaluateRosterReady's own already-ready
 * branch nor reconcile.ts's startup recovery used to call this at all, only
 * refreshReviewCard. claimReadyNotification's own atomic, one-time claim is
 * what makes calling this defensively on every revisit safe — it no-ops
 * immediately once already sent (codex review finding on PR #39, round 9).
 */
export async function sendFirstCompleteNotification(client: Client, pickup: Pickup): Promise<void> {
  if (!new PickupRepository().claimReadyNotification(pickup.id)) return;

  // Re-read fresh, immediately before actually sending: the caller's own
  // refreshReviewCard call just above is a real network wait a concurrent
  // Cancel can complete during. The claim above must stay unconditional --
  // it exists purely to dedup RETRIES of this exact DM, not to gate whether
  // sending is still appropriate -- so this is a separate check: skip a DM
  // that would tell the creator their pickup is "ready for staff review"
  // after it's already been cancelled out from under them (codex review
  // finding on PR #39).
  if (new PickupRepository().byId(pickup.id)?.status !== 'roster_ready') return;

  try {
    const user = await client.users.fetch(pickup.createdBy);

    // Re-read again, immediately before the send itself: client.users.fetch
    // just above is ITSELF a real network wait the same concurrent Cancel
    // can land during -- the check above only closes the gap up to the start
    // of this fetch, not through it (codex review finding on PR #39, round 8).
    if (new PickupRepository().byId(pickup.id)?.status !== 'roster_ready') return;

    await user.send(
      `Your pickup at ${discordShortTime(pickup.startAt)} (${discordRelative(pickup.startAt)}) has a complete roster and is ready for staff review.`,
    );
  } catch {
    // Closed DMs, or no mutual server -- the review card is the real signal.
  }
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
  // Issue #35 requirement 7: never layer a new roster-slot mutation onto a
  // delivery Lucid cannot yet confirm landed -- try to resolve it live
  // first, and refuse rather than proceed if it's still unresolved.
  if (!(await resolveUnresolvedProjections(interaction.client, pickup))) {
    await respond(interaction, PROJECTION_CONFLICT_MESSAGE);
    return false;
  }

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
 * requireAuthorizedForPickup accepts discord.js's RepliableInteraction union,
 * and the abstract MessageComponentInteraction base class is not one of its
 * members, so we hand it the concrete button or select subtype the router
 * actually delivered. Buttons and selects are the only components this flow
 * renders.
 */
async function authorize(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
): Promise<boolean> {
  if (interaction.isButton()) return (await requireAuthorizedForPickup(interaction, pickup)) !== null;
  if (interaction.isStringSelectMenu()) return (await requireAuthorizedForPickup(interaction, pickup)) !== null;
  return false;
}

/**
 * The actions in this flow whose button lives directly on the persistent
 * staff review card, as opposed to an ephemeral continuation opened by one of
 * them (EditBack/EditSwap/EditChangeRole/EditReplaceSlot/EditPickSlot/
 * EditPickTarget/PublishConfirm/PublishBack all live on a private reply with
 * its own, different message ID and must never be checked this way) -- see
 * requireCanonicalEntryMessage's own doc comment.
 */
const ENTRY_ACTIONS: ReadonlySet<string> = new Set([Action.Shuffle, Action.EditRoster, Action.Publish]);

export async function handleReviewComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  try {
    const pickups = new PickupRepository();
    const pickup = pickups.byId(decoded.pickupId);
    if (!pickup) {
      await respond(interaction, 'That pickup no longer exists.');
      return;
    }

    // AUTHORIZATION IS RE-CHECKED ON EVERY ACTION. The review card lives in a
    // staff-only channel, but channel visibility is not an authorization
    // boundary: permissions change, channels get re-permissioned, and custom
    // IDs survive restarts. Each branch below runs through this same guard.
    if (!(await authorize(interaction, pickup))) return;

    // Entry actions only -- see ENTRY_ACTIONS' own doc comment for why a
    // continuation must never be checked this way.
    if (ENTRY_ACTIONS.has(decoded.action) && !(await requireCanonicalEntryMessage(interaction, pickup.reviewMessageId))) {
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
      : pickup.status === 'finished'
        ? 'This pickup has already finished.'
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
  const pool = await eligibleSignupRecordsChecked(
    interaction.client,
    pickup.guildId,
    new SignupRepository().recordsForPickup(pickup.id),
    pickup.eligibilityRoleIds,
  );
  // A lookup failure (rate limit, network blip) is not a confirmed empty
  // pool and must not be reported as one -- see eligibleSignupRecordsChecked's
  // own doc comment (review finding on PR #44).
  if (!pool.ok) {
    await interaction.followUp({
      content: 'Lucid could not verify the current signup pool just now. Try Shuffle again in a moment.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const records = pool.records;

  // Re-checked against the live signup table immediately before generating
  // the replacement roster, with nothing async in between -- eligibleSignupRecordsChecked's
  // own guild-membership/eligibility lookup above is a real network wait,
  // and a withdrawal landing during it leaves the withdrawn player's stale
  // row in `records` untouched: withdrawing a signup doesn't change guild
  // membership or eligibility, so neither check above would ever catch it
  // (codex review finding on PR #44). The version claim below doesn't catch
  // it either -- removing a signup never bumps the pickup's version.
  const liveSignups = new Set(
    new SignupRepository().recordsForPickup(pickup.id).map((record) => `${record.userId}:${record.role}`),
  );
  const liveRecords = records.filter((record) => liveSignups.has(`${record.userId}:${record.role}`));

  // Shuffle re-rolls from the CURRENT signup pool rather than permuting the
  // existing draft. Two consequences staff rely on: players who signed up after
  // the first draft can appear, and any manual edits made so far are fully
  // replaced. That is the intended trade — Shuffle is "give me a different
  // roster", not "nudge this one".
  const { result, isDifferent } = generateDifferentRoster(
    liveRecords,
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

  // Issue #35 requirement 7 -- see claimVersion's matching comment. Shuffle
  // has its own inline claim (followUp, not respond) so the check is
  // duplicated here rather than shared with that helper.
  if (!(await resolveUnresolvedProjections(interaction.client, pickup))) {
    await interaction.followUp({ content: PROJECTION_CONFLICT_MESSAGE, flags: MessageFlags.Ephemeral });
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

  getDatabase().transaction(() => {
    slotRepo.replaceAll(pickup.id, result.slots);
    // Full assignments, not a count -- replaceAll deletes and recreates every
    // slot, so the current roster_slots table only ever reflects the LATEST
    // shuffle. Without the actual slots in the event itself, a later shuffle
    // or regeneration would permanently erase which teams/roles this one
    // assigned (codex review finding on PR #42, matching the same fix
    // already applied to working_roster_generated).
    new PickupEventRepository().record(pickup.id, interaction.user.id, 'roster_shuffled', {
      slots: result.slots,
    });
  })();
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
    getDatabase().transaction(() => {
      slotRepo.swapOccupants(order.id, chaos.id);
      new PickupEventRepository().record(pickup.id, interaction.user.id, 'players_swapped', {
        role: value,
        orderUserId: order.userId,
        chaosUserId: chaos.userId,
      });
    })();
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
    if (pickup.eligibilityRoleIds.length > 0) {
      const eligible = interaction.guild
        ? await resolveEligibleUserIds(interaction.guild, bench, pickup.eligibilityRoleIds)
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

/**
 * Whether `value` can still take over `source`'s role right now, or the
 * refusal message to show staff if not.
 *
 * Called twice by handlePickTarget's 'replace' mode: once before the async
 * candidate verification, and once again immediately after it resolves,
 * with nothing async in between that second call and the write it guards
 * (codex review finding on PR #44) -- a withdrawal landing during that
 * network wait never bumps the pickup's version, so claimVersion's own
 * claim cannot see it, and only a synchronous re-check this close to the
 * write actually closes the window.
 */
function replaceModeRefusal(
  pickup: Pickup,
  slotRepo: RosterSlotRepository,
  source: RosterSlot,
  value: string,
): string | null {
  if (slotRepo.isUserRostered(pickup.id, value)) return 'That player is already on this roster.';
  if (!new SignupRepository().hasSignedUpFor(pickup.id, value, source.role)) {
    return 'That player is no longer signed up for this role or Fill.';
  }
  return null;
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
    getDatabase().transaction(() => {
      slotRepo.swapOccupants(source.id, target.id, true);
      new PickupEventRepository().record(pickup.id, interaction.user.id, 'role_assignment_changed', {
        sourceSlotId: source.id,
        targetSlotId: target.id,
        sourceUserId: source.userId,
        targetUserId: target.userId,
      });
    })();

    await commitEdit(
      interaction,
      pickup.id,
      `Exchanged ${slotLabel(source, pickup.format)} and ${slotLabel(target, pickup.format)}.`,
    );
    return;
  }

  if (mode === 'replace') {
    // Between opening the menu and picking, that player may have been seated
    // elsewhere or withdrawn. Seating them anyway would silently drop somebody.
    const earlyRefusal = replaceModeRefusal(pickup, slotRepo, source, value);
    if (earlyRefusal) {
      await interaction.editReply({ content: earlyRefusal, components: [] });
      return;
    }
    // Re-verified unconditionally, not only when eligibility roles are
    // configured -- issue #35's commit-time target revalidation. A departed
    // member or a bot account must never be seated into this slot regardless
    // of whether this pickup restricts eligibility at all; see
    // verifyCurrentCandidate's own doc comment for why the
    // eligibility-roles-configured gate alone isn't enough.
    const verification = await verifyCurrentCandidate(interaction.guild, value, pickup.eligibilityRoleIds);
    if (!verification.ok) {
      await interaction.editReply({ content: candidateRefusalMessage(verification.reason, value), components: [] });
      return;
    }

    // Re-checked again, synchronously -- see replaceModeRefusal's own doc
    // comment for why the async candidate verification just above makes this
    // second call necessary, not merely defensive.
    const staleRefusal = replaceModeRefusal(pickup, slotRepo, source, value);
    if (staleRefusal) {
      await interaction.editReply({ content: staleRefusal, components: [] });
      return;
    }

    // Claimed immediately before the write — see claimVersion's comment.
    if (!(await claimVersion(interaction, pickup, decoded))) return;

    getDatabase().transaction(() => {
      slotRepo.setOccupant(source.id, value);
      new PickupEventRepository().record(pickup.id, interaction.user.id, 'player_replaced', {
        slotId: source.id,
        previousUserId: source.userId,
        newUserId: value,
      });
    })();
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
      `Can't publish yet — ${withdrawnList(ineligible)} no longer hold an eligibility role. Use Shuffle or Edit Roster first.`,
    );
    return;
  }

  if (!pickup.rosterChannelId) {
    await respond(
      interaction,
      'No public roster channel is configured for this Pickup Space. Set one with `/pickup space edit` first.',
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

  await respond(interaction, `Publish this roster to <#${pickup.rosterChannelId}>?`, rows);
}

/** How long before kickoff the roster reminder goes out (issue #36). */
const REMINDER_LEAD_SECONDS = 15 * 60;

/**
 * Schedule this pickup's T-15 roster reminder.
 *
 * Call this INSIDE the same transaction as the publish transition it belongs
 * to: a pickup that is published but has no reminder row is a reminder
 * nothing will ever schedule again, since publishing happens exactly once.
 *
 * LATE PUBLICATION -- a roster published inside its own last fifteen minutes
 * has a reminder that is already due the moment it exists, and the worker's
 * very next tick would send "starts in 15 minutes" about a pickup starting in
 * three. The row is still written and then skipped on the spot rather than
 * not written at all: the durable, reasoned 'published_after_due' record is
 * exactly what someone asking "why did nobody get pinged?" needs, and a
 * missing row answers nothing.
 */
function scheduleRosterReminder(pickup: Pickup): void {
  if (!pickup.rosterChannelId) return;

  const notifications = new PickupNotificationRepository();
  // startAt is Unix SECONDS; every notification timestamp is milliseconds.
  const dueAt = (pickup.startAt - REMINDER_LEAD_SECONDS) * 1000;
  const { notification } = notifications.schedule({
    pickupId: pickup.id,
    kind: 'roster_reminder',
    dedupeKey: `roster_reminder:${pickup.id}`,
    channelId: pickup.rosterChannelId,
    dueAt,
  });
  if (dueAt <= Date.now()) notifications.skip(notification.id, 'published_after_due');
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
    await respond(interaction, `Can't publish — ${withdrawnList(ineligible)} no longer hold an eligibility role.`);
    return;
  }

  if (!pickup.rosterChannelId) {
    await respond(interaction, 'No public roster channel is configured.');
    return;
  }

  await interaction.deferUpdate();

  // Issue #35 requirement 7 -- see claimVersion's matching comment.
  if (!(await resolveUnresolvedProjections(interaction.client, pickup))) {
    await interaction.editReply({ content: PROJECTION_CONFLICT_MESSAGE, components: [] });
    return;
  }

  const pickups = new PickupRepository();

  // Claim the publish BEFORE posting anything. If two coordinators hit Publish
  // together, only one transition succeeds, so only one public roster is ever
  // posted.
  const slots = new RosterSlotRepository().forPickup(pickup.id);
  const claimedPublish = getDatabase().transaction(() => {
    if (!pickups.transitionStatus(pickup.id, 'roster_ready', 'published')) return false;
    new PickupEventRepository().record(pickup.id, interaction.user.id, 'roster_published', {
      slotCount: slots.length,
    });
    scheduleRosterReminder(pickup);
    return true;
  })();
  if (!claimedPublish) {
    await interaction.editReply({
      content: 'This roster was already published.',
      components: [],
    });
    return;
  }

  // The status transition and its audit event are ALREADY committed above --
  // this send is best-effort delivery of that already-true state, not part of
  // deciding whether the publish happened. Issue #35's delivery-recovery
  // contract: a Discord failure here must never roll the transition back
  // (Ratatoskr-style committed-state recovery, replacing this flow's previous
  // compensating rollback -- a prior version of this branch unwound the
  // status back to `roster_ready` on any send failure, which is unsafe under
  // transport uncertainty: if the send actually landed but the confirmation
  // was merely lost, unwinding the status would let a staff retry post a
  // genuine duplicate roster with no record of the first, orphaned one).
  // Durably tracked instead: `projectSurface` records the attempt, and a
  // confirmed failure or a genuinely uncertain one both simply leave the
  // 'roster' surface pending for the next retry -- see resolveUnresolvedProjections.
  const channel = await interaction.client.channels.fetch(pickup.rosterChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    const projections = new PickupProjectionRepository();
    const projectionId = projections.begin(pickup.id, 'roster', null);
    projections.markPending(projectionId, 'channel-not-sendable');
  } else {
    await projectSurface({
      pickupId: pickup.id,
      surface: 'roster',
      messageId: null,
      edit: async () => {
        const posted = await channel.send({
          content: renderPublicRoster(pickup, slots),
          components: publishedRosterRows(pickup.id),
          // The public roster is the one place mentions are intended: players
          // are meant to be pinged that they are playing.
          allowedMentions: { parse: ['users'] },
        });
        pickups.setMessageIds(pickup.id, { rosterMessageId: posted.id });
      },
    });
  }

  // The staff card stays as a record, with its controls disabled.
  await refreshReviewCard(interaction.client, pickup.id);

  const posted = new PickupRepository().byId(pickup.id)?.rosterMessageId;
  await interaction.editReply(
    posted
      ? { content: `Roster published to <#${pickup.rosterChannelId}>.`, components: [] }
      : {
          content:
            `Roster published, but Lucid could not confirm posting it to <#${pickup.rosterChannelId}> just now. ` +
            'It will keep retrying automatically.',
          components: [],
        },
  );
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
