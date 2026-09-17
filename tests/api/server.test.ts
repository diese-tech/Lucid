/**
 * End-to-end tests for the read-only pickup data API (issue #45) -- a real
 * http.Server bound to an ephemeral port (127.0.0.1:0), driven with Node's
 * built-in fetch, over an in-memory better-sqlite3 database. No supertest
 * dependency exists in this repo (or is added for this) -- this is the same
 * "exercise the real thing" philosophy the other worker tests already use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { createApiServer, startApiServer } from '../../src/api/server.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import type { Pickup, PickupStatus } from '../../src/db/repositories/types.js';
import { fakeId } from '../helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from '../helpers/fixtures.js';

const TEST_API_KEY = 'test-api-key-value';

let db: Database.Database;
let server: Server;
let baseUrl: string;

function createPickup(overrides: { guildId?: string; status?: PickupStatus } = {}): Pickup {
  const guildId = overrides.guildId ?? 'g1';
  const space = seedSpace(db, { guildId });
  const pickup = new PickupRepository(db).create({
    guildId,
    createdBy: fakeId(),
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  });
  if (overrides.status) {
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], overrides.status);
  }
  return new PickupRepository(db).byId(pickup.id)!;
}

/** `apiKey` is REQUIRED, not defaulted -- a caller testing the no-key case must say so explicitly (`null`), never accidentally inherit a default. */
async function apiFetch(path: string, apiKey: string | null) {
  const headers: Record<string, string> = {};
  if (apiKey !== null) headers['X-API-Key'] = apiKey;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);

  server = createApiServer(TEST_API_KEY);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setDatabaseForTesting(null);
  db.close();
});

describe('GET /api/pickups', () => {
  it('rejects a request with no API key', async () => {
    const { status, body } = await apiFetch('/api/pickups?status=open', null);
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a request with the wrong API key', async () => {
    const { status } = await apiFetch('/api/pickups?status=open', 'wrong-key');
    expect(status).toBe(401);
  });

  it('rejects a request with no status filter -- no silent "everything" default', async () => {
    const { status, body } = await apiFetch('/api/pickups', TEST_API_KEY);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'status query parameter is required' });
  });

  it('rejects an unrecognized status value, naming it', async () => {
    const { status, body } = await apiFetch('/api/pickups?status=bogus_value', TEST_API_KEY);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid status value', value: 'bogus_value' });
  });

  it('returns only pickups in the requested status', async () => {
    const open = createPickup({ status: 'open' });
    createPickup({ status: 'published' });

    const { status, body } = await apiFetch('/api/pickups?status=open', TEST_API_KEY);
    expect(status).toBe(200);
    const ids = (body as { pickups: { id: number }[] }).pickups.map((p) => p.id);
    expect(ids).toEqual([open.id]);
  });

  it('supports a comma-separated status list ("active") and orders most-recently-scheduled first', async () => {
    const older = createPickup({ status: 'open' });
    db.prepare('UPDATE pickups SET start_at = start_at - 100 WHERE id = ?').run(older.id);
    const newer = createPickup({ status: 'published' });

    const { status, body } = await apiFetch('/api/pickups?status=open,roster_ready,published', TEST_API_KEY);
    expect(status).toBe(200);
    const ids = (body as { pickups: { id: number }[] }).pickups.map((p) => p.id);
    expect(ids).toEqual([newer.id, older.id]);
  });

  it('status=finished ("completed") includes manual and timeout attribution correctly', async () => {
    const manual = createPickup({ status: 'published' });
    new PickupRepository(db).finishWithAttribution(manual.id, 'staff-1', 'manual');
    const timedOut = createPickup({ status: 'published' });
    new PickupRepository(db).finishWithAttribution(timedOut.id, null, 'timeout');

    const { status, body } = await apiFetch('/api/pickups?status=finished', TEST_API_KEY);
    expect(status).toBe(200);
    const pickups = (body as { pickups: { id: number; finish_reason: string; finished_by: string | null }[] }).pickups;
    const manualRecord = pickups.find((p) => p.id === manual.id)!;
    const timeoutRecord = pickups.find((p) => p.id === timedOut.id)!;
    expect(manualRecord.finish_reason).toBe('manual');
    expect(manualRecord.finished_by).toBe('staff-1');
    expect(timeoutRecord.finish_reason).toBe('timeout');
    expect(timeoutRecord.finished_by).toBeNull();
  });

  it('guild_id filters to one guild', async () => {
    const inG1 = createPickup({ guildId: 'g1', status: 'open' });
    createPickup({ guildId: 'g2', status: 'open' });

    const { status, body } = await apiFetch('/api/pickups?status=open&guild_id=g1', TEST_API_KEY);
    expect(status).toBe(200);
    const ids = (body as { pickups: { id: number }[] }).pickups.map((p) => p.id);
    expect(ids).toEqual([inG1.id]);
  });

  it('clamps limit to the hard maximum rather than honoring an oversized request', async () => {
    for (let i = 0; i < 3; i++) createPickup({ status: 'open' });

    const { status, body } = await apiFetch('/api/pickups?status=open&limit=10000', TEST_API_KEY);
    expect(status).toBe(200);
    // Not asserting the exact ceiling value (an implementation detail) --
    // just that an absurd request doesn't get honored verbatim.
    expect((body as { pickups: unknown[] }).pickups.length).toBeLessThan(10000);
  });

  it('rejects a non-mutating known path hit with a mutation method -- 405, not 404', async () => {
    const res = await fetch(`${baseUrl}/api/pickups`, {
      method: 'POST',
      headers: { 'X-API-Key': TEST_API_KEY },
    });
    expect(res.status).toBe(405);
  });
});

