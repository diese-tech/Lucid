import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { PickupFormat } from '../../domain/roles.js';
import { parseRoleIds } from './role-ids.js';
import type { FinishReason, Pickup, PickupStatus } from './types.js';

interface PickupRow {
  id: number;
  guild_id: string;
  created_by: string;
  format: string;
  start_at: number;
  role_limit: number;
  note: string | null;
  premade_name: string | null;
  eligibility_role_ids: string;
  status: string;
  signup_message_id: string | null;
  review_message_id: string | null;
  roster_message_id: string | null;
  version: number;
  pickup_space_id: number | null;
  origin_channel_id: string | null;
  signup_channel_id: string | null;
  roster_channel_id: string | null;
  review_channel_id: string | null;
  signup_ping_role_id: string | null;
  organizer_ping_role_id: string | null;
  ready_notified_at: number | null;
  finished_at: number | null;
  finished_by_user_id: string | null;
  finish_reason: string | null;
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
    eligibilityRoleIds: parseRoleIds(row.eligibility_role_ids, { failClosed: true }),
    status: row.status as PickupStatus,
    signupMessageId: row.signup_message_id,
    reviewMessageId: row.review_message_id,
    rosterMessageId: row.roster_message_id,
    version: row.version,
    pickupSpaceId: row.pickup_space_id,
    originChannelId: row.origin_channel_id,
    signupChannelId: row.signup_channel_id,
    rosterChannelId: row.roster_channel_id,
    reviewChannelId: row.review_channel_id,
    signupPingRoleId: row.signup_ping_role_id,
    organizerPingRoleId: row.organizer_ping_role_id,
    readyNotifiedAt: row.ready_notified_at,
    finishedAt: row.finished_at,
    finishedByUserId: row.finished_by_user_id,
    finishReason: row.finish_reason as FinishReason | null,
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
  eligibilityRoleIds?: string[];
  /**
   * Pickup Space this pickup belongs to, plus a snapshot of its routing and
   * ping role as they stood at creation time — see the Pickup doc comment in
   * types.ts for why this is captured once rather than resolved live.
   */
  pickupSpaceId: number;
  originChannelId: string | null;
  signupChannelId: string;
  rosterChannelId: string;
  reviewChannelId: string;
  signupPingRoleId?: string | null;
  organizerPingRoleId?: string | null;
}

