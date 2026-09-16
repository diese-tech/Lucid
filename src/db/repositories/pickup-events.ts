import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { PickupEvent, PickupEventType } from './types.js';

interface PickupEventRow {
  id: number;
  pickup_id: number;
  pickup_version: number;
  actor_user_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: number;
}

function hydrate(row: PickupEventRow): PickupEvent {
  return {
    id: row.id,
    pickupId: row.pickup_id,
    pickupVersion: row.pickup_version,
    actorUserId: row.actor_user_id,
    eventType: row.event_type as PickupEventType,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/**
 * Append-only operational history for roster mutations (issue #35).
 *
 * This is NOT a public Discord audit command — nothing here is ever rendered
 * to a channel. It exists purely so a human can later reconstruct what
 * happened to a pickup's roster and who did it, independent of whatever the
 * current Discord message happens to show right now.
 *
 * One successful semantic mutation must produce exactly one event; a refused,
 * stale, or no-op interaction must produce zero. Callers are responsible for
 * only calling `record` from a code path that has already fully committed the
 * mutation it describes — this repository does not itself decide whether an
 * action succeeded.
 */
export class PickupEventRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  /**
   * Record one event, capturing the pickup's CURRENT `version` as part of the
   * same INSERT statement — not passed in separately — so there is no gap
   * between "the mutation landed" and "the version this event describes" for
   * a concurrent bump to fall into.
   *
   * Call this immediately after the mutation it describes, with nothing async
   * in between, wrapped in the SAME `db.transaction()` as that mutation
   * whenever the caller can (better-sqlite3 nests transactions as SAVEPOINTs,
   * so wrapping an already-transactional repository call like
   * `RosterSlotRepository.swapOccupants` in an outer `db.transaction()`
   * alongside this call is enough to commit both atomically without changing
   * that method's own signature).
   */
  record(
    pickupId: number,
    actorUserId: string | null,
    eventType: PickupEventType,
    payload: Record<string, unknown> = {},
  ): void {
    const result = this.db
      .prepare(
        `INSERT INTO pickup_events (pickup_id, pickup_version, actor_user_id, event_type, payload_json, created_at)
         SELECT id, version, ?, ?, ?, ? FROM pickups WHERE id = ?`,
      )
      .run(actorUserId, eventType, JSON.stringify(payload), Date.now(), pickupId);
    if (result.changes !== 1) {
      throw new Error(`Cannot record a pickup event: pickup ${pickupId} does not exist.`);
    }
  }

  /** Full history for one pickup, oldest first. */
  forPickup(pickupId: number): PickupEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM pickup_events WHERE pickup_id = ? ORDER BY id ASC')
      .all(pickupId) as PickupEventRow[];
    return rows.map(hydrate);
  }
}