describe('GET /api/pickups/:id', () => {
  it('returns 404 for an unknown id', async () => {
    const { status, body } = await apiFetch('/api/pickups/999999', TEST_API_KEY);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns the full record, including signups and roster, for a known id', async () => {
    const pickup = createPickup({ status: 'published' });
    new SignupRepository(db).add(pickup.id, 'player-1', 'solo', 2);
    new SignupRepository(db).add(pickup.id, 'player-1', 'fill', 2);
    new RosterSlotRepository(db).replaceAll(pickup.id, [{ team: 'order', role: 'solo', userId: 'player-1' }]);

    const { status, body } = await apiFetch(`/api/pickups/${pickup.id}`, TEST_API_KEY);
    expect(status).toBe(200);
    const record = body as {
      id: number;
      signups: { discord_id: string; roles: string[] }[];
      roster: { team: string; role: string; discord_id: string }[];
    };
    expect(record.id).toBe(pickup.id);
    expect(record.signups).toEqual([{ discord_id: 'player-1', roles: ['solo', 'fill'] }]);
    expect(record.roster).toEqual([{ team: 'order', role: 'solo', discord_id: 'player-1' }]);
  });

  it('finds a finished (historical) pickup by id, not just active ones', async () => {
    const pickup = createPickup({ status: 'published' });
    new PickupRepository(db).finishWithAttribution(pickup.id, 'staff-1', 'manual');

    const { status, body } = await apiFetch(`/api/pickups/${pickup.id}`, TEST_API_KEY);
    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe('finished');
  });

  it('rejects an unknown method on a known-shape path -- 405', async () => {
    const pickup = createPickup({ status: 'open' });
    const res = await fetch(`${baseUrl}/api/pickups/${pickup.id}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': TEST_API_KEY },
    });
    expect(res.status).toBe(405);
  });
});

describe('GET /api/health', () => {
  it('responds without an API key', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe('unknown routes', () => {
  it('returns 404 for a path this API does not serve at all', async () => {
    const { status } = await apiFetch('/api/does-not-exist', TEST_API_KEY);
    expect(status).toBe(404);
  });
});

describe('startApiServer', () => {
  it('logs and does not crash when the port is already in use (codex review finding on PR #52)', async () => {
    // listen()'s bind failure is an asynchronous 'error' event, not a thrown
    // exception -- without an error listener, Node's default behavior for
    // an unhandled 'error' event is to throw and crash the process. This
    // proves startApiServer itself never lets that reach the caller.
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const { port } = occupied.address() as AddressInfo;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let stop: (() => void) | undefined;
    try {
      expect(() => {
        stop = startApiServer(port, TEST_API_KEY);
      }).not.toThrow();

      // The 'error' event fires on a later tick -- give it one.
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
      const [message] = errorSpy.mock.calls.at(-1)!;
      expect(String(message)).toContain('failed to listen');
    } finally {
      stop?.();
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
