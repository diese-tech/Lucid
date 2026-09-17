/**
 * Unit tests for PickupRepository.finishWithAttribution and
 * publishedPastAutoFinishDeadline -- issue #37's completion metadata and the
 * query that bounds the automatic-finish sweep. Flow-level coverage
 * (finish.ts, the auto-finish worker) lives in its own test files; this one
 * only locks down the repository's own contract in isolation.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';

let db: Database.Database;
let pickups: PickupRepository;
let pickupId: number;

function inSeconds(deltaSeconds: number): number {
  return Math.floor(Date.now() / 1000) + deltaSeconds;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  pickups = new PickupRepository(db);
  pickupId = pickups.create({
    guildId: 'g1', createdBy: 'staff', format: 'pickup_vs_pickup', startAt: inSeconds(3600), roleLimit: 2,
  }).id;
  pickups.transitionStatusFromAny(pickupId, ['open'], 'published');
});

afterEach(() => db.close());

describe('finishWithAttribution', () => {
  it('records a manual finish with its actor', () => {
    const changed = pickups.finishWithAttribution(pickupId, 'staff-1', 'manual');

    expect(changed).toBe(true);
    const pickup = pickups.byId(pickupId)!;
    expect(pickup.status).toBe('finished');
    expect(pickup.finishedByUserId).toBe('staff-1');
    expect(pickup.finishReason).toBe('manual');
    expect(pickup.finishedAt).not.toBeNull();
  });

  it('records a timeout finish with no actor', () => {
    pickups.finishWithAttribution(pickupId, null, 'timeout');

    const pickup = pickups.byId(pickupId)!;
    expect(pickup.finishedByUserId).toBeNull();
    expect(pickup.finishReason).toBe('timeout');
  });

  it('refuses a pickup that is not published', () => {
    expect(pickups.finishWithAttribution(999999, 'staff-1', 'manual')).toBe(false);

    const roster_ready = pickups.create({
      guildId: 'g1', createdBy: 'staff', format: 'pickup_vs_pickup', startAt: inSeconds(3600), roleLimit: 2,
    }).id;
    expect(pickups.finishWithAttribution(roster_ready, 'staff-1', 'manual')).toBe(false);
  });

  it('the second of two concurrent finishes loses -- exactly one terminal transition', () => {
    const first = pickups.finishWithAttribution(pickupId, 'staff-1', 'manual');
    const second = pickups.finishWithAttribution(pickupId, null, 'timeout');

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The winner's attribution stands untouched.
    expect(pickups.byId(pickupId)!.finishReason).toBe('manual');
    expect(pickups.byId(pickupId)!.finishedByUserId).toBe('staff-1');
  });
});

describe('publishedPastAutoFinishDeadline', () => {
  it('finds a published pickup whose scheduled start is already 3+ hours in the past', () => {
    const overdue = pickups.create({
      guildId: 'g1', createdBy: 'staff', format: 'pickup_vs_pickup', startAt: inSeconds(-4 * 3600), roleLimit: 2,
    }).id;
    pickups.transitionStatusFromAny(overdue, ['open'], 'published');

    const due = pickups.publishedPastAutoFinishDeadline(Date.now(), 3);

    expect(due.map((p) => p.id)).toContain(overdue);
  });

  it('excludes a published pickup whose start is within the 3-hour window', () => {
    const notYet = pickups.create({
      guildId: 'g1', createdBy: 'staff', format: 'pickup_vs_pickup', startAt: inSeconds(-2 * 3600), roleLimit: 2,
    }).id;
    pickups.transitionStatusFromAny(notYet, ['open'], 'published');

    const due = pickups.publishedPastAutoFinishDeadline(Date.now(), 3);

    expect(due.map((p) => p.id)).not.toContain(notYet);
  });

  it('excludes an open/roster_ready pickup even with a long-past scheduled start -- it never published, so nothing happened', () => {
    const neverPublished = pickups.create({
      guildId: 'g1', createdBy: 'staff', format: 'pickup_vs_pickup', startAt: inSeconds(-4 * 3600), roleLimit: 2,
    }).id;

    expect(pickups.publishedPastAutoFinishDeadline(Date.now(), 3).map((p) => p.id)).not.toContain(neverPublished);
  });

  it('excludes an already-finished or cancelled pickup', () => {
    const finished = pickups.create({
      guildId: 'g1', createdBy: 'staff', format: 'pickup_vs_pickup', startAt: inSeconds(-4 * 3600), roleLimit: 2,
    }).id;
    pickups.transitionStatusFromAny(finished, ['open'], 'published');
    pickups.finishWithAttribution(finished, 'staff-1', 'manual');

    expect(pickups.publishedPastAutoFinishDeadline(Date.now(), 3).map((p) => p.id)).not.toContain(finished);
  });
});
