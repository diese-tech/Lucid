/**
 * Slash command definitions.
 *
 * Commands are registered GLOBALLY rather than to a single guild. Lucid is
 * guild-agnostic by design — any league can add the bot and configure it for
 * their own channels, roles, emoji and timezone — so scoping commands to one
 * dev guild would defeat the point.
 */

import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

export const pickupCommand = new SlashCommandBuilder()
  .setName('pickup')
  .setDescription('Coordinate SMITE 2 pickup scrims')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName('create').setDescription('Create a new pickup and post it for signups'),
  )
  .addSubcommand((sub) =>
    sub.setName('cancel').setDescription('Cancel an open pickup'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('Configure Lucid for this server')
      // Guarded again in the handler; this only hides it in the client UI.
      .addStringOption((option) =>
        option
          .setName('timezone')
          .setDescription('IANA timezone used to read start times (default America/New_York)')
          .setAutocomplete(true)
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('bind_emoji')
          .setDescription('Start the react-to-bind step for the five role icons')
          .setRequired(false),
      ),
  )
  // Config is admin-only. The other subcommands check the configured staff
  // roles at runtime, which this coarse gate cannot express.
  .setDefaultMemberPermissions(undefined);

export const commands = [pickupCommand];

export const commandJSON = commands.map((command) => command.toJSON());

/** Permissions Lucid needs in the guild, for building the invite URL. */
export const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ReadMessageHistory,
  // Needed to strip a reaction that would put a player over their role limit,
  // so Discord's visible state always matches Lucid's records.
  PermissionFlagsBits.ManageMessages,
];

export const TEXT_CHANNEL_TYPES = [ChannelType.GuildText];
