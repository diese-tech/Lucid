/**
 * Tests for startup recovery -- src/discord/reconcile.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../src/db/repositories/signups.js';
import type { Pickup, PickupSpace } from '../src/db/repositories/types.js';
import { generateRoster } from '../src/domain/roster.js';
import { reconcileOnStartup } from '../src/discord/reconcile.js';
import { reconciliationMarker } from '../src/discord/render.js';
import {
  fakeId,
  mockClient,
  mockMessage,
  mockTextChannel,
} from './helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';

let db: Database.Database;
let guildId: string;
let signupChannelId: string;
let reviewChannelId: string;
let rosterChannelId: string;
let space: PickupSpace;

function createPickup(overrides: Partial<{ guildId: string; space: PickupSpace }> = {}): Pickup {
  return new PickupRepository(db).create({
    guildId: overrides.guildId ?? guildId,
    createdBy: fakeId(),
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(overrides.space ?? space),
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
  space = seedSpace(db, { guildId, signupChannelId, reviewChannelId, rosterChannelId });
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

  it("completes an `open` pickup's working roster at startup instead of leaving it stuck", async () => {
    // codex review finding on PR #39: the 'open' case used to call
    // refreshControlCard, which only redraws the pre-roster card and never
    // checks completeness. A crash landing after a signup change (or a Seat
    // Player commit) completed the working roster, but before
    // evaluateRosterReady's own completeness check ran, would leave the
    // pickup stuck `open` forever with a full roster already sitting unused
    // in roster_slots -- refreshControlCard alone would just keep redrawing
    // the same "still collecting" card on every future restart.
    const pickup = createPickup();
    fillRoster(pickup.id);
    const reviewMessage = mockMessage({ content: `## Pickup Open\n\n${reconciliationMarker('control', pickup.id)}` });
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    expect(reviewMessage.edit).toHaveBeenCalled();
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

  it('retries the ready notification for a roster_ready pickup whose original attempt never ran', async () => {
    // codex review finding on PR #39 (round 9): a crash (or a rejected
    // refreshReviewCard) landing between the roster_ready transition and the
    // courtesy DM leaves ready_notified_at permanently null. Startup
    // recovery's 'roster_ready' case used to only call refreshReviewCard,
    // with nothing left to ever retry the missed DM.
    const pickup = createPickup();
    fillRoster(pickup.id);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
    expect(new PickupRepository(db).byId(pickup.id)?.readyNotifiedAt).toBeNull();
    const reviewMessage = mockMessage();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    const fetchedUser = { send: vi.fn(async () => undefined) };
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } }) as unknown as {
      users: { fetch: (id: string) => Promise<unknown> };
    };
    client.users.fetch = vi.fn(async () => fetchedUser);

    await reconcileOnStartup(client as never);

    expect(fetchedUser.send).toHaveBeenCalled();
    expect(new PickupRepository(db).byId(pickup.id)?.readyNotifiedAt).not.toBeNull();
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

  it('skips a cancelled pickup last touched outside the recovery window', async () => {
    // 'open' is deliberately exempt from this window -- see the next test --
    // but every terminal status still only gets recovered inside it, exactly
    // as before.
    const pickup = createPickup();
    new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'cancelled');
    backdate(pickup.id, 8 * 24 * 60 * 60 * 1000); // 8 days ago -- outside the 7-day window
    const reviewChannel = mockTextChannel();
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewChannel.send).not.toHaveBeenCalled();
  });

  it('still reconciles an `open` pickup last touched outside the recovery window', async () => {
    // codex review finding on PR #39 (round 10): on the first deployment of
    // working rosters, an `open` pickup that hadn't been touched recently
    // would otherwise never get its staff card upgraded to the new
    // working-roster rendering (Seat Player included) until some future
    // signup reaction happened to trigger it. `open` has no natural endpoint
    // of its own the way every other status does, so it's exempt from the
    // recovery window entirely.
    const pickup = createPickup();
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    // setMessageIds itself bumps updated_at, so it must run BEFORE the
    // backdate below, not after -- otherwise this would silently fail to
    // exercise the "outside the window" case it's named for.
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    backdate(pickup.id, 30 * 24 * 60 * 60 * 1000); // 30 days ago -- well outside the 7-day window
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await reconcileOnStartup(client as never);

    expect(reviewMessage.edit).toHaveBeenCalled();
  });

  it('keeps reconciling the rest after one pickup throws', async () => {
    const broken = createPickup();
    const otherGuildId = fakeId();
    // Same physical review channel as the outer space, so both pickups route
    // to the one mock channel below -- only the failure injection differs.
    const otherSpace = seedSpace(db, { guildId: otherGuildId, reviewChannelId });
    const fine = createPickup({ guildId: otherGuildId, space: otherSpace });

    // Force a genuine, unexpected throw for `broken` specifically -- not one
    // of the already-handled "channel missing" or "fetch failed" cases inside
    // findOrRepost -- to prove the per-pickup try/catch in reconcileOnStartup's
    // loop actually isolates failures rather than relying on every inner call
    // already being defensive. reconcile.ts no longer looks up GuildConfig at
    // all (channels are snapshotted onto the pickup itself -- see #34), so the
    // injection point moves to the write that would record a recovered
    // message ID: ensureReviewMessage still posts the placeholder card
    // (matching a real crash between the send succeeding and the ID being
    // recorded), but recording it throws, so broken's reviewMessageId is left
    // unset exactly like the original failure this test guards against.
    const original = PickupRepository.prototype.setMessageIds;
    vi.spyOn(PickupRepository.prototype, 'setMessageIds').mockImplementation(function (
      this: PickupRepository,
      id: number,
      ids: Parameters<typeof original>[1],
    ) {
      if (id === broken.id) throw new Error('simulated failure for the broken pickup');
      return original.call(this, id, ids);
    });

    const reviewChannel = mockTextChannel();
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } });

    await expect(reconcileOnStartup(client as never)).resolves.toBeUndefined();

    expect(new PickupRepository(db).byId(fine.id)?.reviewMessageId).toBeTruthy();
    expect(new PickupRepository(db).byId(broken.id)?.reviewMessageId).toBeFalsy();
  });
});
