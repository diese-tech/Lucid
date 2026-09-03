/**
 * Lightweight stand-ins for the discord.js objects Lucid's flow handlers
 * touch, built from what those handlers actually call (grep the surface
 * before trusting memory) rather than reimplementing discord.js.
 *
 * Real discord.js interaction/message classes require a live Client and REST
 * manager underneath, which makes constructing genuine instances impractical
 * in a unit test. Every flow handler in src/discord/flows/ only ever reads a
 * narrow surface off these objects and calls a handful of response methods,
 * so plain objects with that exact surface -- reply/editReply/deferReply/
 * deferUpdate/followUp/update as vi.fn() spies, everything else as plain
 * data -- are what these tests build and assert against, cast at the call
 * site rather than reimplemented here as full class hierarchies.
 */

import { vi } from 'vitest';
import { Collection } from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  Message,
  MessageComponentInteraction,
  MessageReaction,
  ModalSubmitInteraction,
  PartialMessageReaction,
  PartialUser,
  PermissionsBitField,
  User,
} from 'discord.js';

let nextId = 1;
/** Deterministic-enough fake Discord snowflakes -- unique, not realistic. */
export function fakeId(): string {
  return String(1_000_000 + nextId++);
}

export function resetFakeIds(): void {
  nextId = 1;
}

/** A permission-checking object matching the `.has(flag)` surface used everywhere. */
export function mockPermissions(granted: string[]): Pick<PermissionsBitField, 'has'> {
  return {
    has: ((flag: string) => granted.includes(flag)) as PermissionsBitField['has'],
  };
}

export interface MockMemberOptions {
  id?: string;
  roleIds?: string[];
  permissions?: string[];
  username?: string;
  displayName?: string;
  nickname?: string | null;
  bot?: boolean;
}

export function mockMember(options: MockMemberOptions = {}): GuildMember {
  const id = options.id ?? fakeId();
  const roleIds = new Set(options.roleIds ?? []);
  const username = options.username ?? `user-${id}`;
  const displayName = options.displayName ?? username;
  return {
    id,
    displayName,
    nickname: options.nickname ?? null,
    user: { id, bot: options.bot ?? false, username, globalName: displayName },
    permissions: mockPermissions(options.permissions ?? []),
    roles: { cache: { has: (roleId: string) => roleIds.has(roleId) } },
  } as unknown as GuildMember;
}

export interface MockMessageOptions {
  id?: string;
  guild?: Guild | null;
  partial?: boolean;
  content?: string;
}

export function mockMessage(options: MockMessageOptions = {}): Message {
  const id = options.id ?? fakeId();
  const state = { content: options.content ?? '' };
  return {
    id,
    url: `https://discord.com/channels/0/0/${id}`,
    guild: options.guild ?? null,
    partial: options.partial ?? false,
    get content() {
      return state.content;
    },
    edit: vi.fn(async (payload: { content?: string }) => {
      if (typeof payload === 'string') state.content = payload;
      else if (payload?.content !== undefined) state.content = payload.content;
      return this;
    }),
    react: vi.fn(async () => undefined),
    fetch: vi.fn(async function (this: Message) {
      return this;
    }),
  } as unknown as Message;
}

export interface MockGuildOptions {
  id?: string;
  emojiIds?: string[];
  channels?: Record<string, unknown>;
  members?: GuildMember[];
  /**
   * Which role IDs `guild.roles.fetch()` resolves as existing. Omitted means
   * "every role exists" — the lenient default every test not specifically
   * exercising a deleted eligibility role relies on. Pass an explicit list
   * (even an empty one) to simulate a role that was deleted or never existed.
   */
  existingRoleIds?: string[];
}

export function mockGuild(options: MockGuildOptions = {}): Guild {
  const id = options.id ?? fakeId();
  const emojiIds = new Set(options.emojiIds ?? []);
  const channelMap = new Map(Object.entries(options.channels ?? {}));
  const memberList = options.members ?? [];

  return {
    id,
    emojis: { cache: { has: (emojiId: string) => emojiIds.has(emojiId) } },
    roles: {
      fetch: vi.fn(async (roleId: string) => {
        if (!options.existingRoleIds) return { id: roleId };
        if (options.existingRoleIds.includes(roleId)) return { id: roleId };
        return null;
      }),
    },
    channels: {
      fetch: vi.fn(async (channelId: string) => channelMap.get(channelId) ?? null),
    },
    members: {
      // Real discord.js overloads this three ways: a single ID resolves one
      // member (and throws -- DiscordAPIError -- if they're not in the
      // guild); { query, limit } does a search and resolves a Collection
      // (replace.ts's member-search modal); { user: id | id[] } resolves
      // specific known IDs, silently dropping ones not found rather than
      // throwing (review.ts's displayNames(), which falls back to "Unknown
      // member (id)" for exactly that case).
      fetch: vi.fn(
        async (arg?: string | { query?: string; limit?: number } | { user: string | string[] }) => {
          if (typeof arg === 'string') {
            const member = memberList.find((m) => m.id === arg);
            if (!member) throw new Error(`Mock guild has no member ${arg}`);
            return member;
          }
          if (arg && 'user' in arg) {
            const ids = Array.isArray(arg.user) ? arg.user : [arg.user];
            const found = ids.map((id) => memberList.find((m) => m.id === id)).filter((m) => m !== undefined);
            return new Collection(found.map((m) => [m.id, m]));
          }
          const limit = arg?.limit ?? memberList.length;
          return new Collection(memberList.slice(0, limit).map((m) => [m.id, m]));
        },
      ),
      cache: new Collection(memberList.map((m) => [m.id, m])),
    },
  } as unknown as Guild;
}

