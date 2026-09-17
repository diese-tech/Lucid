/**
 * Flow tests for the player-facing Can't Play flow -- src/discord/flows/availability.ts.
 *
 * Scenario numbers in the test names are issue #36's own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { PickupEventRepository } from '../../src/db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../../src/db/repositories/pickup-notifications.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { PickupSpaceRepository } from '../../src/db/repositories/pickup-spaces.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import type { Pickup, PickupSpace, RosterSlot } from '../../src/db/repositories/types.js';
import { Action, decodeId } from '../../src/discord/ids.js';
import { handleAvailabilityComponent } from '../../src/discord/flows/availability.js';
import { renderAvailabilityAlert } from '../../src/discord/render.js';
import {
  fakeId,
  mockClient,
  mockComponentInteraction,
  mockGuild,
  mockMember,
  mockMessage,
  mockTextChannel,
} from '../helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from '../helpers/fixtures.js';

let db: Database.Database;
let guildId: string;
let organizerRoleId: string;
let organizer: ReturnType<typeof mockMember>;
let player: ReturnType<typeof mockMember>;
let teammate: ReturnType<typeof mockMember>;
let bystander: ReturnType<typeof mockMember>;
let space: PickupSpace;
let rosterChannelId: string;
let reviewChannelId: string;

function spaceWithOrganizerRole(options: { rosterChannelId?: string; reviewChannelId?: string } = {}): PickupSpace {
  const spaces = new PickupSpaceRepository(db);
  const seeded = seedSpace(db, { guildId, ...options });
  spaces.setField(seeded.id, 'organizer_ping_role_id', organizerRoleId);
  return spaces.get(seeded.id)!;
}

/**
 * A published pickup with both public surfaces already posted -- the Can't
 * Play button only ever exists on a published roster message, and the staff
 * card is what the flag has to become visible on.
 */
function createPublishedPickup(options: { pickupSpace?: PickupSpace; withRosterMessage?: boolean } = {}): Pickup {
  const pickups = new PickupRepository(db);
  const pickup = pickups.create({
    guildId,
    createdBy: organizer.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(options.pickupSpace ?? space),
  });
  pickups.transitionStatusFromAny(pickup.id, ['open'], 'published');
  pickups.setMessageIds(pickup.id, {
    reviewMessageId: fakeId(),
    ...(options.withRosterMessage === false ? {} : { rosterMessageId: fakeId() }),
  });
  return pickups.byId(pickup.id)!;
}

function seatRoster(pickup: Pickup): void {
  new RosterSlotRepository(db).replaceAll(pickup.id, [
    { team: 'order', role: 'solo', userId: player.id },
    { team: 'order', role: 'jungle', userId: teammate.id },
  ]);
}

function seatOf(pickupId: number, userId: string): RosterSlot {
  return new RosterSlotRepository(db).forPickup(pickupId).find((slot) => slot.userId === userId)!;
}

function unavailableEvents(pickupId: number) {
  return new PickupEventRepository(db).forPickup(pickupId).filter((e) => e.eventType === 'player_unavailable');
}

function organizerAlerts(pickupId: number) {
  return new PickupNotificationRepository(db).forPickup(pickupId).filter((n) => n.kind === 'availability_alert');
}

/** Nothing this flow can write has been written. */
function expectNothingMutated(pickup: Pickup): void {
  expect(new RosterSlotRepository(db).replacementNeededFor(pickup.id)).toHaveLength(0);
  expect(unavailableEvents(pickup.id)).toHaveLength(0);
  expect(new PickupNotificationRepository(db).forPickup(pickup.id)).toHaveLength(0);
}

