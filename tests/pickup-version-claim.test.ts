/**
 * Regression test for a Codex review finding on PR #19.
 *
 * The roster-mutating handlers used to mutate first and bump the version
 * afterward. Two concurrent staff interactions could both read the same
 * starting version, both pass an early staleness check, and both reach the
 * mutation before either bump landed — so both writes applied, and only one
 * was ever accounted for. `claimVersionIfEditable` fixes this by making the
 * claim itself the gate: it's a single atomic UPDATE, so only one concurrent
 * caller can ever win it for a given expected version.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';

let db: Database.Database;
let pickups: PickupRepository;
let pickupId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  pickups = new PickupRepository(db);
  pickupId = pickups.create({
    guildId: 'g1',
    createdBy: 'staff',
    format: 'pickup_vs_premade',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 1,
  }).id;
  pickups.transitionStatus(pickupId, 'open', 'roster_ready');
});

afterEach(() => db.close());

describe('claimVersionIfEditable', () => {
  it('succeeds once for the current version', () => {
    expect(pickups.claimVersionIfEditable(pickupId, 0)).toBe(true);
    expect(pickups.byId(pickupId)!.version).toBe(1);
  });

  it('the second of two concurrent claims against the same starting version loses', () => {
    // Simulates two staff interactions that both loaded version 0 before either
    // one's mutation ran — exactly the window the original mutate-then-bump
    // pattern left open.
    const first = pickups.claimVersionIfEditable(pickupId, 0);
    const second = pickups.claimVersionIfEditable(pickupId, 0);

    expect(first).toBe(true);
    expect(second).toBe(false);
    // Exactly one bump landed, not two.
    expect(pickups.byId(pickupId)!.version).toBe(1);
  });

  it('fails once the pickup is no longer roster_ready, even with the right version', () => {
    pickups.transitionStatus(pickupId, 'roster_ready', 'published');
    expect(pickups.claimVersionIfEditable(pickupId, 0)).toBe(false);
    // Version is untouched by the failed claim.
    expect(pickups.byId(pickupId)!.version).toBe(0);
  });

  it('closes the race where a stale editor mutates after a concurrent publish', () => {
    // A staff member opens Edit Roster while the draft is still open...
    const renderedVersion = pickups.byId(pickupId)!.version;
    // ...then someone else publishes before the edit is confirmed.
    expect(pickups.transitionStatus(pickupId, 'roster_ready', 'published')).toBe(true);

    // The stale editor's claim must fail even though the version number alone
    // hasn't changed — publish doesn't bump version, only status.
    expect(pickups.claimVersionIfEditable(pickupId, renderedVersion)).toBe(false);
  });
});
