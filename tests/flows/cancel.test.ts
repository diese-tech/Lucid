/**
 * Flow tests for /pickup cancel -- src/discord/flows/cancel.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { GuildConfigRepository } from '../../src/db/repositories/guild-config.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import type { Pickup } from '../../src/db/repositories/types.js';
import { UNAUTHORIZED_MESSAGE } from '../../src/discord/permissions.js';
import { cancelPickup, CancelRefusedError, handleCancelCommand, handleCancelComponent } from '../../src/discord/flows/cancel.js';
import {
  fakeId,
  mockChatInputInteraction,
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

describe('handleCancelCommand', () => {
  it('refuses an unauthorized coordinator with the standard message and nothing else', async () => {
    const interaction = mockChatInputInteraction({ guildId, member: unauthorizedMember });
    await handleCancelCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }),
    );
  });

  it('reports nothing to cancel when there are no open pickups', async () => {
    const interaction = mockChatInputInteraction({ guildId, member: authorizedMember });
    await handleCancelCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'There are no open pickups to cancel.' }),
    );
  });

  it('does not offer an already-published pickup as something to cancel', async () => {
    createPickup({ status: 'published' });
    const interaction = mockChatInputInteraction({ guildId, member: authorizedMember });
    await handleCancelCommand(interaction);

    // This is the exact behavior PR #23 corrected the docs to describe: a
    // published pickup never reaches the picker or the confirmation, full
    // stop -- the reply is indistinguishable from "nothing is open at all".
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'There are no open pickups to cancel.' }),
    );
  });

  it('skips the picker and goes straight to confirmation with exactly one open pickup', async () => {
    createPickup();
    const interaction = mockChatInputInteraction({ guildId, member: authorizedMember });
    await handleCancelCommand(interaction);

    const [payload] = interaction.reply.mock.calls[0]! as [{ content: string; components: unknown[] }];
    expect(payload.content).toContain('Cancel **Pickup vs Pickup');
    expect(payload.components).toHaveLength(1);
  });

  it('shows a picker when more than one pickup is open', async () => {
    createPickup();
    createPickup();
    const interaction = mockChatInputInteraction({ guildId, member: authorizedMember });
    await handleCancelCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Which pickup do you want to cancel?' }),
    );
  });
});

describe('handleCancelComponent', () => {
  it('refuses an unauthorized coordinator before reaching the switch', async () => {
    const pickup = createPickup();
    const interaction = mockComponentInteraction({ guildId, member: unauthorizedMember });
    await handleCancelComponent(interaction, { action: 'can', pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }),
    );
  });

  describe('Cancel (the staff-card button)', () => {
    it('tells the coordinator when the pickup is already gone', async () => {
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleCancelComponent(interaction, { action: 'can', pickupId: 999999, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'That pickup no longer exists.' }),
      );
    });

    it('shows the confirmation ephemerally, leaving the shared card alone', async () => {
      const pickup = createPickup();
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleCancelComponent(interaction, { action: 'can', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Cancel **Pickup vs Pickup') }),
      );
      expect(interaction.update).not.toHaveBeenCalled();
    });
  });

  describe('CancelPick (the multi-pickup picker)', () => {
    it('handles a selection that no longer resolves to a real pickup', async () => {
      const interaction = mockComponentInteraction({
        guildId,
        member: authorizedMember,
        kind: 'string-select',
        values: ['999999'],
      });
      await handleCancelComponent(interaction, { action: 'canp', pickupId: 0, args: [] });

      expect(interaction.update).toHaveBeenCalledWith({
        content: 'That pickup no longer exists.',
        components: [],
      });
    });

    it('advances to confirmation for the chosen pickup', async () => {
      const pickup = createPickup();
      const interaction = mockComponentInteraction({
        guildId,
        member: authorizedMember,
        kind: 'string-select',
        values: [String(pickup.id)],
      });
      await handleCancelComponent(interaction, { action: 'canp', pickupId: 0, args: [] });

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Cancel **Pickup vs Pickup') }),
      );
    });
  });

  describe('CancelConfirm', () => {
    it('changes nothing on "Keep It"', async () => {
      const pickup = createPickup();
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleCancelComponent(interaction, { action: 'canc', pickupId: pickup.id, args: ['no'] });

      expect(interaction.update).toHaveBeenCalledWith({
        content: 'No changes made. The pickup is still open.',
        components: [],
      });
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');
    });

    it('cancels on confirmation and reports success', async () => {
      const pickup = createPickup();
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleCancelComponent(interaction, { action: 'canc', pickupId: pickup.id, args: ['yes'] });

      expect(interaction.deferUpdate).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Pickup cancelled') }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
    });

    it("surfaces the CancelRefusedError message verbatim when the pickup can't be cancelled", async () => {
      const pickup = createPickup({ status: 'published' });
      const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
      await handleCancelComponent(interaction, { action: 'canc', pickupId: pickup.id, args: ['yes'] });

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Replace Player') }),
      );
      // The published pickup is untouched, not silently downgraded.
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
    });
  });

  it('does nothing for an action it does not recognize', async () => {
    const interaction = mockComponentInteraction({ guildId, member: authorizedMember });
    await handleCancelComponent(interaction, { action: 'not-a-real-action', pickupId: 0, args: [] });

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('cancelPickup', () => {
  it('refuses a pickup that no longer exists', async () => {
    await expect(cancelPickup(mockClient() as never, 999999)).rejects.toThrow(CancelRefusedError);
  });

  it('cancels an open pickup and rewrites both of its messages', async () => {
    const pickup = createPickup();
    const signupChannelId = fakeId();
    const reviewChannelId = fakeId();
    const signupMessage = mockMessage();
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, {
      signupMessageId: signupMessage.id,
      reviewMessageId: reviewMessage.id,
    });
    new GuildConfigRepository(db).setField(guildId, 'signup_channel_id', signupChannelId);
    new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);

    const client = mockClient({
      channels: {
        [signupChannelId]: mockTextChannel({ messages: { [signupMessage.id]: signupMessage } }),
        [reviewChannelId]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }),
      },
    });

    await cancelPickup(client as never, pickup.id);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
    expect(signupMessage.edit).toHaveBeenCalled();
    expect(reviewMessage.edit).toHaveBeenCalled();
  });

  it('cancels from roster_ready too, not only open', async () => {
    const pickup = createPickup({ status: 'roster_ready' });
    await cancelPickup(mockClient() as never, pickup.id);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
  });

  it('refuses a published pickup and points at Replace Player', async () => {
    const pickup = createPickup({ status: 'published' });
    await expect(cancelPickup(mockClient() as never, pickup.id)).rejects.toThrow(/Replace Player/);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
  });

  it('refuses a pickup that is already cancelled', async () => {
    const pickup = createPickup();
    await cancelPickup(mockClient() as never, pickup.id);
    await expect(cancelPickup(mockClient() as never, pickup.id)).rejects.toThrow(/already been cancelled/);
  });

  it('the conditional status write means only one of two racing confirms can win', async () => {
    const pickup = createPickup();
    const client = mockClient() as never;

    const results = await Promise.allSettled([cancelPickup(client, pickup.id), cancelPickup(client, pickup.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
  });

  it('succeeds without touching anything when no channels are configured', async () => {
    const pickup = createPickup();
    await expect(cancelPickup(mockClient() as never, pickup.id)).resolves.toBeUndefined();
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
  });

  it('still cancels even if the original signup post was deleted out from under it', async () => {
    const pickup = createPickup();
    const signupChannelId = fakeId();
    new PickupRepository(db).setMessageIds(pickup.id, { signupMessageId: fakeId() });
    new GuildConfigRepository(db).setField(guildId, 'signup_channel_id', signupChannelId);

    // messages.fetch throws for any ID not in the map -- exactly what a
    // deleted message looks like from the caller's side.
    const client = mockClient({ channels: { [signupChannelId]: mockTextChannel({ messages: {} }) } });

    await expect(cancelPickup(client as never, pickup.id)).resolves.toBeUndefined();
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
  });
});
