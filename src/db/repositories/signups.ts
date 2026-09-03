import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { Role, SignupRole } from '../../domain/roles.js';
import type { SignupRecord } from '../../domain/roster.js';
import type { Signup } from './types.js';

interface SignupRow {
  id: number;
  pickup_id: number;
  user_id: string;
  role: string;
  created_at: number;
}

function hydrate(row: SignupRow): Signup {
  return {
    id: row.id,
    pickupId: row.pickup_id,
    userId: row.user_id,
    role: row.role as SignupRole,
    createdAt: row.created_at,
  };
}

export type AddSignupOutcome =
  /** Row created; the reaction stands. */
  | { status: 'added' }
  /** Already signed up for this exact role; nothing to do. */
  | { status: 'duplicate' }
  /** At their role limit — caller must remove the reaction that was just added. */
  | { status: 'over_limit'; limit: number };

export class SignupRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  /**
   * Record a role signup, enforcing the pickup's per-player role limit.
   *
   * CONCURRENCY: the count and the insert run inside ONE synchronous
   * transaction. Discord can deliver two reaction events from the same player
   * within the same tick; if we counted their roles, awaited anything, and then
   * inserted, both events could observe "1 of 2 used" and we'd end up with three
   * roles on a two-role pickup. The UNIQUE(pickup_id, user_id, role) index does
   * not catch that — the rows are genuinely distinct.
   *
   * better-sqlite3 is synchronous, so nothing can interleave between the SELECT
   * and the INSERT below. Do not introduce an await inside this transaction, and
   * do not port it to an async driver without adding real locking.
   *
   * Also bumps the parent pickup's `updated_at` -- see the matching comment on
   * `remove()` for why.
   */
  add(pickupId: number, userId: string, role: SignupRole, roleLimit: number): AddSignupOutcome {
    const run = this.db.transaction((): AddSignupOutcome => {
      const existing = this.db
        .prepare('SELECT role FROM signups WHERE pickup_id = ? AND user_id = ?')
        .all(pickupId, userId) as { role: string }[];

      if (existing.some((row) => row.role === role)) return { status: 'duplicate' };
      if (existing.length >= roleLimit) return { status: 'over_limit', limit: roleLimit };

      this.db
        .prepare('INSERT INTO signups (pickup_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(pickupId, userId, role, Date.now());
      this.db.prepare('UPDATE pickups SET updated_at = ? WHERE id = ?').run(Date.now(), pickupId);
      return { status: 'added' };
    });

    return run();
  }

  /**
   * Also bumps the parent pickup's `updated_at` when a row actually goes away
   * -- codex review finding on PR #32: a signup add/remove only ever touched
   * the `signups` table, never the parent `pickups` row, so a crash right
   * after one (before the resulting card refresh reached Discord) could leave
   * a pickup outside reconcile.ts's recovery window even though the write
   * that needs recovering happened moments ago. Removal has no other
   * timestamp to fall back on -- the row is simply gone -- so the parent row
   * is the only place left to record that this pickup was just touched.
   */
  remove(pickupId: number, userId: string, role: SignupRole): void {
    const run = this.db.transaction(() => {
      const result = this.db
        .prepare('DELETE FROM signups WHERE pickup_id = ? AND user_id = ? AND role = ?')
        .run(pickupId, userId, role);
      if (result.changes > 0) {
        this.db.prepare('UPDATE pickups SET updated_at = ? WHERE id = ?').run(Date.now(), pickupId);
      }
    });
    run();
  }

  forPickup(pickupId: number): Signup[] {
    const rows = this.db
      .prepare('SELECT * FROM signups WHERE pickup_id = ? ORDER BY created_at ASC, id ASC')
      .all(pickupId) as SignupRow[];
    return rows.map(hydrate);
  }

  /** Shape the roster algorithm expects. */
  recordsForPickup(pickupId: number): SignupRecord[] {
    return this.forPickup(pickupId).map((signup) => ({
      userId: signup.userId,
      role: signup.role,
      createdAt: signup.createdAt,
    }));
  }

  /** Everyone compatible with a role, including Fill — the replacement pool. */
  usersForRole(pickupId: number, role: Role): string[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, MIN(created_at) AS first_signup,
                MAX(CASE WHEN role = ? THEN 1 ELSE 0 END) AS explicit
         FROM signups
         WHERE pickup_id = ? AND role IN (?, 'fill')
         GROUP BY user_id
         ORDER BY explicit DESC, first_signup ASC, user_id ASC`,
      )
      .all(role, pickupId, role) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  hasSignedUpFor(pickupId: number, userId: string, role: Role): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM signups WHERE pickup_id = ? AND user_id = ? AND role IN (?, 'fill')")
      .get(pickupId, userId, role);
    return row !== undefined;
  }

  /**
   * Does this user have a signup for this pickup at all, for any role?
   *
   * Used for staff-assigned roster slots, where the occupant's signup for
   * their SPECIFIC slot role is expected to be missing on purpose (that's what
   * the override means) — but a player who removed every reaction has actually
   * left the pickup, not just changed roles, and that distinction still needs
   * to be visible before Publish. See withdrawnUserIds in review.ts.
   */
  hasAnySignup(pickupId: number, userId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS present FROM signups WHERE pickup_id = ? AND user_id = ? LIMIT 1')
      .get(pickupId, userId);
    return row !== undefined;
  }
}
