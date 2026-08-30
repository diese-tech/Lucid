/**
 * Flow tests for /pickup config -- src/discord/flows/config.ts.
 *
 * Written after a live-testing session found that reacting to the react-to-
 * bind message did nothing, with zero trace anywhere: no warning, no
 * progress, no log line (see PR #24). That flow had no test coverage at all
 * before this file. The regression test at the bottom locks in the exact
 * contract PR #24 depends on: tryHandleEmojiBind must not swallow its own
 * errors, because index.ts's caller is the thing responsible for catching
 * and logging them now.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { GuildConfigRepository } from '../../src/db/repositories/guild-config.js';
import { ROLES } from '../../src/domain/roles.js';
import {
  handleConfigAutocomplete,
  handleConfigCommand,
  handleConfigComponent,
  tryHandleEmojiBind,
} from '../../src/discord/flows/config.js';
import {
  fakeId,
  mockAutocompleteInteraction,
  mockChatInputInteraction,
  mockComponentInteraction,
  mockGuild,
  mockMessage,
  mockReaction,
  mockUser,
} from '../helpers/discord-mocks.js';

let db: Database.Database;
let guildId: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('handleConfigCommand', () => {
  it('refuses to run outside a server', async () => {
    const interaction = mockChatInputInteraction({ guildId: null, memberPermissions: ['ManageGuild'] });
    await handleConfigCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Run this inside a server.' }),
    );
    expect(new GuildConfigRepository(db).get(guildId)).toBeNull();
  });

  it('refuses without Manage Server, even inside a guild', async () => {
    const interaction = mockChatInputInteraction({ guildId, memberPermissions: [] });
    await handleConfigCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Manage Server') }),
    );
  });

  it('shows the panel when authorized, with role mentions suppressed', async () => {
    const interaction = mockChatInputInteraction({ guildId, memberPermissions: ['ManageGuild'] });
    await handleConfigCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [] },
        components: expect.any(Array),
      }),
    );
    // The panel commits as it goes -- a row exists means a config row was created.
    expect(new GuildConfigRepository(db).get(guildId)).not.toBeNull();
  });

  it('accepts a valid IANA timezone', async () => {
    const interaction = mockChatInputInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      stringOptions: { timezone: 'America/Chicago' },
    });
    await handleConfigCommand(interaction);

    expect(new GuildConfigRepository(db).get(guildId)?.timezone).toBe('America/Chicago');
  });

  it('rejects an invalid timezone without touching the stored value', async () => {
    new GuildConfigRepository(db).ensure(guildId);
    const before = new GuildConfigRepository(db).get(guildId)?.timezone;

    const interaction = mockChatInputInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      stringOptions: { timezone: 'Not/AZone' },
    });
    await handleConfigCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not a recognized timezone') }),
    );
    expect(new GuildConfigRepository(db).get(guildId)?.timezone).toBe(before);
  });

  it('starts the emoji-bind flow instead of showing the panel when bind_emoji is true', async () => {
    const interaction = mockChatInputInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      booleanOptions: { bind_emoji: true },
    });
    await handleConfigCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Bind your role icons') }),
    );
    // Not ephemeral -- Lucid cannot read reactions on an ephemeral message.
    const payload = interaction.reply.mock.calls[0]![0] as { flags?: number };
    expect(payload.flags).toBeUndefined();
  });
});

describe('handleConfigComponent', () => {
  it('does nothing outside a guild', async () => {
    const interaction = mockComponentInteraction({ guildId: null, kind: 'channel-select' });
    await handleConfigComponent(interaction, { action: 'cfgc', pickupId: 0, args: ['signup_channel_id'] });

    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('refuses without Manage Server', async () => {
    const interaction = mockComponentInteraction({ guildId, memberPermissions: [], kind: 'channel-select' });
    await handleConfigComponent(interaction, { action: 'cfgc', pickupId: 0, args: ['signup_channel_id'] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Manage Server') }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('commits a channel select immediately, no save button needed', async () => {
    const channelId = fakeId();
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'channel-select',
      values: [channelId],
    });
    await handleConfigComponent(interaction, { action: 'cfgc', pickupId: 0, args: ['signup_channel_id'] });

    expect(new GuildConfigRepository(db).get(guildId)?.signupChannelId).toBe(channelId);
    expect(interaction.update).toHaveBeenCalled();
  });

  it('stores a single-select role field (ping role) as one ID, not an array', async () => {
    const roleId = fakeId();
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'role-select',
      values: [roleId],
    });
    await handleConfigComponent(interaction, { action: 'cfgr', pickupId: 0, args: ['ping_role_id'] });

    expect(new GuildConfigRepository(db).get(guildId)?.pingRoleId).toBe(roleId);
  });

  it('stores authorized_role_ids as the full multi-select list', async () => {
    const roleIds = [fakeId(), fakeId(), fakeId()];
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'role-select',
      values: roleIds,
    });
    await handleConfigComponent(interaction, { action: 'cfgr', pickupId: 0, args: ['authorized_role_ids'] });

    expect(new GuildConfigRepository(db).get(guildId)?.authorizedRoleIds).toEqual(roleIds);
  });

  it('ignores a component kind that does not match its declared field type', async () => {
    // A channel-select event carrying a role field name -- decodeId can never
    // actually produce this combination, but the handler's own field-type
    // guard is what has to reject it, not luck.
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'channel-select',
      values: [fakeId()],
    });
    await handleConfigComponent(interaction, { action: 'cfgr', pickupId: 0, args: ['ping_role_id'] });

    expect(interaction.update).not.toHaveBeenCalled();
    expect(new GuildConfigRepository(db).get(guildId)?.pingRoleId).toBeUndefined();
  });
});

describe('handleConfigAutocomplete', () => {
  it('responds empty for any option other than timezone', async () => {
    const interaction = mockAutocompleteInteraction({ focusedName: 'something_else', focusedValue: 'x' });
    await handleConfigAutocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('filters timezones case-insensitively and caps at 25', async () => {
    const interaction = mockAutocompleteInteraction({ focusedName: 'timezone', focusedValue: 'new_york' });
    await handleConfigAutocomplete(interaction);

    const [choices] = interaction.respond.mock.calls[0]! as [{ name: string; value: string }[]];
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.length).toBeLessThanOrEqual(25);
    expect(choices.every((c) => c.value.toLowerCase().includes('new_york'))).toBe(true);
  });
});

describe('tryHandleEmojiBind', () => {
  const ADMIN = fakeId();
  const EMOJI = { solo: fakeId(), jungle: fakeId(), mid: fakeId(), support: fakeId(), carry: fakeId() };

  /** Runs the real command handler so the session is created exactly as production creates it. */
  async function startSession() {
    const message = mockMessage();
    const interaction = mockChatInputInteraction({
      guildId,
      userId: ADMIN,
      memberPermissions: ['ManageGuild'],
      booleanOptions: { bind_emoji: true },
    });
    interaction.fetchReply = (async () => message) as typeof interaction.fetchReply;
    await handleConfigCommand(interaction);
    return { message, interaction };
  }

  it('is a no-op for a reaction on a message with no active session', async () => {
    const consumed = await tryHandleEmojiBind(
      mockReaction({ emojiId: fakeId(), message: mockMessage() }),
      mockUser({ id: ADMIN }),
    );
    expect(consumed).toBe(false);
  });

  it("consumes but ignores the bot's own reactions", async () => {
    const { message } = await startSession();
    const consumed = await tryHandleEmojiBind(
      mockReaction({ emojiId: EMOJI.solo, message }),
      mockUser({ id: fakeId(), bot: true }),
    );
    expect(consumed).toBe(true);
    expect(message.edit).not.toHaveBeenCalled();
  });

  it('warns and refuses a reaction from anyone but the admin who ran the command', async () => {
    const guild = mockGuild({ emojiIds: [EMOJI.solo] });
    const { message } = await startSession();
    (message as unknown as { guild: unknown }).guild = guild;

    const consumed = await tryHandleEmojiBind(
      mockReaction({ emojiId: EMOJI.solo, message }),
      mockUser({ id: fakeId() }),
    );

    expect(consumed).toBe(true);
    expect(message.edit).toHaveBeenCalledWith(expect.stringContaining('ran the command'));
  });

  it('warns on a standard emoji, which has no ID to track', async () => {
    const { message } = await startSession();
    const consumed = await tryHandleEmojiBind(
      mockReaction({ emojiId: null, message }),
      mockUser({ id: ADMIN }),
    );
    expect(consumed).toBe(true);
    expect(message.edit).toHaveBeenCalledWith(expect.stringContaining('standard emoji'));
  });

  it('warns on a custom emoji from outside this guild', async () => {
    const guild = mockGuild({ emojiIds: [] }); // Solo emoji NOT registered here.
    const { message } = await startSession();
    (message as unknown as { guild: unknown }).guild = guild;

    const consumed = await tryHandleEmojiBind(
      mockReaction({ emojiId: EMOJI.solo, message }),
      mockUser({ id: ADMIN }),
    );
    expect(consumed).toBe(true);
    expect(message.edit).toHaveBeenCalledWith(expect.stringContaining('Pick a custom emoji from this server'));
  });

  it('advances one role per valid reaction and writes nothing until all five are in', async () => {
    const guild = mockGuild({ emojiIds: Object.values(EMOJI) });
    const { message } = await startSession();
    (message as unknown as { guild: unknown }).guild = guild;

    const consumed = await tryHandleEmojiBind(
      mockReaction({ emojiId: EMOJI.solo, message }),
      mockUser({ id: ADMIN }),
    );

    expect(consumed).toBe(true);
    expect(message.edit).toHaveBeenCalledWith(expect.stringContaining('Next: react with your **Jungle** icon'));
    expect(new GuildConfigRepository(db).get(guildId)?.soloEmojiId).toBeNull();
  });

  it('refuses an icon already bound to an earlier role in this session', async () => {
    const guild = mockGuild({ emojiIds: Object.values(EMOJI) });
    const { message } = await startSession();
    (message as unknown as { guild: unknown }).guild = guild;

    await tryHandleEmojiBind(mockReaction({ emojiId: EMOJI.solo, message }), mockUser({ id: ADMIN }));
    const consumed = await tryHandleEmojiBind(
      mockReaction({ emojiId: EMOJI.solo, message }), // same icon again, for Jungle
      mockUser({ id: ADMIN }),
    );

    expect(consumed).toBe(true);
    expect(message.edit).toHaveBeenLastCalledWith(expect.stringContaining('already bound to another role'));
  });

  it('writes all five role bindings as one unit once the fifth icon lands, and closes the session', async () => {
    const guild = mockGuild({ emojiIds: Object.values(EMOJI) });
    const { message } = await startSession();
    (message as unknown as { guild: unknown }).guild = guild;

    for (const role of ROLES) {
      const consumed = await tryHandleEmojiBind(
        mockReaction({ emojiId: EMOJI[role], message }),
        mockUser({ id: ADMIN }),
      );
      expect(consumed).toBe(true);
    }

    const config = new GuildConfigRepository(db).get(guildId);
    expect(config?.soloEmojiId).toBe(EMOJI.solo);
    expect(config?.jungleEmojiId).toBe(EMOJI.jungle);
    expect(config?.midEmojiId).toBe(EMOJI.mid);
    expect(config?.supportEmojiId).toBe(EMOJI.support);
    expect(config?.carryEmojiId).toBe(EMOJI.carry);

    // Session closed: a sixth reaction on the same message finds nothing.
    const afterClose = await tryHandleEmojiBind(
      mockReaction({ emojiId: EMOJI.solo, message }),
      mockUser({ id: ADMIN }),
    );
    expect(afterClose).toBe(false);
  });

  it(
    'regression (PR #24): does not swallow its own errors -- the caller in index.ts is what must catch and log them',
    async () => {
      const { message } = await startSession();
      const reaction = mockReaction({ emojiId: EMOJI.solo, message });
      // The code branches on reaction.message.partial (not reaction.partial)
      // to decide whether to fetch. A partial message is fetched before
      // anything else runs; a failure here (a deleted message, a permissions
      // error) must propagate, not disappear -- see index.ts's
      // MessageReactionAdd handler, which is the only thing that may catch
      // this, and must log when it does.
      (message as unknown as { partial: boolean }).partial = true;
      message.fetch = (async () => {
        throw new Error('simulated Discord API failure fetching the partial message');
      }) as typeof message.fetch;

      await expect(
        tryHandleEmojiBind(reaction, mockUser({ id: ADMIN })),
      ).rejects.toThrow('simulated Discord API failure');
    },
  );

  it(
    'regression (codex review, PR #24): an abandoned session expires, instead of logging every reaction forever',
    async () => {
      vi.useFakeTimers();
      try {
        // Started but never finished -- bindSessions.delete() only runs on
        // successful completion, so before the fix this session would sit in
        // the Map until the process restarted.
        await startSession();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        // Sixteen minutes pass -- past the 15-minute TTL.
        vi.advanceTimersByTime(16 * 60 * 1000);

        // An ordinary player reacting to an ordinary pickup post, nothing to
        // do with the abandoned session at all.
        const consumed = await tryHandleEmojiBind(
          mockReaction({ emojiId: fakeId(), message: mockMessage() }),
          mockUser({ id: fakeId() }),
        );

        expect(consumed).toBe(false);
        // Before the fix, bindSessions.size stayed > 0 forever, so this call
        // would have logged. After pruning, there is nothing active, so it
        // must not.
        expect(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
