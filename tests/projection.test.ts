/**
 * Unit tests for src/discord/projection.ts -- the durable delivery-attempt
 * wrapper added in issue #35's later phase.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupProjectionRepository } from '../src/db/repositories/pickup-projections.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { classifyProjectionFailure, projectSurface } from '../src/discord/projection.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';
import { fakeId } from './helpers/discord-mocks.js';

let db: Database.Database;
let pickupId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  const guildId = fakeId();
  const space = seedSpace(db, { guildId });
  pickupId = new PickupRepository(db).create({
    guildId,
    createdBy: 'staff',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  }).id;
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
});

function discordError(code: number = RESTJSONErrorCodes.UnknownMessage): DiscordAPIError {
  return new DiscordAPIError({ message: 'boom', code }, code, 404, 'PATCH', '/channels/1/messages/1', {});
}

describe('classifyProjectionFailure', () => {
  it('treats a DiscordAPIError as a confirmed, safely-retryable rejection', () => {
    expect(classifyProjectionFailure(discordError())).toEqual({
      status: 'pending',
      note: `discord-error-${RESTJSONErrorCodes.UnknownMessage}`,
    });
  });

  it('treats a plain Error (a timeout, a dropped connection) as genuinely uncertain', () => {
    const result = classifyProjectionFailure(new Error('socket hang up'));
    expect(result.status).toBe('uncertain');
    expect(result.note).toContain('socket hang up');
  });

  it('treats a non-Error thrown value as uncertain too', () => {
    expect(classifyProjectionFailure('a string was thrown').status).toBe('uncertain');
  });
});

describe('projectSurface', () => {
  it('marks the attempt applied on success and never rethrows', async () => {
    const edit = vi.fn(async () => undefined);

    const status = await projectSurface({ pickupId, surface: 'roster', messageId: 'msg-1', edit });

    expect(status).toBe('applied');
    expect(new PickupProjectionRepository(db).unresolvedForPickup(pickupId)).toHaveLength(0);
  });

  it('marks a confirmed Discord rejection pending, without rethrowing', async () => {
    const edit = vi.fn(async () => {
      throw discordError();
    });

    const status = await projectSurface({ pickupId, surface: 'roster', messageId: 'msg-1', edit });

    expect(status).toBe('pending');
    const [row] = new PickupProjectionRepository(db).unresolvedForPickup(pickupId);
    expect(row).toMatchObject({ status: 'pending', surface: 'roster', messageId: 'msg-1' });
  });

  it('marks a genuinely uncertain failure uncertain, without rethrowing, and logs it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const edit = vi.fn(async () => {
      throw new Error('request timed out');
    });

    const status = await projectSurface({ pickupId, surface: 'review', messageId: 'msg-2', edit });

    expect(status).toBe('uncertain');
    expect(errorSpy).toHaveBeenCalled();
    const [row] = new PickupProjectionRepository(db).unresolvedForPickup(pickupId);
    expect(row).toMatchObject({ status: 'uncertain', surface: 'review' });
    errorSpy.mockRestore();
  });

  it('begins tracking BEFORE attempting the edit, so a crash mid-edit still leaves a durable record', async () => {
    let sawPendingRowDuringEdit: string | undefined;
    const edit = vi.fn(async () => {
      sawPendingRowDuringEdit = new PickupProjectionRepository(db).unresolvedForPickup(pickupId)[0]?.status;
    });

    await projectSurface({ pickupId, surface: 'roster', messageId: 'msg-1', edit });

    expect(sawPendingRowDuringEdit).toBe('pending');
  });
});
