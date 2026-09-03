/**
 * Flow tests for closing out a published pickup -- src/discord/flows/finish.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { GuildConfigRepository } from '../../src/db/repositories/guild-config.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import type { Pickup } from '../../src/db/repositories/types.js';
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

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let authorizedMember: ReturnType<typeof mockMember>;
let unauthorizedMember: ReturnType<typeof mockMember>;

function createPickup(overrides: Partial<{ status: Pickup['status'] }> = {}): Pickup {
  const pickup = new PickupRepository(db).create({
    guildId,
    createdBy: authorizedMember.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
  });
  if (overrides.status) {
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], overrides.status);
  }
  return new PickupRepository(db).byId(pickup.id)!;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  authorizedRoleId = fakeId();

  new GuildConfigRepository(db).setField(guildId, 'authorized_role_ids', [authorizedRoleId]);

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
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('has not been published yet') }),
      );
    });

    it('refuses a pickup that is already finished', async () => {
      const pickup = createPickup({ status: 'finished' });
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'That pickup is already finished.' }),
      );
    });

    it('shows the confirmation ephemerally for a published pickup', async () => {
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleFinishComponent(interaction, { action: 'fin', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Finish this pickup?') }),
      );
      expect(interaction.update).not.toHaveBeenCalled();
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
    const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
    await handleFinishComponent(interaction, { action: 'not-a-real-action', pickupId: 0, args: [] });

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
    const rosterChannelId = fakeId();
    const reviewChannelId = fakeId();
    const rosterMessage = mockMessage();
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, {
      rosterMessageId: rosterMessage.id,
      reviewMessageId: reviewMessage.id,
    });
    new GuildConfigRepository(db).setField(guildId, 'roster_channel_id', rosterChannelId);
    new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);

    const client = mockClient({
      channels: {
        [rosterChannelId]: mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } }),
        [reviewChannelId]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }),
      },
    });

    await finishPickup(client as never, pickup.id);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
    const [rosterPayload] = rosterMessage.edit.mock.calls.at(-1)! as [
      { content: string; components: unknown[] },
    ];
    expect(rosterPayload.content).toContain('finished');
    const [reviewPayload] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(reviewPayload.content).toContain('finished');
  });

  it('refuses a pickup that has not been published yet', async () => {
    const pickup = createPickup({ status: 'roster_ready' });
    await expect(finishPickup(mockClient() as never, pickup.id)).rejects.toThrow(/has not been published/);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
  });

  it('refuses a pickup that is already finished', async () => {
    const pickup = createPickup({ status: 'finished' });
    await expect(finishPickup(mockClient() as never, pickup.id)).rejects.toThrow(/already finished/);
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
  });

  it('succeeds without touching anything when no channels are configured', async () => {
    const pickup = createPickup({ status: 'published' });
    await expect(finishPickup(mockClient() as never, pickup.id)).resolves.toBeUndefined();
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
  });

  it('still finishes even if the roster message was deleted out from under it', async () => {
    const pickup = createPickup({ status: 'published' });
    const rosterChannelId = fakeId();
    new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: fakeId() });
    new GuildConfigRepository(db).setField(guildId, 'roster_channel_id', rosterChannelId);

    const client = mockClient({ channels: { [rosterChannelId]: mockTextChannel({ messages: {} }) } });

    await expect(finishPickup(client as never, pickup.id)).resolves.toBeUndefined();
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
  });
});
