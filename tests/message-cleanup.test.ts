/**
 * Unit tests for message-cleanup.ts -- the worker that sweeps stale,
 * already-delivered TRANSIENT notification messages (roster reminders,
 * availability alerts, replacement notices) off Discord once they are past
 * their retention window (issue #37). The persistent staff card and public
 * roster/signup posts are a completely separate surface and are never
 * touched by anything here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';

import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupNotificationRepository } from '../src/db/repositories/pickup-notifications.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import type { PickupNotificationStatus } from '../src/db/repositories/types.js';
import { CLEANUP_STALE_AFTER_MS, processMessageCleanup } from '../src/discord/message-cleanup.js';
import { fakeId, mockClient, mockMessage, mockTextChannel } from './helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';

let db: Database.Database;
let pickupId: number;

function createPickup(): number {
  const guildId = fakeId();
  const space = seedSpace(db, { guildId });
  return new PickupRepository(db).create({
    guildId,
    createdBy: 'staff',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  }).id;
}

/**
 * Build a notification in an arbitrary terminal (or non-terminal) status,
 * with a `sent_at` we control directly -- markSent() itself always stamps
 * the real wall clock, so getting an aged 'sent' row for these tests means
 * setting `sent_at` with a raw UPDATE afterward, same as schema-migrations
 * tests build rows with raw SQL where the repository API has no dial for it.
 */
function createNotification(
  notifications: PickupNotificationRepository,
  options: {
    status: PickupNotificationStatus;
    sentAt: number;
    channelId?: string;
    messageId?: string;
    dedupeKey?: string;
  },
): number {
  const channelId = options.channelId ?? fakeId();
  const { notification } = notifications.schedule({
    pickupId,
    kind: 'roster_reminder',
    dedupeKey: options.dedupeKey ?? fakeId(),
    channelId,
    dueAt: 1000,
  });

  if (options.status === 'attempted') {
    notifications.claimDue(notification.id, options.sentAt, '{}');
  } else if (options.status === 'sent' || options.status === 'cleaned') {
    notifications.claimDue(notification.id, options.sentAt, '{}');
    notifications.markSent(notification.id, options.messageId ?? fakeId());
    if (options.status === 'cleaned') notifications.markCleaned(notification.id);
  } else if (options.status === 'skipped') {
    notifications.skip(notification.id, 'test-reason');
  } else if (options.status === 'uncertain') {
    notifications.claimDue(notification.id, options.sentAt, '{}');
    notifications.markUncertain(notification.id, 'test-error');
  }
  // 'pending' needs no further transition.

  db.prepare('UPDATE pickup_notifications SET sent_at = ? WHERE id = ?').run(options.sentAt, notification.id);
  return notification.id;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  pickupId = createPickup();
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
});

describe('PickupNotificationRepository.dueForCleanup', () => {
  it('finds a sent row whose sent_at is more than the retention window in the past, and excludes one within it', () => {
    const notifications = new PickupNotificationRepository(db);
    const now = Date.now();
    const stale = createNotification(notifications, { status: 'sent', sentAt: now - CLEANUP_STALE_AFTER_MS - 1000 });
    createNotification(notifications, { status: 'sent', sentAt: now - CLEANUP_STALE_AFTER_MS + 60_000 });

    const due = notifications.dueForCleanup(now, CLEANUP_STALE_AFTER_MS, 25);

    expect(due.map((n) => n.id)).toEqual([stale]);
  });

  it('excludes rows in every status other than sent', () => {
    const notifications = new PickupNotificationRepository(db);
    const now = Date.now();
    const longAgo = now - CLEANUP_STALE_AFTER_MS - 1000;

    createNotification(notifications, { status: 'pending', sentAt: longAgo });
    createNotification(notifications, { status: 'attempted', sentAt: longAgo });
    createNotification(notifications, { status: 'skipped', sentAt: longAgo });
    createNotification(notifications, { status: 'uncertain', sentAt: longAgo });
    createNotification(notifications, { status: 'cleaned', sentAt: longAgo });
    const sent = createNotification(notifications, { status: 'sent', sentAt: longAgo });

    const due = notifications.dueForCleanup(now, CLEANUP_STALE_AFTER_MS, 25);

    expect(due.map((n) => n.id)).toEqual([sent]);
  });
});

describe('PickupNotificationRepository.markCleaned', () => {
  it('succeeds exactly once for a sent row, and refuses a second call against the now-cleaned row', () => {
    const notifications = new PickupNotificationRepository(db);
    const id = createNotification(notifications, { status: 'sent', sentAt: Date.now() });

    const first = notifications.markCleaned(id);
    const second = notifications.markCleaned(id);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(notifications.forPickup(pickupId).find((n) => n.id === id)?.status).toBe('cleaned');
  });
});

