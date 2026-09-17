/**
 * Unit tests for PickupNotificationRepository -- the durable substrate for
 * one-shot player-facing notifications added in issue #36 (T-15 roster
 * reminders, availability alerts, replacement notices). Flow-level coverage
 * (what actually schedules/resolves each kind) lives alongside each flow's
 * own tests and a future notifications.test.ts; this file only locks down
 * the repository's own contract in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { PickupNotificationRepository } from '../src/db/repositories/pickup-notifications.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';
import { fakeId } from './helpers/discord-mocks.js';

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

beforeEach(() => {
  db = openDatabase(':memory:');
  pickupId = createPickup();
});

afterEach(() => db.close());

describe('PickupNotificationRepository', () => {
  it('schedules a new notification as pending', () => {
    const notifications = new PickupNotificationRepository(db);

    const { created, notification } = notifications.schedule({
      pickupId, kind: 'roster_reminder', dedupeKey: `roster_reminder:${pickupId}`, channelId: 'chan-1', dueAt: 1000,
    });

    expect(created).toBe(true);
    expect(notification).toMatchObject({
      pickupId, kind: 'roster_reminder', dedupeKey: `roster_reminder:${pickupId}`,
      channelId: 'chan-1', dueAt: 1000, status: 'pending',
    });
  });

  it('scheduling the same dedupe key twice is a no-op that returns the existing row', () => {
    const notifications = new PickupNotificationRepository(db);
    const key = `roster_reminder:${pickupId}`;
    const first = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: key, channelId: 'chan-1', dueAt: 1000 });

    const second = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: key, channelId: 'chan-2', dueAt: 2000 });

    expect(second.created).toBe(false);
    // The original row wins entirely -- a re-scheduling call cannot silently
    // move the due time or channel of an already-scheduled notification.
    expect(second.notification).toEqual(first.notification);
    expect(notifications.forPickup(pickupId)).toHaveLength(1);
  });

  it('throws rather than silently tracking a notification for a pickup that does not exist', () => {
    const notifications = new PickupNotificationRepository(db);
    expect(() =>
      notifications.schedule({ pickupId: 999999, kind: 'roster_reminder', dedupeKey: 'x', channelId: 'chan-1', dueAt: 1000 }),
    ).toThrow();
  });

  it('due() returns only pending notifications whose due time has arrived, in due order', () => {
    const notifications = new PickupNotificationRepository(db);
    const late = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 2000 }).notification;
    const early = notifications.schedule({ pickupId, kind: 'availability_alert', dedupeKey: 'b', channelId: 'c', dueAt: 1000 }).notification;
    notifications.schedule({ pickupId, kind: 'replacement_notice', dedupeKey: 'c', channelId: 'c', dueAt: 5000 }); // not yet due

    const due = notifications.due(3000);

    expect(due.map((n) => n.id)).toEqual([early.id, late.id]);
  });

  it('claimDue atomically moves a due, pending row to attempted and freezes the payload snapshot', () => {
    const notifications = new PickupNotificationRepository(db);
    const { notification } = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });

    const claimed = notifications.claimDue(notification.id, 1500, '{"content":"reminder"}');

    expect(claimed).toBe(true);
    const [row] = notifications.forPickup(pickupId);
    expect(row).toMatchObject({ status: 'attempted', attemptedAt: 1500, payloadSnapshot: '{"content":"reminder"}' });
  });

  it('claimDue refuses a row that is not yet due', () => {
    const notifications = new PickupNotificationRepository(db);
    const { notification } = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 5000 });

    expect(notifications.claimDue(notification.id, 1000, '{}')).toBe(false);
    expect(notifications.forPickup(pickupId)[0]?.status).toBe('pending');
  });

  it('claimDue is the atomic race guard -- exactly one of two concurrent claims wins', () => {
    const notifications = new PickupNotificationRepository(db);
    const { notification } = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });

    const first = notifications.claimDue(notification.id, 2000, '{}');
    const second = notifications.claimDue(notification.id, 2000, '{}');

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('markSent records the message ID and removes the row from due()', () => {
    const notifications = new PickupNotificationRepository(db);
    const { notification } = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });
    notifications.claimDue(notification.id, 1500, '{}');

    notifications.markSent(notification.id, 'msg-123');

    const [row] = notifications.forPickup(pickupId);
    expect(row).toMatchObject({ status: 'sent', messageId: 'msg-123' });
    expect(notifications.due(9999)).toHaveLength(0);
  });

  it('skip records a durable reason and removes the row from due()', () => {
    const notifications = new PickupNotificationRepository(db);
    const { notification } = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });

    notifications.skip(notification.id, 'cancelled');

    const [row] = notifications.forPickup(pickupId);
    expect(row).toMatchObject({ status: 'skipped', skippedReason: 'cancelled' });
    expect(notifications.due(9999)).toHaveLength(0);
  });

  it('markUncertain is terminal -- never eligible to be claimed again', () => {
    const notifications = new PickupNotificationRepository(db);
    const { notification } = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });
    notifications.claimDue(notification.id, 1500, '{}');

    notifications.markUncertain(notification.id, 'transport-uncertain: timeout');

    const [row] = notifications.forPickup(pickupId);
    expect(row).toMatchObject({ status: 'uncertain', errorContext: 'transport-uncertain: timeout' });
    expect(notifications.due(9999)).toHaveLength(0);
    expect(notifications.claimDue(notification.id, 9999, '{}')).toBe(false);
  });

  it('allUncertain sweeps uncertain notifications across every pickup, for startup recovery', () => {
    const notifications = new PickupNotificationRepository(db);
    const otherPickupId = createPickup();
    const resolved = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 }).notification;
    notifications.claimDue(resolved.id, 1500, '{}');
    notifications.markSent(resolved.id, 'msg-1');
    const stuck = notifications.schedule({ pickupId: otherPickupId, kind: 'roster_reminder', dedupeKey: 'b', channelId: 'c', dueAt: 1000 }).notification;
    notifications.claimDue(stuck.id, 1500, '{}');
    notifications.markUncertain(stuck.id, 'timeout');

    const all = notifications.allUncertain();

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: stuck.id, pickupId: otherPickupId });
  });

  it('keeps every notification scoped to its own pickup', () => {
    const notifications = new PickupNotificationRepository(db);
    const otherPickupId = createPickup();

    notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });
    notifications.schedule({ pickupId: otherPickupId, kind: 'roster_reminder', dedupeKey: 'b', channelId: 'c', dueAt: 1000 });

    expect(notifications.forPickup(pickupId)).toHaveLength(1);
    expect(notifications.forPickup(otherPickupId)).toHaveLength(1);
  });

  it('reconcileStaleAttempts recovers a row stranded in attempted by a crash, so it is not silently lost', () => {
    // codex review finding on PR #49: a process that exits between
    // claimDue() and the matching markSent/skip/markUncertain call leaves
    // the row in 'attempted' forever otherwise -- due() only selects
    // 'pending' (so it can never be claimed again) and allUncertain() only
    // selected 'uncertain' (so it was never surfaced either). Simulate that
    // crash by claiming a row and never resolving it, then confirm the
    // startup reconciliation sweep recovers it into the SAME 'uncertain'
    // reporting path a genuinely ambiguous send outcome uses.
    const notifications = new PickupNotificationRepository(db);
    const { notification } = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });
    notifications.claimDue(notification.id, 1500, '{"content":"reminder"}');

    const reconciled = notifications.reconcileStaleAttempts();

    expect(reconciled).toBe(1);
    const [row] = notifications.forPickup(pickupId);
    expect(row).toMatchObject({ status: 'uncertain', errorContext: expect.stringContaining('restarted') });
    expect(notifications.allUncertain().map((n) => n.id)).toEqual([notification.id]);
    expect(notifications.due(9999)).toHaveLength(0);
  });

  it('reconcileStaleAttempts leaves pending, sent, skipped and already-uncertain rows untouched', () => {
    const notifications = new PickupNotificationRepository(db);
    const pending = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 }).notification;
    const sent = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'b', channelId: 'c', dueAt: 1000 }).notification;
    notifications.claimDue(sent.id, 1500, '{}');
    notifications.markSent(sent.id, 'msg-1');
    const skipped = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'c', channelId: 'c', dueAt: 1000 }).notification;
    notifications.skip(skipped.id, 'cancelled');
    const uncertain = notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'd', channelId: 'c', dueAt: 1000 }).notification;
    notifications.claimDue(uncertain.id, 1500, '{}');
    notifications.markUncertain(uncertain.id, 'transport-uncertain: timeout');

    expect(notifications.reconcileStaleAttempts()).toBe(0);

    const statuses = new Map(notifications.forPickup(pickupId).map((n) => [n.id, n.status]));
    expect(statuses.get(pending.id)).toBe('pending');
    expect(statuses.get(sent.id)).toBe('sent');
    expect(statuses.get(skipped.id)).toBe('skipped');
    expect(statuses.get(uncertain.id)).toBe('uncertain');
    // The pre-existing uncertain row's own error context is never overwritten.
    expect(notifications.forPickup(pickupId).find((n) => n.id === uncertain.id)?.errorContext).toBe(
      'transport-uncertain: timeout',
    );
  });

  it('is deleted along with its pickup (ON DELETE CASCADE)', () => {
    const notifications = new PickupNotificationRepository(db);
    notifications.schedule({ pickupId, kind: 'roster_reminder', dedupeKey: 'a', channelId: 'c', dueAt: 1000 });

    db.prepare('DELETE FROM pickups WHERE id = ?').run(pickupId);

    expect(notifications.forPickup(pickupId)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pickup_notifications').get()).toEqual({ n: 0 });
  });
});
