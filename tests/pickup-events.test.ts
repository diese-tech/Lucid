/**
 * Unit tests for PickupEventRepository -- the append-only operational history
 * added in issue #35's first phase. Flow-level coverage (one event per
 * successful mutation, zero on a refused/stale one) lives alongside each
 * flow's own test file; this file only locks down the repository's own
 * contract in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { PickupEventRepository } from '../src/db/repositories/pickup-events.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';
import { fakeId } from './helpers/discord-mocks.js';

let db: Database.Database;
let pickupId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  const guildId = fakeId();
  const space = seedSpace(db, { guildId });
  pickupId = new PickupRepository(db).create({
    guildId,
    createdBy: 'staff',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  }).id;
});

afterEach(() => db.close());

describe('PickupEventRepository', () => {
  it('records an event carrying the pickup current version and payload', () => {
    const events = new PickupEventRepository(db);
    new PickupRepository(db).bumpVersion(pickupId, 0); // version now 1

    events.record(pickupId, 'staff-1', 'roster_shuffled', { slotCount: 10 });

    const [event] = events.forPickup(pickupId);
    expect(event).toMatchObject({
      pickupId,
      pickupVersion: 1,
      actorUserId: 'staff-1',
      eventType: 'roster_shuffled',
      payload: { slotCount: 10 },
    });
  });

  it('accepts a null actor for automatic (non-staff) events', () => {
    const events = new PickupEventRepository(db);

    events.record(pickupId, null, 'working_roster_generated', { seated: 8 });

    expect(events.forPickup(pickupId)[0]).toMatchObject({ actorUserId: null });
  });

  it('captures the version at record time, not a version passed in by the caller', () => {
    // Load-bearing: this is what closes the gap the doc comment describes --
    // if a caller could pass its own (possibly stale) version, a concurrent
    // bump landing between the mutation and the event write could make the
    // event describe a version that never actually existed with this
    // payload.
    const events = new PickupEventRepository(db);
    new PickupRepository(db).bumpVersion(pickupId, 0);
    new PickupRepository(db).bumpVersion(pickupId, 1);

    events.record(pickupId, 'staff-1', 'roster_shuffled', {});

    expect(events.forPickup(pickupId)[0]?.pickupVersion).toBe(2);
  });

  it('keeps every pickup event scoped to its own pickup', () => {
    const events = new PickupEventRepository(db);
    const guildId = fakeId();
    const otherSpace = seedSpace(db, { guildId });
    const otherPickupId = new PickupRepository(db).create({
      guildId,
      createdBy: 'staff',
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      ...spaceSnapshot(otherSpace),
    }).id;

    events.record(pickupId, 'staff-1', 'roster_shuffled', {});
    events.record(otherPickupId, 'staff-2', 'pickup_cancelled', {});

    expect(events.forPickup(pickupId)).toHaveLength(1);
    expect(events.forPickup(otherPickupId)).toHaveLength(1);
  });

  it('returns history oldest first', () => {
    const events = new PickupEventRepository(db);

    events.record(pickupId, null, 'working_roster_generated', { seq: 1 });
    events.record(pickupId, 'staff-1', 'player_seated', { seq: 2 });
    events.record(pickupId, 'staff-1', 'roster_shuffled', { seq: 3 });

    expect(events.forPickup(pickupId).map((e) => e.payload.seq)).toEqual([1, 2, 3]);
  });

  it('throws rather than silently recording an event for a pickup that does not exist', () => {
    const events = new PickupEventRepository(db);
    expect(() => events.record(999999, 'staff-1', 'roster_shuffled', {})).toThrow();
  });

  it('is deleted along with its pickup (ON DELETE CASCADE)', () => {
    const events = new PickupEventRepository(db);
    events.record(pickupId, 'staff-1', 'roster_shuffled', {});

    db.prepare('DELETE FROM pickups WHERE id = ?').run(pickupId);

    expect(events.forPickup(pickupId)).toHaveLength(0);
  });
});
