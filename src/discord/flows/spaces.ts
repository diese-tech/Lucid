/**
 * `/pickup space create|edit|list|delete` — Pickup Space administration.
 *
 * A Pickup Space is one independently configured pickup lane inside a guild:
 * its own origin/signup/roster/review channels, its own authorized staff
 * roles, its own optional ping/eligibility roles. A guild that only ever
 * needs one lane still has exactly one space (created automatically by
 * migration 005 from the old singleton guild config); a guild that wants a
 * separate restricted lower-skill lane alongside its public one creates a
 * second space rather than Lucid growing a hardcoded notion of "tiers".
 *
 * Gated by Discord's own Manage Server permission, the same as `/pickup
 * config` and for the same reason: a space's authorized-role list is one of
 * the things this command configures, so Lucid's own staff guard has nothing
 * to check against until an admin has set at least one role here.
 *
 * The edit panel is split into two pages — channels, then roles — because
 * Discord caps a message at five action rows and a select menu fills a whole
 * row by itself; four fields plus a page-switch button is what fits. Each
 * select commits the moment it changes, exactly like `/pickup config`'s
 * panel, for the same reason: there is nowhere left to put a Save button.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';

import { PickupSpaceRepository, isSpaceComplete } from '../../db/repositories/pickup-spaces.js';
import type { PickupSpace } from '../../db/repositories/types.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { boundedLines } from '../render.js';

const SET = '✅';
const UNSET = '⬜';

const MAX_NAME_LENGTH = 90;

const NO_MANAGE_GUILD = 'You need the **Manage Server** permission to manage Pickup Spaces.';

function requireManageGuild(interaction: {
  memberPermissions: { has(flag: 'ManageGuild'): boolean } | null;
}): boolean {
  return interaction.memberPermissions?.has('ManageGuild') ?? false;
}

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

type SpacePage = 'channels' | 'roles';

const CHANNEL_FIELDS = ['origin_channel_id', 'signup_channel_id', 'roster_channel_id', 'review_channel_id'] as const;
const ROLE_FIELDS = [
  'authorized_role_ids',
  'signup_ping_role_id',
  'organizer_ping_role_id',
  'default_eligibility_role_ids',
] as const;

/** Fields stored as a JSON array rather than a single optional role ID. */
const MULTI_ROLE_FIELDS = ['authorized_role_ids', 'default_eligibility_role_ids'] as const;

function isMultiRoleField(field: RoleFieldName): boolean {
  return (MULTI_ROLE_FIELDS as readonly string[]).includes(field);
}

type ChannelField = (typeof CHANNEL_FIELDS)[number];
type RoleFieldName = (typeof ROLE_FIELDS)[number];

function isChannelField(value: string): value is ChannelField {
  return (CHANNEL_FIELDS as readonly string[]).includes(value);
}

function isRoleField(value: string): value is RoleFieldName {
  return (ROLE_FIELDS as readonly string[]).includes(value);
}

type PanelComponent = ChannelSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder;
type PanelRow = ActionRowBuilder<PanelComponent>;

function row(...components: PanelComponent[]): PanelRow {
  return new ActionRowBuilder<PanelComponent>().addComponents(...components);
}

function channelRow(spaceId: number, field: ChannelField, placeholder: string): PanelRow {
  return row(
    new ChannelSelectMenuBuilder()
      .setCustomId(encodeId(Action.SpaceChannel, spaceId, field))
      .setPlaceholder(placeholder)
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1),
  );
}

function roleRow(
  spaceId: number,
  field: RoleFieldName,
  placeholder: string,
  minValues: number,
  maxValues: number,
): PanelRow {
  return row(
    new RoleSelectMenuBuilder()
      .setCustomId(encodeId(Action.SpaceRole, spaceId, field))
      .setPlaceholder(placeholder)
      .setMinValues(minValues)
      .setMaxValues(maxValues),
  );
}

function channelStatus(id: string | null, label: string): string {
  return id ? `${SET} **${label}:** <#${id}>` : `${UNSET} **${label}:** not set`;
}

function roleStatus(id: string | null, label: string): string {
  return id ? `${SET} **${label}:** <@&${id}>` : `${UNSET} **${label}:** not set`;
}

