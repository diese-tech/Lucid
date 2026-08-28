/**
 * Regression test for a Codex review finding on PR #19.
 *
 * The staff-assigned exemption in `withdrawnUserIds()` was originally
 * unconditional: once a slot was marked staff-assigned, it stayed exempt from
 * the withdrawal check for the rest of the draft's life. That's too broad —
 * it exempts the SPECIFIC role mismatch the override is for, but a player who
 * later removes every reaction has left the pickup entirely, which the
 * override was never meant to paper over.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../src/db/repositories/signups.js';
import { withdrawnUserIds } from '../src/discord/flows/review.js';

let db: Database.Database;
let pickupId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  // withdrawnUserIds() constructs its own repositories internally rather than
  // accepting injected ones, so the module-level singleton has to point at
  // this test's database.
  setDatabaseForTesting(db);

  pickupId = new PickupRepository(db).create({
    guildId: 'g1',
    createdBy: 'staff',
    format: 'pickup_vs_premade',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 1,
  }).id;
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
});

describe('withdrawnUserIds', () => {
  it('flags a normal slot whose occupant has no matching signup', () => {
    new RosterSlotRepository(db).replaceAll(pickupId, [
      { team: 'pickup', role: 'solo', userId: 'u1' },
    ]);
    // u1 never signed up at all.
    expect(withdrawnUserIds(pickupId)).toEqual(new Set(['u1']));
  });

  it('does not flag a normal slot whose occupant signed up for that exact role', () => {
    new SignupRepository(db).add(pickupId, 'u1', 'solo', 1);
    new RosterSlotRepository(db).replaceAll(pickupId, [
      { team: 'pickup', role: 'solo', userId: 'u1' },
    ]);
    expect(withdrawnUserIds(pickupId)).toEqual(new Set());
  });

  it('does not flag a staff-assigned slot for the expected role mismatch', () => {
    const signups = new SignupRepository(db);
    const slots = new RosterSlotRepository(db);
    signups.add(pickupId, 'u1', 'jungle', 1); // signed up for jungle, staff put them at solo
    slots.replaceAll(pickupId, [{ team: 'pickup', role: 'solo', userId: 'u1' }]);
    slots.setOccupant(slots.forPickup(pickupId)[0]!.id, 'u1', true);

    expect(withdrawnUserIds(pickupId)).toEqual(new Set());
  });

  it('still flags a staff-assigned slot once the occupant has zero signups left', () => {
    const signups = new SignupRepository(db);
    const slots = new RosterSlotRepository(db);
    signups.add(pickupId, 'u1', 'jungle', 1);
    slots.replaceAll(pickupId, [{ team: 'pickup', role: 'solo', userId: 'u1' }]);
    slots.setOccupant(slots.forPickup(pickupId)[0]!.id, 'u1', true);

    // The player fully un-reacts — they've left the pickup, not just changed
    // roles. The override must not paper over that.
    signups.remove(pickupId, 'u1', 'jungle');

    expect(withdrawnUserIds(pickupId)).toEqual(new Set(['u1']));
  });
});
