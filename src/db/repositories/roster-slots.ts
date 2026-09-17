import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { Role, Team } from '../../domain/roles.js';
import type { SlotAssignment } from '../../domain/roster.js';
import type { RosterSlot } from './types.js';

export type AddFixedSlotOutcome =
  /** Seat inserted, marked staff_assigned. */
  | { status: 'added' }
  /** The pickup is no longer `open` (cancelled, or the roster already froze). */
  | { status: 'pickup_not_open' }
  /** That player no longer has any signup for this pickup (they withdrew). */
  | { status: 'user_withdrawn' }
  /** Someone already occupies that exact team+role location. */
  | { status: 'location_taken' }
  /** That player already holds a different seat on this pickup's roster. */
  | { status: 'user_already_rostered' };

interface RosterSlotRow {
  id: number;
  pickup_id: number;
  team: string;
  role: string;
  user_id: string;
  staff_assigned: number;
  replacement_needed: number;
  replacement_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

function hydrate(row: RosterSlotRow): RosterSlot {
  return {
    id: row.id,
    pickupId: row.pickup_id,
    team: row.team as Team,
    role: row.role as Role,
    userId: row.user_id,
    staffAssigned: row.staff_assigned === 1,
    replacementNeeded: row.replacement_needed === 1,
    replacementRequestedAt: row.replacement_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RosterSlotRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  forPickup(pickupId: number): RosterSlot[] {
    const rows = this.db
      .prepare('SELECT * FROM roster_slots WHERE pickup_id = ?')
      .all(pickupId) as RosterSlotRow[];
    return rows.map(hydrate);
  }

  byId(id: number): RosterSlot | null {
    const row = this.db.prepare('SELECT * FROM roster_slots WHERE id = ?').get(id) as
      | RosterSlotRow
      | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Replace the whole roster for a pickup.
   *
   * Used by initial generation and by Shuffle. Deleting first keeps the
   * UNIQUE(pickup_id, team, role) constraint satisfied without needing upsert
   * logic, and the transaction means observers never see a partial roster.
   */
  replaceAll(pickupId: number, slots: SlotAssignment[]): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM roster_slots WHERE pickup_id = ?').run(pickupId);
      // Regenerated rosters are always algorithmic, so staff_assigned resets to
      // 0 — Shuffle discards manual overrides along with everything else.
      const insert = this.db.prepare(
        `INSERT INTO roster_slots (pickup_id, team, role, user_id, staff_assigned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      );
      for (const slot of slots) {
        insert.run(pickupId, slot.team, slot.role, slot.userId, now, now);
      }
    })();
  }

  /**
   * Persist a recomputed working roster: replace every AUTOMATIC slot with
   * `automaticSlots`, leaving every staff-assigned slot completely untouched.
   *
   * Used by evaluateRosterReady while a pickup is `open` (see review.ts) so
   * the roster grows and shrinks with the live signup pool. Only deleting
   * `staff_assigned = 0` rows is what lets a hand-placed seat (Seat Player)
   * survive every later recalculation — a plain `replaceAll` here would wipe
   * manual placements out on the very next reaction. `automaticSlots` must
   * already exclude any fixed occupant (see generateWorkingRoster's
   * `fixedSlots` option) — this method does not attempt to reconcile the two
   * itself, it trusts the caller passed a matching pair.
   */
  replaceWorkingRoster(pickupId: number, automaticSlots: SlotAssignment[]): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM roster_slots WHERE pickup_id = ? AND staff_assigned = 0')
        .run(pickupId);
      const insert = this.db.prepare(
        `INSERT INTO roster_slots (pickup_id, team, role, user_id, staff_assigned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      );
      for (const slot of automaticSlots) {
        insert.run(pickupId, slot.team, slot.role, slot.userId, now, now);
      }
    })();
  }

  /**
   * Add ONE hand-placed seat to an otherwise-untouched roster — the Seat
   * Player commit (see flows/seat.ts), as distinct from replaceWorkingRoster's
   * bulk automatic recompute.
   *
   * Location and occupant are both checked inside the same synchronous
   * transaction as the insert, mirroring SignupRepository.add's discipline:
   * two staff members confirming Seat Player on the same open seat (or the
   * same player) in the same tick cannot both succeed. Returns which
   * conflict blocked the write, if any, rather than throwing — a caller who
   * over-trusted a stale seat/player list they rendered a moment earlier
   * needs to tell staff exactly what changed, not crash.
   */
  addFixedSlot(pickupId: number, team: Team, role: Role, userId: string): AddFixedSlotOutcome {
    const now = Date.now();
    const run = this.db.transaction((): AddFixedSlotOutcome => {
      // Re-checked here, not trusted from whatever the caller resolved before
      // its own (real, async) eligibility lookup: currentWorkingRoster's
      // signup read happens BEFORE that await, so a cancellation or a
      // withdrawal landing during it would otherwise slip past the caller's
      // now-stale unseatedUserIds check entirely. Both conditions below are
      // pure DB state, checked in the same synchronous transaction as the
      // insert itself, so nothing async can land between the check and the
      // write — codex review finding on PR #39.
      const pickup = this.db
        .prepare("SELECT 1 FROM pickups WHERE id = ? AND status = 'open'")
        .get(pickupId);
      if (!pickup) return { status: 'pickup_not_open' };

      const stillSignedUp = this.db
        .prepare('SELECT 1 FROM signups WHERE pickup_id = ? AND user_id = ? LIMIT 1')
        .get(pickupId, userId);
      if (!stillSignedUp) return { status: 'user_withdrawn' };

      const locationTaken = this.db
        .prepare('SELECT 1 FROM roster_slots WHERE pickup_id = ? AND team = ? AND role = ?')
        .get(pickupId, team, role);
      if (locationTaken) return { status: 'location_taken' };

      const userTaken = this.db
        .prepare('SELECT 1 FROM roster_slots WHERE pickup_id = ? AND user_id = ?')
        .get(pickupId, userId);
      if (userTaken) return { status: 'user_already_rostered' };

      this.db
        .prepare(
          `INSERT INTO roster_slots (pickup_id, team, role, user_id, staff_assigned, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(pickupId, team, role, userId, now, now);

      // Touch the parent pickup's own updated_at in the same transaction as
      // the insert -- reconcile.ts's startup recovery only re-evaluates
      // pickups updated within its recent window (PickupRepository.
      // updatedSince). A seat placed on a pickup that otherwise hasn't been
      // touched in a while (an old, slow-filling open pickup) would
      // otherwise leave this write invisible to that recovery query, so a
      // crash between this commit and the evaluateRosterReady call that
      // follows it could strand a just-completed roster with no path back to
      // roster_ready (codex review finding on PR #39, round 8).
      this.db.prepare('UPDATE pickups SET updated_at = ? WHERE id = ?').run(now, pickupId);
      return { status: 'added' };
    });
    return run();
  }

  /**
   * Remove any staff-assigned slot whose occupant is no longer in
   * `eligibleUserIds` — a manually placed player who withdrew their last
   * signup, or lost the pickup's configured eligibility role, while the
   * pickup is still `open`. Automatic (non-staff-assigned) slots are
   * untouched — those are already recomputed wholesale, every time, by
   * replaceWorkingRoster from the current pool.
   *
   * Without this, review.ts's currentFixedSlots would keep pinning that
   * occupant's location as filled and excluding them from re-matching
   * forever: generateWorkingRoster would count the pickup complete around an
   * invalid seat, AND the stale row's own UNIQUE(pickup_id, team, role)
   * constraint would then refuse the location to anyone else, whether
   * seated automatically or placed again by hand through Seat Player —
   * codex review finding on PR #39.
   */
  pruneStaleFixedSlots(pickupId: number, eligibleUserIds: ReadonlySet<string>): void {
    const stale = this.forPickup(pickupId).filter(
      (slot) => slot.staffAssigned && !eligibleUserIds.has(slot.userId),
    );
    if (stale.length === 0) return;
    const placeholders = stale.map(() => '?').join(', ');
    this.db.prepare(`DELETE FROM roster_slots WHERE id IN (${placeholders})`).run(...stale.map((slot) => slot.id));
  }

  /**
   * Seat a different player in one slot, leaving team and role untouched.
   *
   * Pass `staffAssigned: true` when the placement ignores role eligibility — a
   * staff override. That marks the slot exempt from the withdrawn-signup check,
   * so a deliberate override doesn't read as a player who quietly dropped out
   * and block publishing.
   */
  /**
   * Seat `userId` here, clearing any replacement-needed flag.
   *
   * A new occupant IS the resolution of a seat that needed one (issue #36):
   * whatever the previous occupant said about their own availability cannot
   * apply to the player replacing them. Every replacement path -- post-publish
   * Replace Player, pre-publish Edit Roster -- funnels through here, so this
   * is the single point where that flag can be cleared without each flow
   * having to remember to.
   */
  setOccupant(slotId: number, userId: string, staffAssigned = false): void {
    this.db
      .prepare(
        `UPDATE roster_slots
         SET user_id = ?, staff_assigned = ?, replacement_needed = 0, replacement_requested_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(userId, staffAssigned ? 1 : 0, Date.now(), slotId);
  }

  /**
   * Exchange the occupants of two slots atomically.
   *
   * `staffAssigned` should be true for a cross-role exchange (Change Role
   * Assignment, which deliberately skips the eligibility check) and false for a
   * same-role swap between teams, where both players remain in a role they
   * actually signed up for.
   */
  swapOccupants(slotAId: number, slotBId: number, staffAssigned = false): void {
    this.db.transaction(() => {
      const a = this.byId(slotAId);
      const b = this.byId(slotBId);
      if (!a || !b) throw new Error('Cannot swap: one of the roster slots no longer exists.');
      // Preserve an existing override marker — moving a staff-placed player
      // between slots must not quietly re-subject them to the eligibility check.
      this.setOccupant(slotAId, b.userId, staffAssigned || b.staffAssigned);
      this.setOccupant(slotBId, a.userId, staffAssigned || a.staffAssigned);
      // A replacement-needed flag belongs to the PLAYER, not the seat: a
      // player who can't play still can't play after staff move them
      // elsewhere on the roster. setOccupant deliberately clears the flag
      // (a new occupant resolves a seat), so carry each player's own flag
      // with them here -- the same reasoning as staffAssigned just above.
      if (b.replacementNeeded) this.markReplacementNeeded(slotAId, b.userId);
      if (a.replacementNeeded) this.markReplacementNeeded(slotBId, a.userId);
    })();
  }

  /**
   * Flag this seat as needing a replacement, without removing its occupant.
   *
   * Atomic and idempotent (issue #36): the CAS refuses unless the slot still
   * holds exactly `expectedUserId` AND is not already flagged, so a repeated
   * Can't Play confirmation on the same unresolved seat is a true no-op --
   * no second event, no duplicate organizer alert -- and a seat whose
   * occupant changed underneath the interaction is refused rather than
   * flagged for the wrong player.
   */
  markReplacementNeeded(slotId: number, expectedUserId: string): 'flagged' | 'already_flagged' | 'occupant_changed' {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE roster_slots
         SET replacement_needed = 1, replacement_requested_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND replacement_needed = 0`,
      )
      .run(now, now, slotId, expectedUserId);
    if (result.changes === 1) return 'flagged';
    const slot = this.byId(slotId);
    if (slot && slot.userId === expectedUserId && slot.replacementNeeded) return 'already_flagged';
    return 'occupant_changed';
  }

  /** Resolve a flagged seat without changing its occupant -- e.g. the player says they can play after all. */
  clearReplacementNeeded(slotId: number): void {
    this.db
      .prepare(
        'UPDATE roster_slots SET replacement_needed = 0, replacement_requested_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(Date.now(), slotId);
  }

  /** Every seat on this pickup currently awaiting a replacement, oldest request first. */
  replacementNeededFor(pickupId: number): RosterSlot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM roster_slots
         WHERE pickup_id = ? AND replacement_needed = 1
         ORDER BY replacement_requested_at ASC, id ASC`,
      )
      .all(pickupId) as RosterSlotRow[];
    return rows.map(hydrate);
  }

  userIds(pickupId: number): string[] {
    return this.forPickup(pickupId).map((slot) => slot.userId);
  }

  isUserRostered(pickupId: number, userId: string): boolean {
    return this.userIds(pickupId).includes(userId);
  }
}