function roleListStatus(ids: readonly string[], label: string): string {
  return ids.length > 0
    ? `${SET} **${label}:** ${ids.map((id) => `<@&${id}>`).join(', ')}`
    : `${UNSET} **${label}:** not set`;
}

function spacePanel(space: PickupSpace, page: SpacePage): { content: string; components: PanelRow[] } {
  const lines = [`## Pickup Space: ${space.name}`, ''];

  if (page === 'channels') {
    lines.push(channelStatus(space.originChannelId, 'Origin channel — where /pickup create is run'));
    lines.push(channelStatus(space.signupChannelId, 'Signup channel'));
    lines.push(channelStatus(space.rosterChannelId, 'Roster channel'));
    lines.push(channelStatus(space.reviewChannelId, 'Staff review channel'));
    lines.push('');
    lines.push('Each menu saves as soon as you pick something; there is no save button.');
    lines.push('Press **Next: Roles →** to set staff roles, ping roles, and eligibility.');

    return {
      content: lines.join('\n'),
      components: [
        channelRow(space.id, 'origin_channel_id', 'Origin channel — where /pickup create is run'),
        channelRow(space.id, 'signup_channel_id', 'Signup channel — where pickups are posted'),
        channelRow(space.id, 'roster_channel_id', 'Roster channel — where final rosters are published'),
        channelRow(space.id, 'review_channel_id', 'Staff review channel — private roster drafts'),
        row(
          new ButtonBuilder()
            .setCustomId(encodeId(Action.SpaceMore, space.id))
            .setLabel('Next: Roles →')
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    };
  }

  lines.push(roleListStatus(space.authorizedRoleIds, 'Authorized staff roles'));
  lines.push(roleStatus(space.signupPingRoleId, 'Signup ping role (optional)'));
  lines.push(roleStatus(space.organizerPingRoleId, 'Organizer notification role (optional)'));
  lines.push(roleListStatus(space.defaultEligibilityRoleIds, 'Default eligibility roles (optional)'));
  lines.push('');
  lines.push('Each menu saves as soon as you pick something; there is no save button.');

  return {
    content: lines.join('\n'),
    components: [
      roleRow(space.id, 'authorized_role_ids', 'Authorized staff roles — who may manage pickups', 1, 25),
      roleRow(space.id, 'signup_ping_role_id', 'Signup ping role — pinged on each new pickup', 0, 1),
      roleRow(space.id, 'organizer_ping_role_id', 'Organizer notification role', 0, 1),
      roleRow(
        space.id,
        'default_eligibility_role_ids',
        'Default eligibility roles — any one qualifies a new pickup',
        0,
        25,
      ),
      row(
        new ButtonBuilder()
          .setCustomId(encodeId(Action.SpaceBack, space.id))
          .setLabel('← Back: Channels')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(encodeId(Action.SpaceRename, space.id))
          .setLabel('Rename')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function renameModal(space: PickupSpace): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(encodeId(Action.SpaceRenameModal, space.id))
    .setTitle('Rename Pickup Space');

  const name = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Name')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(MAX_NAME_LENGTH)
    .setRequired(true)
    .setValue(space.name);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(name));
  return modal;
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

export async function handleSpaceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Run this inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!requireManageGuild(interaction)) {
    await interaction.reply({ content: NO_MANAGE_GUILD, flags: MessageFlags.Ephemeral });
    return;
  }

  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'create':
      await handleSpaceCreate(interaction);
      return;
    case 'edit':
      await handleSpaceEdit(interaction);
      return;
    case 'list':
      await handleSpaceList(interaction);
      return;
    case 'delete':
      await handleSpaceDelete(interaction);
      return;
    default:
      return;
  }
}

async function handleSpaceCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const name = interaction.options.getString('name', true).trim();

  if (!name) {
    await interaction.reply({ content: 'Give the space a name.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (name.length > MAX_NAME_LENGTH) {
    await interaction.reply({
      content: `Space names must be ${MAX_NAME_LENGTH} characters or fewer.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = new PickupSpaceRepository().create({ guildId, name });
  if (!result.ok) {
    await interaction.reply({
      content: `A Pickup Space named **${name}** already exists in this server. Use \`/pickup space edit\` to change it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    ...spacePanel(result.space, 'channels'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleSpaceEdit(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const name = interaction.options.getString('space', true);
  const space = new PickupSpaceRepository().byName(guildId, name);

  if (!space) {
    await interaction.reply({
      content: `No Pickup Space named **${name}** exists. Use \`/pickup space list\` to see what's configured.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    ...spacePanel(space, 'channels'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleSpaceList(interaction: ChatInputCommandInteraction): Promise<void> {
  const spaces = new PickupSpaceRepository().list(interaction.guildId!);

  if (spaces.length === 0) {
    await interaction.reply({
      content: 'No Pickup Spaces yet. Create one with `/pickup space create name:<name>`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Discord caps a message at 2000 characters. A guild running enough spaces
  // -- each name up to MAX_NAME_LENGTH characters -- could otherwise blow
  // past that and make /pickup space list fail outright, precisely when the
  // list is most needed. Truncate with a pointer to the per-space lookup
  // rather than let the whole reply silently fail.
  const lines = boundedLines(
    ['## Pickup Spaces', ''],
    spaces.map((space) => {
      const status = isSpaceComplete(space) ? SET : UNSET;
      const origin = space.originChannelId ? `<#${space.originChannelId}>` : 'no origin channel set';
      return `${status} **${space.name}** — ${origin}`;
    }),
    (remaining) =>
      remaining > 0
        ? `...and ${remaining} more. Use \`/pickup space edit space:<name>\` to look one up by name.`
        : 'Edit one with `/pickup space edit space:<name>`.',
  );

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handleSpaceDelete(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const name = interaction.options.getString('space', true);
  const repo = new PickupSpaceRepository();
  const space = repo.byName(guildId, name);

  if (!space) {
    await interaction.reply({ content: `No Pickup Space named **${name}** exists.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const count = repo.pickupCount(space.id);
  if (count > 0) {
    await interaction.reply({
      content: `**${space.name}** has ${count} pickup${count === 1 ? '' : 's'} on record and can't be deleted — that would destroy history. Its configuration can still be changed with \`/pickup space edit\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Delete **${space.name}**? It has never had a pickup created in it, so this is safe. This cannot be undone.`,
    components: [
      row(
        new ButtonBuilder()
          .setCustomId(encodeId(Action.SpaceDeleteConfirm, space.id, 'yes'))
          .setLabel('Delete')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(encodeId(Action.SpaceDeleteConfirm, space.id, 'no'))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export async function handleSpaceComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  if (!interaction.guildId) return;
  if (!requireManageGuild(interaction)) {
    await interaction.reply({ content: NO_MANAGE_GUILD, flags: MessageFlags.Ephemeral });
    return;
  }

  const repo = new PickupSpaceRepository();

  if (decoded.action === Action.SpaceDeleteConfirm) {
    if (decoded.args[0] !== 'yes') {
      await interaction.update({ content: 'Nothing was deleted.', components: [] });
      return;
    }
    const space = repo.get(decoded.pickupId);
    if (!space) {
      await interaction.update({ content: 'That Pickup Space no longer exists.', components: [] });
      return;
    }
    const result = repo.delete(space.id);
    if (!result.ok) {
      await interaction.update({
        content: `**${space.name}** now has ${result.pickupCount} pickup(s) on record and can no longer be deleted.`,
        components: [],
      });
      return;
    }
    await interaction.update({ content: `**${space.name}** was deleted.`, components: [] });
    return;
  }

  if (decoded.action === Action.SpaceRename) {
    const space = repo.get(decoded.pickupId);
    if (!space) {
      await interaction.reply({ content: 'That Pickup Space no longer exists.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(renameModal(space));
    return;
  }

  const space = repo.get(decoded.pickupId);
  if (!space) {
    await interaction.update({ content: 'That Pickup Space no longer exists.', components: [] });
    return;
  }

  if (decoded.action === Action.SpaceMore) {
    await interaction.update(spacePanel(space, 'roles'));
    return;
  }
  if (decoded.action === Action.SpaceBack) {
    await interaction.update(spacePanel(space, 'channels'));
    return;
  }

  const field = decoded.args[0];
  if (!field) return;

  if (interaction.isChannelSelectMenu() && isChannelField(field)) {
    const channelId = interaction.values[0] ?? null;

    if (field === 'origin_channel_id' && channelId) {
      // origin_channel_id is how /pickup create resolves which space a
      // command belongs to — byOriginChannel() does an unconstrained
      // lookup, so two spaces sharing one origin channel would make that
      // resolution arbitrary and could apply the wrong space's
      // authorization, eligibility and routing to a new pickup.
      const claimedBy = repo.byOriginChannel(interaction.guildId, channelId);
      if (claimedBy && claimedBy.id !== space.id) {
        const panel = spacePanel(space, 'channels');
        await interaction.update({
          content: `⚠️ <#${channelId}> is already the origin channel for **${claimedBy.name}** — pick a different channel.\n\n${panel.content}`,
          components: panel.components,
          allowedMentions: { parse: [] },
        });
        return;
      }
    }

    // Commit immediately — there is no Save button to batch behind.
    try {
      repo.setField(space.id, field, channelId);
    } catch (error) {
      // The pre-check above is a courtesy, not the real guard — a real
      // UNIQUE index on (guild_id, origin_channel_id) is what actually
      // closes the race between two admins editing two spaces at once (see
      // migration 007). Losing that race lands here, not in the pre-check.
      if (
        field === 'origin_channel_id' &&
        channelId &&
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        const claimedBy = repo.byOriginChannel(interaction.guildId, channelId);
        const panel = spacePanel(space, 'channels');
        await interaction.update({
          content: `⚠️ <#${channelId}> was just claimed as the origin channel for **${claimedBy?.name ?? 'another space'}** — pick a different channel.\n\n${panel.content}`,
          components: panel.components,
          allowedMentions: { parse: [] },
        });
        return;
      }
      throw error;
    }
  } else if (interaction.isRoleSelectMenu() && isRoleField(field)) {
    if (isMultiRoleField(field)) {
      repo.setField(space.id, field, [...interaction.values]);
    } else {
      repo.setField(space.id, field, interaction.values[0] ?? null);
    }
  } else {
    return;
  }

  const updated = repo.get(space.id)!;
  const page: SpacePage = isChannelField(field) ? 'channels' : 'roles';
  await interaction.update({ ...spacePanel(updated, page), allowedMentions: { parse: [] } });
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export async function handleSpaceModal(interaction: ModalSubmitInteraction, decoded: DecodedId): Promise<void> {
  if (!interaction.guildId) return;
  if (!requireManageGuild(interaction)) {
    await interaction.reply({ content: NO_MANAGE_GUILD, flags: MessageFlags.Ephemeral });
    return;
  }

  const repo = new PickupSpaceRepository();
  const space = repo.get(decoded.pickupId);
  if (!space) {
    await interaction.reply({ content: 'That Pickup Space no longer exists.', flags: MessageFlags.Ephemeral });
    return;
  }

  const name = interaction.fields.getTextInputValue('name').trim();
  if (!name) {
    await interaction.reply({ content: 'Give the space a name.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (name.length > MAX_NAME_LENGTH) {
    await interaction.reply({
      content: `Space names must be ${MAX_NAME_LENGTH} characters or fewer.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = repo.byName(interaction.guildId, name);
  if (existing && existing.id !== space.id) {
    await interaction.reply({
      content: `A Pickup Space named **${name}** already exists.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  repo.setField(space.id, 'name', name);
  const updated = repo.get(space.id)!;
  const payload = { ...spacePanel(updated, 'roles'), allowedMentions: { parse: [] as const } };

  if (interaction.isFromMessage()) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export async function handleSpaceAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'space') {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.toLowerCase();
  const options = new PickupSpaceRepository()
    .list(interaction.guildId)
    .filter((space) => space.name.toLowerCase().includes(query))
    // Discord rejects a response with more than 25 choices.
    .slice(0, 25)
    .map((space) => ({ name: space.name, value: space.name }));

  await interaction.respond(options);
}