export class PickupRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  create(input: CreatePickupInput): Pickup {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO pickups
           (guild_id, created_by, format, start_at, role_limit, note, premade_name, eligibility_role_ids,
            pickup_space_id, origin_channel_id, signup_channel_id, roster_channel_id, review_channel_id,
            signup_ping_role_id, organizer_ping_role_id,
            status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
      )
      .run(
        input.guildId,
        input.createdBy,
        input.format,
        input.startAt,
        input.roleLimit,
        input.note ?? null,
        input.premadeName ?? null,
        JSON.stringify(input.eligibilityRoleIds ?? []),
        input.pickupSpaceId,
        input.originChannelId ?? null,
        input.signupChannelId,
        input.rosterChannelId,
        input.reviewChannelId,
        input.signupPingRoleId ?? null,
        input.organizerPingRoleId ?? null,
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

  /**
   * Pickups touched within a recent window, oldest first.
   *
   * Startup recovery (see reconcile.ts) uses this to bound its work to
   * whatever was plausibly in flight around the bot's last restart, rather
   * than re-verifying every pickup a guild has ever run.
   */
  updatedSince(sinceMs: number): Pickup[] {
    const rows = this.db
      .prepare('SELECT * FROM pickups WHERE updated_at >= ? ORDER BY id ASC')
      .all(sinceMs) as PickupRow[];
    return rows.map(hydrate);
  }

  /**
   * Every pickup currently `open`, regardless of how long ago it was touched.
   *
   * Startup recovery (see reconcile.ts) unions this with updatedSince: `open`
   * is the one status with no natural endpoint of its own (everything else --
   * cancelled, finished, published -- is a terminal state something already
   * moved it into), so a pickup can sit untouched past the recovery window
   * while still genuinely needing today's staff-card rendering. Deliberately
   * unbounded, unlike updatedSince -- but that stays cheap in practice, since
   * a pickup only stays `open` until its roster fills or staff cancel it, not
   * indefinitely (codex review finding on PR #39, round 10).
   */
  openPickups(): Pickup[] {
    const rows = this.db.prepare("SELECT * FROM pickups WHERE status = 'open' ORDER BY id ASC").all() as PickupRow[];
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
   * Transition to 'finished' AND record who/when/why in the same atomic
   * statement (issue #37) -- the same CAS discipline as `transitionStatus`,
   * just widened to set the completion columns in the one write that wins
   * the race, rather than as a separate follow-up update that could land
   * after a second caller's own transition (there is no second finish to
   * race against once this returns false).
   *
   * `finishedByUserId` must be null for `finishReason: 'timeout'` -- an
   * automatic finish names no actor because none clicked anything.
   */
  finishWithAttribution(
    id: number,
    finishedByUserId: string | null,
    finishReason: FinishReason,
  ): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE pickups
         SET status = 'finished', updated_at = ?, finished_at = ?, finished_by_user_id = ?, finish_reason = ?
         WHERE id = ? AND status = 'published'`,
      )
      .run(now, now, finishedByUserId, finishReason, id);
    return result.changes === 1;
  }

  /**
   * Published pickups whose scheduled start passed the automatic-finish
   * deadline -- issue #37's T+3h timeout. `status = 'published'` in the same
   * WHERE clause as the caller's later `finishWithAttribution` means this is
   * a read the caller must re-verify against, not a claim: a manual Finish
   * (or a startup crash mid-sweep) can move a pickup out of `published`
   * between this query and that write, and `finishWithAttribution`'s own CAS
   * is what actually decides the race, not this list.
   */
  publishedPastAutoFinishDeadline(nowMs: number, thresholdHours: number): Pickup[] {
    const cutoffSeconds = Math.floor(nowMs / 1000) - thresholdHours * 3600;
    const rows = this.db
      .prepare(`SELECT * FROM pickups WHERE status = 'published' AND start_at <= ? ORDER BY id ASC`)
      .all(cutoffSeconds) as PickupRow[];
    return rows.map(hydrate);
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

  /**
   * Same guarantee as `claimVersionIfEditable`, for the post-publish Replace
   * Player mutation instead of the pre-publish Edit Roster ones.
   *
   * codex review finding on PR #33: replace.ts used to call the plain
   * `bumpVersion` here, which only checks `version` -- exactly the gap
   * `claimVersionIfEditable`'s own doc comment already warns about for
   * Publish, just one stage later in the lifecycle. Finish never touches
   * `version` (same as Publish never touching it), so a replacement that
   * started before a concurrent Finish completed could still win its claim
   * on version alone and mutate a roster that had just been closed out from
   * under it -- writing a stale slot, sending a public replacement notice,
   * and leaving the card's controls enabled with no finished note. Folding
   * the status check into the same atomic statement closes that gap exactly
   * as it already does for Publish vs. Shuffle/Edit.
   */
  claimVersionIfPublished(id: number, expectedVersion: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE pickups SET version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'published'`,
      )
      .run(Date.now(), id, expectedVersion);
    return result.changes === 1;
  }

  /**
   * Pickups in any of the given statuses, most recently scheduled first --
   * the external read API's (issue #45) one list query. `guildId` narrows to
   * one guild when given; omitted, spans every guild this instance manages
   * (see docs/api.md's guild-scoping note -- the API layer, not this query,
   * is where a consumer is expected to filter by the guild_id on each
   * record). `statuses` must be non-empty -- the caller is responsible for
   * that, since an empty array would produce invalid SQL (`IN ()`).
   */
  listByStatus(statuses: PickupStatus[], options: { guildId?: string; limit?: number } = {}): Pickup[] {
    const { guildId, limit = 100 } = options;
    const placeholders = statuses.map(() => '?').join(', ');
    const guildClause = guildId ? 'AND guild_id = ?' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM pickups WHERE status IN (${placeholders}) ${guildClause}
         ORDER BY start_at DESC, id DESC LIMIT ?`,
      )
      .all(...statuses, ...(guildId ? [guildId] : []), limit) as PickupRow[];
    return rows.map(hydrate);
  }

  /**
   * Claim the one-time "roster just became complete" notification.
   *
   * Conditioned on `ready_notified_at` still being NULL, so the caller that
   * wins this claim is guaranteed to be the only one that ever sends it —
   * same single-atomic-statement discipline as `transitionStatus`. A pickup
   * whose roster later goes incomplete then complete again finds this already
   * claimed and correctly sends nothing.
   */
  claimReadyNotification(id: number): boolean {
    const result = this.db
      .prepare('UPDATE pickups SET ready_notified_at = ? WHERE id = ? AND ready_notified_at IS NULL')
      .run(Date.now(), id);
    return result.changes === 1;
  }
}