describe('processMessageCleanup', () => {
  function mockDeletableChannel(options: { id?: string; deleteImpl?: () => Promise<void> } = {}) {
    const channel = mockTextChannel({ id: options.id });
    return {
      ...channel,
      messages: {
        ...channel.messages,
        delete: vi.fn(options.deleteImpl ?? (async () => undefined)),
      },
    };
  }

  it('deletes the Discord message for a due row and marks it cleaned', async () => {
    const notifications = new PickupNotificationRepository(db);
    const channelId = fakeId();
    const messageId = fakeId();
    const id = createNotification(notifications, {
      status: 'sent',
      sentAt: Date.now() - CLEANUP_STALE_AFTER_MS - 1000,
      channelId,
      messageId,
    });
    const channel = mockDeletableChannel({ id: channelId });
    const client = mockClient({ channels: { [channelId]: channel } });

    await processMessageCleanup(client as never);

    expect(channel.messages.delete).toHaveBeenCalledWith(messageId);
    expect(notifications.forPickup(pickupId).find((n) => n.id === id)?.status).toBe('cleaned');
  });

  it('treats an already-gone message as a successful cleanup, without erroring', async () => {
    const notifications = new PickupNotificationRepository(db);
    const channelId = fakeId();
    const messageId = fakeId();
    const id = createNotification(notifications, {
      status: 'sent',
      sentAt: Date.now() - CLEANUP_STALE_AFTER_MS - 1000,
      channelId,
      messageId,
    });
    const channel = mockDeletableChannel({
      id: channelId,
      deleteImpl: async () => {
        throw new DiscordAPIError(
          { message: 'Unknown Message', code: RESTJSONErrorCodes.UnknownMessage },
          RESTJSONErrorCodes.UnknownMessage,
          404,
          'DELETE',
          `/channels/${channelId}/messages/${messageId}`,
          {},
        );
      },
    });
    const client = mockClient({ channels: { [channelId]: channel } });

    await expect(processMessageCleanup(client as never)).resolves.not.toThrow();

    expect(notifications.forPickup(pickupId).find((n) => n.id === id)?.status).toBe('cleaned');
  });

  it('leaves a row as sent when the delete fails for another reason, so it can retry next tick', async () => {
    const notifications = new PickupNotificationRepository(db);
    const channelId = fakeId();
    const messageId = fakeId();
    const id = createNotification(notifications, {
      status: 'sent',
      sentAt: Date.now() - CLEANUP_STALE_AFTER_MS - 1000,
      channelId,
      messageId,
    });
    const channel = mockDeletableChannel({
      id: channelId,
      deleteImpl: async () => {
        throw new Error('simulated permissions failure');
      },
    });
    const client = mockClient({ channels: { [channelId]: channel } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await processMessageCleanup(client as never);

    expect(notifications.forPickup(pickupId).find((n) => n.id === id)?.status).toBe('sent');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('one row failing does not stop a second, independently-due row from still being cleaned in the same call', async () => {
    const notifications = new PickupNotificationRepository(db);
    const now = Date.now();
    const channelIdA = fakeId();
    const channelIdB = fakeId();
    const messageIdA = fakeId();
    const messageIdB = fakeId();
    // Oldest first -- dueForCleanup() processes in that order, so this is the
    // row whose markCleaned() call the spy below fails on the first go.
    const idA = createNotification(notifications, {
      status: 'sent',
      sentAt: now - CLEANUP_STALE_AFTER_MS - 5000,
      channelId: channelIdA,
      messageId: messageIdA,
    });
    const idB = createNotification(notifications, {
      status: 'sent',
      sentAt: now - CLEANUP_STALE_AFTER_MS - 1000,
      channelId: channelIdB,
      messageId: messageIdB,
    });
    const channelA = mockDeletableChannel({ id: channelIdA });
    const channelB = mockDeletableChannel({ id: channelIdB });
    const client = mockClient({ channels: { [channelIdA]: channelA, [channelIdB]: channelB } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const markCleanedSpy = vi.spyOn(PickupNotificationRepository.prototype, 'markCleaned');
    markCleanedSpy.mockImplementationOnce(() => {
      throw new Error('simulated unexpected failure marking row A cleaned');
    });

    await expect(processMessageCleanup(client as never)).resolves.not.toThrow();

    // Row A's delete went out to Discord, but recording that outcome blew
    // up -- it is left exactly where processMessageCleanup's own per-item
    // isolation leaves any other unexpected failure.
    expect(channelA.messages.delete).toHaveBeenCalledWith(messageIdA);
    expect(notifications.forPickup(pickupId).find((n) => n.id === idA)?.status).toBe('sent');
    // Row B is entirely independent and still gets cleaned in the same call.
    expect(channelB.messages.delete).toHaveBeenCalledWith(messageIdB);
    expect(notifications.forPickup(pickupId).find((n) => n.id === idB)?.status).toBe('cleaned');

    markCleanedSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
