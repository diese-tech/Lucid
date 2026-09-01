/**
 * `/pickup config` — the one-time server setup flow.
 *
 * This command is guarded by Discord's own Manage Server permission rather than
 * by Lucid's staff-role check. It has to be: the staff role list is one of the
 * things this command configures, so on a brand-new server there is nobody the
 * normal guard could possibly authorize.
 *
 * Setup happens in two panels because Discord's message layout forces it:
 *
 *   Panel 1 (ephemeral) — five select menus, one per configured ID.
 *   Panel 2 (public)    — a react-to-bind message for the five role emoji,
 *                         because there is no "emoji picker" component in
 *                         Discord; reacting is the only way a human can hand us
 *                         a custom emoji ID without reading it off a raw
 *                         message.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  RoleSelectMenuBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type MessageComponentInteraction,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';

import { GuildConfigRepository } from '../../db/repositories/guild-config.js';
import type { GuildConfig } from '../../db/repositories/types.js';
import { ROLES, SIGNUP_ROLES, SIGNUP_ROLE_LABELS, type Role, type SignupRole } from '../../domain/roles.js';
import { isValidTimezone } from '../../domain/time.js';
import { Action, encodeId, type DecodedId } from '../ids.js';

/** Set / unset markers used throughout the panel body. */
const SET = '✅';
const UNSET = '⬜';

/** The five IDs the panel collects, in the order they appear on screen. */
const CHANNEL_FIELDS = ['signup_channel_id', 'roster_channel_id', 'review_channel_id'] as const;
const ROLE_FIELDS = ['ping_role_id', 'authorized_role_ids'] as const;

type ChannelField = (typeof CHANNEL_FIELDS)[number];
type RoleField = (typeof ROLE_FIELDS)[number];

function isChannelField(value: string): value is ChannelField {
  return (CHANNEL_FIELDS as readonly string[]).includes(value);
}

