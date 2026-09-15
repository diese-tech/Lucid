/**
 * Flow tests for manual seating -- src/discord/flows/seat.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import type { Pickup, PickupSpace } from '../../src/db/repositories/types.js';
import { UNAUTHORIZED_MESSAGE } from '../../src/discord/permissions.js';
import { Action } from '../../src/discord/ids.js';
import { handleSeatComponent } from '../../src/discord/flows/seat.js';
import {
  fakeId,
  mockClient,
  mockComponentInteraction,
  mockMember,
  mockMessage,
  mockTextChannel,
} from '../helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from '../helpers/fixtures.js';

function firstOptionValues(row: unknown): string[] {
  const json = (row as { toJSON: () => { components: { options: { value: string }[] }[] } }).toJSON();
  return json.components[0]!.options.map((option) => option.value);
}

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let staff: ReturnType<typeof mockMember>;
let space: PickupSpace;
let reviewChannelId: string;

function createOpenPickup(): Pickup {
  return new PickupRepository(db).create({
    guildId,
    createdBy: staff.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  });
}

function clientFor(reviewMessage = mockMessage()) {
  const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
  return { client: mockClient({ channels: { [reviewChannelId]: reviewChannel } }), reviewMessage };
}

function interactionFor(kind: 'button' | 'string-select', extra: Record<string, unknown> = {}) {
  return mockComponentInteraction({
    guildId,
    member: staff,
    userId: staff.id,
    kind,
    ...extra,
  } as never);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  authorizedRoleId = fakeId();
  reviewChannelId = fakeId();
  space = seedSpace(db, { guildId, authorizedRoleIds: [authorizedRoleId], reviewChannelId });
  staff = mockMember({ roleIds: [authorizedRoleId], username: 'coordinator' });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('handleSeatComponent -- authorization', () => {
  it('refuses an unauthorized member before doing anything else', async () => {
    const pickup = createOpenPickup();
    const unauthorized = mockMember({ roleIds: [] });
    const interaction = mockComponentInteraction({ guildId, member: unauthorized, userId: unauthorized.id });

    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
  });

  it('refuses when the pickup no longer exists', async () => {
    const interaction = interactionFor('button');
    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: 999999, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'That pickup no longer exists.' }),
    );
  });
});

describe('SeatPlayer (step 1 -- pick the open seat)', () => {
  it('refuses a pickup that is not open', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'cancelled');

    const { client } = clientFor();
    const interaction = interactionFor('button', { client });
    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer collecting a working roster') }),
    );
  });

  it('says there is nothing to seat when no eligible signups are unseated', async () => {
    const pickup = createOpenPickup();
    const { client } = clientFor();
    const interaction = interactionFor('button', { client });

    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No eligible signed-up players') }),
    );
  });

  it('offers every open location when eligible unseated signups exist', async () => {
    const pickup = createOpenPickup();
    // Three Solo signups for two Solo seats: the matcher auto-fills both
    // Solo locations, leaving the third (latest) signup genuinely unseated
    // -- exactly the state Seat Player exists for.
    const signups = new SignupRepository(db);
    signups.add(pickup.id, 'alice', 'solo', 2);
    signups.add(pickup.id, 'bob', 'solo', 2);
    signups.add(pickup.id, 'carol', 'solo', 2);
    const { client } = clientFor();
    const interaction = interactionFor('button', { client });

    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
    const values = firstOptionValues(payload.components[0]);
    // Solo is fully seated (order + chaos); every other location is open.
    expect(values).toHaveLength(8);
    expect(values).not.toContain('order:solo');
    expect(values).not.toContain('chaos:solo');
  });
});

describe('SeatPickSlot (step 2 -- pick the player)', () => {
  it('refuses when the chosen seat was just filled by someone else', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);
    new SignupRepository(db).add(pickup.id, 'bob', 'jungle', 2);
    new SignupRepository(db).add(pickup.id, 'someone-else', 'jungle', 2);
    // Simulate a race: this exact seat got filled between the slot menu
    // rendering and this selection landing.
    new RosterSlotRepository(db).addFixedSlot(pickup.id, 'chaos', 'jungle', 'someone-else');

    const { client } = clientFor();
    const interaction = interactionFor('string-select', { client, customId: `${Action.SeatPickSlot}:${pickup.id}`, values: ['chaos:jungle'] });

    await handleSeatComponent(interaction, { action: Action.SeatPickSlot, pickupId: pickup.id, args: [] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('was just filled') }),
    );
  });

  it('lists unseated eligible signups with their declared roles', async () => {
    const pickup = createOpenPickup();
    // Three Solo-only signups for two Solo seats: alice and bob auto-fill
    // Solo, leaving carol (latest) unseated -- Jungle has no signups at all,
    // so chaos:jungle stays open for her to be placed into by hand.
    const signups = new SignupRepository(db);
    signups.add(pickup.id, 'alice', 'solo', 2);
    signups.add(pickup.id, 'bob', 'solo', 2);
    signups.add(pickup.id, 'carol', 'solo', 2);

    const { client } = clientFor();
    const interaction = interactionFor('string-select', {
      client,
      customId: `${Action.SeatPickSlot}:${pickup.id}`,
      values: ['chaos:jungle'],
    });

    await handleSeatComponent(interaction, { action: Action.SeatPickSlot, pickupId: pickup.id, args: [] });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
    const values = firstOptionValues(payload.components[0]);
    expect(values).toEqual(['carol']);
  });
});

describe('SeatPickPlayer (step 3 -- confirm)', () => {
  it('offers a plain Confirm when the player declared that role', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'jungle', 2);

    const { client } = clientFor();
    const interaction = interactionFor('string-select', {
      client,
      customId: `${Action.SeatPickPlayer}:${pickup.id}:order:jungle`,
      values: ['alice'],
    });

    await handleSeatComponent(interaction, {
      action: Action.SeatPickPlayer,
      pickupId: pickup.id,
      args: ['order', 'jungle'],
    });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ content: string; components: unknown[] }];
    expect(payload.content).not.toContain('⚠️');
    const buttons = (payload.components[0] as { toJSON: () => { components: { label: string }[] } }).toJSON();
    expect(buttons.components.map((b) => b.label)).toContain('Confirm');
  });

  it('warns and offers Seat Anyway when the player did not declare that role', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);

    const { client } = clientFor();
    const interaction = interactionFor('string-select', {
      client,
      customId: `${Action.SeatPickPlayer}:${pickup.id}:order:jungle`,
      values: ['alice'],
    });

    await handleSeatComponent(interaction, {
      action: Action.SeatPickPlayer,
      pickupId: pickup.id,
      args: ['order', 'jungle'],
    });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ content: string; components: unknown[] }];
    expect(payload.content).toContain('⚠️');
    expect(payload.content).toContain('did not sign up for Jungle');
    const buttons = (payload.components[0] as { toJSON: () => { components: { label: string }[] } }).toJSON();
    expect(buttons.components.map((b) => b.label)).toContain('Seat Anyway');
  });
});

describe('SeatConfirm (step 4 -- commit)', () => {
  function confirmInteraction(pickupId: number, team: string, role: string, userId: string, decision: string, client: unknown) {
    return interactionFor('button', {
      client,
      customId: `${Action.SeatConfirm}:${pickupId}:${team}:${role}:${userId}:${decision}`,
    });
  }

  it('makes no changes when the coordinator cancels', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'alice', 'no', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'alice', 'no'],
    });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'No changes made. The roster is unchanged.' }),
    );
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  /**
   * Alice, bob and carol all sign up Solo-only for the pickup's two Solo
   * seats. Alice and bob auto-fill Solo; carol is the latest signup and
   * stays genuinely unseated -- exactly the fixture every commit test below
   * needs, since a single signup for any role always gets auto-seated
   * (capacity 2) and so can never be a realistic "still unseated" target.
   */
  function seedOversubscribedSolo(pickupId: number): void {
    const signups = new SignupRepository(db);
    signups.add(pickupId, 'alice', 'solo', 2);
    signups.add(pickupId, 'bob', 'solo', 2);
    signups.add(pickupId, 'carol', 'solo', 2);
  }

  it('seats the player as staff_assigned and redraws the control card', async () => {
    const pickup = createOpenPickup();
    seedOversubscribedSolo(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Done') }),
    );
    const slots = new RosterSlotRepository(db).forPickup(pickup.id);
    const seat = slots.find((s) => s.team === 'order' && s.role === 'jungle');
    expect(seat?.userId).toBe('carol');
    expect(seat?.staffAssigned).toBe(true);

    // evaluateRosterReady's own recompute+redraw ran as part of the commit.
    expect(reviewMessage.edit).toHaveBeenCalled();
  });

  it('refuses when the seat was just claimed by a concurrent placement', async () => {
    const pickup = createOpenPickup();
    seedOversubscribedSolo(pickup.id);
    new SignupRepository(db).add(pickup.id, 'someone-else', 'jungle', 2);
    new RosterSlotRepository(db).addFixedSlot(pickup.id, 'order', 'jungle', 'someone-else');
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('was just filled') }),
    );
    const seat = new RosterSlotRepository(db).forPickup(pickup.id).find((s) => s.team === 'order' && s.role === 'jungle');
    expect(seat?.userId).toBe('someone-else');
  });

  it('refuses when the chosen player already holds a different seat', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'jungle', 2);
    new RosterSlotRepository(db).addFixedSlot(pickup.id, 'chaos', 'mid', 'alice');
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'alice', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'alice', 'yes'],
    });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('is no longer an eligible unseated signup') }),
    );
  });

  it('refuses when the player withdrew between confirmation and commit', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'jungle', 2);
    new SignupRepository(db).remove(pickup.id, 'alice', 'jungle');
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'alice', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'alice', 'yes'],
    });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('is no longer an eligible unseated signup') }),
    );
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('freezes the pickup into roster_ready when the manual seat completes the roster', async () => {
    const pickup = createOpenPickup();
    const signups = new SignupRepository(db);
    for (const role of ['solo', 'mid', 'support', 'carry'] as const) {
      signups.add(pickup.id, `${role}-a`, role, 2);
      signups.add(pickup.id, `${role}-b`, role, 2);
    }
    // Jungle is one short of its two seats -- alice fills it manually.
    signups.add(pickup.id, 'jungle-a', 'jungle', 2);
    signups.add(pickup.id, 'alice', 'solo', 2); // off-role, unseated eligible signup

    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = confirmInteraction(pickup.id, 'chaos', 'jungle', 'alice', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['chaos', 'jungle', 'alice', 'yes'],
    });

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    const slots = new RosterSlotRepository(db).forPickup(pickup.id);
    expect(slots).toHaveLength(10);
    const manual = slots.find((s) => s.userId === 'alice');
    expect(manual?.staffAssigned).toBe(true);
  });
});
