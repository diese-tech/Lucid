/**
 * The external, versioned pickup record (issue #45) -- what
 * `GET /api/pickups` and `GET /api/pickups/:id` actually return.
 *
 * Deliberately a SEPARATE shape from the internal `Pickup`/`Signup`/
 * `RosterSlot` types, not a passthrough: the internal types carry routing
 * plumbing (origin channel, ping roles, version, staff-only eligibility
 * config) nothing outside Lucid asked for, and expressing that as a
 * silence -- fields simply not present here -- is safer than exposing
 * everything and trusting every future internal field addition to remember
 * "don't leak this externally." `schema_version` is the compatibility
 * contract: a future breaking change bumps it rather than silently
 * reshaping what existing consumers already parse.
 */

import type { Role, SignupRole, Team, PickupFormat } from '../domain/roles.js';
import { ROLES, capacityForFormat } from '../domain/roles.js';
import type { FinishReason, Pickup, PickupStatus, RosterSlot, Signup } from '../db/repositories/types.js';

export interface PickupRecord {
  schema_version: 1;
  id: number;
  guild_id: string;
  status: PickupStatus;
  format: PickupFormat;
  /** Only meaningful for `pickup_vs_premade` -- the opponent's name. Null otherwise. */
  premade_name: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  scheduled_start_at: string;
  finished_at: string | null;
  finished_by: string | null;
  finish_reason: FinishReason | null;
  required_players: number;
  /** Unique participants -- a player holding two SignupRole rows (e.g. solo + fill) still counts once. */
  signup_count: number;
  signups: { discord_id: string; roles: SignupRole[] }[];
  /** Always an array, even before a roster exists -- [] rather than a key consumers must check for. */
  roster: { team: Team; role: Role; discord_id: string }[];
  discord: {
    guild_id: string;
    signup_channel_id: string | null;
    roster_channel_id: string | null;
    review_channel_id: string | null;
    signup_message_id: string | null;
    roster_message_id: string | null;
    review_message_id: string | null;
  };
}

/** Group signups by user, preserving each player's full set of declared roles. */
function signupsByUser(signups: readonly Signup[]): { discord_id: string; roles: SignupRole[] }[] {
  const byUser = new Map<string, SignupRole[]>();
  for (const signup of signups) {
    const roles = byUser.get(signup.userId);
    if (roles) roles.push(signup.role);
    else byUser.set(signup.userId, [signup.role]);
  }
  return [...byUser.entries()].map(([discord_id, roles]) => ({ discord_id, roles }));
}

/**
 * Pure mapping from Lucid's internal state to the external read model.
 * Shared by both the list and by-id routes so the two can never drift.
 */
export function toPickupRecord(pickup: Pickup, signups: readonly Signup[], rosterSlots: readonly RosterSlot[]): PickupRecord {
  const grouped = signupsByUser(signups);
  return {
    schema_version: 1,
    id: pickup.id,
    guild_id: pickup.guildId,
    status: pickup.status,
    format: pickup.format,
    premade_name: pickup.premadeName,
    created_by: pickup.createdBy,
    created_at: new Date(pickup.createdAt).toISOString(),
    updated_at: new Date(pickup.updatedAt).toISOString(),
    // startAt is the one internal timestamp in Unix SECONDS, not milliseconds
    // (every other timestamp column is epoch ms) -- see types.ts's own doc
    // comment on Pickup.startAt.
    scheduled_start_at: new Date(pickup.startAt * 1000).toISOString(),
    finished_at: pickup.finishedAt !== null ? new Date(pickup.finishedAt).toISOString() : null,
    finished_by: pickup.finishedByUserId,
    finish_reason: pickup.finishReason,
    required_players: capacityForFormat(pickup.format) * ROLES.length,
    signup_count: grouped.length,
    signups: grouped,
    roster: rosterSlots.map((slot) => ({ team: slot.team, role: slot.role, discord_id: slot.userId })),
    discord: {
      guild_id: pickup.guildId,
      signup_channel_id: pickup.signupChannelId,
      roster_channel_id: pickup.rosterChannelId,
      review_channel_id: pickup.reviewChannelId,
      signup_message_id: pickup.signupMessageId,
      roster_message_id: pickup.rosterMessageId,
      review_message_id: pickup.reviewMessageId,
    },
  };
}
