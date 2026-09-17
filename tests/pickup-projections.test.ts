/**
 * Unit tests for PickupProjectionRepository -- the durable Discord
 * delivery-recovery ledger added in issue #35's later phase. Flow-level
 * coverage (which surfaces get tracked, how a failure is classified) lives
 * alongside each flow's own test file and tests/projection.test.ts; this
 * file only locks down the repository's own contract in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { PickupProjectionRepository } from '../src/db/repositories/pickup-projections.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';
import { fakeId } from './helpers/discord-mocks.js';

let db: Database.Database;
let pickupId: number;

function createPickup(): number {
  const guildId = fakeId();
  const space = seedSpace(db, { guildId });
  return new PickupRepository(db).create({
    guildId,
    createdBy: 'staff',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  }).id;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  pickupId = createPickup();
});

afterEach(() => db.close());

describe('PickupProjectionRepository', () => {
  it('captures the pickup current version and message ID at begin time', () => {
    const projections = new PickupProjectionRepository(db);
    new PickupRepository(db).bumpVersion(pickupId, 0); // version now 1

    const id = projections.begin(pickupId, 'roster', 'msg-1');

    const [row] = projections.unresolvedForPickup(pickupId);
    expect(row).toMatchObject({ id, pickupId, pickupVersion: 1, surface: 'roster', messageId: 'msg-1', status: 'pending' });
  });

  it('captures the version at begin time, not one the caller might be holding stale', () => {
    const projections = new PickupProjectionRepository(db);
    new PickupRepository(db).bumpVersion(pickupId, 0);
    new PickupRepository(db).bumpVersion(pickupId, 1);

    projections.begin(pickupId, 'review', null);

    expect(projections.unresolvedForPickup(pickupId)[0]?.pickupVersion).toBe(2);
  });

  it('throws rather than silently tracking a projection for a pickup that does not exist', () => {
    const projections = new PickupProjectionRepository(db);
    expect(() => projections.begin(999999, 'roster', null)).toThrow();
  });

  it('marking a row applied clears it from unresolvedForPickup', () => {
    const projections = new PickupProjectionRepository(db);
    const id = projections.begin(pickupId, 'roster', 'msg-1');

    projections.markApplied(id);

    expect(projections.unresolvedForPickup(pickupId)).toHaveLength(0);
  });

  it('marking a row pending or uncertain keeps it in unresolvedForPickup with the recorded status and note', () => {
    const projections = new PickupProjectionRepository(db);
    const pendingId = projections.begin(pickupId, 'roster', 'msg-1');
    projections.markPending(pendingId, 'discord-error-10008');

    expect(projections.unresolvedForPickup(pickupId)).toContainEqual(
      expect.objectContaining({ id: pendingId, status: 'pending', errorContext: 'discord-error-10008' }),
    );
  });

  it('only the LATEST attempt per (pickup, surface) counts -- an older unresolved row is superseded once a newer one exists', () => {
    const projections = new PickupProjectionRepository(db);
    const first = projections.begin(pickupId, 'roster', 'msg-1');
    projections.markUncertain(first, 'transport-uncertain: timeout');

    // A second, later attempt for the SAME surface -- e.g. a retry.
    const second = projections.begin(pickupId, 'roster', 'msg-1');

    const unresolved = projections.unresolvedForPickup(pickupId);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.id).toBe(second);

    // Once the newer attempt succeeds, nothing is left unresolved -- the
    // older, superseded row is never independently retried or reported.
    projections.markApplied(second);
    expect(projections.unresolvedForPickup(pickupId)).toHaveLength(0);
  });

  it('tracks each surface independently for the same pickup', () => {
    const projections = new PickupProjectionRepository(db);
    projections.begin(pickupId, 'review', 'review-msg');
    projections.begin(pickupId, 'roster', 'roster-msg');

    const unresolved = projections.unresolvedForPickup(pickupId);
    expect(unresolved.map((row) => row.surface).sort()).toEqual(['review', 'roster']);
  });

  it('keeps every projection scoped to its own pickup', () => {
    const projections = new PickupProjectionRepository(db);
    const otherPickupId = createPickup();

    projections.begin(pickupId, 'roster', 'a');
    projections.begin(otherPickupId, 'roster', 'b');

    expect(projections.unresolvedForPickup(pickupId)).toHaveLength(1);
    expect(projections.unresolvedForPickup(otherPickupId)).toHaveLength(1);
  });

  it('allUnresolved sweeps unresolved attempts across every pickup, for startup recovery', () => {
    const projections = new PickupProjectionRepository(db);
    const otherPickupId = createPickup();
    const applied = projections.begin(pickupId, 'review', 'a');
    projections.markApplied(applied);
    projections.begin(otherPickupId, 'roster', 'b');

    const all = projections.allUnresolved();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ pickupId: otherPickupId, surface: 'roster' });
  });

  it('is deleted along with its pickup (ON DELETE CASCADE)', () => {
    const projections = new PickupProjectionRepository(db);
    projections.begin(pickupId, 'roster', 'msg-1');

    db.prepare('DELETE FROM pickups WHERE id = ?').run(pickupId);

    expect(projections.unresolvedForPickup(pickupId)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pickup_projection_updates').get()).toEqual({ n: 0 });
  });
});
