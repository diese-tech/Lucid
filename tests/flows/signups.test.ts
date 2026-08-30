/**
 * Flow tests for player signups via reactions -- src/discord/flows/signups.ts.
 *
 * There is no command here: the reaction IS the signup, and removing it IS
 * the withdrawal. Both handlers share resolveReaction() internally (not
 * exported), so its branches are exercised through handleReactionAdd, with
 * only the branches that plausibly differ re-checked against
 * handleReactionRemove directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { GuildConfigRepository } from '../../src/db/repositories/guild-config.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import type { Pickup } from '../../src/db/repositories/types.js';
import { handleReactionAdd, handleReactionRemove } from '../../src/discord/flows/signups.js';
import { fakeId, mockClient, mockMessage, mockReaction, mockTextChannel, mockUser } from '../helpers/discord-mocks.js';

let db: Database.Database;
let guildId: string;
let soloEmojiId: string;
let signupMessage: ReturnType<typeof mockMessage>;
let pickup: Pickup;

function createPickup(roleLimit = 2): Pickup {
  return new PickupRepository(db).create({
    guildId, createdBy: 'staff', format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600, roleLimit,
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  soloEmojiId = fakeId();
  new GuildConfigRepository(db).setEmoji(guildId, 'solo', soloEmojiId);

  pickup = createPickup();
  signupMessage = mockMessage();
  new PickupRepository(db).setMessageIds(pickup.id, { signupMessageId: signupMessage.id });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('handleReactionAdd', () => {
  it('ignores the bot own seeded reactions', async () => {
    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage });
    const user = mockUser({ bot: true });
    await handleReactionAdd(reaction, user);

    expect(reaction.fetch).not.toHaveBeenCalled();
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('is a no-op for a reaction on a message that is not a signup post', async () => {
    const reaction = mockReaction({ emojiId: soloEmojiId, message: mockMessage() });
    await handleReactionAdd(reaction, mockUser());
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('ignores reactions on a cancelled pickup', async () => {
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'cancelled');
    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage });
    await handleReactionAdd(reaction, mockUser());
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('ignores reactions on an already-published pickup', async () => {
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'published');
    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage });
    await handleReactionAdd(reaction, mockUser());
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('ignores a standard emoji, which has no ID to match against', async () => {
    const reaction = mockReaction({ emojiId: null, message: signupMessage });
    await handleReactionAdd(reaction, mockUser());
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it("ignores a custom emoji that is not one of this guild's configured role icons", async () => {
    const reaction = mockReaction({ emojiId: fakeId(), message: signupMessage });
    await handleReactionAdd(reaction, mockUser());
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('silently does nothing when hydrating a partial reaction fails (the message was deleted)', async () => {
    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage, partial: true, fetchFails: true });
    await expect(handleReactionAdd(reaction, mockUser())).resolves.toBeUndefined();
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('records a valid signup and keeps the staff card current', async () => {
    const reviewChannelId = fakeId();
    const reviewMessage = mockMessage();
    new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const client = mockClient({
      channels: { [reviewChannelId]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }) },
    });

    const player = mockUser();
    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage, client });
    await handleReactionAdd(reaction, player);

    const signups = new SignupRepository(db).forPickup(pickup.id);
    expect(signups).toHaveLength(1);
    expect(signups[0]).toMatchObject({ userId: player.id, role: 'solo' });
    // evaluateRosterReady -> still 'open' (not feasible with one signup) ->
    // refreshControlCard -> redraws the staff card with the new count.
    expect(reviewMessage.edit).toHaveBeenCalled();
  });

  it('treats a repeat reaction for the same role as a no-op duplicate', async () => {
    const player = mockUser();
    await handleReactionAdd(mockReaction({ emojiId: soloEmojiId, message: signupMessage }), player);
    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage });
    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(1);
    expect(reaction.users.remove).not.toHaveBeenCalled();
  });

  it('removes the reaction and DMs the player once they are over their role limit', async () => {
    const single = createPickup(1);
    const singleMessage = mockMessage();
    new PickupRepository(db).setMessageIds(single.id, { signupMessageId: singleMessage.id });
    const jungleEmojiId = fakeId();
    new GuildConfigRepository(db).setEmoji(guildId, 'jungle', jungleEmojiId);

    const player = mockUser();
    await handleReactionAdd(mockReaction({ emojiId: soloEmojiId, message: singleMessage }), player);

    const overLimit = mockReaction({ emojiId: jungleEmojiId, message: singleMessage });
    await handleReactionAdd(overLimit, player);

    expect(overLimit.users.remove).toHaveBeenCalledWith(player.id);
    expect(player.send).toHaveBeenCalledWith(expect.stringContaining('1 role'));
    expect(new SignupRepository(db).forPickup(single.id)).toHaveLength(1); // still just Solo
  });

  it('still DMs the player when Lucid lacks permission to remove the over-limit reaction', async () => {
    const single = createPickup(1);
    const singleMessage = mockMessage();
    new PickupRepository(db).setMessageIds(single.id, { signupMessageId: singleMessage.id });
    const jungleEmojiId = fakeId();
    new GuildConfigRepository(db).setEmoji(guildId, 'jungle', jungleEmojiId);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const player = mockUser();
    await handleReactionAdd(mockReaction({ emojiId: soloEmojiId, message: singleMessage }), player);

    const overLimit = mockReaction({ emojiId: jungleEmojiId, message: singleMessage });
    overLimit.users.remove = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });
    await expect(handleReactionAdd(overLimit, player)).resolves.toBeUndefined();

    expect(player.send).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not throw when the player has DMs closed', async () => {
    const single = createPickup(1);
    const singleMessage = mockMessage();
    new PickupRepository(db).setMessageIds(single.id, { signupMessageId: singleMessage.id });
    const jungleEmojiId = fakeId();
    new GuildConfigRepository(db).setEmoji(guildId, 'jungle', jungleEmojiId);

    const player = mockUser({ sendFails: true });
    await handleReactionAdd(mockReaction({ emojiId: soloEmojiId, message: singleMessage }), player);
    const overLimit = mockReaction({ emojiId: jungleEmojiId, message: singleMessage });

    await expect(handleReactionAdd(overLimit, player)).resolves.toBeUndefined();
  });

  it('never lets a failure anywhere inside propagate out of the handler', async () => {
    vi.spyOn(SignupRepository.prototype, 'add').mockImplementation(() => {
      throw new Error('simulated database failure');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage });
    await expect(handleReactionAdd(reaction, mockUser())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('handleReactionRemove', () => {
  it('ignores bot reactions', async () => {
    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage });
    await handleReactionRemove(reaction, mockUser({ bot: true }));
    expect(reaction.fetch).not.toHaveBeenCalled();
  });

  it('is a no-op for a reaction on a message that is not a signup post', async () => {
    const player = mockUser();
    await handleReactionAdd(mockReaction({ emojiId: soloEmojiId, message: signupMessage }), player);

    const reaction = mockReaction({ emojiId: soloEmojiId, message: mockMessage() });
    await handleReactionRemove(reaction, player);

    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(1); // untouched
  });

  it('withdraws the signup for that role', async () => {
    const player = mockUser();
    await handleReactionAdd(mockReaction({ emojiId: soloEmojiId, message: signupMessage }), player);
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(1);

    await handleReactionRemove(mockReaction({ emojiId: soloEmojiId, message: signupMessage }), player);

    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('never lets a failure anywhere inside propagate out of the handler', async () => {
    vi.spyOn(SignupRepository.prototype, 'remove').mockImplementation(() => {
      throw new Error('simulated database failure');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const reaction = mockReaction({ emojiId: soloEmojiId, message: signupMessage });
    await expect(handleReactionRemove(reaction, mockUser())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
