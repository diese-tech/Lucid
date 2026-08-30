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
}

export function mockMember(options: MockMemberOptions = {}): GuildMember {
  const id = options.id ?? fakeId();
  const roleIds = new Set(options.roleIds ?? []);
  return {
    id,
    user: { id, bot: false },
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
}

export function mockGuild(options: MockGuildOptions = {}): Guild {
  const id = options.id ?? fakeId();
  const emojiIds = new Set(options.emojiIds ?? []);
  const channelMap = new Map(Object.entries(options.channels ?? {}));
  const memberList = options.members ?? [];

  return {
    id,
    emojis: { cache: { has: (emojiId: string) => emojiIds.has(emojiId) } },
    channels: {
      fetch: vi.fn(async (channelId: string) => channelMap.get(channelId) ?? null),
    },
    members: {
      fetch: vi.fn(async () => new Map(memberList.map((m) => [m.id, m]))),
      cache: { get: (memberId: string) => memberList.find((m) => m.id === memberId) },
    },
  } as unknown as Guild;
}

/** Shared response-method spies every interaction-like mock exposes. */
function responseSpies() {
  return {
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
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
 * Base fields shared by every interaction mock below. Callers narrow the
 * return type with `as unknown as <RealType>` at the call site -- see the
 * module doc comment for why that's the right tradeoff here.
 */
function baseInteraction(options: MockInteractionOptions) {
  const userId = options.userId ?? fakeId();
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
    replied: options.replied ?? false,
    deferred: options.deferred ?? false,
    client: options.client ?? mockClient(),
    isRepliable: () => true,
    ...responseSpies(),
  };
}

export interface MockChatInputOptions extends MockInteractionOptions {
  subcommand?: string;
  customId?: string;
}

export function mockChatInputInteraction(
  options: MockChatInputOptions = {},
): ChatInputCommandInteraction {
  return {
    ...baseInteraction(options),
    options: {
      getSubcommand: () => options.subcommand ?? '',
      getString: (name: string) => options.stringOptions?.[name] ?? null,
      getBoolean: (name: string) => options.booleanOptions?.[name] ?? null,
    },
  } as unknown as ChatInputCommandInteraction;
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
  return {
    ...baseInteraction(options),
    customId: options.customId ?? 'unset',
    values: options.values ?? [],
    message: options.message ?? mockMessage(),
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'string-select',
    isChannelSelectMenu: () => kind === 'channel-select',
    isRoleSelectMenu: () => kind === 'role-select',
    isFromMessage: () => true,
  } as unknown as MessageComponentInteraction;
}

export interface MockModalOptions extends MockInteractionOptions {
  customId?: string;
  fields?: Record<string, string>;
}

export function mockModalInteraction(options: MockModalOptions = {}): ModalSubmitInteraction {
  return {
    ...baseInteraction(options),
    customId: options.customId ?? 'unset',
    isFromMessage: () => false,
    fields: {
      getTextInputValue: (id: string) => {
        const value = options.fields?.[id];
        if (value === undefined) throw new Error(`No mock value set for modal field "${id}"`);
        return value;
      },
    },
  } as unknown as ModalSubmitInteraction;
}

export interface MockAutocompleteOptions extends MockInteractionOptions {
  focusedName?: string;
  focusedValue?: string;
}

export function mockAutocompleteInteraction(
  options: MockAutocompleteOptions = {},
): AutocompleteInteraction {
  return {
    ...baseInteraction(options),
    options: {
      getFocused: () => ({
        name: options.focusedName ?? '',
        value: options.focusedValue ?? '',
      }),
    },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

export interface MockReactionOptions {
  emojiId?: string | null;
  emojiName?: string;
  message?: Message;
  partial?: boolean;
}

export function mockReaction(
  options: MockReactionOptions = {},
): MessageReaction | PartialMessageReaction {
  return {
    emoji: { id: options.emojiId ?? null, name: options.emojiName ?? '🔥' },
    message: options.message ?? mockMessage(),
    // Real discord.js reactions can themselves be partial, but nothing in
    // Lucid currently branches on THIS flag -- config.ts's react-to-bind flow
    // checks reaction.message.partial instead (set that on the mockMessage
    // you pass in, via its own `partial` option, if a test needs it).
    partial: options.partial ?? false,
  } as unknown as MessageReaction;
}

export interface MockUserOptions {
  id?: string;
  bot?: boolean;
}

export function mockUser(options: MockUserOptions = {}): User | PartialUser {
  return { id: options.id ?? fakeId(), bot: options.bot ?? false } as unknown as User;
}

export function mockClient(): unknown {
  return {
    channels: { fetch: vi.fn(async () => null) },
    users: { fetch: vi.fn(async () => null) },
  };
}
