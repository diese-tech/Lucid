/**
 * PickupSpaceRepository -- the per-guild, per-lane configuration introduced
 * by #34 to replace the single guild-wide GuildConfig.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import {
  PickupSpaceRepository,
  isSpaceComplete,
  missingSpaceFields,
} from '../src/db/repositories/pickup-spaces.js';
import type { PickupSpace } from '../src/db/repositories/types.js';

const GUILD_ID = '999000111';
const OTHER_GUILD_ID = '999000222';

let db: Database.Database;
let repo: PickupSpaceRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new PickupSpaceRepository(db);
});

describe('create', () => {
  it('creates a space with an empty authorized-role list and no channels set', () => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.space.guildId).toBe(GUILD_ID);
    expect(result.space.name).toBe('Public Pickups');
    expect(result.space.authorizedRoleIds).toEqual([]);
    expect(result.space.originChannelId).toBeNull();
    expect(result.space.signupChannelId).toBeNull();
    expect(result.space.rosterChannelId).toBeNull();
    expect(result.space.reviewChannelId).toBeNull();
    expect(result.space.signupPingRoleId).toBeNull();
    expect(result.space.defaultEligibilityRoleIds).toEqual([]);
  });

  it('refuses a duplicate name within the same guild', () => {
    repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    expect(result).toEqual({ ok: false, reason: 'duplicate_name' });
  });

  it('allows the same name in two different guilds', () => {
    const first = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    const second = repo.create({ guildId: OTHER_GUILD_ID, name: 'Public Pickups' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

describe('setField', () => {
  let space: PickupSpace;

  beforeEach(() => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    space = result.space;
  });

  it('commits a channel field immediately', () => {
    repo.setField(space.id, 'signup_channel_id', 'chan-1');
    expect(repo.get(space.id)?.signupChannelId).toBe('chan-1');
  });

  it('stores authorized_role_ids as a real array, not a stringified blob on the domain type', () => {
    repo.setField(space.id, 'authorized_role_ids', ['role-a', 'role-b']);
    expect(repo.get(space.id)?.authorizedRoleIds).toEqual(['role-a', 'role-b']);
  });

  it('stores default_eligibility_role_ids as a real array of however many roles are configured', () => {
    repo.setField(space.id, 'default_eligibility_role_ids', ['silver', 'gold']);
    expect(repo.get(space.id)?.defaultEligibilityRoleIds).toEqual(['silver', 'gold']);
  });

  it('renames the space', () => {
    repo.setField(space.id, 'name', 'Restricted Lane');
    expect(repo.get(space.id)?.name).toBe('Restricted Lane');
  });

  it('clears an optional role field back to null', () => {
    repo.setField(space.id, 'signup_ping_role_id', 'ping-role');
    expect(repo.get(space.id)?.signupPingRoleId).toBe('ping-role');
    repo.setField(space.id, 'signup_ping_role_id', null);
    expect(repo.get(space.id)?.signupPingRoleId).toBeNull();
  });
});

describe('list', () => {
  it('returns only the requesting guild\'s spaces, oldest first', () => {
    const a = repo.create({ guildId: GUILD_ID, name: 'A' });
    const b = repo.create({ guildId: GUILD_ID, name: 'B' });
    repo.create({ guildId: OTHER_GUILD_ID, name: 'Other guild space' });
    if (!a.ok || !b.ok) throw new Error('setup failed');

    const spaces = repo.list(GUILD_ID);
    expect(spaces.map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('returns an empty list for a guild with no spaces', () => {
    expect(repo.list(GUILD_ID)).toEqual([]);
  });
});

describe('byName', () => {
  it('finds a space by its exact name within a guild', () => {
    repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    expect(repo.byName(GUILD_ID, 'Public Pickups')?.name).toBe('Public Pickups');
  });

  it('does not find a space by name in a different guild', () => {
    repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    expect(repo.byName(OTHER_GUILD_ID, 'Public Pickups')).toBeNull();
  });

  it('returns null for an unknown name', () => {
    expect(repo.byName(GUILD_ID, 'Nope')).toBeNull();
  });
});

describe('byOriginChannel', () => {
  it('resolves the space whose origin channel matches', () => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    repo.setField(result.space.id, 'origin_channel_id', 'origin-chan');

    expect(repo.byOriginChannel(GUILD_ID, 'origin-chan')?.id).toBe(result.space.id);
  });

  it('returns null when no space claims that channel', () => {
    expect(repo.byOriginChannel(GUILD_ID, 'unclaimed-chan')).toBeNull();
  });

  it('does not resolve an origin channel belonging to a different guild', () => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    repo.setField(result.space.id, 'origin_channel_id', 'origin-chan');

    expect(repo.byOriginChannel(OTHER_GUILD_ID, 'origin-chan')).toBeNull();
  });
});

describe('pickupCount / delete', () => {
  let space: PickupSpace;

  beforeEach(() => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    space = result.space;
    repo.setField(space.id, 'origin_channel_id', 'origin-chan');
    repo.setField(space.id, 'signup_channel_id', 'signup-chan');
    repo.setField(space.id, 'roster_channel_id', 'roster-chan');
    repo.setField(space.id, 'review_channel_id', 'review-chan');
  });

  it('counts zero pickups for a freshly created space', () => {
    expect(repo.pickupCount(space.id)).toBe(0);
  });

  it('deletes a space that has never had a pickup', () => {
    const result = repo.delete(space.id);
    expect(result).toEqual({ ok: true });
    expect(repo.get(space.id)).toBeNull();
  });

  it('refuses to delete a space with pickups on record, however old', () => {
    new PickupRepository(db).create({
      guildId: GUILD_ID,
      createdBy: 'staff',
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      pickupSpaceId: space.id,
      originChannelId: space.originChannelId,
      signupChannelId: space.signupChannelId!,
      rosterChannelId: space.rosterChannelId!,
      reviewChannelId: space.reviewChannelId!,
    });

    expect(repo.pickupCount(space.id)).toBe(1);
    const result = repo.delete(space.id);
    expect(result).toEqual({ ok: false, reason: 'in_use', pickupCount: 1 });
    // Refused, not partially applied.
    expect(repo.get(space.id)).not.toBeNull();
  });
});

describe('missingSpaceFields / isSpaceComplete', () => {
  it('reports everything missing for a null space', () => {
    expect(isSpaceComplete(null)).toBe(false);
    expect(missingSpaceFields(null)).not.toHaveLength(0);
  });

  it('reports every required field missing on a freshly created space', () => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');

    expect(isSpaceComplete(result.space)).toBe(false);
    expect(missingSpaceFields(result.space)).toEqual([
      'origin channel',
      'signup channel',
      'roster channel',
      'staff review channel',
      'authorized staff roles',
    ]);
  });

  it('is complete once all four channels and at least one authorized role are set', () => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    const { id } = result.space;

    repo.setField(id, 'origin_channel_id', 'origin-chan');
    repo.setField(id, 'signup_channel_id', 'signup-chan');
    repo.setField(id, 'roster_channel_id', 'roster-chan');
    repo.setField(id, 'review_channel_id', 'review-chan');
    repo.setField(id, 'authorized_role_ids', ['staff-role']);

    expect(isSpaceComplete(repo.get(id))).toBe(true);
    expect(missingSpaceFields(repo.get(id))).toEqual([]);
  });

  it('does not require the optional ping/eligibility roles for completeness', () => {
    const result = repo.create({ guildId: GUILD_ID, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    const { id } = result.space;

    repo.setField(id, 'origin_channel_id', 'origin-chan');
    repo.setField(id, 'signup_channel_id', 'signup-chan');
    repo.setField(id, 'roster_channel_id', 'roster-chan');
    repo.setField(id, 'review_channel_id', 'review-chan');
    repo.setField(id, 'authorized_role_ids', ['staff-role']);
    // Deliberately left unset: signup_ping_role_id, default_eligibility_role_ids.

    expect(isSpaceComplete(repo.get(id))).toBe(true);
  });
});
