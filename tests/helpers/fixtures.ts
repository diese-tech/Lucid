/**
 * Shared fixtures for flow tests that need an authorized, fully routed
 * Pickup Space — which after #34's Pickup Spaces work is most of them, since
 * channels, ping roles, and authorized staff roles all live on the space now
 * rather than on GuildConfig.
 */

import type Database from 'better-sqlite3';
import { PickupSpaceRepository } from '../../src/db/repositories/pickup-spaces.js';
import type { PickupSpace } from '../../src/db/repositories/types.js';
import { fakeId } from './discord-mocks.js';

export interface SeedSpaceOptions {
  guildId: string;
  name?: string;
  authorizedRoleIds?: string[];
  originChannelId?: string;
  signupChannelId?: string;
  rosterChannelId?: string;
  reviewChannelId?: string;
  signupPingRoleId?: string | null;
  defaultEligibilityRoleIds?: string[];
}

/**
 * A fully configured Pickup Space: all four channels set, and any roles the
 * caller passes. Channels default to fresh fake IDs when not given, so tests
 * that don't care about a specific channel ID still get a complete space.
 */
export function seedSpace(db: Database.Database, options: SeedSpaceOptions): PickupSpace {
  const repo = new PickupSpaceRepository(db);
  const result = repo.create({ guildId: options.guildId, name: options.name ?? `Space ${fakeId()}` });
  if (!result.ok) throw new Error(`seedSpace: a space named "${options.name}" already exists in this test`);
  const space = result.space;

  repo.setField(space.id, 'origin_channel_id', options.originChannelId ?? fakeId());
  repo.setField(space.id, 'signup_channel_id', options.signupChannelId ?? fakeId());
  repo.setField(space.id, 'roster_channel_id', options.rosterChannelId ?? fakeId());
  repo.setField(space.id, 'review_channel_id', options.reviewChannelId ?? fakeId());
  if (options.authorizedRoleIds) repo.setField(space.id, 'authorized_role_ids', options.authorizedRoleIds);
  if (options.signupPingRoleId !== undefined) {
    repo.setField(space.id, 'signup_ping_role_id', options.signupPingRoleId);
  }
  if (options.defaultEligibilityRoleIds) {
    repo.setField(space.id, 'default_eligibility_role_ids', options.defaultEligibilityRoleIds);
  }

  return repo.get(space.id)!;
}

/**
 * The subset of `CreatePickupInput` a space snapshots onto a pickup at
 * creation — spread this into `PickupRepository.create()` alongside the
 * pickup's own fields (guildId, createdBy, format, startAt, roleLimit, ...).
 */
export function spaceSnapshot(space: PickupSpace): {
  pickupSpaceId: number;
  originChannelId: string | null;
  signupChannelId: string;
  rosterChannelId: string;
  reviewChannelId: string;
  signupPingRoleId: string | null;
  organizerPingRoleId: string | null;
} {
  if (!space.signupChannelId || !space.rosterChannelId || !space.reviewChannelId) {
    throw new Error('spaceSnapshot: space is missing a required channel — seed it with seedSpace()');
  }
  return {
    pickupSpaceId: space.id,
    originChannelId: space.originChannelId,
    signupChannelId: space.signupChannelId,
    rosterChannelId: space.rosterChannelId,
    reviewChannelId: space.reviewChannelId,
    signupPingRoleId: space.signupPingRoleId,
    organizerPingRoleId: space.organizerPingRoleId,
  };
}
