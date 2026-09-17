/**
 * Tests for the automatic T+3h finish worker -- src/discord/auto-finish.ts
 * (issue #37).
 *
 * Drives the real exported functions against a real in-memory database, the
 * same way notifications.test.ts and flows/finish.test.ts do -- "due" here is
 * a computed property of durable pickup state, not a mocked resolver, so a
 * test that stubbed the query would be testing nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import type { Pickup, PickupSpace } from '../src/db/repositories/types.js';
import { processAutoFinishes, startAutoFinishWorker } from '../src/discord/auto-finish.js';
import { fakeId, mockClient, mockMessage, mockTextChannel } from './helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';

let db: Database.Database;
let guildId: string;
let space: PickupSpace;
let stopWorker: (() => void) | null = null;

function inSeconds(secondsFromNow: number): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

/** A pickup, `open` by default, directly forced to whatever status a test needs to set up. */
function createPickup(overrides: { status?: Pickup['status']; startAt?: number } = {}): Pickup {
  const pickup = new PickupRepository(db).create({
    guildId,
    createdBy: 'staff',
    format: 'pickup_vs_pickup',
    startAt: overrides.startAt ?? inSeconds(3600),
    roleLimit: 2,
    ...spaceSnapshot(space),
  });
  // A direct DB-level status force, same shortcut flows/finish.test.ts's own
  // createPickup() uses -- these tests care about the worker's behavior
  // given a status/start_at combination, not about how a pickup legitimately
  // reaches `published`.
  if (overrides.status) {
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], overrides.status);
  }
  return new PickupRepository(db).byId(pickup.id)!;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  space = seedSpace(db, { guildId });
});

