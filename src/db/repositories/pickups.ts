import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { PickupFormat } from '../../domain/roles.js';
import type { Pickup, PickupStatus } from './types.js';

interface PickupRow {
  id: number;
  guild_id: string;
  created_by: string;
  format: string;
  start_at: number;
  role_limit: number;
  note: string | null;
  premade_name: string | null;
  eligibility_role_id: string | null;
  status: string;
  signup_message_id: string | null;
  review_message_id: string | null;
  roster_message_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

function hydrate(row: PickupRow): Pickup {
  return {
    id: row.id,
    guildId: row.guild_id,
    createdBy: row.created_by,
    format: row.format as PickupFormat,
    startAt: row.start_at,
    roleLimit: row.role_limit,
    note: row.note,
    premadeName: row.premade_name,
    eligibilityRoleId: row.eligibility_role_id,
    status: row.status as PickupStatus,
    signupMessageId: row.signup_message_id,
    reviewMessageId: row.review_message_id,
    rosterMessageId: row.roster_message_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreatePickupInput {
  guildId: string;
  createdBy: string;
  format: PickupFormat;
  startAt: number;
  roleLimit: number;
  note?: string | null;
  premadeName?: string | null;
  eligibilityRoleId?: string | null;
}

export class PickupRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  create(input: CreatePickupInput): Pickup {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO pickups
           (guild_id, created_by, format, start_at, role_limit, note, premade_name, eligibility_role_id,
            status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
      )
      .run(
        input.guildId,
        input.createdBy,
        input.format,
        input.startAt,
        input.roleLimit,
        input.note ?? null,
        input.premadeName ?? null,
        input.eligibilityRoleId ?? null,
        now,
        now,
      );
    return this.byId(Number(result.lastInsertRowid))!;
  }

  byId(id: number): Pickup | null {
    const row = this.db.prepare('SELECT * FROM pickups WHERE id = ?').get(id) as
      | PickupRow
      | undefined;
    return row ? hydrate(row) : null;
  }

  bySignupMessageId(messageId: string): Pickup | null {
    const row = this.db
      .prepare('SELECT * FROM pickups WHERE signup_message_id = ?')
      .get(messageId) as PickupRow | undefined;
    return row ? hydrate(row) : null;
  }

  /** Pickups that can still be cancelled, newest first. */
  cancellable(guildId: string): Pickup[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pickups
         WHERE guild_id = ? AND status IN ('open', 'roster_ready')
         ORDER BY start_at ASC`,
      )
      .all(guildId) as PickupRow[];
    return rows.map(hydrate);
  }

  /** Active pickups at the exact same time created by the same coordinator. */
  overlappingForCoordinator(guildId: string, createdBy: string, startAt: number): Pickup[] {
    const rows = this.db.prepare(
      `SELECT * FROM pickups
       WHERE guild_id = ? AND created_by = ? AND start_at = ?
         AND status IN ('open', 'roster_ready', 'published')
       ORDER BY id ASC`,
    ).all(guildId, createdBy, startAt) as PickupRow[];
    return rows.map(hydrate);
  }

  setMessageIds(
    id: number,
    ids: { signupMessageId?: string; reviewMessageId?: string; rosterMessageId?: string },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (ids.signupMessageId !== undefined) {
      sets.push('signup_message_id = ?');
      values.push(ids.signupMessageId);
    }
    if (ids.reviewMessageId !== undefined) {
      sets.push('review_message_id = ?');
      values.push(ids.reviewMessageId);
    }
    if (ids.rosterMessageId !== undefined) {
      sets.push('roster_message_id = ?');
      values.push(ids.rosterMessageId);
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE pickups SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Move a pickup between states, but only from the state we expect.
   *
   * This conditional write is what stops two reaction events that both observed
   * "roster is feasible" from each posting a review card. Whichever UPDATE runs
   * first changes a row and returns 1; the loser returns 0 and does nothing.
   * Always branch on the return value rather than assuming success.
   */
  transitionStatus(id: number, from: PickupStatus, to: PickupStatus): boolean {
    const result = this.db
      .prepare('UPDATE pickups SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, Date.now(), id, from);
    return result.changes === 1;
  }

  /** Same as above but accepting several valid source states. */
  transitionStatusFromAny(id: number, from: PickupStatus[], to: PickupStatus): boolean {
    const placeholders = from.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE pickups SET status = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, Date.now(), id, ...from);
    return result.changes === 1;
  }

  /**
   * Bump the roster version.
   *
   * Staff interactions carry the version they were rendered from. If it no
   * longer matches, someone else changed the roster in between and the stale
   * click is refused rather than overwriting their work.
   *
   * CALL THIS BEFORE MUTATING, NOT AFTER. Bumping after the mutation only
   * detects a lost race after the damage is done — two interactions can both
   * read the same starting version, both pass a pre-check, and both reach the
   * mutation; the second bump then fails silently while its write has already
   * landed. Bumping first means only one concurrent caller ever wins the claim
   * for a given expected version, and the loser bails before touching anything.
   * See `claimVersionIfEditable` for the version this also needs to be paired
   * with an "is the draft still open" check.
   */
  bumpVersion(id: number, expectedVersion: number): boolean {
    const result = this.db
      .prepare(
        'UPDATE pickups SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
      )
      .run(Date.now(), id, expectedVersion);
    return result.changes === 1;
  }

  /**
   * Claim the roster version for a mutation, in one atomic statement that also
   * requires the pickup still be an open, unpublished draft.
   *
   * This is the guard every roster-slot mutation (Shuffle, the three Edit
   * Roster actions) must call immediately before writing — see the warning on
   * `bumpVersion`. Folding the status check into the same WHERE clause closes a
   * second race the plain version bump cannot: Publish transitions status but
   * never touches `version`, so a concurrent Shuffle or Edit that only checked
   * version could otherwise still win its claim and mutate a roster that was
   * just published out from under it. Because this is a single SQL statement,
   * better-sqlite3's synchronous execution makes the status-and-version check
   * and the increment indivisible — nothing else can interleave between them.
   */
  claimVersionIfEditable(id: number, expectedVersion: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE pickups SET version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'roster_ready'`,
      )
      .run(Date.now(), id, expectedVersion);
    return result.changes === 1;
  }
}
