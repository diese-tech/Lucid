/**
 * Signup recording, and the role limit that has to hold under a burst.
 *
 * Discord delivers reaction events fast enough that a player spamming three
 * role emoji produces three handler invocations effectively at once. The role
 * limit is enforced inside a single synchronous better-sqlite3 transaction
 * precisely so those cannot interleave; these tests pin that behaviour down.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase } from '../src/db/index.js';
import { GuildConfigRepository } from '../src/db/repositories/guild-config.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { SignupRepository } from '../src/db/repositories/signups.js';
import type { Pickup } from '../src/db/repositories/types.js';

const GUILD_ID = '999000111';
const PLAYER = '424242';

let db: Database.Database;
let signups: SignupRepository;
let pickup: Pickup;

/** A fresh in-memory database per test, so no test can inherit another's rows. */
function createPickup(roleLimit: number): Pickup {
  return new PickupRepository(db).create({
    guildId: GUILD_ID,
    createdBy: '1',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit,
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  new GuildConfigRepository(db).ensure(GUILD_ID);
  signups = new SignupRepository(db);
  pickup = createPickup(2);
});

describe('SignupRepository.add', () => {
  it('accepts roles up to the pickup limit', () => {
    expect(signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit)).toEqual({ status: 'added' });
    expect(signups.add(pickup.id, PLAYER, 'jungle', pickup.roleLimit)).toEqual({ status: 'added' });

    expect(signups.forPickup(pickup.id)).toHaveLength(2);
  });

  it('counts Fill against the same per-player role limit', () => {
    expect(signups.add(pickup.id, PLAYER, 'fill', pickup.roleLimit)).toEqual({ status: 'added' });
    expect(signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit)).toEqual({ status: 'added' });
    expect(signups.add(pickup.id, PLAYER, 'jungle', pickup.roleLimit)).toEqual({
      status: 'over_limit', limit: 2,
    });
  });

  it('refuses the role that would go over the limit', () => {
    signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit);
    signups.add(pickup.id, PLAYER, 'jungle', pickup.roleLimit);

    expect(signups.add(pickup.id, PLAYER, 'mid', pickup.roleLimit)).toEqual({
      status: 'over_limit',
      limit: 2,
    });
    expect(signups.forPickup(pickup.id)).toHaveLength(2);
  });

  it('treats a repeat of the same role as a duplicate, not a second signup', () => {
    expect(signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit)).toEqual({ status: 'added' });
    // A double-delivered reaction event looks exactly like this.
    expect(signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit)).toEqual({
      status: 'duplicate',
    });

    expect(signups.forPickup(pickup.id)).toHaveLength(1);
  });

  it('counts the limit per player, not per pickup', () => {
    signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit);
    signups.add(pickup.id, PLAYER, 'jungle', pickup.roleLimit);
    expect(signups.add(pickup.id, 'someone-else', 'mid', pickup.roleLimit)).toEqual({
      status: 'added',
    });
  });

  it('holds the limit when calls arrive back to back with nothing awaited between them', () => {
    // No `await` anywhere in this sequence — this is the shape of the burst that
    // would break a "count, then await, then insert" implementation. Because the
    // count and the insert share one synchronous transaction, nothing can
    // observe the pre-insert count and slip a third row in.
    const outcomes = [
      signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit),
      signups.add(pickup.id, PLAYER, 'jungle', pickup.roleLimit),
      signups.add(pickup.id, PLAYER, 'mid', pickup.roleLimit),
      signups.add(pickup.id, PLAYER, 'support', pickup.roleLimit),
    ];

    expect(outcomes.filter((outcome) => outcome.status === 'added')).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.status === 'over_limit')).toHaveLength(2);

    const stored = signups.forPickup(pickup.id).filter((row) => row.userId === PLAYER);
    expect(stored).toHaveLength(pickup.roleLimit);
  });

  it('holds a limit of one the same way', () => {
    const single = createPickup(1);

    const outcomes = [
      signups.add(single.id, PLAYER, 'solo', single.roleLimit),
      signups.add(single.id, PLAYER, 'carry', single.roleLimit),
    ];

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['added', 'over_limit']);
    expect(signups.forPickup(single.id)).toHaveLength(1);
  });
});

describe('SignupRepository queries', () => {
  it('frees a role again after the reaction is removed', () => {
    signups.add(pickup.id, PLAYER, 'solo', pickup.roleLimit);
    signups.add(pickup.id, PLAYER, 'jungle', pickup.roleLimit);
    expect(signups.add(pickup.id, PLAYER, 'mid', pickup.roleLimit).status).toBe('over_limit');

    signups.remove(pickup.id, PLAYER, 'solo');

    expect(signups.hasSignedUpFor(pickup.id, PLAYER, 'solo')).toBe(false);
    expect(signups.add(pickup.id, PLAYER, 'mid', pickup.roleLimit)).toEqual({ status: 'added' });
  });

  it('lists the bench for a role in signup order', () => {
    signups.add(pickup.id, 'first', 'support', pickup.roleLimit);
    signups.add(pickup.id, 'second', 'support', pickup.roleLimit);
    signups.add(pickup.id, 'other', 'carry', pickup.roleLimit);

    // Two reactions can land inside the same millisecond, which would leave the
    // ordering here to chance. Spread them out so the assertion is about the
    // repository's ORDER BY and nothing else.
    db.prepare('UPDATE signups SET created_at = ? WHERE user_id = ?').run(2_000, 'first');
    db.prepare('UPDATE signups SET created_at = ? WHERE user_id = ?').run(3_000, 'second');

    // Bench order matters: replacement offers the earliest signup first.
    expect(signups.usersForRole(pickup.id, 'support')).toEqual(['first', 'second']);
  });

  it('lists explicit candidates before Fill candidates for a roster role', () => {
    signups.add(pickup.id, 'fill-first', 'fill', pickup.roleLimit);
    signups.add(pickup.id, 'explicit-later', 'support', pickup.roleLimit);
    db.prepare('UPDATE signups SET created_at = ? WHERE user_id = ?').run(1_000, 'fill-first');
    db.prepare('UPDATE signups SET created_at = ? WHERE user_id = ?').run(2_000, 'explicit-later');

    expect(signups.usersForRole(pickup.id, 'support')).toEqual(['explicit-later', 'fill-first']);
    expect(signups.hasSignedUpFor(pickup.id, 'fill-first', 'support')).toBe(true);
  });
});
