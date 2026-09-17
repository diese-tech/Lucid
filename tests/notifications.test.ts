/**
 * Tests for the durable notification worker -- src/discord/notifications.ts --
 * and for the T-15 reminder Publish schedules alongside the status transition
 * (issue #36).
 *
 * The scenarios below are the ones issue #36 names by number; the rest cover
 * the delivery contract the repository's own doc comments encode. Everything
 * drives the real exported functions against a real in-memory database --
 * what a reminder SAYS is only ever resolved from live state at delivery
 * time, so a test that stubbed the resolver would be testing nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';

import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupEventRepository } from '../src/db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../src/db/repositories/pickup-notifications.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../src/db/repositories/signups.js';
import type { Pickup, PickupSpace } from '../src/db/repositories/types.js';
import { handleReviewComponent } from '../src/discord/flows/review.js';
import {
  deliverNotification,
  processDueNotifications,
  startNotificationWorker,
} from '../src/discord/notifications.js';
import { generateRoster } from '../src/domain/roster.js';
import {
  fakeId,
  mockClient,
  mockComponentInteraction,
  mockMember,
  mockMessage,
  mockTextChannel,
} from './helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';

let db: Database.Database;
let guildId: string;
let reviewChannelId: string;
let rosterChannelId: string;
let staff: ReturnType<typeof mockMember>;
let space: PickupSpace;
let stopWorker: (() => void) | null = null;

const REMINDER_LEAD_SECONDS = 15 * 60;

function inSeconds(secondsFromNow: number): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

/** A roster_ready pickup with a full ten-player roster, one Publish click away. */
function createRosterReadyPickup(
  options: { startAt?: number; organizerPingRoleId?: string } = {},
): Pickup {
  const pickups = new PickupRepository(db);
  const pickup = pickups.create({
    guildId,
    createdBy: staff.id,
    format: 'pickup_vs_pickup',
    startAt: options.startAt ?? inSeconds(3600),
    roleLimit: 2,
    ...spaceSnapshot(space),
    organizerPingRoleId: options.organizerPingRoleId ?? null,
  });

  const signups = new SignupRepository(db);
  for (const role of ['solo', 'jungle', 'mid', 'support', 'carry'] as const) {
    signups.add(pickup.id, `${role}-a-${fakeId()}`, role, 2);
    signups.add(pickup.id, `${role}-b-${fakeId()}`, role, 2);
  }
  const generated = generateRoster(signups.recordsForPickup(pickup.id), 'pickup_vs_pickup');
  if (!generated.feasible) throw new Error('test fixture is not actually feasible');
  new RosterSlotRepository(db).replaceAll(pickup.id, generated.slots);
  pickups.transitionStatus(pickup.id, 'open', 'roster_ready');
  return pickups.byId(pickup.id)!;
}

function clientFor() {
  const reviewMessage = mockMessage();
  const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
  const rosterChannel = mockTextChannel();
  return {
    reviewMessage,
    reviewChannel,
    rosterChannel,
    client: mockClient({
      channels: { [reviewChannelId]: reviewChannel, [rosterChannelId]: rosterChannel },
    }),
  };
}

/** Click Publish for real, exactly as staff would, and return the published pickup. */
async function publish(pickup: Pickup, client: unknown): Promise<Pickup> {
  const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
  await handleReviewComponent(interaction, {
    action: 'pubc',
    pickupId: pickup.id,
    args: [String(pickup.version)],
  });
  return new PickupRepository(db).byId(pickup.id)!;
}

/** `now` as the worker sees it on the tick this pickup's reminder comes due. */
function reminderDueAt(pickup: Pickup): number {
  return (pickup.startAt - REMINDER_LEAD_SECONDS) * 1000;
}

function reminderFor(pickup: Pickup) {
  return new PickupNotificationRepository(db).byDedupeKey(`roster_reminder:${pickup.id}`)!;
}

