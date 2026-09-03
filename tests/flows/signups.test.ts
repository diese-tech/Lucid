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
import {
  fakeId,
  mockClient,
  mockGuild,
  mockMember,
  mockMessage,
  mockReaction,
  mockTextChannel,
  mockUser,
} from '../helpers/discord-mocks.js';

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

  it('ignores reactions on a finished pickup', async () => {
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'finished');
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

  it('records the optional Fill reaction as a signup preference', async () => {
    const fillEmojiId = fakeId();
    new GuildConfigRepository(db).setField(guildId, 'fill_emoji_id', fillEmojiId);
    const player = mockUser();

    await handleReactionAdd(mockReaction({ emojiId: fillEmojiId, message: signupMessage }), player);

    expect(new SignupRepository(db).forPickup(pickup.id)).toEqual([
      expect.objectContaining({ userId: player.id, role: 'fill' }),
    ]);
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

describe('handleReactionAdd — pickup eligibility', () => {
  let eligibilityRoleId: string;
  let restricted: Pickup;
  let restrictedMessage: ReturnType<typeof mockMessage>;

  beforeEach(() => {
    eligibilityRoleId = fakeId();
    restricted = new PickupRepository(db).create({
      guildId, createdBy: 'staff', format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600, roleLimit: 2, eligibilityRoleId,
    });
  });

  function reactionFor(
    guild: ReturnType<typeof mockGuild>,
    reactionOptions: Parameters<typeof mockReaction>[0] = {},
  ) {
    restrictedMessage = mockMessage({ guild });
    new PickupRepository(db).setMessageIds(restricted.id, { signupMessageId: restrictedMessage.id });
    return mockReaction({ emojiId: soloEmojiId, message: restrictedMessage, ...reactionOptions });
  }

  it('does not persist a signup, and removes + DMs, when the reactor lacks the eligibility role', async () => {
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [] })] });
    const reaction = reactionFor(guild);

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
    expect(reaction.users.remove).toHaveBeenCalledWith(player.id);
    expect(player.send).toHaveBeenCalledWith(expect.stringContaining(`<@&${eligibilityRoleId}>`));
  });

  it('records the signup normally when the reactor holds the eligibility role', async () => {
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const reaction = reactionFor(guild);

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toEqual([
      expect.objectContaining({ userId: player.id, role: 'solo' }),
    ]);
    expect(reaction.users.remove).not.toHaveBeenCalled();
  });

  it('refreshes the staff card exactly once per reaction, not twice', async () => {
    // codex review finding on PR #31 (ninth pass): evaluateRosterReady
    // already owns the staff card refresh for every outcome, including
    // "still collecting" on a restricted pickup (it calls refreshControlCard
    // internally). The handler calling refreshControlCard again afterward
    // used to double the eligibility resolution (a guild fetch plus a member
    // lookup) and the message.edit for every single reaction.
    const reviewChannelId = fakeId();
    const reviewMessage = mockMessage();
    new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);
    new PickupRepository(db).setMessageIds(restricted.id, { reviewMessageId: reviewMessage.id });

    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const client = mockClient({
      channels: { [reviewChannelId]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }) },
      guilds: { [guildId]: guild },
    });
    const reaction = reactionFor(guild, { client });

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(1);
    expect(reviewMessage.edit).toHaveBeenCalledTimes(1);
  });

  it('does not write a signup if the pickup was cancelled while the eligibility check was in flight', async () => {
    // codex review finding on PR #31: isMemberEligible's member fetch is a
    // real network wait between resolving the reaction and writing the
    // signup. Simulate the pickup being cancelled during that exact wait by
    // hooking the same guild.members.fetch() call the eligibility check uses.
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const originalFetch = guild.members.fetch;
    guild.members.fetch = vi.fn(async (...args: Parameters<typeof originalFetch>) => {
      new PickupRepository(db).transitionStatusFromAny(restricted.id, ['open'], 'cancelled');
      return originalFetch(...args);
    }) as typeof guild.members.fetch;
    const reaction = reactionFor(guild);

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
  });

  it('does not write a signup if the player removed their own reaction while the eligibility check was in flight', async () => {
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const reaction = reactionFor(guild, { stillReacting: false });

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
  });

  it('does not write a signup if the pickup was cancelled while re-confirming the reaction was still there', async () => {
    // codex review finding on PR #31 (second pass): the first fix read the
    // pickup fresh BEFORE awaiting reaction.users.fetch(), leaving the same
    // race one await later. The status check must be the very last thing
    // before the write, after every remaining await, not before any of them.
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const reaction = reactionFor(guild);
    reaction.users.fetch = vi.fn(async () => {
      new PickupRepository(db).transitionStatusFromAny(restricted.id, ['open'], 'cancelled');
      return { has: () => true };
    }) as typeof reaction.users.fetch;

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
  });

  it('does not write a signup if the pickup was finished while re-confirming the reaction was still there', async () => {
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const reaction = reactionFor(guild);
    reaction.users.fetch = vi.fn(async () => {
      new PickupRepository(db).transitionStatusFromAny(restricted.id, ['open'], 'finished');
      return { has: () => true };
    }) as typeof reaction.users.fetch;

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
  });

  it('DMs the player and does not silently drop the signup when the reactor recheck itself fails', async () => {
    // codex review finding on PR #31 (fifth pass): a transient failure
    // fetching current reactors is not the same fact as "the player isn't
    // reacting" and must not be treated as one -- the earlier fix's
    // .catch(() => false) did exactly that, silently.
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const reaction = reactionFor(guild);
    reaction.users.fetch = vi.fn(async () => {
      throw new Error('simulated transient REST failure');
    }) as typeof reaction.users.fetch;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handleReactionAdd(reaction, player)).resolves.toBeUndefined();

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
    expect(player.send).toHaveBeenCalledWith(expect.stringContaining('temporary error'));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('still records an eligible signup while the pickup is roster_ready, so late players can join the bench', async () => {
    // codex review finding on PR #31 (second pass): resolveReaction() itself
    // allows roster_ready (only cancelled/published are dead), and the
    // eligibility re-validation must not be stricter than that.
    new PickupRepository(db).transitionStatusFromAny(restricted.id, ['open'], 'roster_ready');
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [eligibilityRoleId] })] });
    const reaction = reactionFor(guild);

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toEqual([
      expect.objectContaining({ userId: player.id, role: 'solo' }),
    ]);
  });

  it('does not reject the signup or remove the reaction when the member fetch fails unresolvably (unknown, not confirmed ineligible)', async () => {
    // codex review finding on PR #31 (sixth pass): a member-fetch failure is
    // not the same fact as "confirmed lacks the role" -- eligibility.ts's
    // isMemberEligible now reports 'unknown' for it, and this must NOT be
    // treated as 'ineligible' (which would wrongly remove a fine reaction and
    // tell the player they lack a role Lucid never actually checked).
    const player = mockUser();
    const guild = mockGuild({ members: [] }); // fetch throws -- "left the server" or a transient failure, indistinguishable
    const reaction = reactionFor(guild);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleReactionAdd(reaction, player);

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
    expect(reaction.users.remove).not.toHaveBeenCalled();
    expect(player.send).toHaveBeenCalledWith(expect.stringContaining('temporary error'));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('still rejects the signup, without throwing, when the reaction cannot be removed from a confirmed-ineligible member', async () => {
    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [] })] }); // found, but lacks the role
    const reaction = reactionFor(guild);
    reaction.users.remove = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handleReactionAdd(reaction, player)).resolves.toBeUndefined();

    expect(new SignupRepository(db).forPickup(restricted.id)).toHaveLength(0);
    expect(player.send).toHaveBeenCalled();
    // The DM must not claim the reaction was removed when it visibly wasn't —
    // codex review finding on PR #31.
    const [dm] = (player.send as ReturnType<typeof vi.fn>).mock.calls[0]! as [string];
    expect(dm).not.toContain('was removed');
    errorSpy.mockRestore();
  });

  it("refreshes the control card even though nothing was added, so a broken eligibility role still surfaces", async () => {
    // codex review finding on PR #31: a rejected reaction is the only path
    // that would ever discover the eligibility role was deleted, since a
    // successful signup never reaches this branch.
    const reviewChannelId = fakeId();
    const reviewMessage = mockMessage();
    new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);
    new PickupRepository(db).setMessageIds(restricted.id, { reviewMessageId: reviewMessage.id });

    const player = mockUser();
    // Member found (so the check comes back a confirmed 'ineligible', not
    // 'unknown') but the role itself no longer exists in the guild.
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [] })], existingRoleIds: [] });
    const restrictedMessage = mockMessage({ guild });
    new PickupRepository(db).setMessageIds(restricted.id, { signupMessageId: restrictedMessage.id });
    const client = mockClient({
      channels: { [reviewChannelId]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }) },
      guilds: { [guildId]: guild },
    });
    const reaction = mockReaction({ emojiId: soloEmojiId, message: restrictedMessage, client });

    await handleReactionAdd(reaction, player);

    expect(reviewMessage.edit).toHaveBeenCalled();
    const [payload] = reviewMessage.edit.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('eligibility role no longer exists');
  });

  it('refreshes the review card, not a no-op control-card call, when a late reaction is rejected on a roster_ready pickup', async () => {
    // codex review finding on PR #31: refreshControlCard immediately returns
    // for anything past `open`, so this call used to silently do nothing once
    // the pickup was already roster_ready -- leaving a stale card (e.g. still
    // showing everyone eligible after the role was deleted) with nothing left
    // to ever redraw it, since a rejected reaction never becomes a signup
    // change either.
    new PickupRepository(db).transitionStatusFromAny(restricted.id, ['open'], 'roster_ready');
    const reviewChannelId = fakeId();
    const reviewMessage = mockMessage();
    new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);
    new PickupRepository(db).setMessageIds(restricted.id, { reviewMessageId: reviewMessage.id });

    const player = mockUser();
    const guild = mockGuild({ members: [mockMember({ id: player.id, roleIds: [] })] }); // confirmed ineligible
    const restrictedMessage = mockMessage({ guild });
    new PickupRepository(db).setMessageIds(restricted.id, { signupMessageId: restrictedMessage.id });
    const client = mockClient({
      channels: { [reviewChannelId]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }) },
      guilds: { [guildId]: guild },
    });
    const reaction = mockReaction({ emojiId: soloEmojiId, message: restrictedMessage, client });

    await handleReactionAdd(reaction, player);

    expect(reviewMessage.edit).toHaveBeenCalled();
    const [payload] = reviewMessage.edit.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('## Pickup Ready');
  });

  it('is unaffected on a pickup with no eligibility role configured', async () => {
    // Sanity check that the new guard is scoped to restricted pickups only --
    // the unrestricted `pickup` fixture from the outer describe block should
    // behave exactly as before.
    const player = mockUser();
    await handleReactionAdd(mockReaction({ emojiId: soloEmojiId, message: signupMessage }), player);
    expect(new SignupRepository(db).forPickup(pickup.id)).toHaveLength(1);
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
