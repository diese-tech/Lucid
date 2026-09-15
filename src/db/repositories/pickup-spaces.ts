import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import { parseRoleIds } from './role-ids.js';
import type { PickupSpace } from './types.js';

interface PickupSpaceRow {
  id: number;
  guild_id: string;
  name: string;
  origin_channel_id: string | null;
  signup_channel_id: string | null;
  roster_channel_id: string | null;
  review_channel_id: string | null;
  signup_ping_role_id: string | null;
  default_eligibility_role_ids: string;
  authorized_role_ids: string;
  created_at: number;
  updated_at: number;
}

function hydrate(row: PickupSpaceRow): PickupSpace {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    originChannelId: row.origin_channel_id,
    signupChannelId: row.signup_channel_id,
    rosterChannelId: row.roster_channel_id,
    reviewChannelId: row.review_channel_id,
    signupPingRoleId: row.signup_ping_role_id,
    defaultEligibilityRoleIds: parseRoleIds(row.default_eligibility_role_ids, { failClosed: true }),
    authorizedRoleIds: parseRoleIds(row.authorized_role_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SpaceField =
  | 'name'
  | 'origin_channel_id'
  | 'signup_channel_id'
  | 'roster_channel_id'
  | 'review_channel_id'
  | 'signup_ping_role_id'
  | 'default_eligibility_role_ids'
  | 'authorized_role_ids';

export interface CreateSpaceInput {
  guildId: string;
  name: string;
}

export type CreateSpaceResult =
  | { ok: true; space: PickupSpace }
  | { ok: false; reason: 'duplicate_name' };

export type DeleteSpaceResult = { ok: true } | { ok: false; reason: 'in_use'; pickupCount: number };

export class PickupSpaceRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  get(id: number): PickupSpace | null {
    const row = this.db.prepare('SELECT * FROM pickup_spaces WHERE id = ?').get(id) as
      | PickupSpaceRow
      | undefined;
    return row ? hydrate(row) : null;
  }

  /** All spaces for a guild, oldest first — matches how they were created. */
  list(guildId: string): PickupSpace[] {
    const rows = this.db
      .prepare('SELECT * FROM pickup_spaces WHERE guild_id = ? ORDER BY id ASC')
      .all(guildId) as PickupSpaceRow[];
    return rows.map(hydrate);
  }

  byName(guildId: string, name: string): PickupSpace | null {
    const row = this.db
      .prepare('SELECT * FROM pickup_spaces WHERE guild_id = ? AND name = ?')
      .get(guildId, name) as PickupSpaceRow | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Resolve which space `/pickup create` belongs to from the channel it was
   * run in. Matches `origin_channel_id` only — see product-spec's Pickup
   * Space resolution rule. At most one space can claim a given origin channel
   * in a guild (enforced by callers, not a DB constraint, since a space's
   * origin channel is edited field-by-field like the rest of its config).
   */
  byOriginChannel(guildId: string, channelId: string): PickupSpace | null {
    const row = this.db
      .prepare('SELECT * FROM pickup_spaces WHERE guild_id = ? AND origin_channel_id = ?')
      .get(guildId, channelId) as PickupSpaceRow | undefined;
    return row ? hydrate(row) : null;
  }

  create(input: CreateSpaceInput): CreateSpaceResult {
    const now = Date.now();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO pickup_spaces (guild_id, name, authorized_role_ids, created_at, updated_at)
           VALUES (?, ?, '[]', ?, ?)`,
        )
        .run(input.guildId, input.name, now, now);
      return { ok: true, space: this.get(Number(result.lastInsertRowid))! };
    } catch (error) {
      // SQLITE_CONSTRAINT on the (guild_id, name) unique index.
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return { ok: false, reason: 'duplicate_name' };
      }
      throw error;
    }
  }

  setField(id: number, field: SpaceField, value: string | string[] | null): void {
    const stored = Array.isArray(value) ? JSON.stringify(value) : value;
    this.db
      .prepare(`UPDATE pickup_spaces SET ${field} = ?, updated_at = ? WHERE id = ?`)
      .run(stored, Date.now(), id);
  }

  /** How many pickups (of any status, past or present) reference this space. */
  pickupCount(id: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pickups WHERE pickup_space_id = ?').get(id) as {
      count: number;
    };
    return row.count;
  }

  /**
   * Refuses to delete a space any pickup has ever referenced — a `pickups`
   * row pointing at a deleted space would corrupt history (and, since the
   * column carries a foreign key, the delete would fail regardless once any
   * row references it). Spaces created by mistake and never used are safe to
   * remove outright.
   */
  delete(id: number): DeleteSpaceResult {
    const count = this.pickupCount(id);
    if (count > 0) return { ok: false, reason: 'in_use', pickupCount: count };
    this.db.prepare('DELETE FROM pickup_spaces WHERE id = ?').run(id);
    return { ok: true };
  }
}

/**
 * Which required fields are still unset.
 *
 * A half-configured space is a normal state while an admin is setting it up,
 * so callers must check completeness explicitly before letting anyone create
 * a pickup through it — mirrors guild-config.ts's own missingConfigFields.
 */
export function missingSpaceFields(space: PickupSpace | null): string[] {
  if (!space) return ['everything — run `/pickup space create` first'];

  const missing: string[] = [];
  if (!space.originChannelId) missing.push('origin channel');
  if (!space.signupChannelId) missing.push('signup channel');
  if (!space.rosterChannelId) missing.push('roster channel');
  if (!space.reviewChannelId) missing.push('staff review channel');
  if (space.authorizedRoleIds.length === 0) missing.push('authorized staff roles');
  return missing;
}

export function isSpaceComplete(space: PickupSpace | null): boolean {
  return missingSpaceFields(space).length === 0;
}
