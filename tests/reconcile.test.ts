/**
 * Tests for startup recovery -- src/discord/reconcile.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { GuildConfigRepository } from '../src/db/repositories/guild-config.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../src/db/repositories/signups.js';
import type { Pickup } from '../src/db/repositories/types.js';
import { generateRoster } from '../src/domain/roster.js';
import { reconcileOnStartup } from '../src/discord/reconcile.js';
import { reconciliationMarker } from '../src/discord/render.js';
import {
  fakeId,
  mockClient,
  mockMessage,
  mockTextChannel,
} from './helpers/discord-mocks.js';

let db: Database.Database;
let guildId: string;
let signupChannelId: string;
let reviewChannelId: string;
let rosterChannelId: string;

function createPickup(overrides: Partial<{ guildId: string }> = {}): Pickup {
  return new PickupRepository(db).create({
    guildId: overrides.guildId ?? guildId,
    createdBy: fakeId(),
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
  });
}

/** Ten distinct signups -- two per role -- so generateRoster's matching is feasible. */
function fillRoster(pickupId: number): void {
  const signups = new SignupRepository(db);
  for (const role of ['solo', 'jungle', 'mid', 'support', 'carry'] as const) {
    signups.add(pickupId, `${role}-a-${fakeId()}`, role, 2);
    signups.add(pickupId, `${role}-b-${fakeId()}`, role, 2);
  }
  const records = new SignupRepository(db).recordsForPickup(pickupId);
  const generated = generateRoster(records, 'pickup_vs_pickup');
  if (!generated.feasible) throw new Error('test fixture is not actually feasible');
  new RosterSlotRepository(db).replaceAll(pickupId, generated.slots);
}

