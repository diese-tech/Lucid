/**
 * Flow tests for closing out a published pickup -- src/discord/flows/finish.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { PickupEventRepository } from '../../src/db/repositories/pickup-events.js';
import { PickupProjectionRepository } from '../../src/db/repositories/pickup-projections.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import type { Pickup, PickupSpace } from '../../src/db/repositories/types.js';
import { UNAUTHORIZED_MESSAGE } from '../../src/discord/permissions.js';
import { finishPickup, FinishRefusedError, handleFinishComponent } from '../../src/discord/flows/finish.js';
import {
  fakeId,
  mockClient,
  mockComponentInteraction,
  mockMember,
  mockMessage,
  mockTextChannel,
} from '../helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from '../helpers/fixtures.js';

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let space: PickupSpace;
let authorizedMember: ReturnType<typeof mockMember>;
let unauthorizedMember: ReturnType<typeof mockMember>;

function createPickup(overrides: Partial<{ status: Pickup['status'] }> = {}): Pickup {
  const pickup = new PickupRepository(db).create({
    guildId,
    createdBy: authorizedMember.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  });
  // issue #35: the Finish button's canonical-message-ID check needs a real
  // rosterMessageId to compare against, even for tests that never render or
  // edit the public roster themselves. reviewMessageId likewise for
  // FinishFromCard's own check (issue #37, codex review finding on PR #51).
  new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: fakeId(), reviewMessageId: fakeId() });
  if (overrides.status) {
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], overrides.status);
  }
  return new PickupRepository(db).byId(pickup.id)!;
}

/** The published roster's mock message, matching whatever rosterMessageId createPickup() set. */
function rosterMessageFor(pickup: Pickup) {
  return mockMessage({ id: pickup.rosterMessageId! });
}

/** The staff card's mock message, matching whatever reviewMessageId createPickup() set. */
function reviewMessageFor(pickup: Pickup) {
  return mockMessage({ id: pickup.reviewMessageId! });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  authorizedRoleId = fakeId();

  space = seedSpace(db, { guildId, authorizedRoleIds: [authorizedRoleId] });

  authorizedMember = mockMember({ roleIds: [authorizedRoleId] });
  unauthorizedMember = mockMember({ roleIds: [] });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
});