afterEach(() => {
  stopWorker?.();
  stopWorker = null;
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('processAutoFinishes', () => {
  it('auto-finishes a published pickup whose scheduled start is well past the 3-hour threshold', async () => {
    const pickup = createPickup({ status: 'published', startAt: inSeconds(-4 * 3600) });
    const client = mockClient();

    await processAutoFinishes(client as never);

    const finished = new PickupRepository(db).byId(pickup.id)!;
    expect(finished.status).toBe('finished');
    expect(finished.finishReason).toBe('timeout');
    expect(finished.finishedByUserId).toBeNull();
    expect(finished.finishedAt).not.toBeNull();
  });

  it('leaves a published pickup untouched while it is still within the 3-hour window', async () => {
    const pickup = createPickup({ status: 'published', startAt: inSeconds(-1 * 3600) });
    const client = mockClient();

    await processAutoFinishes(client as never);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
  });

  it.each(['open', 'roster_ready'] as const)(
    'leaves a pickup that never published (%s) untouched, even with a long-past scheduled start',
    async (status) => {
      const pickup = createPickup({ status, startAt: inSeconds(-4 * 3600) });
      const client = mockClient();

      await processAutoFinishes(client as never);

      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe(status);
    },
  );

  it.each(['finished', 'cancelled'] as const)(
    'leaves an already-%s pickup untouched -- not re-processed',
    async (status) => {
      const pickup = createPickup({ status, startAt: inSeconds(-4 * 3600) });
      const client = mockClient();

      await processAutoFinishes(client as never);

      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe(status);
    },
  );

  it('keeps finishing the rest of a pass after one due pickup fails outright', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Created (and thus given the lower id) first, so it is the first one
    // `publishedPastAutoFinishDeadline`'s id-ordered read reaches -- exactly
    // the call the mocked failure below hits.
    const failing = createPickup({ status: 'published', startAt: inSeconds(-4 * 3600) });
    const succeeding = createPickup({ status: 'published', startAt: inSeconds(-5 * 3600) });
    const client = mockClient();

    vi.spyOn(PickupRepository.prototype, 'finishWithAttribution').mockImplementationOnce(() => {
      throw new Error('simulated database failure');
    });

    await processAutoFinishes(client as never);

    // The failing pickup's transaction rolled back entirely -- it is still
    // published, exactly as if this tick had never touched it.
    expect(new PickupRepository(db).byId(failing.id)?.status).toBe('published');
    // The second, independently-due pickup was not stopped by the first
    // one's failure.
    expect(new PickupRepository(db).byId(succeeding.id)?.status).toBe('finished');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`failed to auto-finish pickup ${failing.id}`),
      expect.anything(),
    );
  });

  it('silently treats a lost claim race (FinishRefusedError) as harmless, not an error', async () => {
    // Simulates exactly what a real race looks like: this tick's read of
    // publishedPastAutoFinishDeadline sees the pickup as still `published`,
    // but by the time finishPickup's own atomic claim runs -- a coordinator
    // manually finishing it, or a second overlapping tick winning first --
    // the row has already moved on. Forced here by mocking the read to
    // return a snapshot that is stale relative to the row a concurrent
    // transitionStatus has since moved out of `published`.
    const pickup = createPickup({ status: 'published', startAt: inSeconds(-4 * 3600) });
    const staleSnapshot = new PickupRepository(db).byId(pickup.id)!;
    vi.spyOn(PickupRepository.prototype, 'publishedPastAutoFinishDeadline').mockReturnValueOnce([staleSnapshot]);
    new PickupRepository(db).transitionStatus(pickup.id, 'published', 'finished');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = mockClient();

    await expect(processAutoFinishes(client as never)).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
    // The row is untouched by this tick -- it lost the race, it did not win
    // one -- but it is still exactly the outcome ('not published') this
    // worker wants.
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
  });

  it('rewrites both public messages exactly like a manual finish, just worded for a timeout', async () => {
    const rosterMessage = mockMessage();
    const reviewMessage = mockMessage();
    const pickup = createPickup({ status: 'published', startAt: inSeconds(-4 * 3600) });
    new PickupRepository(db).setMessageIds(pickup.id, {
      rosterMessageId: rosterMessage.id,
      reviewMessageId: reviewMessage.id,
    });
    const client = mockClient({
      channels: {
        [space.rosterChannelId!]: mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } }),
        [space.reviewChannelId!]: mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } }),
      },
    });

    await processAutoFinishes(client as never);

    const [reviewPayload] = reviewMessage.edit.mock.calls.at(-1)! as [{ embeds: { description: string }[] }];
    expect(reviewPayload.embeds[0]!.description).toContain('Automatically finished');
    expect(reviewPayload.embeds[0]!.description).not.toContain('Finished by');
  });

  it('respects the limit parameter, leaving the rest for a later pass', async () => {
    const first = createPickup({ status: 'published', startAt: inSeconds(-4 * 3600) });
    const second = createPickup({ status: 'published', startAt: inSeconds(-5 * 3600) });
    const client = mockClient();

    await processAutoFinishes(client as never, Date.now(), 3, 1);

    expect(new PickupRepository(db).byId(first.id)?.status).toBe('finished');
    expect(new PickupRepository(db).byId(second.id)?.status).toBe('published');
  });
});

describe('startAutoFinishWorker', () => {
  it('auto-finishes on an initial synchronous tick, before the interval ever fires', async () => {
    const pickup = createPickup({ status: 'published', startAt: inSeconds(-4 * 3600) });
    const client = mockClient();

    stopWorker = startAutoFinishWorker(client as never, { intervalMs: 60_000 });
    // The initial tick is fire-and-forget (`void processAutoFinishes(...)`),
    // so let its microtasks/awaits settle before asserting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
  });

  it('runs one loop per process and stops cleanly -- a second call returns the same stopper', () => {
    const client = mockClient();

    stopWorker = startAutoFinishWorker(client as never, { intervalMs: 60_000 });
    const second = startAutoFinishWorker(client as never, { intervalMs: 60_000 });

    // A second loop would be harmless but unstoppable -- its interval handle
    // would be unreachable -- so the running loop's own stopper comes back.
    expect(second).toBe(stopWorker);
  });
});