/** Backdate a pickup's updated_at, since the repository always stamps "now". */
function backdate(pickupId: number, msAgo: number): void {
  db.prepare('UPDATE pickups SET updated_at = ? WHERE id = ?').run(Date.now() - msAgo, pickupId);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  signupChannelId = fakeId();
  reviewChannelId = fakeId();
  rosterChannelId = fakeId();
  new GuildConfigRepository(db).setField(guildId, 'signup_channel_id', signupChannelId);
  new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);
  new GuildConfigRepository(db).setField(guildId, 'roster_channel_id', rosterChannelId);
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('reconcileOnStartup', () => {
  it('recovers a missing review message by finding the already-sent one, without sending a duplicate', async () => {
    const pickup = createPickup(); // open, reviewMessageId still null

    // Simulate: the control card genuinely was posted (it carries the
    // reconciliation marker, same as the real renderControlCard output would),
    // but the write recording its ID never landed.
    const existing = mockMessage({ content: `## Pickup Open\n\n${reconciliationMarker('control', pickup.id)}` });
    const reviewChannel = mockTextChannel({ messages: { [existing.id]: existing } });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewChannel.send).not.toHaveBeenCalled();
    expect(new PickupRepository(db).byId(pickup.id)?.reviewMessageId).toBe(existing.id);
  });

  it('does not mistake a marker-containing message from someone else for its own', async () => {
    // codex review finding on PR #32 (P2): the marker is a plain, visible
    // substring, so anything else that happens to contain it -- another bot,
    // a staff member quoting an old card while troubleshooting -- must not be
    // recorded as Lucid's own message. Recording the wrong ID would make
    // every future edit fail (Lucid doesn't own that message) while the
    // genuinely-missing card never gets posted at all.
    const pickup = createPickup();
    const impostor = mockMessage({
      content: `not actually the card, just quoting it -- ${reconciliationMarker('control', pickup.id)}`,
      authorId: 'someone-else',
    });
    const reviewChannel = mockTextChannel({ messages: { [impostor.id]: impostor } });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewChannel.send).toHaveBeenCalledTimes(1);
    const recorded = new PickupRepository(db).byId(pickup.id)?.reviewMessageId;
    expect(recorded).toBeTruthy();
    expect(recorded).not.toBe(impostor.id);
  });

  it('finds a marker beyond the first page of channel history instead of giving up and reposting', async () => {
    // codex review finding on PR #32 (P1): a single-page search would
    // conclude "never sent" and repost a genuine duplicate -- pinging every
    // player a second time -- if enough unrelated messages landed in the
    // channel after the original send. Build more messages than one search
    // page holds, with the real one buried past the first page.
    const pickup = createPickup();
    const now = Date.now();
    const existing = mockMessage({
      content: `## Pickup Open\n\n${reconciliationMarker('control', pickup.id)}`,
      createdTimestamp: now - 1000 * 150, // older than the 100 filler messages below
    });
    const messages: Record<string, ReturnType<typeof mockMessage>> = { [existing.id]: existing };
    for (let i = 0; i < 120; i += 1) {
      const filler = mockMessage({ content: `chatter ${i}`, createdTimestamp: now - 1000 * i });
      messages[filler.id] = filler;
    }
    const reviewChannel = mockTextChannel({ messages });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewChannel.send).not.toHaveBeenCalled();
    expect(new PickupRepository(db).byId(pickup.id)?.reviewMessageId).toBe(existing.id);
  });

  it('reposts a genuinely missing review message when no existing one is found', async () => {
    const pickup = createPickup();
    const reviewChannel = mockTextChannel(); // empty history -- nothing was ever sent
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewChannel.send).toHaveBeenCalledTimes(1);
    const recorded = new PickupRepository(db).byId(pickup.id)?.reviewMessageId;
    expect(recorded).toBeTruthy();
  });

  it('recovers a missing public roster message for a published pickup by finding the already-sent one', async () => {
    const pickup = createPickup();
    fillRoster(pickup.id);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
    new PickupRepository(db).transitionStatus(pickup.id, 'roster_ready', 'published');
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    // rosterMessageId stays null -- the publish's send succeeded but recording
    // it never happened.

    const existing = mockMessage({ content: `## Pickup Roster\n\n${reconciliationMarker('roster', pickup.id)}` });
    const rosterChannel = mockTextChannel({ messages: { [existing.id]: existing } });
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    const client = mockClient({
      channels: { [reviewChannelId]: reviewChannel, [rosterChannelId]: rosterChannel },
    });

    await reconcileOnStartup(client as never);

    expect(rosterChannel.send).not.toHaveBeenCalled();
    expect(new PickupRepository(db).byId(pickup.id)?.rosterMessageId).toBe(existing.id);
  });

  it('reposts a genuinely missing public roster message for a published pickup, pinging players', async () => {
    const pickup = createPickup();
    fillRoster(pickup.id);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
    new PickupRepository(db).transitionStatus(pickup.id, 'roster_ready', 'published');
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const rosterChannel = mockTextChannel(); // empty history
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    const client = mockClient({
      channels: { [reviewChannelId]: reviewChannel, [rosterChannelId]: rosterChannel },
    });

    await reconcileOnStartup(client as never);

    expect(rosterChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: ['users'] } }),
    );
    expect(new PickupRepository(db).byId(pickup.id)?.rosterMessageId).toBeTruthy();
  });

  it('self-heals a stale review card for a roster_ready pickup whose last edit never landed', async () => {
    const pickup = createPickup();
    fillRoster(pickup.id);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
    // The message still shows the pre-roster control card -- as if the
    // process crashed before evaluateRosterReady's refreshReviewCard call
    // ever landed.
    const staleMessage = mockMessage({ content: '## Pickup Open' });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: staleMessage.id });
    const reviewChannel = mockTextChannel({ messages: { [staleMessage.id]: staleMessage } });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(staleMessage.edit).toHaveBeenCalled();
    const [payload] = staleMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('## Pickup Ready');
  });

  it('re-applies the cancelled form to both messages for a cancelled pickup', async () => {
    const pickup = createPickup();
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'cancelled');
    const signupMessage = mockMessage({ content: '**Pickup games at some time**' }); // still shows "open"
    const reviewMessage = mockMessage({ content: '## Pickup Open' });
    new PickupRepository(db).setMessageIds(pickup.id, {
      signupMessageId: signupMessage.id,
      reviewMessageId: reviewMessage.id,
    });
    const signupChannel = mockTextChannel({ messages: { [signupMessage.id]: signupMessage } });
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    const client = mockClient({
      channels: { [signupChannelId]: signupChannel, [reviewChannelId]: reviewChannel },
    });

    await reconcileOnStartup(client as never);

    expect(signupMessage.edit).toHaveBeenCalled();
    expect(reviewMessage.edit).toHaveBeenCalled();
    const [signupPayload] = signupMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    const [reviewPayload] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(signupPayload.content).toContain('cancelled');
    expect(reviewPayload.content).toContain('## Pickup Cancelled');
  });

  it('recovers an orphaned control card before applying the cancelled form, instead of leaving it looking open forever', async () => {
    // codex review finding on PR #32 (P2): if postControlCard sent
    // successfully but recording reviewMessageId failed, and the pickup was
    // then cancelled before reconciliation ever ran, writeCancelledMessages
    // alone has nothing to edit (it skips a null ID) -- the orphaned card
    // would keep showing "Pickup Open" with live-looking controls forever.
    const pickup = createPickup(); // reviewMessageId still null
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'cancelled');

    const orphan = mockMessage({ content: `## Pickup Open\n\n${reconciliationMarker('control', pickup.id)}` });
    const reviewChannel = mockTextChannel({ messages: { [orphan.id]: orphan } });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewChannel.send).not.toHaveBeenCalled(); // found, not duplicated
    expect(new PickupRepository(db).byId(pickup.id)?.reviewMessageId).toBe(orphan.id);
    expect(orphan.edit).toHaveBeenCalled();
    const [payload] = orphan.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('## Pickup Cancelled');
  });

  it('re-applies the finished form to both messages for a finished pickup', async () => {
    const pickup = createPickup();
    fillRoster(pickup.id);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
    new PickupRepository(db).transitionStatus(pickup.id, 'roster_ready', 'published');
    new PickupRepository(db).transitionStatus(pickup.id, 'published', 'finished');
    const rosterMessage = mockMessage({ content: '## Pickup Roster' }); // still shows live controls
    const reviewMessage = mockMessage({ content: '## Pickup Ready' });
    new PickupRepository(db).setMessageIds(pickup.id, {
      rosterMessageId: rosterMessage.id,
      reviewMessageId: reviewMessage.id,
    });
    const rosterChannel = mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } });
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    const client = mockClient({
      channels: { [rosterChannelId]: rosterChannel, [reviewChannelId]: reviewChannel },
    });

    await reconcileOnStartup(client as never);

    expect(rosterMessage.edit).toHaveBeenCalled();
    expect(reviewMessage.edit).toHaveBeenCalled();
    const [rosterPayload] = rosterMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    const [reviewPayload] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(rosterPayload.content).toContain('finished');
    expect(reviewPayload.content).toContain('finished');
  });

  it('recovers orphaned roster and review messages before applying the finished form', async () => {
    // Same reasoning as the cancelled-orphan test above, extended to cover
    // BOTH messages a finished pickup depends on -- a finished pickup can
    // have either ID still unrecorded if an earlier crash hit `published`
    // and a later one hit `finished` before recovery ever ran for the first.
    const pickup = createPickup();
    fillRoster(pickup.id);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
    new PickupRepository(db).transitionStatus(pickup.id, 'roster_ready', 'published');
    new PickupRepository(db).transitionStatus(pickup.id, 'published', 'finished');
    // Both message IDs stay null -- both sends succeeded but neither got recorded.

    const rosterOrphan = mockMessage({ content: `## Pickup Roster\n\n${reconciliationMarker('roster', pickup.id)}` });
    const reviewOrphan = mockMessage({ content: `## Pickup Open\n\n${reconciliationMarker('control', pickup.id)}` });
    const rosterChannel = mockTextChannel({ messages: { [rosterOrphan.id]: rosterOrphan } });
    const reviewChannel = mockTextChannel({ messages: { [reviewOrphan.id]: reviewOrphan } });
    const client = mockClient({
      channels: { [rosterChannelId]: rosterChannel, [reviewChannelId]: reviewChannel },
    });

    await reconcileOnStartup(client as never);

    expect(rosterChannel.send).not.toHaveBeenCalled();
    expect(reviewChannel.send).not.toHaveBeenCalled();
    const updated = new PickupRepository(db).byId(pickup.id);
    expect(updated?.rosterMessageId).toBe(rosterOrphan.id);
    expect(updated?.reviewMessageId).toBe(reviewOrphan.id);
    expect(rosterOrphan.edit).toHaveBeenCalled();
    expect(reviewOrphan.edit).toHaveBeenCalled();
  });

  it('skips a pickup last touched outside the recovery window', async () => {
    const pickup = createPickup();
    backdate(pickup.id, 8 * 24 * 60 * 60 * 1000); // 8 days ago -- outside the 7-day window
    const reviewChannel = mockTextChannel();
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewChannel.send).not.toHaveBeenCalled();
  });

  it('keeps reconciling the rest after one pickup throws', async () => {
    const broken = createPickup();
    const otherGuildId = fakeId();
    new GuildConfigRepository(db).setField(otherGuildId, 'review_channel_id', reviewChannelId);
    const fine = createPickup({ guildId: otherGuildId });

    // Force a genuine, unexpected throw for `broken`'s guild specifically --
    // not one of the already-handled "channel missing" or "fetch failed"
    // cases inside findOrRepost -- to prove the per-pickup try/catch in
    // reconcileOnStartup's loop actually isolates failures rather than
    // relying on every inner call already being defensive.
    const original = GuildConfigRepository.prototype.get;
    vi.spyOn(GuildConfigRepository.prototype, 'get').mockImplementation(function (
      this: GuildConfigRepository,
      lookupGuildId: string,
    ) {
      if (lookupGuildId === broken.guildId) throw new Error('simulated failure for the broken pickup');
      return original.call(this, lookupGuildId);
    });

    const reviewChannel = mockTextChannel();
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await expect(reconcileOnStartup(client as never)).resolves.toBeUndefined();

    expect(new PickupRepository(db).byId(fine.id)?.reviewMessageId).toBeTruthy();
    expect(new PickupRepository(db).byId(broken.id)?.reviewMessageId).toBeFalsy();
  });
});