function lastSend(channel: ReturnType<typeof mockTextChannel>) {
  const call = channel.send.mock.calls.at(-1);
  if (!call) throw new Error('nothing was sent to this channel');
  return call[0] as {
    content: string;
    allowedMentions: { parse: string[]; users: string[]; roles: string[] };
  };
}

/** A published pickup whose reminder is scheduled and still pending. */
async function publishedWithReminder(options: { startAt?: number } = {}) {
  const harness = clientFor();
  const draft = createRosterReadyPickup(options);
  new PickupRepository(db).setMessageIds(draft.id, { reviewMessageId: harness.reviewMessage.id });
  const pickup = await publish(new PickupRepository(db).byId(draft.id)!, harness.client);
  // Publishing itself posts the public roster through this same channel --
  // clear it so every later assertion is about the notification alone.
  harness.rosterChannel.send.mockClear();
  return { ...harness, pickup };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  reviewChannelId = fakeId();
  rosterChannelId = fakeId();
  const authorizedRoleId = fakeId();
  space = seedSpace(db, {
    guildId,
    authorizedRoleIds: [authorizedRoleId],
    reviewChannelId,
    rosterChannelId,
  });
  staff = mockMember({ roleIds: [authorizedRoleId] });
});

afterEach(() => {
  stopWorker?.();
  stopWorker = null;
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('Publish schedules the T-15 roster reminder', () => {
  it('scheduling is atomic with the publish: exactly one reminder, due fifteen minutes before kickoff', async () => {
    const { pickup } = await publishedWithReminder();

    const scheduled = new PickupNotificationRepository(db).forPickup(pickup.id);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      kind: 'roster_reminder',
      dedupeKey: `roster_reminder:${pickup.id}`,
      channelId: rosterChannelId,
      dueAt: (pickup.startAt - REMINDER_LEAD_SECONDS) * 1000,
      status: 'pending',
    });
  });

  it('records a durable skipped reminder, and sends nothing, when the roster is published after T-15', async () => {
    // Issue #36 scenario 5. A reminder that is already due the moment it is
    // scheduled must not fire -- "starts in 15 minutes" would simply be
    // false -- but the row is still written, so the question "why did nobody
    // get pinged?" has an answer sitting in the database.
    const { pickup, rosterChannel, client } = await publishedWithReminder({ startAt: inSeconds(300) });

    expect(reminderFor(pickup)).toMatchObject({ status: 'skipped', skippedReason: 'published_after_due' });

    await processDueNotifications(client as never, Date.now());
    expect(rosterChannel.send).not.toHaveBeenCalled();
  });
});