function clientFor(pickup: Pickup) {
  const rosterMessage = mockMessage({ id: pickup.rosterMessageId ?? fakeId() });
  const reviewMessage = mockMessage({ id: pickup.reviewMessageId! });
  const client = mockClient({
    channels: {
      [rosterChannelId]: mockTextChannel({ id: rosterChannelId, messages: { [rosterMessage.id]: rosterMessage } }),
      [reviewChannelId]: mockTextChannel({ id: reviewChannelId, messages: { [reviewMessage.id]: reviewMessage } }),
    },
    guilds: { [guildId]: mockGuild({ id: guildId }) },
  });
  return { client, rosterMessage, reviewMessage };
}

/** The public entry click, carrying whichever message ID the test wants it to claim. */
function entryInteraction(
  pickup: Pickup,
  member: ReturnType<typeof mockMember>,
  extra: Record<string, unknown> = {},
) {
  return mockComponentInteraction({
    guildId,
    member,
    userId: member.id,
    customId: `${Action.Unavailable}:${pickup.id}`,
    message: mockMessage({ id: pickup.rosterMessageId ?? fakeId() }),
    ...extra,
  } as never);
}

/**
 * The confirm click. Its `message` is deliberately left as the default fresh
 * mock -- a private ephemeral reply never carries the canonical roster
 * message's ID, which is exactly why issue #35 forbids binding a continuation
 * to it (scenario 12).
 */
function confirmInteraction(
  pickup: Pickup,
  member: ReturnType<typeof mockMember>,
  args: readonly string[],
  extra: Record<string, unknown> = {},
) {
  return mockComponentInteraction({
    guildId,
    member,
    userId: member.id,
    customId: [Action.UnavailableConfirm, pickup.id, ...args].join(':'),
    ...extra,
  } as never);
}

/** The confirm button's own args, read back off the ephemeral prompt this flow rendered. */
function renderedConfirmArgs(entry: ReturnType<typeof entryInteraction>): string[] {
  const [payload] = entry.reply.mock.calls[0]! as [
    { components: { toJSON: () => { components: { custom_id: string }[] } }[] },
  ];
  const customId = payload.components[0]!.toJSON().components[0]!.custom_id;
  return decodeId(customId)!.args;
}

async function dispatch(interaction: ReturnType<typeof entryInteraction>): Promise<void> {
  await handleAvailabilityComponent(interaction, decodeId(interaction.customId)!);
}

/** Open Can't Play and confirm it, exactly as a player clicking through would. */
async function cantPlay(pickup: Pickup, member: ReturnType<typeof mockMember>, client: unknown) {
  const entry = entryInteraction(pickup, member, { client });
  await dispatch(entry);
  const confirm = confirmInteraction(pickup, member, renderedConfirmArgs(entry), { client });
  await dispatch(confirm);
  return { entry, confirm };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  organizerRoleId = fakeId();
  rosterChannelId = fakeId();
  reviewChannelId = fakeId();
  space = spaceWithOrganizerRole({ rosterChannelId, reviewChannelId });
  organizer = mockMember({ username: 'organizer' });
  player = mockMember({ username: 'seated-player' });
  teammate = mockMember({ username: 'teammate' });
  bystander = mockMember({ username: 'bystander' });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe("Can't Play entry", () => {
  it('offers a seated player the private confirmation, mutating nothing yet (scenario 9)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    const entry = entryInteraction(pickup, player, { client });
    await dispatch(entry);

    const [payload] = entry.reply.mock.calls[0]! as [{ content: string; components: unknown[] }];
    expect(payload.content).toContain("Can't make this pickup?");
    expect(payload.content).toContain('notify the organizer');
    // The seat and the version this player is acting on both travel in the
    // confirm button, so the commit step can refuse a roster that moved.
    expect(renderedConfirmArgs(entry)).toEqual([String(seatOf(pickup.id, player.id).id), String(pickup.version), 'yes']);
    expectNothingMutated(pickup);
  });

  it('refuses a user who holds no seat on this roster (scenario 10)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    const entry = entryInteraction(pickup, bystander, { client });
    await dispatch(entry);

    expect(entry.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not seated on this roster') }),
    );
    expectNothingMutated(pickup);
  });

  it('refuses a control copied off some other message (scenario 11)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    const entry = entryInteraction(pickup, player, { client, message: mockMessage() });
    await dispatch(entry);

    expect(entry.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not on the current message') }),
    );
    expectNothingMutated(pickup);
  });

  it('refuses when the pickup has no canonical roster message recorded at all', async () => {
    const pickup = createPublishedPickup({ withRosterMessage: false });
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    const entry = entryInteraction(pickup, player, { client });
    await dispatch(entry);

    expect(entry.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not on the current message') }),
    );
    expectNothingMutated(pickup);
  });

  it.each([
    ['open', 'has not been published yet'],
    ['finished', 'already finished'],
    ['cancelled', 'was cancelled'],
  ] as const)('refuses a %s pickup', async (status, expected) => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['published'], status);
    const { client } = clientFor(pickup);

    const entry = entryInteraction(pickup, player, { client });
    await dispatch(entry);

    expect(entry.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(expected) }),
    );
    expectNothingMutated(pickup);
  });

  it('tells a click from another guild nothing about the pickup', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    const entry = entryInteraction(pickup, player, { client, guildId: fakeId() });
    await dispatch(entry);

    expect(entry.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'That pickup no longer exists.' }),
    );
    expectNothingMutated(pickup);
  });
});