interface InteractionState {
  replied: boolean;
  deferred: boolean;
}

/**
 * Shared response-method spies every interaction-like mock exposes.
 *
 * Real discord.js interactions flip their own `.replied`/`.deferred` flags as
 * a SIDE EFFECT of calling reply()/deferReply()/update()/deferUpdate() --
 * several flows (replace.ts's `say()` helper among them) call one of these
 * and then branch on those flags later in the same handler. A plain
 * always-false mock breaks that; these spies mutate the shared `state` object
 * the way the real methods mutate `this`.
 */
function responseSpies(state: InteractionState) {
  return {
    reply: vi.fn(async () => {
      state.replied = true;
    }),
    deferReply: vi.fn(async () => {
      state.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => {
      state.deferred = true;
    }),
    update: vi.fn(async () => {
      state.replied = true;
    }),
    showModal: vi.fn(async () => {
      state.replied = true;
    }),
    fetchReply: vi.fn(async () => mockMessage()),
  };
}

export interface MockInteractionOptions {
  guildId?: string | null;
  guild?: Guild | null;
  userId?: string;
  member?: GuildMember | null;
  memberPermissions?: string[] | null;
  replied?: boolean;
  deferred?: boolean;
  client?: unknown;
  /** Values returned by interaction.options.getString/getBoolean, keyed by option name. */
  stringOptions?: Record<string, string | null>;
  booleanOptions?: Record<string, boolean | null>;
}

/**
 * Assembles the fields and spies shared by every interaction mock below, plus
 * whatever fields are specific to one interaction type.
 *
 * `replied`/`deferred` are defined as getters reading a shared `state` object
 * mutated by the response spies above -- NOT spread as plain values, which
 * would freeze them at their construction-time snapshot and silently break
 * every test relying on them changing after reply()/deferReply() is called.
 * Callers narrow the return type with `as unknown as <RealType>` at the call
 * site -- see the module doc comment for why that's the right tradeoff here.
 */
function assembleInteraction(
  options: MockInteractionOptions,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const userId = options.userId ?? fakeId();
  const state: InteractionState = { replied: options.replied ?? false, deferred: options.deferred ?? false };

  return {
    guildId: options.guildId === undefined ? fakeId() : options.guildId,
    guild: options.guild ?? null,
    user: { id: userId, bot: false },
    member: options.member ?? null,
    memberPermissions:
      options.memberPermissions === undefined
        ? mockPermissions([])
        : options.memberPermissions === null
          ? null
          : mockPermissions(options.memberPermissions),
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    client: options.client ?? mockClient(),
    isRepliable: () => true,
    ...responseSpies(state),
    ...extra,
  };
}

export interface MockChatInputOptions extends MockInteractionOptions {
  subcommand?: string;
  customId?: string;
}

export function mockChatInputInteraction(
  options: MockChatInputOptions = {},
): ChatInputCommandInteraction {
  return assembleInteraction(options, {
    options: {
      getSubcommand: () => options.subcommand ?? '',
      getString: (name: string) => options.stringOptions?.[name] ?? null,
      getBoolean: (name: string) => options.booleanOptions?.[name] ?? null,
    },
  }) as unknown as ChatInputCommandInteraction;
}

export interface MockComponentOptions extends MockInteractionOptions {
  customId?: string;
  values?: string[];
  kind?: 'button' | 'string-select' | 'channel-select' | 'role-select';
  message?: Message;
}

export function mockComponentInteraction(
  options: MockComponentOptions = {},
): MessageComponentInteraction {
  const kind = options.kind ?? 'button';
  return assembleInteraction(options, {
    customId: options.customId ?? 'unset',
    values: options.values ?? [],
    message: options.message ?? mockMessage(),
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'string-select',
    isChannelSelectMenu: () => kind === 'channel-select',
    isRoleSelectMenu: () => kind === 'role-select',
    isFromMessage: () => true,
  }) as unknown as MessageComponentInteraction;
}

export interface MockModalOptions extends MockInteractionOptions {
  customId?: string;
  fields?: Record<string, string>;
}

export function mockModalInteraction(options: MockModalOptions = {}): ModalSubmitInteraction {
  return assembleInteraction(options, {
    customId: options.customId ?? 'unset',
    isFromMessage: () => false,
    fields: {
      getTextInputValue: (id: string) => {
        const value = options.fields?.[id];
        if (value === undefined) throw new Error(`No mock value set for modal field "${id}"`);
        return value;
      },
    },
  }) as unknown as ModalSubmitInteraction;
}

export interface MockAutocompleteOptions extends MockInteractionOptions {
  focusedName?: string;
  focusedValue?: string;
}

export function mockAutocompleteInteraction(
  options: MockAutocompleteOptions = {},
): AutocompleteInteraction {
  return assembleInteraction(options, {
    options: {
      getFocused: () => ({
        name: options.focusedName ?? '',
        value: options.focusedValue ?? '',
      }),
    },
    respond: vi.fn(async () => undefined),
  }) as unknown as AutocompleteInteraction;
}

export interface MockReactionOptions {
  emojiId?: string | null;
  emojiName?: string;
  message?: Message;
  /**
   * This reaction's OWN partial flag (signups.ts's hydratePartials() branches
   * on it directly: `if (reaction.partial) await reaction.fetch()`). Distinct
   * from the mockMessage you pass in having its own `partial` -- config.ts's
   * react-to-bind flow checks reaction.message.partial instead; set that on
   * the message itself if a test needs that one.
   */
  partial?: boolean;
  /** Throws instead of resolving, simulating the message having been deleted before it could be fetched. */
  fetchFails?: boolean;
  client?: unknown;
}

export function mockReaction(
  options: MockReactionOptions = {},
): MessageReaction | PartialMessageReaction {
  const state = { partial: options.partial ?? false };
  return {
    emoji: { id: options.emojiId ?? null, name: options.emojiName ?? '🔥' },
    message: options.message ?? mockMessage(),
    get partial() {
      return state.partial;
    },
    client: options.client ?? mockClient(),
    users: { remove: vi.fn(async () => undefined) },
    fetch: vi.fn(async () => {
      if (options.fetchFails) throw new Error('simulated fetch failure -- message no longer exists');
      state.partial = false;
    }),
  } as unknown as MessageReaction;
}

export interface MockUserOptions {
  id?: string;
  bot?: boolean;
  partial?: boolean;
  /** Throws instead of resolving, simulating the user having left every mutual server. */
  fetchFails?: boolean;
  /** Throws instead of resolving, simulating closed DMs. */
  sendFails?: boolean;
}

export function mockUser(options: MockUserOptions = {}): User | PartialUser {
  const state = { partial: options.partial ?? false };
  return {
    id: options.id ?? fakeId(),
    bot: options.bot ?? false,
    get partial() {
      return state.partial;
    },
    fetch: vi.fn(async () => {
      if (options.fetchFails) throw new Error('simulated fetch failure -- user no longer resolvable');
      state.partial = false;
    }),
    send: vi.fn(async () => {
      if (options.sendFails) throw new Error('simulated closed DMs');
    }),
  } as unknown as User;
}

export interface MockClientOptions {
  /** Channel-ID-keyed map returned by client.channels.fetch(id) -- distinct from Guild.channels, which flows never use for this. */
  channels?: Record<string, unknown>;
  /** Guild-ID-keyed map returned by client.guilds.fetch(id) -- review.ts's displayNames() goes through this to reach guild.members.fetch({ user }). */
  guilds?: Record<string, Guild>;
}

export function mockClient(options: MockClientOptions = {}): unknown {
  const channelMap = new Map(Object.entries(options.channels ?? {}));
  const guildMap = new Map(Object.entries(options.guilds ?? {}));
  return {
    channels: { fetch: vi.fn(async (id: string) => channelMap.get(id) ?? null) },
    guilds: {
      fetch: vi.fn(async (id: string) => {
        const guild = guildMap.get(id);
        if (!guild) throw new Error(`Mock client has no guild ${id}`);
        return guild;
      }),
    },
    users: { fetch: vi.fn(async () => null) },
  };
}

export interface MockTextChannelOptions {
  id?: string;
  /** Message-ID-keyed map returned by channel.messages.fetch(id). */
  messages?: Record<string, Message>;
  /** False to simulate a non-text channel (e.g. a voice or DM channel) being configured by mistake. */
  isTextBased?: boolean;
  isDMBased?: boolean;
}

/**
 * A guild text channel as `textChannel()` helpers across the flow files need
 * it: isTextBased()/isDMBased() type guards, plus messages.fetch(id) for
 * editing an already-posted signup/review/roster message in place.
 */
export function mockTextChannel(options: MockTextChannelOptions = {}) {
  const id = options.id ?? fakeId();
  const messageMap = new Map(Object.entries(options.messages ?? {}));
  return {
    id,
    isTextBased: () => options.isTextBased ?? true,
    isDMBased: () => options.isDMBased ?? false,
    isSendable: () => (options.isTextBased ?? true) && !(options.isDMBased ?? false),
    send: vi.fn(async (payload: unknown) => mockMessage({ content: (payload as { content?: string })?.content })),
    messages: {
      fetch: vi.fn(async (messageId: string) => {
        const message = messageMap.get(messageId);
        if (!message) throw new Error(`Mock channel has no message ${messageId}`);
        return message;
      }),
    },
  };
}
