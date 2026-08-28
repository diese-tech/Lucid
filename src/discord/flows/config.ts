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
  ChannelSelectMenuBuilder,
  ChannelType,
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
import { ROLES, ROLE_LABELS, type Role } from '../../domain/roles.js';
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
    return `${SET} **Role emoji:** ${icons}`;
  }
  return `${UNSET} **Role emoji:** ${bound.length} of ${ROLES.length} bound`;
}

function emojiFor(config: GuildConfig, role: Role): string | null {
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
    'Once the channels and roles above are set, run `/pickup config bind_emoji:true` and react to the message Lucid posts to bind your five role icons.',
  );

  return { content: lines.join('\n'), components: panelRows() };
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

export async function handleConfigCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Run this inside a server.', ephemeral: true });
    return;
  }

  // Manage Server, not Lucid's own staff guard — see the file header for why.
  if (!interaction.memberPermissions?.has('ManageGuild')) {
    await interaction.reply({
      content: 'You need the **Manage Server** permission to configure Lucid.',
      ephemeral: true,
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
        ephemeral: true,
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
    ephemeral: true,
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
      ephemeral: true,
    });
    return;
  }

  const field = decoded.args[0];
  if (!field) return;

  const repo = new GuildConfigRepository();

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
  /** Filled positionally against ROLES: first reaction is Solo, and so on. */
  collected: { role: Role; emojiId: string }[];
}

/**
 * Live binding messages, keyed by message ID.
 *
 * In-memory is fine here: nothing is written to the database until all five
 * emoji are collected, so a restart mid-binding simply abandons the attempt and
 * the admin runs the command again. There is no half-saved state to clean up.
 */
const bindSessions = new Map<string, BindSession>();

function bindInstructions(session: BindSession): string {
  const lines = [
    '**Bind your role icons**',
    '',
    'React to this message with your five Conquest role icons, in this order: Solo, Jungle, Mid, Support, Carry.',
    '',
  ];

  for (const [index, role] of ROLES.entries()) {
    const done = session.collected[index];
    lines.push(
      done
        ? `${SET} ${ROLE_LABELS[role]} — <:${role}:${done.emojiId}>`
        : `${UNSET} ${ROLE_LABELS[role]}`,
    );
  }

  const next = ROLES[session.collected.length];
  if (next) {
    lines.push('');
    lines.push(`Next: react with your **${ROLE_LABELS[next]}** icon.`);
  }
  return lines.join('\n');
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

  const session: BindSession = { guildId, collected: [] };

  await interaction.reply({ content: bindInstructions(session), ephemeral: false });
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
  const session = bindSessions.get(reaction.message.id);
  if (!session) return false;

  // Lucid's own reactions (if any ever land here) are not a person's answer.
  if (user.bot) return true;

  const message = reaction.message.partial
    ? await reaction.message.fetch()
    : reaction.message;

  const warn = async (text: string): Promise<void> => {
    await message.edit(`${bindInstructions(session)}\n\n⚠️ ${text}`);
  };

  const emojiId = reaction.emoji.id;

  // A standard Unicode emoji has no ID, and Lucid tracks signups strictly by
  // custom emoji ID — so it cannot be used as a role icon.
  if (!emojiId) {
    await warn('That is a standard emoji. Use one of your server\'s custom role icons instead.');
    return true;
  }

  // Lucid can only re-add a reaction it has access to. If the emoji is not in
  // the bot's cache it lives in a server Lucid isn't in, and seeding the signup
  // post with it would fail later, when it is much harder to diagnose.
  if (!reaction.client.emojis.cache.has(emojiId)) {
    await warn('Lucid cannot use that emoji. Pick a custom emoji from this server.');
    return true;
  }

  if (session.collected.some((entry) => entry.emojiId === emojiId)) {
    await warn('That icon is already bound to another role. Pick a different one.');
    return true;
  }

  const role = ROLES[session.collected.length];
  if (!role) return true; // Defensive: a full session is deleted below.

  session.collected.push({ role, emojiId });

  if (session.collected.length < ROLES.length) {
    await message.edit(bindInstructions(session));
    return true;
  }

  // All five in hand — write them as one unit so a guild is never left with a
  // partially rebound icon set.
  const emojiByRole = {} as Record<Role, string>;
  for (const entry of session.collected) emojiByRole[entry.role] = entry.emojiId;

  new GuildConfigRepository().setAllEmoji(session.guildId, emojiByRole);
  bindSessions.delete(reaction.message.id);

  const icons = ROLES.map((r) => `<:${r}:${emojiByRole[r]}>`).join(' ');
  await message.edit(
    `${SET} **Role icons bound.** ${icons}\n\nLucid will seed these on every signup post, in this order: ${ROLES.map(
      (r) => ROLE_LABELS[r],
    ).join(' → ')}.`,
  );
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