describe("Can't Play confirmation", () => {
  it('flags the seat from a private continuation whose message is not the canonical roster (scenario 12)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    const { confirm } = await cantPlay(pickup, player, client);

    // The continuation's own message ID is not -- and can never be -- the
    // canonical one; requiring it here would make this flow unusable.
    expect(confirm.message.id).not.toBe(pickup.rosterMessageId);

    const seat = seatOf(pickup.id, player.id);
    expect(seat.replacementNeeded).toBe(true);
    expect(seat.replacementRequestedAt).toEqual(expect.any(Number));
    // Flagged, never removed or replaced: the roster still reads the same.
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(2);
    expect(seat.userId).toBe(player.id);

    const [event] = unavailableEvents(pickup.id);
    expect(event!.actorUserId).toBe(player.id);
    expect(event!.payload).toMatchObject({ slotId: seat.id, team: 'order', role: 'solo' });
    const [reply] = confirm.editReply.mock.calls.at(-1)! as [{ content: string }];
    expect(reply.content).toContain('flagged for a replacement');
    expect(reply.content).not.toContain('could not be refreshed');
  });

  it('refuses once someone else has taken the seat (scenario 13)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);
    const entry = entryInteraction(pickup, player, { client });
    await dispatch(entry);
    const args = renderedConfirmArgs(entry);

    // Staff replace this player while the confirmation sits on screen --
    // exactly what commitReplacement does: claim the version, then reseat.
    new PickupRepository(db).claimVersionIfPublished(pickup.id, pickup.version);
    new RosterSlotRepository(db).setOccupant(seatOf(pickup.id, player.id).id, bystander.id, true);

    const confirm = confirmInteraction(pickup, player, args, { client });
    await dispatch(confirm);

    expect(confirm.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('roster has changed') }),
    );
    expectNothingMutated(pickup);
  });

  it('refuses a confirmation carrying a version the roster has moved past (scenario 11)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);
    const entry = entryInteraction(pickup, player, { client });
    await dispatch(entry);
    const [slotId, , decision] = renderedConfirmArgs(entry);

    // This player's own seat is untouched -- only the roster's version moved,
    // which is enough on its own to make their control stale.
    new PickupRepository(db).claimVersionIfPublished(pickup.id, pickup.version);

    const confirm = confirmInteraction(pickup, player, [slotId!, String(pickup.version), decision!], { client });
    await dispatch(confirm);

    expect(confirm.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('roster has changed') }),
    );
    expectNothingMutated(pickup);
  });

  it("refuses to flag another player's seat", async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    const confirm = confirmInteraction(
      pickup,
      bystander,
      [String(seatOf(pickup.id, player.id).id), String(pickup.version), 'yes'],
      { client },
    );
    await dispatch(confirm);

    expect(confirm.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('roster has changed') }),
    );
    expectNothingMutated(pickup);
  });

  it('changes nothing when the player picks Never mind', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);
    const entry = entryInteraction(pickup, player, { client });
    await dispatch(entry);
    const [slotId, version] = renderedConfirmArgs(entry);

    const confirm = confirmInteraction(pickup, player, [slotId!, version!, 'no'], { client });
    await dispatch(confirm);

    expect(confirm.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('still on the roster') }),
    );
    expectNothingMutated(pickup);
  });

  it('produces exactly one event and one organizer alert when clicked twice (scenario 14)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    await cantPlay(pickup, player, client);
    const { confirm: second } = await cantPlay(pickup, player, client);

    expect(unavailableEvents(pickup.id)).toHaveLength(1);
    expect(organizerAlerts(pickup.id)).toHaveLength(1);
    const [payload] = second.editReply.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('already marked');
    expect(payload.content).toContain('not notified a second time');
  });
});

