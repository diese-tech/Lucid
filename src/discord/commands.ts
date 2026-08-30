/**
 * Slash command definitions.
 *
 * Registered per-guild, not globally — see discord/register.ts, which
 * index.ts calls for every guild Lucid is already in on boot and again when
 * it joins a new one. Guild-scoped registration applies in seconds; a global
 * registration can take up to an hour to propagate, a poor fit for a command
 * set that's still actively changing. Lucid stays guild-agnostic in the
 * sense that matters: nothing here assumes which guild, only that there is
 * one — any league can still add the bot and configure it for their own
 * channels, roles, emoji and timezone.
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
  // The ping role (product-spec §12) is exactly the kind of role a server
  // would deliberately leave "not mentionable by anyone" — so only staff/bots
  // with explicit permission can trigger it. Discord calls this permission
  // "Mention @everyone, @here, and All Roles" in its own UI, which also
  // covers a non-mentionable role, not just @everyone/@here as the name here
  // implies. Included defensively — flagging that this specific behavior
  // isn't verified against a live server yet, worth confirming pings actually
  // land once Lucid pings its first pickup.
  PermissionFlagsBits.MentionEveryone,
];

export const TEXT_CHANNEL_TYPES = [ChannelType.GuildText];
