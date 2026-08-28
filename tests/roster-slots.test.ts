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
