/**
 * Staff authorization.
 *
 * One guard, used by every management action: creating pickups, all three Edit
 * Roster actions, Shuffle, Publish, Cancel, Finish and Replace Player. There is
 * no looser tier for any of them — notably not for Edit Roster's eligibility
 * override, which is if anything the action that most warrants the check.
 *
 * "Coordinator and above" is expressed by which roles a Pickup Space puts in
 * `authorized_role_ids`, not by anything in this file. Lucid deliberately has
 * no built-in notion of rank.
 *
 * Authorization is scoped to a Pickup Space, not the whole guild: since #34,
 * a guild can run several independently staffed spaces, so a role authorized
 * in one space carries no authority in another.
 */

import { MessageFlags, type GuildMember, type RepliableInteraction } from 'discord.js';
import { PickupSpaceRepository } from '../db/repositories/pickup-spaces.js';
import type { Pickup, PickupSpace } from '../db/repositories/types.js';

/** The shape every authority check actually needs — just the role list. */
export interface Authorizable {
  authorizedRoleIds: string[];
}

export function isAuthorized(member: GuildMember | null, target: Authorizable | null): boolean {
  if (!member || !target) return false;

  // Guild administrators always pass, so a server can never lock itself out of
  // its own bot by misconfiguring a space's role list.
  if (member.permissions.has('Administrator')) return true;

  if (target.authorizedRoleIds.length === 0) return false;
  return target.authorizedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export const UNAUTHORIZED_MESSAGE =
  'You do not have permission to manage pickups. Ask an admin to add your role with `/pickup space edit`.';

async function replyUnauthorized(interaction: RepliableInteraction): Promise<void> {
  const payload = { content: UNAUTHORIZED_MESSAGE, flags: MessageFlags.Ephemeral } as const;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

/**
 * Guard an interaction against an already-resolved space, replying with the
 * standard refusal when it fails.
 *
 * Returns the space on success so callers don't have to re-resolve it. Note
 * this re-checks on every interaction rather than trusting that the component
 * was only rendered somewhere staff can see — channel visibility is not an
 * authorization boundary.
 */
export async function requireAuthorizedForSpace(
  interaction: RepliableInteraction,
  space: PickupSpace | null,
): Promise<PickupSpace | null> {
  const member = interaction.member as GuildMember | null;
  if (!isAuthorized(member, space)) {
    await replyUnauthorized(interaction);
    return null;
  }
  return space;
}

/**
 * Same guard, resolved from a pickup's own snapshotted Pickup Space rather
 * than a space the caller already has in hand — the normal case for every
 * flow that manages an existing pickup (cancel, review, replace, finish).
 *
 * A pickup with no space (only possible for one that predates migration 005
 * in a guild whose legacy config was never completed — see schema.ts) has
 * nothing to authorize against and is always refused.
 */
export async function requireAuthorizedForPickup(
  interaction: RepliableInteraction,
  pickup: Pickup,
): Promise<PickupSpace | null> {
  const space = pickup.pickupSpaceId ? new PickupSpaceRepository().get(pickup.pickupSpaceId) : null;
  return requireAuthorizedForSpace(interaction, space);
}