function isRoleField(value: string): value is RoleField {
  return (ROLE_FIELDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Panel 1 — channels, roles and timezone
// ---------------------------------------------------------------------------

type PanelRow = ActionRowBuilder<ChannelSelectMenuBuilder | RoleSelectMenuBuilder>;

function channelRow(field: ChannelField, placeholder: string): PanelRow {
  const select = new ChannelSelectMenuBuilder()
    // Pickup ID is 0 because configuration belongs to the guild, not to any one
    // pickup. The ID format wants a number in that position regardless.
    .setCustomId(encodeId(Action.ConfigChannel, 0, field))
    .setPlaceholder(placeholder)
    .addChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder<ChannelSelectMenuBuilder | RoleSelectMenuBuilder>().addComponents(
    select,
  );
}

function roleRow(
  field: RoleField,
  placeholder: string,
  minValues: number,
  maxValues: number,
): PanelRow {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(encodeId(Action.ConfigRole, 0, field))
    .setPlaceholder(placeholder)
    .setMinValues(minValues)
    .setMaxValues(maxValues);

  return new ActionRowBuilder<ChannelSelectMenuBuilder | RoleSelectMenuBuilder>().addComponents(
    select,
  );
}

/**
 * The five rows of Panel 1.
 *
 * THERE IS DELIBERATELY NO SAVE BUTTON. Discord allows a message at most five
 * action rows, and a select menu must sit alone in its row — the five selects
 * use up the entire budget, so a sixth row for Save cannot exist. Each select
 * therefore commits the moment it changes (see `handleConfigComponent`), and the
 * panel re-renders with fresh status so the admin can see the save landed.
 */
function panelRows(): PanelRow[] {
  return [
    channelRow('signup_channel_id', 'Signup channel — where pickups are posted'),
    channelRow('roster_channel_id', 'Roster channel — where final rosters are published'),
    channelRow('review_channel_id', 'Staff review channel — private roster drafts'),
    roleRow('ping_role_id', 'Ping role — pinged on each new pickup', 1, 1),
    roleRow('authorized_role_ids', 'Authorized staff roles — who may manage pickups', 1, 25),
  ];
}

function channelStatus(id: string | null, label: string): string {
  return id ? `${SET} **${label}:** <#${id}>` : `${UNSET} **${label}:** not set`;
}

function emojiSummary(config: GuildConfig | null): string {
  if (!config) return `${UNSET} **Role emoji:** not bound`;

  const bound = ROLES.filter((role) => emojiFor(config, role) !== null);
  if (bound.length === ROLES.length) {
    const icons = ROLES.map((role) => `<:${role}:${emojiFor(config, role)}>`).join(' ');
    const fill = config.fillEmojiId ? ` <:${'fill'}:${config.fillEmojiId}> (Fill)` : ' (Fill skipped)';
    return `${SET} **Role emoji:** ${icons}${fill}`;
  }
  return `${UNSET} **Role emoji:** ${bound.length} of ${ROLES.length} bound`;
}

function emojiFor(config: GuildConfig, role: SignupRole): string | null {
  switch (role) {
    case 'solo':
      return config.soloEmojiId;
    case 'jungle':
      return config.jungleEmojiId;
    case 'mid':
      return config.midEmojiId;
    case 'support':
      return config.supportEmojiId;
    case 'carry':
      return config.carryEmojiId;
    case 'fill':
      return config.fillEmojiId;
  }
}

/** The full ephemeral panel: live status text plus the five selects. */
function buildPanel(guildId: string): {
  content: string;
  components: PanelRow[];
} {
  const config = new GuildConfigRepository().get(guildId);

  const lines: string[] = ['## Lucid Configuration', ''];
  lines.push(channelStatus(config?.signupChannelId ?? null, 'Signup channel'));
  lines.push(channelStatus(config?.rosterChannelId ?? null, 'Roster channel'));
  lines.push(channelStatus(config?.reviewChannelId ?? null, 'Staff review channel'));

  lines.push(
    config?.pingRoleId
      ? `${SET} **Ping role:** <@&${config.pingRoleId}>`
      : `${UNSET} **Ping role:** not set`,
  );

  const staffRoles = config?.authorizedRoleIds ?? [];
  lines.push(
    staffRoles.length > 0
      ? `${SET} **Authorized staff roles:** ${staffRoles.map((id) => `<@&${id}>`).join(', ')}`
      : `${UNSET} **Authorized staff roles:** not set`,
  );

  lines.push(emojiSummary(config));
  lines.push('');
  lines.push(`**Timezone:** \`${config?.timezone ?? 'America/New_York'}\``);
  lines.push('Change it with `/pickup config timezone:<zone>` — start typing and pick a suggestion.');
  lines.push('');
  lines.push('Each menu saves as soon as you pick something; there is no save button.');
  lines.push(
    'Once the channels and roles above are set, run `/pickup config bind_emoji:true` and react to bind five required role icons plus an optional Fill icon.',
  );

  return { content: lines.join('\n'), components: panelRows() };
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

export async function handleConfigCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Run this inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Manage Server, not Lucid's own staff guard — see the file header for why.
  if (!interaction.memberPermissions?.has('ManageGuild')) {
    await interaction.reply({
      content: 'You need the **Manage Server** permission to configure Lucid.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const repo = new GuildConfigRepository();
  repo.ensure(interaction.guildId);

  const timezone = interaction.options.getString('timezone');
  if (timezone) {
    if (!isValidTimezone(timezone)) {
      await interaction.reply({
        content: `\`${timezone}\` is not a recognized timezone. Use an IANA name such as \`America/New_York\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    repo.setField(interaction.guildId, 'timezone', timezone);
  }

  if (interaction.options.getBoolean('bind_emoji')) {
    await startEmojiBinding(interaction);
    return;
  }

  const panel = buildPanel(interaction.guildId);
  await interaction.reply({
    ...panel,
    flags: MessageFlags.Ephemeral,
    // The panel echoes role mentions back as status text; suppress them so
    // reviewing your own config never pings the whole server.
    allowedMentions: { parse: [] },
  } satisfies InteractionReplyOptions);
}

// ---------------------------------------------------------------------------
// Panel 1 components
// ---------------------------------------------------------------------------

export async function handleConfigComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  if (!interaction.guildId) return;

  if (!interaction.memberPermissions?.has('ManageGuild')) {
    await interaction.reply({
      content: 'You need the **Manage Server** permission to configure Lucid.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const repo = new GuildConfigRepository();

  if (decoded.action === Action.ConfigSkipFill) {
    const session = bindSessions.get(interaction.message.id);
    if (!session) {
      await interaction.update({ content: 'This emoji-binding session expired. Run `/pickup config bind_emoji:true` again.', components: [] });
      return;
    }
    if (session.initiatedBy !== interaction.user.id) {
      await interaction.reply({ content: 'Only the admin who started this binding can skip Fill.', flags: MessageFlags.Ephemeral });
      return;
    }
    await finishEmojiBinding(interaction.message, session, null);
    return;
  }

  const field = decoded.args[0];
  if (!field) return;

  if (interaction.isChannelSelectMenu() && isChannelField(field)) {
    // Commit immediately — there is no Save button to batch behind.
    repo.setField(interaction.guildId, field, interaction.values[0] ?? null);
  } else if (interaction.isRoleSelectMenu() && isRoleField(field)) {
    if (field === 'authorized_role_ids') {
      // Stored as a JSON array; the repository handles the encoding.
      repo.setField(interaction.guildId, 'authorized_role_ids', [...interaction.values]);
    } else {
      repo.setField(interaction.guildId, field, interaction.values[0] ?? null);
    }
  } else {
    return;
  }

  const panel = buildPanel(interaction.guildId);
  await interaction.update({ ...panel, allowedMentions: { parse: [] } });
}

// ---------------------------------------------------------------------------
// Panel 2 — react-to-bind emoji
// ---------------------------------------------------------------------------

interface BindSession {
  guildId: string;
  /**
   * Whoever ran `bind_emoji:true`. The binding message has to be public — Lucid
   * can't read reactions on an ephemeral one — but that means every reaction to
   * it is visible to every member, not just the admin running setup. Without
   * pinning the session to this ID, any member could react to a live binding
   * message and hand Lucid arbitrary emoji for the guild's role icons,
   * overwriting the real admin's in-progress setup.
   */
  initiatedBy: string;
  /** Filled positionally against SIGNUP_ROLES: five required roles, then optional Fill. */
  collected: { role: SignupRole; emojiId: string }[];
  startedAt: number;
}

/**
 * Live binding messages, keyed by message ID.
 *
 * In-memory is fine here: nothing is written to the database until all five
 * emoji are collected, so a restart mid-binding simply abandons the attempt and
 * the admin runs the command again. There is no half-saved state to clean up.
 *
 * An abandoned session (the admin never finishes, or deletes the prompt) is
 * likewise harmless for the DATA -- but `bindSessions.delete()` only runs on
 * successful completion, so without the pruning below it would sit in this
 * Map until the next restart. That is not just a memory leak: the
 * `[bind]` logging in tryHandleEmojiBind gates on "is any session active" as
 * a proxy for "is this rare and brief," which stops being true the moment one
 * session never closes -- every reaction on every guild would then log
 * forever instead of only during an actual setup. Found by codex review on
 * PR #24.
 */
const bindSessions = new Map<string, BindSession>();

const BIND_SESSION_TTL_MS = 15 * 60 * 1000;

/** Drop sessions nobody finished within a reasonable sitting. */
function pruneExpiredSessions(): void {
  const cutoff = Date.now() - BIND_SESSION_TTL_MS;
  for (const [messageId, session] of bindSessions) {
    if (session.startedAt < cutoff) bindSessions.delete(messageId);
  }
}

function bindInstructions(session: BindSession): string {
  const lines = [
    '**Bind your role icons**',
    '',
    'React with your five required Conquest role icons, then optionally Fill: Solo, Jungle, Mid, Support, Carry, Fill.',
    '',
  ];

  for (const [index, role] of SIGNUP_ROLES.entries()) {
    const done = session.collected[index];
    lines.push(
      done
        ? `${SET} ${SIGNUP_ROLE_LABELS[role]} — <:${role}:${done.emojiId}>`
        : `${UNSET} ${SIGNUP_ROLE_LABELS[role]}${role === 'fill' ? ' (optional)' : ''}`,
    );
  }

  const next = SIGNUP_ROLES[session.collected.length];
  if (next) {
    lines.push('');
    lines.push(`Next: react with your **${SIGNUP_ROLE_LABELS[next]}** icon${next === 'fill' ? ', or press **Skip Fill**' : ''}.`);
  }
  return lines.join('\n');
}

function bindComponents(session: BindSession): ActionRowBuilder<ButtonBuilder>[] {
  if (session.collected.length !== ROLES.length) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeId(Action.ConfigSkipFill, 0))
      .setLabel('Skip Fill')
      .setStyle(ButtonStyle.Secondary),
  )];
}

async function finishEmojiBinding(
  message: MessageReaction['message'],
  session: BindSession,
  fillEmojiId: string | null,
): Promise<void> {
  const emojiByRole = {} as Record<Role, string>;
  for (const entry of session.collected) {
    if (entry.role !== 'fill') emojiByRole[entry.role] = entry.emojiId;
  }
  new GuildConfigRepository().setAllEmoji(session.guildId, emojiByRole, fillEmojiId);
  bindSessions.delete(message.id);

  const icons = ROLES.map((r) => `<:${r}:${emojiByRole[r]}>`).join(' ');
  const fill = fillEmojiId ? ` <:${'fill'}:${fillEmojiId}>` : ' Fill skipped';
  await message.edit({
    content: `${SET} **Role icons bound.** ${icons}${fill}\n\nLucid will seed them in this order: ${SIGNUP_ROLES.filter((role) => role !== 'fill' || fillEmojiId).map(
      (role) => SIGNUP_ROLE_LABELS[role],
    ).join(' → ')}.`,
    components: [],
  });
}

/**
 * Post the public binding message.
 *
 * It has to be public: Lucid cannot read reactions on an ephemeral message,
 * and reacting is the only way to hand us a custom emoji ID.
 */
async function startEmojiBinding(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  pruneExpiredSessions();
  const session: BindSession = { guildId, initiatedBy: interaction.user.id, collected: [], startedAt: Date.now() };

  // Deliberately NOT ephemeral (no MessageFlags.Ephemeral): see the note above
  // — reactions on an ephemeral message are invisible to us, and this whole
  // flow is driven by the coordinator reacting to this exact message.
  await interaction.reply({ content: bindInstructions(session) });
  const message = await interaction.fetchReply();
  bindSessions.set(message.id, session);
}

/**
 * Called by the reaction router BEFORE the signup handler, for every added
 * reaction.
 *
 * Returns true for ANY reaction landing on a live binding message — including
 * ones we reject — so the signup handler never mistakes a binding reaction for
 * a player signing up. Returns false for everything else.
 */
export async function tryHandleEmojiBind(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<boolean> {
  pruneExpiredSessions();
  const session = bindSessions.get(reaction.message.id);

  // Scoped to "there is an active binding flow somewhere" rather than logged
  // unconditionally -- this function runs on EVERY reaction added anywhere
  // Lucid can see, including every player signing up on a live pickup post,
  // so logging every call would drown the logs in normal operation. This
  // only stays quiet outside a real setup window because of the pruning
  // above: an abandoned session that never reached bindSessions.delete()
  // would otherwise keep this non-empty, and therefore keep this logging
  // every single reaction, forever.
  if (bindSessions.size > 0) {
    console.log(
      `[bind] reaction on message ${reaction.message.id} by ${user.id} — ` +
        `${session ? 'matches an active binding session' : 'no active binding session for this message'} ` +
        `(${bindSessions.size} active session(s) tracked)`,
    );
  }

  if (!session) return false;

  // Lucid's own reactions (if any ever land here) are not a person's answer.
  if (user.bot) return true;

  const message = reaction.message.partial
    ? await reaction.message.fetch()
    : reaction.message;

  const warn = async (text: string): Promise<void> => {
    await message.edit(`${bindInstructions(session)}\n\n⚠️ ${text}`);
  };

  // Only the admin who ran the command can supply icons. The message is public
  // by necessity (see the BindSession.initiatedBy comment), so without this
  // check any member reacting here could overwrite the guild's role-icon
  // configuration mid-setup.
  if (user.id !== session.initiatedBy) {
    await warn(`Only <@${session.initiatedBy}> can bind these icons — they ran the command.`);
    return true;
  }

  const emojiId = reaction.emoji.id;

  // A standard Unicode emoji has no ID, and Lucid tracks signups strictly by
  // custom emoji ID — so it cannot be used as a role icon.
  if (!emojiId) {
    await warn('That is a standard emoji. Use one of your server\'s custom role icons instead.');
    return true;
  }

  // Scoped to THIS guild specifically, not reaction.client.emojis.cache (every
  // emoji Lucid can see across every server it's in). Discord does not let a
  // bot react with a custom emoji belonging to a different guild than the
  // message it's reacting to — an emoji from another server Lucid happens to
  // be in would pass a guild-unscoped check here but fail later when Lucid
  // actually tries to seed it onto a signup post in this one.
  if (!reaction.message.guild?.emojis.cache.has(emojiId)) {
    await warn('Lucid cannot use that emoji. Pick a custom emoji from this server.');
    return true;
  }

  if (session.collected.some((entry) => entry.emojiId === emojiId)) {
    await warn('That icon is already bound to another role. Pick a different one.');
    return true;
  }

  const role = SIGNUP_ROLES[session.collected.length];
  if (!role) return true; // Defensive: a full session is deleted below.

  session.collected.push({ role, emojiId });

  if (session.collected.length < SIGNUP_ROLES.length) {
    await message.edit({ content: bindInstructions(session), components: bindComponents(session) });
    return true;
  }
  await finishEmojiBinding(message, session, emojiId);
  return true;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export async function handleConfigAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'timezone') {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.toLowerCase();
  const zones = Intl.supportedValuesOf('timeZone')
    .filter((zone) => zone.toLowerCase().includes(query))
    // Discord rejects a response with more than 25 choices.
    .slice(0, 25)
    .map((zone) => ({ name: zone, value: zone }));

  await interaction.respond(zones);
}
