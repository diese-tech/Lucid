import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
});

function readyPickup() {
  const guildId = 'guild-1';
  const space = seedSpace(db, { guildId });
  const pickups = new PickupRepository(db);
  const pickup = pickups.create({
    guildId,
    createdBy: 'staff-1',
    format: 'pickup_vs_pickup',
    startAt: 2_000_000_000,
    roleLimit: 2,
    ...spaceSnapshot(space),
  });
  pickups.transitionStatus(pickup.id, 'open', 'roster_ready');
  return pickups.byId(pickup.id)!;
}

describe('publication state', () => {
  it('atomically freezes one exact draft and rejects a double claim', () => {
    const pickup = readyPickup();
    const pickups = new PickupRepository(db);

    expect(pickups.beginPublication(pickup.id, pickup.version, 'staff-1')).toBe(true);
    expect(pickups.beginPublication(pickup.id, pickup.version, 'staff-2')).toBe(false);

    const active = pickups.byId(pickup.id)!;
    expect(active.status).toBe('roster_ready');
    expect(active.publicationStatus).toBe('publishing');
    expect(active.version).toBe(pickup.version + 1);
    expect(active.publicationActorUserId).toBe('staff-1');
  });

  it('blocks edit and cancel claims while delivery is active', () => {
    const pickup = readyPickup();
    const pickups = new PickupRepository(db);
    pickups.beginPublication(pickup.id, pickup.version, 'staff-1');
    const active = pickups.byId(pickup.id)!;

    expect(pickups.claimVersionIfEditable(active.id, active.version)).toBe(false);
    expect(pickups.transitionStatusFromAny(active.id, ['open', 'roster_ready'], 'cancelled')).toBe(false);
  });

  it('only becomes published when the confirmed Discord message ID lands', () => {
    const pickup = readyPickup();
    const pickups = new PickupRepository(db);
    pickups.beginPublication(pickup.id, pickup.version, 'staff-1');

    expect(pickups.confirmPublication(pickup.id, 'message-1')).toBe(true);
    expect(pickups.byId(pickup.id)).toMatchObject({
      status: 'published',
      publicationStatus: 'confirmed',
      rosterMessageId: 'message-1',
    });
  });

  it('returns a definite rejection to an editable retry state without changing seats or resetting version', () => {
    const pickup = readyPickup();
    const pickups = new PickupRepository(db);
    pickups.beginPublication(pickup.id, pickup.version, 'staff-1');
    const claimedVersion = pickups.byId(pickup.id)!.version;

    expect(pickups.markPublicationFailed(pickup.id, 'discord-error-50013')).toBe(true);
    expect(pickups.byId(pickup.id)).toMatchObject({
      status: 'roster_ready',
      publicationStatus: 'failed',
      publicationErrorCategory: 'discord-error-50013',
      version: claimedVersion,
    });
    expect(pickups.beginPublication(pickup.id, claimedVersion, 'staff-2')).toBe(true);
  });

  it('conservatively reopens a legacy false-published row only after a definite failed repair', () => {
    const pickup = readyPickup();
    db.prepare(
      `UPDATE pickups
       SET status = 'published', roster_message_id = NULL, publication_status = 'uncertain'
       WHERE id = ?`,
    ).run(pickup.id);

    expect(new PickupRepository(db).markPublicationFailed(pickup.id, 'discord-error-50013')).toBe(true);
    expect(new PickupRepository(db).byId(pickup.id)).toMatchObject({
      status: 'roster_ready',
      publicationStatus: 'failed',
      rosterMessageId: null,
    });
  });
});
