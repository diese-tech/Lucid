import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { PickupNotification, PickupNotificationKind, PickupNotificationStatus } from './types.js';

interface PickupNotificationRow {
  id: number;
  pickup_id: number;
  kind: string;
  dedupe_key: string;
  channel_id: string;
  due_at: number;
  payload_snapshot: string | null;
  status: string;
  attempted_at: number | null;
  sent_at: number | null;
  message_id: string | null;
  skipped_reason: string | null;
  error_context: string | null;
  created_at: number;
}

function hydrate(row: PickupNotificationRow): PickupNotification {
  return {
    id: row.id,
    pickupId: row.pickup_id,
    kind: row.kind as PickupNotificationKind,
    dedupeKey: row.dedupe_key,
    channelId: row.channel_id,
    dueAt: row.due_at,
    payloadSnapshot: row.payload_snapshot,
    status: row.status as PickupNotificationStatus,
    attemptedAt: row.attempted_at,
    sentAt: row.sent_at,
    messageId: row.message_id,
    skippedReason: row.skipped_reason,
    errorContext: row.error_context,
    createdAt: row.created_at,
  };
}

export interface ScheduleNotificationInput {
  pickupId: number;
  kind: PickupNotificationKind;
  /** Deterministic per-notification identity -- see the schema's own doc comment. */
  dedupeKey: string;
  channelId: string;
  dueAt: number;
}

/**
 * Durable substrate for one-shot player-facing notifications (issue #36) --
 * see the PickupNotification doc comment in types.ts for what this is (and
 * is not) for, and schema.ts's migration 011 for the full column contract.
 *
 * This repository only ever manages ROUTING/identity and delivery STATE. It
 * never stores or resolves message content beyond the frozen `payloadSnapshot`
 * captured at claim time -- resolving what a notification should actually say,
 * from live pickup/roster state, is notifications.ts's job.
 */
export class PickupNotificationRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  /**
   * Schedule one notification, or return the one that already exists for the
   * same `dedupeKey` untouched. Safe to call more than once for "the same"
   * notification -- a lifecycle transition re-evaluated after a crash, or a
   * scheduling call retried for any reason -- without ever producing a
   * second row: the uniqueness constraint on `dedupe_key` is the only source
   * of truth for "has this already been scheduled," not any in-memory check.
   */
  schedule(input: ScheduleNotificationInput): { created: boolean; notification: PickupNotification } {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO pickup_notifications (pickup_id, kind, dedupe_key, channel_id, due_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(input.pickupId, input.kind, input.dedupeKey, input.channelId, input.dueAt, now);
    const notification = this.byDedupeKey(input.dedupeKey);
    if (!notification) {
      throw new Error(`Failed to schedule or find a pickup notification for dedupe key ${input.dedupeKey}.`);
    }
    return { created: result.changes === 1, notification };
  }

  byDedupeKey(dedupeKey: string): PickupNotification | null {
    const row = this.db
      .prepare('SELECT * FROM pickup_notifications WHERE dedupe_key = ?')
      .get(dedupeKey) as PickupNotificationRow | undefined;
    return row ? hydrate(row) : null;
  }

  /** Every notification not yet due, or due but unclaimed, in due-order. */
  due(now: number, limit = 25): PickupNotification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pickup_notifications WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC, id ASC LIMIT ?`,
      )
      .all(now, limit) as PickupNotificationRow[];
    return rows.map(hydrate);
  }

  /**
   * Atomically claim one pending, due notification for delivery -- the CAS
   * that makes this safe under overlapping worker ticks or process restarts:
   * only the caller whose UPDATE actually matches a row (`changes === 1`)
   * may proceed to resolve content and send. Freezes `payloadSnapshot`
   * (what the caller is about to attempt) in the same statement, so an
   * outcome later left 'uncertain' still has a durable record of what was
   * meant to go out.
   */
  claimDue(id: number, now: number, payloadSnapshot: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE pickup_notifications
         SET status = 'attempted', attempted_at = ?, payload_snapshot = ?
         WHERE id = ? AND status = 'pending' AND due_at <= ?`,
      )
      .run(now, payloadSnapshot, id, now);
    return result.changes === 1;
  }

  /** Confirmed delivered. */
  markSent(id: number, messageId: string): void {
    this.db
      .prepare(`UPDATE pickup_notifications SET status = 'sent', sent_at = ?, message_id = ? WHERE id = ?`)
      .run(Date.now(), messageId, id);
  }

  /** Resolved at delivery time that sending is no longer appropriate -- never claimed, or claimed and found stale. */
  skip(id: number, reason: string): void {
    this.db
      .prepare(`UPDATE pickup_notifications SET status = 'skipped', skipped_reason = ? WHERE id = ?`)
      .run(reason, id);
  }

  /**
   * The send's outcome is genuinely unknown. Terminal -- never claimed or
   * retried again, matching PickupProjectionRepository.markUncertain's own
   * reasoning: retrying could duplicate a message that already went out.
   */
  markUncertain(id: number, errorContext: string): void {
    this.db
      .prepare(`UPDATE pickup_notifications SET status = 'uncertain', error_context = ? WHERE id = ?`)
      .run(errorContext, id);
  }

  /** Every notification left in 'uncertain' -- startup's own report-to-a-human sweep. */
  allUncertain(): PickupNotification[] {
    const rows = this.db
      .prepare(`SELECT * FROM pickup_notifications WHERE status = 'uncertain' ORDER BY id ASC`)
      .all() as PickupNotificationRow[];
    return rows.map(hydrate);
  }

  /** Full notification history for one pickup, oldest first -- test/debugging use. */
  forPickup(pickupId: number): PickupNotification[] {
    const rows = this.db
      .prepare('SELECT * FROM pickup_notifications WHERE pickup_id = ? ORDER BY id ASC')
      .all(pickupId) as PickupNotificationRow[];
    return rows.map(hydrate);
  }
}
