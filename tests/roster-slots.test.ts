/**
 * Regression tests for the staff-override marker on roster slots.
 *
 * These exist because two separately-correct rules collide without it:
 *   1. Staff may assign a player to a role they never signed up for.
 *   2. Publishing is blocked while a rostered player has no signup for their
 *      slot's role.
 * Taken together and applied naively, using rule 1 immediately trips rule 2 and
 * greys out Publish, making the override impossible to actually use. The
 * `staffAssigned` marker is what separates "a human put them here" from "this
 * player quietly dropped out".
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../src/db/repositories/signups.js';
import type { SlotAssignment } from '../src/domain/roster.js';

let db: Database.Database;
let pickups: PickupRepository;
let slots: RosterSlotRepository;
let pickupId: number;

const DRAFT: SlotAssignment[] = [
  { team: 'order', role: 'solo', userId: 'u1' },
  { team: 'order', role: 'jungle', userId: 'u2' },
  { team: 'order', role: 'mid', userId: 'u3' },
  { team: 'order', role: 'support', userId: 'u4' },
  { team: 'order', role: 'carry', userId: 'u5' },
  { team: 'chaos', role: 'solo', userId: 'u6' },
  { team: 'chaos', role: 'jungle', userId: 'u7' },
  { team: 'chaos', role: 'mid', userId: 'u8' },
  { team: 'chaos', role: 'support', userId: 'u9' },
  { team: 'chaos', role: 'carry', userId: 'u10' },
];

beforeEach(() => {
  db = openDatabase(':memory:');
  pickups = new PickupRepository(db);
  slots = new RosterSlotRepository(db);
  pickupId = pickups.create({
    guildId: 'g1',
    createdBy: 'staff',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
  }).id;
  slots.replaceAll(pickupId, DRAFT);
});

afterEach(() => db.close());

function slotFor(team: string, role: string) {
  const found = slots.forPickup(pickupId).find((s) => s.team === team && s.role === role);
  if (!found) throw new Error(`missing slot ${team}/${role}`);
  return found;
}

describe('staff-assigned marker', () => {
  it('is clear on a freshly generated roster', () => {
    expect(slots.forPickup(pickupId).every((slot) => !slot.staffAssigned)).toBe(true);
  });

  it('is set by a cross-role exchange, on both slots', () => {
    const a = slotFor('order', 'solo');
    const b = slotFor('chaos', 'mid');
    slots.swapOccupants(a.id, b.id, true);

    expect(slotFor('order', 'solo').userId).toBe('u8');
    expect(slotFor('chaos', 'mid').userId).toBe('u1');
    expect(slotFor('order', 'solo').staffAssigned).toBe(true);
    expect(slotFor('chaos', 'mid').staffAssigned).toBe(true);
  });

  it('stays clear for a same-role swap between teams', () => {
    // Both players keep playing a role they actually signed up for, so there is
    // nothing to exempt from the withdrawal check.
    slots.swapOccupants(slotFor('order', 'solo').id, slotFor('chaos', 'solo').id);

    expect(slotFor('order', 'solo').userId).toBe('u6');
    expect(slotFor('order', 'solo').staffAssigned).toBe(false);
    expect(slotFor('chaos', 'solo').staffAssigned).toBe(false);
  });

  it('stays clear when a slot is filled from the eligible bench', () => {
    slots.setOccupant(slotFor('order', 'solo').id, 'bench1');
    expect(slotFor('order', 'solo').staffAssigned).toBe(false);
  });

  it('is set when a slot is filled by an override', () => {
    slots.setOccupant(slotFor('order', 'solo').id, 'outsider', true);
    expect(slotFor('order', 'solo').staffAssigned).toBe(true);
  });

  it('survives a later same-role swap once set', () => {
    // Moving an overridden player around must not quietly re-subject them to
    // the eligibility check they were deliberately exempted from.
    slots.setOccupant(slotFor('order', 'solo').id, 'outsider', true);
    slots.swapOccupants(slotFor('order', 'solo').id, slotFor('chaos', 'solo').id);

    expect(slotFor('chaos', 'solo').userId).toBe('outsider');
    expect(slotFor('chaos', 'solo').staffAssigned).toBe(true);
  });

  it('is cleared by a regenerated roster, since Shuffle discards manual edits', () => {
    slots.setOccupant(slotFor('order', 'solo').id, 'outsider', true);
    slots.replaceAll(pickupId, DRAFT);

    expect(slots.forPickup(pickupId).every((slot) => !slot.staffAssigned)).toBe(true);
  });

  it('keeps every slot occupied through an exchange', () => {
    slots.swapOccupants(slotFor('order', 'solo').id, slotFor('chaos', 'mid').id, true);

    const all = slots.forPickup(pickupId);
    expect(all).toHaveLength(10);
    expect(new Set(all.map((s) => s.userId)).size).toBe(10);
  });
});

describe('replaceWorkingRoster', () => {
  beforeEach(() => {
    // These tests want a clean slate, not the full DRAFT roster seeded above.
    slots.replaceWorkingRoster(pickupId, []);
  });

  it('inserts automatic slots as not staff-assigned', () => {
    slots.replaceWorkingRoster(pickupId, [{ team: 'order', role: 'solo', userId: 'p1' }]);

    const all = slots.forPickup(pickupId);
    expect(all).toHaveLength(1);
    expect(all[0]!.userId).toBe('p1');
    expect(all[0]!.staffAssigned).toBe(false);
  });

  it('leaves an existing staff-assigned slot completely untouched', () => {
    slots.replaceWorkingRoster(pickupId, [{ team: 'order', role: 'solo', userId: 'p1' }]);
    slots.setOccupant(slotFor('order', 'solo').id, 'manual-pick', true);

    // A later recompute that no longer even mentions this location must not
    // remove or alter the staff-assigned row.
    slots.replaceWorkingRoster(pickupId, [{ team: 'chaos', role: 'jungle', userId: 'p2' }]);

    const all = slots.forPickup(pickupId);
    expect(all).toHaveLength(2);
    expect(slotFor('order', 'solo').userId).toBe('manual-pick');
    expect(slotFor('order', 'solo').staffAssigned).toBe(true);
    expect(slotFor('chaos', 'jungle').userId).toBe('p2');
    expect(slotFor('chaos', 'jungle').staffAssigned).toBe(false);
  });

  it('drops an automatic slot that no longer appears in the new set', () => {
    slots.replaceWorkingRoster(pickupId, [{ team: 'order', role: 'solo', userId: 'p1' }]);
    slots.replaceWorkingRoster(pickupId, [{ team: 'order', role: 'jungle', userId: 'p2' }]);

    const all = slots.forPickup(pickupId);
    expect(all).toHaveLength(1);
    expect(all[0]!.userId).toBe('p2');
  });

  it('clears every automatic slot when given an empty set, without touching staff-assigned ones', () => {
    slots.replaceWorkingRoster(pickupId, [{ team: 'order', role: 'solo', userId: 'p1' }]);
    slots.setOccupant(slotFor('order', 'solo').id, 'manual-pick', true);
    slots.replaceWorkingRoster(pickupId, []);

    const all = slots.forPickup(pickupId);
    expect(all).toHaveLength(1);
    expect(all[0]!.userId).toBe('manual-pick');
  });
});

describe('addFixedSlot', () => {
  let openPickupId: number;
  let signups: SignupRepository;

  beforeEach(() => {
    signups = new SignupRepository(db);
    openPickupId = pickups.create({
      guildId: 'g1',
      createdBy: 'staff',
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
    }).id;
  });

  it('inserts a staff-assigned seat for a currently signed-up player', () => {
    signups.add(openPickupId, 'p1', 'jungle', 2);
    const outcome = slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p1');

    expect(outcome).toEqual({ status: 'added' });
    const seat = slots.forPickup(openPickupId).find((s) => s.team === 'order' && s.role === 'jungle');
    expect(seat?.userId).toBe('p1');
    expect(seat?.staffAssigned).toBe(true);
  });

  it('refuses a player with no signup for this pickup at all', () => {
    // codex review finding on PR #39: currentWorkingRoster reads signups
    // BEFORE its own async eligibility lookup, so a withdrawal landing
    // during that wait must not slip past a stale "still eligible" check --
    // this is the guard that actually closes it, checked transactionally
    // with the insert itself.
    const outcome = slots.addFixedSlot(openPickupId, 'order', 'jungle', 'ghost');

    expect(outcome).toEqual({ status: 'user_withdrawn' });
    expect(slots.forPickup(openPickupId)).toHaveLength(0);
  });

  it('refuses once the pickup is no longer open', () => {
    signups.add(openPickupId, 'p1', 'jungle', 2);
    pickups.transitionStatus(openPickupId, 'open', 'cancelled');

    const outcome = slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p1');

    expect(outcome).toEqual({ status: 'pickup_not_open' });
    expect(slots.forPickup(openPickupId)).toHaveLength(0);
  });

  it('refuses a location already occupied', () => {
    signups.add(openPickupId, 'p1', 'jungle', 2);
    signups.add(openPickupId, 'p2', 'jungle', 2);
    slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p1');

    const outcome = slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p2');

    expect(outcome).toEqual({ status: 'location_taken' });
    expect(slots.forPickup(openPickupId)).toHaveLength(1);
  });

  it('refuses a player who already holds a different seat', () => {
    signups.add(openPickupId, 'p1', 'jungle', 2);
    signups.add(openPickupId, 'p1', 'mid', 2);
    slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p1');

    const outcome = slots.addFixedSlot(openPickupId, 'chaos', 'mid', 'p1');

    expect(outcome).toEqual({ status: 'user_already_rostered' });
    expect(slots.forPickup(openPickupId)).toHaveLength(1);
  });
});

describe('pruneStaleFixedSlots', () => {
  let openPickupId: number;
  let signups: SignupRepository;

  beforeEach(() => {
    signups = new SignupRepository(db);
    openPickupId = pickups.create({
      guildId: 'g1',
      createdBy: 'staff',
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
    }).id;
  });

  it('leaves a staff-assigned slot alone when its occupant is still eligible', () => {
    signups.add(openPickupId, 'p1', 'jungle', 2);
    slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p1');

    slots.pruneStaleFixedSlots(openPickupId, new Set(['p1']));

    expect(slots.forPickup(openPickupId)).toHaveLength(1);
  });

  it('removes a staff-assigned slot whose occupant is no longer eligible', () => {
    signups.add(openPickupId, 'p1', 'jungle', 2);
    slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p1');

    // p1 withdrew (or lost the eligibility role) -- no longer in the
    // currently-eligible set the caller resolved.
    slots.pruneStaleFixedSlots(openPickupId, new Set());

    expect(slots.forPickup(openPickupId)).toHaveLength(0);
  });

  it('never touches an automatic (non-staff-assigned) slot', () => {
    slots.replaceWorkingRoster(openPickupId, [{ team: 'order', role: 'solo', userId: 'auto1' }]);

    slots.pruneStaleFixedSlots(openPickupId, new Set());

    expect(slots.forPickup(openPickupId)).toHaveLength(1);
  });

  it('frees the location for a fresh placement once the stale occupant is pruned', () => {
    signups.add(openPickupId, 'p1', 'jungle', 2);
    signups.add(openPickupId, 'p2', 'jungle', 2);
    slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p1');

    // Without pruning, this would fail with 'location_taken' even though p1
    // is no longer a valid occupant.
    slots.pruneStaleFixedSlots(openPickupId, new Set(['p2']));
    const outcome = slots.addFixedSlot(openPickupId, 'order', 'jungle', 'p2');

    expect(outcome).toEqual({ status: 'added' });
    expect(slots.forPickup(openPickupId)[0]?.userId).toBe('p2');
  });
});
