/**
 * Staff authorization.
 *
 * One guard, used by every management action: creating pickups, all three Edit
 * Roster actions, Shuffle, Publish, Cancel and Replace Player. There is no
 * looser tier for any of them — notably not for Edit Roster's eligibility
 * override, which is if anything the action that most warrants the check.
 *
 * "Coordinator and above" is expressed by which roles a guild puts in
 * `authorized_role_ids`, not by anything in this file. Lucid deliberately has
 * no built-in notion of rank.
 */

import { MessageFlags, type GuildMember, type RepliableInteraction } from 'discord.js';
import { GuildConfigRepository } from '../db/repositories/guild-config.js';
import type { GuildConfig } from '../db/repositories/types.js';

export function isAuthorized(member: GuildMember | null, config: GuildConfig | null): boolean {
  if (!member || !config) return false;

  // Guild administrators always pass, so a server can never lock itself out of
  // its own bot by misconfiguring the role list.
  if (member.permissions.has('Administrator')) return true;

  if (config.authorizedRoleIds.length === 0) return false;
  return config.authorizedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export const UNAUTHORIZED_MESSAGE =
  'You do not have permission to manage pickups. Ask an admin to add your role with `/pickup config`.';

/**
 * Guard an interaction, replying with the standard refusal when it fails.
 *
 * Returns the guild config on success so callers don't have to re-read it.
 * Note this re-checks on every interaction rather than trusting that the
 * component was only rendered somewhere staff can see — channel visibility is
 * not an authorization boundary.
 */
export async function requireAuthorized(
  interaction: RepliableInteraction,
): Promise<GuildConfig | null> {
  if (!interaction.guildId) return null;

  const config = new GuildConfigRepository().get(interaction.guildId);
  const member = interaction.member as GuildMember | null;

  if (!isAuthorized(member, config)) {
    const payload = { content: UNAUTHORIZED_MESSAGE, flags: MessageFlags.Ephemeral } as const;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
    return null;
  }
  return config;
}
