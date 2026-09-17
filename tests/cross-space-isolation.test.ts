/**
 * Cross-Pickup-Space isolation -- issue #35's test scenario 16: "active
 * pickups in two Pickup Spaces cannot affect one another."
 *
 * A guild can run several independently staffed Pickup Spaces (#34). This
 * exercises real handler chains (not just repository-layer assertions) to
 * prove that a role authorized in one space grants no authority over a
 * DIFFERENT space's pickup, and that a mutation against one space's pickup
 * leaves the other space's pickup completely untouched -- status, version,
 * message IDs, and audit history alike.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupEventRepository } from '../src/db/repositories/pickup-events.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import type { Pickup, PickupSpace } from '../src/db/repositories/types.js';
import { UNAUTHORIZED_MESSAGE } from '../src/discord/permissions.js';
import { Action } from '../src/discord/ids.js';
import { cancelPickup, handleCancelComponent } from '../src/discord/flows/cancel.js';
import { fakeId, mockComponentInteraction, mockMember } from './helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';

let db: Database.Database;
let guildId: string;
let roleA: string;
let roleB: string;
let spaceA: PickupSpace;
let spaceB: PickupSpace;

function createPickupIn(space: PickupSpace): Pickup {
  const pickup = new PickupRepository(db).create({
    guildId,
    createdBy: 'creator',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  });
  new PickupRepository(db).setMessageIds(pickup.id, {
    signupMessageId: fakeId(),
    reviewMessageId: fakeId(),
  });
  return new PickupRepository(db).byId(pickup.id)!;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  roleA = fakeId();
  roleB = fakeId();
  spaceA = seedSpace(db, { guildId, name: 'Space A', authorizedRoleIds: [roleA] });
  spaceB = seedSpace(db, { guildId, name: 'Space B', authorizedRoleIds: [roleB] });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
});

describe('cross-Pickup-Space isolation (issue #35 scenario 16)', () => {
  it("a role authorized in Space A grants no authority over Space B's pickup", async () => {
    const pickupB = createPickupIn(spaceB);
    const staffOfA = mockMember({ roleIds: [roleA] }); // NOT authorized for Space B

    const interaction = mockComponentInteraction({ guildId, member: staffOfA, userId: staffOfA.id });
    await handleCancelComponent(interaction, { action: Action.Cancel, pickupId: pickupB.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
    expect(new PickupRepository(db).byId(pickupB.id)?.status).toBe('open');
  });

  it("cancelling Space A's pickup leaves Space B's active pickup completely untouched", async () => {
    const pickupA = createPickupIn(spaceA);
    const pickupB = createPickupIn(spaceB);
    const staffOfA = mockMember({ roleIds: [roleA] });

    await cancelPickup({} as never, pickupA.id, staffOfA.id);

    const a = new PickupRepository(db).byId(pickupA.id)!;
    const b = new PickupRepository(db).byId(pickupB.id)!;
    expect(a.status).toBe('cancelled');
    // Space B's pickup: status, version, and message IDs are all exactly as
    // they were before Space A's cancellation.
    expect(b.status).toBe('open');
    expect(b.version).toBe(pickupB.version);
    expect(b.signupMessageId).toBe(pickupB.signupMessageId);
    expect(b.reviewMessageId).toBe(pickupB.reviewMessageId);
    // The audit event is scoped to pickup A alone.
    expect(new PickupEventRepository(db).forPickup(pickupA.id)).toHaveLength(1);
    expect(new PickupEventRepository(db).forPickup(pickupB.id)).toHaveLength(0);
  });

  it("a role authorized in Space B grants no authority over Space A's pickup, even in the same guild", async () => {
    const pickupA = createPickupIn(spaceA);
    const staffOfB = mockMember({ roleIds: [roleB] }); // NOT authorized for Space A

    const interaction = mockComponentInteraction({ guildId, member: staffOfB, userId: staffOfB.id });
    await handleCancelComponent(interaction, { action: Action.Cancel, pickupId: pickupA.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
    expect(new PickupRepository(db).byId(pickupA.id)?.status).toBe('open');
  });
});
