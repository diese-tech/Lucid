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
import { helpCommand } from './help.js';

export const pickupCommand = new SlashCommandBuilder()
  .setName('pickup')
  .setDescription('Create, configure, or cancel pickup games.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName('create').setDescription('Set up a pickup, preview it, then post it for signups.'),
  )
  .addSubcommand((sub) =>
    sub.setName('cancel').setDescription('Cancel an open pickup after confirmation.'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('Set the channels, staff roles, timezone, and signup emojis for this server.')
      // Guarded again in the handler; this only hides it in the client UI.
      .addStringOption((option) =>
        option
          .setName('timezone')
          .setDescription('Timezone used to read pickup times, such as America/New_York.')
          .setAutocomplete(true)
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('bind_emoji')
          .setDescription('Bind five role emojis and optional Fill.')
          .setRequired(false),
      ),
  )
  // Config is admin-only. The other subcommands check the configured staff
  // roles at runtime, which this coarse gate cannot express.
  .setDefaultMemberPermissions(undefined);

export const commands = [pickupCommand, helpCommand];

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
