import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { Role, Team } from '../../domain/roles.js';
import type { SlotAssignment } from '../../domain/roster.js';
import type { RosterSlot } from './types.js';

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
