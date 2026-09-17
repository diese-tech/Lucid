import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import type { PickupProjectionUpdate, ProjectionSurface } from './types.js';

interface PickupProjectionRow {
  id: number;
  pickup_id: number;
  pickup_version: number;
  surface: string;
  message_id: string | null;
  status: string;
  attempted_at: number | null;
  applied_at: number | null;
  error_context: string | null;
  created_at: number;
}

function hydrate(row: PickupProjectionRow): PickupProjectionUpdate {
  return {
    id: row.id,
    pickupId: row.pickup_id,
    pickupVersion: row.pickup_version,
    surface: row.surface as ProjectionSurface,
    messageId: row.message_id,
    status: row.status as PickupProjectionUpdate['status'],
    attemptedAt: row.attempted_at,
    appliedAt: row.applied_at,
    errorContext: row.error_context,
    createdAt: row.created_at,
  };
}

/** Selects the latest row per (pickup, surface) that is not yet 'applied'. */
const UNRESOLVED_LATEST_PER_SURFACE = `
  SELECT t.* FROM pickup_projection_updates t
  WHERE t.status != 'applied'
    AND t.id = (
      SELECT MAX(id) FROM pickup_projection_updates t2
      WHERE t2.pickup_id = t.pickup_id AND t2.surface = t.surface
    )
`;

/**
 * Durable per-attempt record of projecting an already-committed mutation onto
 * Discord -- see the PickupProjectionUpdate doc comment in types.ts. Audit
 * (PickupEventRepository) and delivery (this) are deliberately separate
 * tables, mirroring the same idiom that repository already established.
 */
export class PickupProjectionRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  /**
   * Begin tracking one attempt to project `surface` onto `messageId`,
   * capturing the pickup's CURRENT version in the same INSERT statement --
   * mirrors PickupEventRepository.record's own idiom, for the same reason:
   * no gap between "this is the version being projected" and a concurrent
   * bump landing in between.
   *
   * Call this immediately before attempting the Discord edit/send it
   * describes -- see projection.ts's projectSurface, the normal caller.
   */
  begin(pickupId: number, surface: ProjectionSurface, messageId: string | null): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO pickup_projection_updates
           (pickup_id, pickup_version, surface, message_id, status, attempted_at, created_at)
         SELECT id, version, ?, ?, 'pending', ?, ? FROM pickups WHERE id = ?`,
      )
      .run(surface, messageId, now, now, pickupId);
    if (result.changes !== 1) {
      throw new Error(`Cannot begin a projection update: pickup ${pickupId} does not exist.`);
    }
    return Number(result.lastInsertRowid);
  }

  /** Confirmed the edit/send landed. */
  markApplied(id: number): void {
    this.db
      .prepare(
        `UPDATE pickup_projection_updates SET status = 'applied', applied_at = ?, error_context = NULL WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /** A confirmed Discord rejection safe to simply retry later -- see projection.ts's classifyProjectionFailure. */
  markPending(id: number, errorContext: string): void {
    this.db
      .prepare(`UPDATE pickup_projection_updates SET status = 'pending', error_context = ? WHERE id = ?`)
      .run(errorContext, id);
  }

  /** A transport/response failure that leaves whether the edit actually landed genuinely unknown. */
  markUncertain(id: number, errorContext: string): void {
    this.db
      .prepare(`UPDATE pickup_projection_updates SET status = 'uncertain', error_context = ? WHERE id = ?`)
      .run(errorContext, id);
  }

  /**
   * The latest delivery attempt per surface for this pickup, for whichever
   * surfaces that latest attempt left unresolved. A newer attempt for a
   * surface always supersedes an older one for this purpose -- once a fresh
   * redraw succeeds, whatever an earlier attempt was left uncertain about no
   * longer matters, and the old row simply stands as history rather than
   * needing to be explicitly marked "superseded".
   */
  unresolvedForPickup(pickupId: number): PickupProjectionUpdate[] {
    const rows = this.db
      .prepare(`${UNRESOLVED_LATEST_PER_SURFACE} AND t.pickup_id = ? ORDER BY t.id ASC`)
      .all(pickupId) as PickupProjectionRow[];
    return rows.map(hydrate);
  }

  /** Same as unresolvedForPickup, across every pickup -- startup reconciliation's own sweep. */
  allUnresolved(): PickupProjectionUpdate[] {
    const rows = this.db.prepare(`${UNRESOLVED_LATEST_PER_SURFACE} ORDER BY t.id ASC`).all() as PickupProjectionRow[];
    return rows.map(hydrate);
  }
}
