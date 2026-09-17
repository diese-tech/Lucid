/**
 * Route handlers for the read-only pickup data API (issue #45).
 *
 * Pure request-in/response-out functions -- no `http` types here at all, so
 * they're trivial to unit test and the actual `node:http` wiring in
 * server.ts stays a thin adapter. Both handlers funnel through
 * `read-model.ts`'s `toPickupRecord`, so the list and by-id shapes can
 * never drift from each other.
 */

import { PickupRepository } from '../db/repositories/pickups.js';
import { RosterSlotRepository } from '../db/repositories/roster-slots.js';
import { SignupRepository } from '../db/repositories/signups.js';
import type { Pickup, PickupStatus } from '../db/repositories/types.js';
import { toPickupRecord, type PickupRecord } from './read-model.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

const PICKUP_STATUSES: readonly PickupStatus[] = ['open', 'roster_ready', 'published', 'cancelled', 'finished'];

/** Default page size and hard ceiling for `limit` -- see routes' own doc comments for why neither is configurable past this. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function isPickupStatus(value: string): value is PickupStatus {
  return (PICKUP_STATUSES as readonly string[]).includes(value);
}

function buildRecord(pickup: Pickup): PickupRecord {
  const signups = new SignupRepository().forPickup(pickup.id);
  const rosterSlots = new RosterSlotRepository().forPickup(pickup.id);
  return toPickupRecord(pickup, signups, rosterSlots);
}

/**
 * GET /api/pickups?status=<comma-separated>&guild_id=<optional>&limit=<optional>
 *
 * `status` is REQUIRED, not defaulted -- an unfiltered, cross-status,
 * cross-guild dump has no natural bound the way e.g. openPickups() does
 * (see that method's own doc comment in pickups.ts for why *that* unbounded
 * query is safe: `open` is self-limiting in practice). This one wouldn't
 * be, so a caller must say what they want rather than silently getting
 * "everything" from an omitted parameter.
 */
export function handleListPickups(searchParams: URLSearchParams): RouteResult {
  const statusParam = searchParams.get('status');
  if (!statusParam) {
    return { status: 400, body: { error: 'status query parameter is required' } };
  }

  const requested = statusParam
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requested.length === 0) {
    return { status: 400, body: { error: 'status query parameter is required' } };
  }
  // Never silently dropped -- a typo'd status value returning zero results
  // (rather than an error) would read as "this filter is correct, there's
  // just nothing due" instead of what actually happened.
  const badValue = requested.find((value) => !isPickupStatus(value));
  if (badValue !== undefined) {
    return { status: 400, body: { error: 'invalid status value', value: badValue } };
  }
  const statuses = requested.filter(isPickupStatus);

  const guildId = searchParams.get('guild_id') ?? undefined;

  let limit = DEFAULT_LIMIT;
  const limitParam = searchParams.get('limit');
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { status: 400, body: { error: 'invalid limit value', value: limitParam } };
    }
    // Clamped, not rejected -- a caller asking for more than the ceiling
    // gets the ceiling rather than an error; only a malformed value errors.
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const pickups = new PickupRepository().listByStatus(statuses, { guildId, limit });
  return { status: 200, body: { pickups: pickups.map(buildRecord) } };
}

/** GET /api/pickups/:id -- any status, since "historical state" explicitly includes finished/cancelled pickups. */
export function handleGetPickup(id: number): RouteResult {
  const pickup = new PickupRepository().byId(id);
  if (!pickup) return { status: 404, body: { error: 'not_found' } };
  return { status: 200, body: buildRecord(pickup) };
}