describe('organizer alert', () => {
  it("lands in this pickup's own staff channel, never another space's (scenarios 15, 21)", async () => {
    const otherSpace = spaceWithOrganizerRole();
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    await cantPlay(pickup, player, client);

    const [alert] = organizerAlerts(pickup.id);
    expect(alert!.channelId).toBe(reviewChannelId);
    expect(alert!.channelId).not.toBe(otherSpace.reviewChannelId);
    expect(alert!.dedupeKey).toBe(`availability_alert:${pickup.id}:${seatOf(pickup.id, player.id).id}`);
    expect(alert!.status).toBe('pending');
  });

  it("names the pickup's own creator and the space's configured organizer role (scenario 15)", async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client } = clientFor(pickup);

    await cantPlay(pickup, player, client);

    const alert = renderAvailabilityAlert({
      pickup: new PickupRepository(db).byId(pickup.id)!,
      slot: seatOf(pickup.id, player.id),
    });
    expect(alert).toContain(`<@${organizer.id}>`);
    expect(alert).toContain(`<@&${organizerRoleId}>`);
    expect(alert).toContain(`<@${player.id}>`);
  });
});

describe('surface refresh', () => {
  it('redraws the public roster so the flagged seat is visible to everyone', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client, rosterMessage } = clientFor(pickup);

    await cantPlay(pickup, player, client);

    expect(rosterMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('⚠️ replacement needed') }),
    );
  });

  it('redraws the staff card too -- the surface organizers actually use to resolve the flag (codex review finding on PR #50)', async () => {
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    // A real signup backing each seat, so this asserts on the
    // replacement-needed marker specifically rather than incidentally
    // tripping the unrelated "signup withdrawn" one -- renderTeamBlock shows
    // at most one warning per slot.
    new SignupRepository(db).add(pickup.id, player.id, 'solo', 2);
    new SignupRepository(db).add(pickup.id, teammate.id, 'jungle', 2);
    const { client, reviewMessage } = clientFor(pickup);

    await cantPlay(pickup, player, client);

    expect(reviewMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('⚠️ replacement needed') }),
    );
  });

  it('keeps the committed flag when Discord refuses the redraw', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pickup = createPublishedPickup();
    seatRoster(pickup);
    const { client, reviewMessage } = clientFor(pickup);
    reviewMessage.edit = vi.fn(async () => {
      throw new Error('simulated Discord failure');
    }) as never;

    const { confirm } = await cantPlay(pickup, player, client);

    expect(seatOf(pickup.id, player.id).replacementNeeded).toBe(true);
    expect(unavailableEvents(pickup.id)).toHaveLength(1);
    expect(organizerAlerts(pickup.id)).toHaveLength(1);
    const [payload] = confirm.editReply.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('flagged for a replacement');
    expect(payload.content).toContain('could not be refreshed');
    errorSpy.mockRestore();
  });
});