describe('handleFinishComponent', () => {
  it('refuses an unauthorized coordinator before reaching the switch', async () => {
    const pickup = createPickup({ status: 'published' });
    const interaction = mockComponentInteraction({ guildId, member: unauthorizedMember });
    await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }),
    );
  });

  describe('Finish (the button on the published roster)', () => {
    it('tells the coordinator when the pickup is already gone', async () => {
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: 999999, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'That pickup no longer exists.' }),
      );
    });

    it('refuses a pickup that has not been published yet', async () => {
      const pickup = createPickup(); // still open
      const interaction = mockComponentInteraction({
        guildId, member: authorizedMember, message: rosterMessageFor(pickup),
      });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('has not been published yet') }),
      );
    });

    it('refuses a pickup that is already finished', async () => {
      const pickup = createPickup({ status: 'finished' });
      const interaction = mockComponentInteraction({
        guildId, member: authorizedMember, message: rosterMessageFor(pickup),
      });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'That pickup is already finished.' }),
      );
    });

    it('refuses a click from a message that is not the current published roster, without mutating anything', async () => {
      // issue #35: canonical-message-ID binding. This button lives directly
      // on the published public roster -- a click attributed to any OTHER
      // message must be refused before it can do anything.
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({
        guildId, member: authorizedMember, message: mockMessage({ id: fakeId() }),
      });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not on the current message') }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
    });

    it('shows the confirmation ephemerally for a published pickup', async () => {
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({
        guildId, member: authorizedMember, message: rosterMessageFor(pickup),
      });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Finish this pickup?') }),
      );
      expect(interaction.update).not.toHaveBeenCalled();
    });
  });

  describe('FinishFromCard (issue #37, codex review finding on PR #51)', () => {
    it('shows the confirmation when clicked from the current staff card', async () => {
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({
        guildId, member: authorizedMember, message: reviewMessageFor(pickup),
      });
      await handleFinishComponent(interaction, { action: 'finst', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Finish this pickup?') }),
      );
    });

    it('refuses a click attributed to the public roster message instead of the staff card', async () => {
      // The two entry points are checked against their OWN canonical
      // message, not each other's -- a FinishFromCard click carrying the
      // roster message's ID (or any other message) must be refused exactly
      // like Finish's own canonical check refuses a stale roster click.
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({
        guildId, member: authorizedMember, message: rosterMessageFor(pickup),
      });
      await handleFinishComponent(interaction, { action: 'finst', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not on the current message') }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
    });
  });

  describe('FinishConfirm', () => {
    it('changes nothing on "Keep It Open"', async () => {
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleFinishComponent(interaction, { action: 'finc', pickupId: pickup.id, args: ['no'] });

      expect(interaction.update).toHaveBeenCalledWith({
        content: 'No changes made. The roster stays open.',
        components: [],
      });
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
    });

    it('finishes on confirmation and reports success', async () => {
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleFinishComponent(interaction, { action: 'finc', pickupId: pickup.id, args: ['yes'] });

      expect(interaction.deferUpdate).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Pickup finished') }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');

      // issue #35: finishing records exactly one durable audit event,
      // carrying the confirming coordinator as its actor.
      const events = new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'pickup_finished');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorUserId: interaction.user.id });
    });

    it("surfaces the FinishRefusedError message verbatim when the pickup can't be finished", async () => {
      const pickup = createPickup(); // still open, never published
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleFinishComponent(interaction, { action: 'finc', pickupId: pickup.id, args: ['yes'] });

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('has not been published yet') }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');
    });
  });

  it('does nothing for an action it does not recognize', async () => {
    // Needs a real pickup now: handleFinishComponent loads the pickup (and
    // authorizes against it) BEFORE the switch, so an unrecognized action on
    // a nonexistent pickup ID would reply "no longer exists" instead of
    // reaching the default case this test means to exercise.
    const pickup = createPickup();
    const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
    await handleFinishComponent(interaction, { action: 'not-a-real-action', pickupId: pickup.id, args: [] });

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('finishPickup', () => {
  it('refuses a pickup that no longer exists', async () => {
    await expect(finishPickup(mockClient() as never, 999999)).rejects.toThrow(FinishRefusedError);
  });

  it('finishes a published pickup and rewrites both of its messages, disabling their controls', async () => {
    const pickup = createPickup({ status: 'published' });
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: 'alice' },
    ]);
    const rosterMessage = mockMessage();
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, {
      rosterMessageId: rosterMessage.id,
      reviewMessageId: reviewMessage.id,
    });

    const client = mockClient({
      channels: {
        [space.rosterChannelId!]: mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } }),
        [space.reviewChannelId!]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }),
      },
    });

    await finishPickup(client as never, pickup.id, 'staff-1');

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
    const [rosterPayload] = rosterMessage.edit.mock.calls.at(-1)! as [
      { content: string; components: unknown[] },
    ];
    expect(rosterPayload.content).toContain('finished');
    const [reviewPayload] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(reviewPayload.content).toContain('Finished by <@staff-1>');
  });

  it('rewrites the public signup post to the finished form, linking to the final roster (issue #37)', async () => {
    const pickup = createPickup({ status: 'published' });
    const rosterMessage = mockMessage();
    const reviewMessage = mockMessage();
    const signupMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, {
      rosterMessageId: rosterMessage.id,
      reviewMessageId: reviewMessage.id,
      signupMessageId: signupMessage.id,
    });
    const client = mockClient({
      channels: {
        [space.rosterChannelId!]: mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } }),
        [space.reviewChannelId!]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }),
        [space.signupChannelId!]: mockTextChannel({ messages: { [signupMessage.id]: signupMessage } }),
      },
    });

    await finishPickup(client as never, pickup.id);

    const [signupPayload] = signupMessage.edit.mock.calls.at(-1)! as [{ content: string; components: unknown[] }];
    expect(signupPayload.content).toContain('Pickup finished');
    expect(signupPayload.content).toContain('[View Final Roster]');
    expect(signupPayload.components).toEqual([]);
  });

  it('records manual attribution and words the finished card with the actor (issue #37)', async () => {
    const pickup = createPickup({ status: 'published' });
    const rosterMessage = mockMessage();
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, {
      rosterMessageId: rosterMessage.id,
      reviewMessageId: reviewMessage.id,
    });
    const client = mockClient({
      channels: {
        [space.rosterChannelId!]: mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } }),
        [space.reviewChannelId!]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }),
      },
    });

    await finishPickup(client as never, pickup.id, 'staff-1');

    const finished = new PickupRepository(db).byId(pickup.id)!;
    expect(finished.finishReason).toBe('manual');
    expect(finished.finishedByUserId).toBe('staff-1');
    expect(finished.finishedAt).not.toBeNull();
    const [reviewPayload2] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(reviewPayload2.content).toContain('Finished by <@staff-1>');
  });

  it('records a timeout finish with no actor and words the finished card distinctly (issue #37)', async () => {
    const pickup = createPickup({ status: 'published' });
    const rosterMessage = mockMessage();
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, {
      rosterMessageId: rosterMessage.id,
      reviewMessageId: reviewMessage.id,
    });
    const client = mockClient({
      channels: {
        [space.rosterChannelId!]: mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } }),
        [space.reviewChannelId!]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }),
      },
    });

    await finishPickup(client as never, pickup.id, null, 'timeout');

    const finished = new PickupRepository(db).byId(pickup.id)!;
    expect(finished.finishReason).toBe('timeout');
    expect(finished.finishedByUserId).toBeNull();
    const [reviewPayload3] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(reviewPayload3.content).toContain('Automatically finished');
    expect(reviewPayload3.content).not.toContain('Finished by');
  });

  it('refuses a pickup that has not been published yet', async () => {
    const pickup = createPickup({ status: 'roster_ready' });
    await expect(finishPickup(mockClient() as never, pickup.id)).rejects.toThrow(/has not been published/);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
  });

  it('refuses a pickup that is already finished', async () => {
    const pickup = createPickup({ status: 'finished' });
    await expect(finishPickup(mockClient() as never, pickup.id)).rejects.toThrow(/already finished/);
    // issue #35: the refused call must not record an event.
    expect(new PickupEventRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('refuses a cancelled pickup', async () => {
    const pickup = createPickup({ status: 'cancelled' });
    await expect(finishPickup(mockClient() as never, pickup.id)).rejects.toThrow(FinishRefusedError);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
  });

  it('the conditional status write means only one of two racing confirms can win', async () => {
    const pickup = createPickup({ status: 'published' });
    const client = mockClient() as never;

    const results = await Promise.allSettled([finishPickup(client, pickup.id), finishPickup(client, pickup.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
    // issue #35: the race produces exactly one mutation and exactly one event.
    expect(
      new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'pickup_finished'),
    ).toHaveLength(1);
  });

  it('succeeds without touching anything when no channels are configured', async () => {
    const pickup = createPickup({ status: 'published' });
    await expect(finishPickup(mockClient() as never, pickup.id)).resolves.toBeUndefined();
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
  });

  it('still finishes even if the roster message was deleted out from under it', async () => {
    // issue #35's delivery-recovery contract: a deleted canonical message
    // must fail truthfully -- not pretend the mutation reverted, and not
    // silently lose the fact that delivery couldn't be confirmed.
    const pickup = createPickup({ status: 'published' });
    new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: fakeId() });

    const client = mockClient({ channels: { [space.rosterChannelId!]: mockTextChannel({ messages: {} }) } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(finishPickup(client as never, pickup.id)).resolves.toBeUndefined();
    errorSpy.mockRestore();

    // The lifecycle transition stands regardless -- the database, not the
    // Discord message, is the pickup's source of truth.
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
    // The failed delivery attempt is durably recorded, not silently dropped.
    const projections = new PickupProjectionRepository(db).unresolvedForPickup(pickup.id);
    expect(projections).toContainEqual(expect.objectContaining({ surface: 'roster', status: 'uncertain' }));
  });
});
