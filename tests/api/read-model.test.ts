/**
 * Unit tests for src/api/read-model.ts's toPickupRecord() -- a pure mapping
 * function, so these never touch a database or an HTTP server.
 */

import { describe, expect, it } from 'vitest';
import { toPickupRecord } from '../../src/api/read-model.js';
import type { Pickup, RosterSlot, Signup } from '../../src/db/repositories/types.js';

function basePickup(overrides: Partial<Pickup> = {}): Pickup {
  return {
    id: 1,
    guildId: 'g1',
    createdBy: 'staff-1',
    format: 'pickup_vs_pickup',
    startAt: 1_700_000_000,
    roleLimit: 2,
    note: null,
    premadeName: null,
    eligibilityRoleIds: [],
    status: 'open',
    signupMessageId: 'sig1',
    reviewMessageId: 'rev1',
    rosterMessageId: null,
    version: 0,
    pickupSpaceId: 1,
    originChannelId: 'origin1',
    signupChannelId: 'signup-chan',
    rosterChannelId: 'roster-chan',
    reviewChannelId: 'review-chan',
    signupPingRoleId: null,
    organizerPingRoleId: null,
    readyNotifiedAt: null,
    finishedAt: null,
    finishedByUserId: null,
    finishReason: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...overrides,
  };
}

function baseSignup(overrides: Partial<Signup> = {}): Signup {
  return { id: 1, pickupId: 1, userId: 'player-1', role: 'solo', createdAt: 1_700_000_000_000, ...overrides };
}

function baseRosterSlot(overrides: Partial<RosterSlot> = {}): RosterSlot {
  return {
    id: 1,
    pickupId: 1,
    team: 'order',
    role: 'solo',
    userId: 'player-1',
    staffAssigned: false,
    replacementNeeded: false,
    replacementRequestedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('toPickupRecord', () => {
  it('carries schema_version and maps every top-level field', () => {
    const record = toPickupRecord(basePickup(), [], []);
    expect(record.schema_version).toBe(1);
    expect(record.id).toBe(1);
    expect(record.guild_id).toBe('g1');
    expect(record.status).toBe('open');
    expect(record.format).toBe('pickup_vs_pickup');
    expect(record.created_by).toBe('staff-1');
  });

  it('converts createdAt/updatedAt (epoch ms) to ISO8601', () => {
    const record = toPickupRecord(basePickup(), [], []);
    expect(record.created_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(record.updated_at).toBe(new Date(1_700_000_001_000).toISOString());
  });

  it('converts scheduled_start_at from startAt (epoch SECONDS, the one exception) to ISO8601', () => {
    const record = toPickupRecord(basePickup({ startAt: 1_700_000_000 }), [], []);
    expect(record.scheduled_start_at).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it('leaves finish fields null before a pickup finishes', () => {
    const record = toPickupRecord(basePickup(), [], []);
    expect(record.finished_at).toBeNull();
    expect(record.finished_by).toBeNull();
    expect(record.finish_reason).toBeNull();
  });

  it('reports a manual finish with its actor and timestamp', () => {
    const pickup = basePickup({
      status: 'finished',
      finishedAt: 1_700_000_050_000,
      finishedByUserId: 'staff-1',
      finishReason: 'manual',
    });
    const record = toPickupRecord(pickup, [], []);
    expect(record.finished_at).toBe(new Date(1_700_000_050_000).toISOString());
    expect(record.finished_by).toBe('staff-1');
    expect(record.finish_reason).toBe('manual');
  });

  it('reports an automatic timeout finish with no actor', () => {
    const pickup = basePickup({
      status: 'finished',
      finishedAt: 1_700_000_050_000,
      finishedByUserId: null,
      finishReason: 'timeout',
    });
    const record = toPickupRecord(pickup, [], []);
    expect(record.finished_by).toBeNull();
    expect(record.finish_reason).toBe('timeout');
  });

  it('computes required_players from format capacity -- 10 for pickup_vs_pickup (5 roles x 2 teams)', () => {
    const record = toPickupRecord(basePickup({ format: 'pickup_vs_pickup' }), [], []);
    expect(record.required_players).toBe(10);
  });

  it('computes required_players for pickup_vs_premade -- 5 (5 roles x 1 team, opponent is not rostered)', () => {
    const record = toPickupRecord(basePickup({ format: 'pickup_vs_premade', premadeName: 'Shadow Fiend' }), [], []);
    expect(record.required_players).toBe(5);
  });

  it('surfaces premade_name for pickup_vs_premade and leaves it null otherwise', () => {
    const withPremade = toPickupRecord(basePickup({ format: 'pickup_vs_premade', premadeName: 'Shadow Fiend' }), [], []);
    expect(withPremade.premade_name).toBe('Shadow Fiend');
    const withoutPremade = toPickupRecord(basePickup({ format: 'pickup_vs_pickup' }), [], []);
    expect(withoutPremade.premade_name).toBeNull();
  });

  it('groups multiple signup rows for the same player into one signups entry with every declared role', () => {
    const signups = [
      baseSignup({ id: 1, userId: 'player-1', role: 'solo' }),
      baseSignup({ id: 2, userId: 'player-1', role: 'fill' }),
      baseSignup({ id: 3, userId: 'player-2', role: 'jungle' }),
    ];
    const record = toPickupRecord(basePickup(), signups, []);
    expect(record.signup_count).toBe(2);
    expect(record.signups).toEqual([
      { discord_id: 'player-1', roles: ['solo', 'fill'] },
      { discord_id: 'player-2', roles: ['jungle'] },
    ]);
  });

  it('signup_count counts unique participants, not signup rows', () => {
    const signups = [
      baseSignup({ id: 1, userId: 'player-1', role: 'solo' }),
      baseSignup({ id: 2, userId: 'player-1', role: 'fill' }),
    ];
    const record = toPickupRecord(basePickup(), signups, []);
    expect(record.signup_count).toBe(1);
    expect(signups.length).toBe(2);
  });

  it('roster is an empty array, not omitted, when no roster slots exist yet', () => {
    const record = toPickupRecord(basePickup({ status: 'open' }), [], []);
    expect(record.roster).toEqual([]);
  });

  it('maps roster slots to team/role/discord_id', () => {
    const slots = [
      baseRosterSlot({ id: 1, team: 'order', role: 'solo', userId: 'player-1' }),
      baseRosterSlot({ id: 2, team: 'chaos', role: 'jungle', userId: 'player-2' }),
    ];
    const record = toPickupRecord(basePickup({ status: 'published' }), [], slots);
    expect(record.roster).toEqual([
      { team: 'order', role: 'solo', discord_id: 'player-1' },
      { team: 'chaos', role: 'jungle', discord_id: 'player-2' },
    ]);
  });

  it('includes every Discord message/channel ID needed to resolve back to Discord', () => {
    const pickup = basePickup({
      signupMessageId: 'sig1',
      rosterMessageId: 'roster1',
      reviewMessageId: 'rev1',
    });
    const record = toPickupRecord(pickup, [], []);
    expect(record.discord).toEqual({
      guild_id: 'g1',
      signup_channel_id: 'signup-chan',
      roster_channel_id: 'roster-chan',
      review_channel_id: 'review-chan',
      signup_message_id: 'sig1',
      roster_message_id: 'roster1',
      review_message_id: 'rev1',
    });
  });
});
