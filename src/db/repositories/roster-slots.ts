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
      const insert = this.db.prepare(
        `INSERT INTO roster_slots (pickup_id, team, role, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const slot of slots) {
        insert.run(pickupId, slot.team, slot.role, slot.userId, now, now);
      }
    })();
  }

  /** Seat a different player in one slot, leaving team and role untouched. */
  setOccupant(slotId: number, userId: string): void {
    this.db
      .prepare('UPDATE roster_slots SET user_id = ?, updated_at = ? WHERE id = ?')
      .run(userId, Date.now(), slotId);
  }

  /** Exchange the occupants of two slots atomically. */
  swapOccupants(slotAId: number, slotBId: number): void {
    this.db.transaction(() => {
      const a = this.byId(slotAId);
      const b = this.byId(slotBId);
      if (!a || !b) throw new Error('Cannot swap: one of the roster slots no longer exists.');
      this.setOccupant(slotAId, b.userId);
      this.setOccupant(slotBId, a.userId);
    })();
  }

  userIds(pickupId: number): string[] {
    return this.forPickup(pickupId).map((slot) => slot.userId);
  }

  isUserRostered(pickupId: number, userId: string): boolean {
    return this.userIds(pickupId).includes(userId);
  }
}