describe('roster reminder delivery', () => {
  it('survives a restart: a fresh worker pass over the same database still sends exactly one reminder', async () => {
    // Issue #36 scenario 2. Nothing about the reminder lives in memory -- no
    // setTimeout was ever armed -- so a process that dies between publishing
    // and T-15 loses nothing: the row is still pending, and the next pass any
    // process makes over this database picks it up.
    const { pickup, rosterChannel, client } = await publishedWithReminder();

    await processDueNotifications(client as never, reminderDueAt(pickup));

    expect(rosterChannel.send).toHaveBeenCalledTimes(1);
    expect(reminderFor(pickup)).toMatchObject({ status: 'sent', messageId: expect.any(String) });
  });

  it('pings the roster as it stands at DELIVERY time, not as it stood at publish time', async () => {
    // Issue #36 scenario 3.
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const slots = new RosterSlotRepository(db);
    const seat = slots.forPickup(pickup.id)[0]!;
    const incoming = `incoming-${fakeId()}`;
    slots.setOccupant(seat.id, incoming, true);

    await processDueNotifications(client as never, reminderDueAt(pickup));

    const sent = lastSend(rosterChannel);
    expect(sent.content).toContain(`<@${incoming}>`);
    expect(sent.allowedMentions.users).toContain(incoming);
  });

  it('does not ping a player who was replaced before the reminder went out', async () => {
    // Issue #36 scenario 4 -- the other half of resolving content late.
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const slots = new RosterSlotRepository(db);
    const seat = slots.forPickup(pickup.id)[0]!;
    const replaced = seat.userId;
    slots.setOccupant(seat.id, `incoming-${fakeId()}`, true);

    await processDueNotifications(client as never, reminderDueAt(pickup));

    const sent = lastSend(rosterChannel);
    expect(sent.content).not.toContain(`<@${replaced}>`);
    expect(sent.allowedMentions.users).not.toContain(replaced);
  });

  it('pings only the players on the roster, never by broad mention parsing', async () => {
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const rostered = new RosterSlotRepository(db).userIds(pickup.id);

    await processDueNotifications(client as never, reminderDueAt(pickup));

    // `parse: []` with an explicit allowlist, never `parse: ['users']`: the
    // rendered reminder is the only thing deciding who gets a notification.
    expect(lastSend(rosterChannel).allowedMentions).toEqual({
      parse: [],
      users: rostered,
      roles: [],
    });
  });

  it.each(['cancelled', 'finished'] as const)('skips its reminder for a %s pickup', async (status) => {
    // Issue #36 scenario 6.
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    new PickupRepository(db).transitionStatus(pickup.id, 'published', status);

    await processDueNotifications(client as never, reminderDueAt(pickup));

    expect(rosterChannel.send).not.toHaveBeenCalled();
    expect(reminderFor(pickup)).toMatchObject({ status: 'skipped', skippedReason: `pickup_${status}` });
  });

  it('does not send twice when a later pass revisits an already-delivered reminder', async () => {
    // Issue #36 scenario 7.
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const now = reminderDueAt(pickup);

    await processDueNotifications(client as never, now);
    await processDueNotifications(client as never, now + 60_000);

    expect(rosterChannel.send).toHaveBeenCalledTimes(1);
  });

  it('marks an ambiguous send outcome uncertain and never resends it', async () => {
    // Issue #36 scenario 8. A plain thrown Error is not a definite answer
    // from Discord -- the message may well have landed -- so retrying could
    // duplicate it. See classifyProjectionFailure's own doc comment.
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rosterChannel.send.mockRejectedValueOnce(new Error('connection reset'));
    const now = reminderDueAt(pickup);

    await processDueNotifications(client as never, now);
    await processDueNotifications(client as never, now + 60_000);

    expect(rosterChannel.send).toHaveBeenCalledTimes(1);
    expect(reminderFor(pickup)).toMatchObject({
      status: 'uncertain',
      errorContext: expect.stringContaining('transport-uncertain'),
    });
    // What was about to go out is frozen alongside it, so a human reviewing
    // the row can see exactly what may or may not have been delivered.
    expect(reminderFor(pickup).payloadSnapshot).toContain('starts in 15 minutes');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('retries a confirmed Discord rejection on a later pass', async () => {
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    rosterChannel.send.mockRejectedValueOnce(
      new DiscordAPIError(
        { message: 'Missing Access', code: RESTJSONErrorCodes.MissingAccess },
        RESTJSONErrorCodes.MissingAccess,
        403,
        'POST',
        `/channels/${rosterChannelId}/messages`,
        {},
      ),
    );
    const now = reminderDueAt(pickup);

    await processDueNotifications(client as never, now);
    expect(reminderFor(pickup)).toMatchObject({
      status: 'pending',
      errorContext: `discord-error-${RESTJSONErrorCodes.MissingAccess}`,
    });

    await processDueNotifications(client as never, now + 60_000);
    expect(reminderFor(pickup)).toMatchObject({ status: 'sent' });
    expect(rosterChannel.send).toHaveBeenCalledTimes(2);
  });

  it('stops retrying a rejected reminder once the pickup has already started', async () => {
    // What BOUNDS the retry above: a confirmed rejection goes back on the
    // queue, but a reminder about a pickup that has already begun resolves
    // as a terminal skip instead of retrying against a broken channel
    // forever.
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    rosterChannel.send.mockRejectedValueOnce(
      new DiscordAPIError(
        { message: 'Missing Access', code: RESTJSONErrorCodes.MissingAccess },
        RESTJSONErrorCodes.MissingAccess,
        403,
        'POST',
        `/channels/${rosterChannelId}/messages`,
        {},
      ),
    );
    await processDueNotifications(client as never, reminderDueAt(pickup));

    db.prepare('UPDATE pickups SET start_at = ? WHERE id = ?').run(inSeconds(-60), pickup.id);
    await processDueNotifications(client as never, reminderDueAt(pickup) + 60_000);

    expect(rosterChannel.send).toHaveBeenCalledTimes(1);
    expect(reminderFor(pickup)).toMatchObject({ status: 'skipped', skippedReason: 'too_late' });
  });

  it('sends exactly once when two passes both resolve the same due reminder before either claims it', async () => {
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const now = reminderDueAt(pickup);
    const [due] = new PickupNotificationRepository(db).due(now);

    // Both deliveries hold the same pending row -- the interleaving
    // claimDue's compare-and-set exists for. Only the winner may send.
    await Promise.all([
      deliverNotification(client as never, due!, now),
      deliverNotification(client as never, due!, now),
    ]);

    expect(rosterChannel.send).toHaveBeenCalledTimes(1);
    expect(reminderFor(pickup)).toMatchObject({ status: 'sent' });
  });

  it('keeps delivering the rest of a pass after one notification fails outright', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await publishedWithReminder();
    const second = createRosterReadyPickup();
    new PickupRepository(db).setMessageIds(second.id, { reviewMessageId: first.reviewMessage.id });
    const published = await publish(new PickupRepository(db).byId(second.id)!, first.client);
    first.rosterChannel.send.mockClear();

    // The claim itself blows up for whichever notification the pass reaches
    // first -- outside deliverNotification's own send-failure handling, so
    // only processDueNotifications' per-notification guard can contain it.
    vi.spyOn(PickupNotificationRepository.prototype, 'claimDue').mockImplementationOnce(() => {
      throw new Error('simulated database failure');
    });

    await processDueNotifications(first.client as never, Date.now() + 3_600_000);

    expect(first.rosterChannel.send).toHaveBeenCalledTimes(1);
    expect([reminderFor(first.pickup).status, reminderFor(published).status].sort()).toEqual([
      'pending',
      'sent',
    ]);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('availability alert delivery', () => {
  async function alertFor(organizerPingRoleId?: string) {
    const harness = clientFor();
    const draft = createRosterReadyPickup({ organizerPingRoleId });
    new PickupRepository(db).setMessageIds(draft.id, { reviewMessageId: harness.reviewMessage.id });
    const pickup = await publish(new PickupRepository(db).byId(draft.id)!, harness.client);

    const slots = new RosterSlotRepository(db);
    const seat = slots.forPickup(pickup.id)[0]!;
    slots.markReplacementNeeded(seat.id, seat.userId);
    const { notification } = new PickupNotificationRepository(db).schedule({
      pickupId: pickup.id,
      kind: 'availability_alert',
      dedupeKey: `availability_alert:${pickup.id}:${seat.id}`,
      channelId: reviewChannelId,
      dueAt: Date.now(),
    });
    return { ...harness, pickup, seat, notification };
  }

  it('pings the organizer and the configured organizer role, and nobody else', async () => {
    const organizerPingRoleId = fakeId();
    const { pickup, seat, reviewChannel, client } = await alertFor(organizerPingRoleId);

    await processDueNotifications(client as never, Date.now());

    const sent = lastSend(reviewChannel);
    expect(sent.content).toContain(`<@${seat.userId}>`);
    expect(sent.allowedMentions).toEqual({
      parse: [],
      users: [pickup.createdBy],
      roles: [organizerPingRoleId],
    });
  });

  it('skips an alert whose seat staff have already resolved', async () => {
    const { seat, reviewChannel, client, notification } = await alertFor();
    new RosterSlotRepository(db).clearReplacementNeeded(seat.id);

    await processDueNotifications(client as never, Date.now());

    expect(reviewChannel.send).not.toHaveBeenCalled();
    expect(new PickupNotificationRepository(db).byDedupeKey(notification.dedupeKey)).toMatchObject({
      status: 'skipped',
      skippedReason: 'resolved_availability',
    });
  });
});

describe('replacement notice delivery', () => {
  it('names the incoming and outgoing players from the durable event, not from the seat', async () => {
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const pickups = new PickupRepository(db);
    const slots = new RosterSlotRepository(db);
    const seat = slots.forPickup(pickup.id)[0]!;
    const outgoing = seat.userId;
    const incoming = `incoming-${fakeId()}`;

    // Exactly what Replace Player commits: claim the version, seat the new
    // player, record the event that says who displaced whom.
    pickups.claimVersionIfPublished(pickup.id, pickup.version);
    const version = pickups.byId(pickup.id)!.version;
    slots.setOccupant(seat.id, incoming, true);
    new PickupEventRepository(db).record(pickup.id, staff.id, 'player_replaced', {
      slotId: seat.id,
      previousUserId: outgoing,
      newUserId: incoming,
    });
    new PickupNotificationRepository(db).schedule({
      pickupId: pickup.id,
      kind: 'replacement_notice',
      dedupeKey: `replacement_notice:${pickup.id}:${seat.id}:${version}`,
      channelId: rosterChannelId,
      dueAt: Date.now(),
    });

    await processDueNotifications(client as never, Date.now());

    const sent = lastSend(rosterChannel);
    expect(sent.content).toContain(`<@${incoming}>`);
    // The seat itself no longer remembers the outgoing player at all -- only
    // the event does, which is the whole point of resolving from it.
    expect(sent.content).toContain(`replacing <@${outgoing}>`);
    // The outgoing player is named, deliberately not pinged.
    expect(sent.allowedMentions).toEqual({ parse: [], users: [incoming], roles: [] });
  });

  it('skips a notice whose event cannot be found rather than guessing at the players', async () => {
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const seat = new RosterSlotRepository(db).forPickup(pickup.id)[0]!;
    const dedupeKey = `replacement_notice:${pickup.id}:${seat.id}:${pickup.version + 1}`;
    new PickupNotificationRepository(db).schedule({
      pickupId: pickup.id,
      kind: 'replacement_notice',
      dedupeKey,
      channelId: rosterChannelId,
      dueAt: Date.now(),
    });

    await processDueNotifications(client as never, Date.now());

    expect(rosterChannel.send).not.toHaveBeenCalled();
    expect(new PickupNotificationRepository(db).byDedupeKey(dedupeKey)).toMatchObject({
      status: 'skipped',
      skippedReason: 'replacement_event_missing',
    });
  });
});

describe('startNotificationWorker', () => {
  it('reports a delivery a crash stranded mid-attempt instead of blindly resending it', async () => {
    const { pickup, rosterChannel, client } = await publishedWithReminder();
    const notifications = new PickupNotificationRepository(db);
    // A row claimed for delivery by a process that then died: its send may
    // or may not have landed, so it is exactly the case that must never be
    // silently re-queued.
    notifications.claimDue(reminderFor(pickup).id, reminderDueAt(pickup), '{"content":"..."}');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    stopWorker = startNotificationWorker(client as never, { intervalMs: 60_000 });

    expect(reminderFor(pickup)).toMatchObject({
      status: 'uncertain',
      errorContext: expect.stringContaining('process restarted'),
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('uncertain delivery needs review'));
    expect(rosterChannel.send).not.toHaveBeenCalled();
  });

  it('runs one loop per process and stops cleanly', async () => {
    const { client } = await publishedWithReminder();

    stopWorker = startNotificationWorker(client as never, { intervalMs: 60_000 });
    const second = startNotificationWorker(client as never, { intervalMs: 60_000 });

    // A second loop would be harmless but unstoppable -- its interval handle
    // would be unreachable -- so the running loop's own stopper comes back.
    expect(second).toBe(stopWorker);
  });
});
