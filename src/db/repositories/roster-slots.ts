import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { Role, Team } from '../../domain/roles.js';
import type { SlotAssignment } from '../../domain/roster.js';
import type { RosterSlot } from './types.js';

export type AddFixedSlotOutcome =
  /** Seat inserted, marked staff_assigned. */
  | { status: 'added' }
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
      return { status: 'added' };
    });
    return run();
  }

  /**
   * Seat a different player in one slot, leaving team and role untouched.
   *
   * Pass `staffAssigned: true` when the placement ignores role eligibility — a
   * staff override. That marks the slot exempt from the withdrawn-signup check,
   * so a deliberate override doesn't read as a player who quietly dropped out
   * and block publishing.
   */
  setOccupant(slotId: number, userId: string, staffAssigned = false): void {
    this.db
      .prepare('UPDATE roster_slots SET user_id = ?, staff_assigned = ?, updated_at = ? WHERE id = ?')
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
    })();
  }

  userIds(pickupId: number): string[] {
    return this.forPickup(pickupId).map((slot) => slot.userId);
  }

  isUserRostered(pickupId: number, userId: string): boolean {
    return this.userIds(pickupId).includes(userId);
  }
}
