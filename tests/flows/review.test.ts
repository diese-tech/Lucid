/**
 * Flow tests for the staff review card -- src/discord/flows/review.ts.
 *
 * The largest, most consequential flow file in Lucid: the one place with real
 * algorithmic content (roster matching), the version-claiming concurrency
 * guards that protect every mutation, and Publish -- the least reversible
 * action in the whole bot. Shuffle's outcome branches (infeasible / no
 * alternative / success) are driven by generateDifferentRoster, which shuffles
 * internally -- rather than fight that randomness with oversized signup pools,
 * those three tests spy on domain/roster.js directly, so the outcome is exact
 * and the test is about review.ts's own branching, not the matching algorithm
 * (already covered by tests/roster.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { GuildConfigRepository } from '../../src/db/repositories/guild-config.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import type { Pickup } from '../../src/db/repositories/types.js';
import { UNAUTHORIZED_MESSAGE } from '../../src/discord/permissions.js';
import { renderReviewCard } from '../../src/discord/render.js';
import * as rosterModule from '../../src/domain/roster.js';
import { evaluateRosterReady, handleReviewComponent, refreshReviewCard } from '../../src/discord/flows/review.js';
import {
  fakeId,
  mockClient,
  mockComponentInteraction,
  mockGuild,
  mockMember,
  mockMessage,
  mockTextChannel,
} from '../helpers/discord-mocks.js';

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let staff: ReturnType<typeof mockMember>;
let reviewChannelId: string;
let rosterChannelId: string;

function createOpenPickup(): Pickup {
  return new PickupRepository(db).create({
    guildId,
    createdBy: staff.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
  });
}

/** Ten distinct signups -- two per role, one player each -- so generateRoster's
 * deterministic (non-shuffle) matching has exactly one way to fill every slot. */
function signUpEnoughForPickupVsPickup(pickupId: number): void {
  const signups = new SignupRepository(db);
  for (const role of ['solo', 'jungle', 'mid', 'support', 'carry'] as const) {
    signups.add(pickupId, `${role}-a-${fakeId()}`, role, 2);
    signups.add(pickupId, `${role}-b-${fakeId()}`, role, 2);
  }
}

function createRosterReadyPickup(): Pickup {
  const pickup = createOpenPickup();
  signUpEnoughForPickupVsPickup(pickup.id);
  new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
  const slots = new RosterSlotRepository(db);
  const records = new SignupRepository(db).recordsForPickup(pickup.id);
  const result = rosterModule.generateRoster(records, 'pickup_vs_pickup');
  if (!result.feasible) throw new Error('test fixture is not actually feasible -- fix signUpEnoughForPickupVsPickup');
  slots.replaceAll(pickup.id, result.slots);
  return new PickupRepository(db).byId(pickup.id)!;
}

function clientFor(reviewMessage = mockMessage(), rosterChannel = mockTextChannel()) {
  const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
  return {
    client: mockClient({ channels: { [reviewChannelId]: reviewChannel, [rosterChannelId]: rosterChannel } }),
    reviewMessage,
    reviewChannel,
    rosterChannel,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  authorizedRoleId = fakeId();
  reviewChannelId = fakeId();
  rosterChannelId = fakeId();
  new GuildConfigRepository(db).setField(guildId, 'authorized_role_ids', [authorizedRoleId]);
  new GuildConfigRepository(db).setField(guildId, 'review_channel_id', reviewChannelId);
  new GuildConfigRepository(db).setField(guildId, 'roster_channel_id', rosterChannelId);
  staff = mockMember({ roleIds: [authorizedRoleId] });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('evaluateRosterReady', () => {
  it('does nothing for a pickup that no longer exists', async () => {
    await expect(evaluateRosterReady(mockClient() as never, 999999)).resolves.toBeUndefined();
  });

  it('leaves a published pickup alone', async () => {
    const pickup = createRosterReadyPickup();
    new PickupRepository(db).transitionStatus(pickup.id, 'roster_ready', 'published');
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    await evaluateRosterReady(client as never, pickup.id);
    expect(reviewMessage.edit).not.toHaveBeenCalled();
  });

  it('redraws the review card for a roster_ready pickup without regenerating the draft', async () => {
    const pickup = createRosterReadyPickup();
    const before = new RosterSlotRepository(db).forPickup(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    await evaluateRosterReady(client as never, pickup.id);

    expect(reviewMessage.edit).toHaveBeenCalled();
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toEqual(before);
  });

  it('shows readiness telemetry, not a raw count, while the pool cannot yet fill every slot', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'someone', 'solo', 2); // nowhere near enough
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    await evaluateRosterReady(client as never, pickup.id);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');
    const [payload] = reviewMessage.edit.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('1/10 eligible players');
    expect(payload.content).toContain('Solo 1/2');
    expect(payload.content).toContain('Waiting on:');
  });

  it('resolves eligibility once and reuses it for both the feasibility check and the card, not twice independently', async () => {
    // codex review finding on PR #31 (thirteenth pass): evaluateRosterReady
    // used to resolve eligibility once for generateRoster and again,
    // independently, inside refreshControlCard for the rendered card. Two
    // separate lookups are two separate snapshots of Discord state -- a role
    // change landing between them could make the feasibility decision and
    // the rendered card disagree. There must be exactly one bulk member
    // lookup per evaluation now.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    new SignupRepository(db).add(pickup.id, 'someone', 'solo', 2); // nowhere near enough
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const guild = mockGuild({ id: guildId, members: [mockMember({ id: 'someone', roleIds: [eligibilityRoleId] })] });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } });

    await evaluateRosterReady(client as never, pickup.id);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');
    expect(guild.members.fetch).toHaveBeenCalledTimes(1);
    expect(reviewMessage.edit).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite the staff card with a stale "open" reading if the pickup was cancelled while eligibility was resolving', async () => {
    // codex review finding on PR #31 (fourteenth pass): writeControlCard had
    // no status re-check of its own, so a cancellation landing during
    // eligibilityContext's guild/role/member fetches (or fetchStaffMessage's
    // own fetch) would still get overwritten with a "Pickup Open" card and a
    // live Cancel button, even though the database already says cancelled.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    new SignupRepository(db).add(pickup.id, 'someone', 'solo', 2);
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const guild = mockGuild({ id: guildId, members: [mockMember({ id: 'someone', roleIds: [eligibilityRoleId] })] });
    guild.members.fetch = vi.fn(async () => {
      new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'cancelled');
      return new Map([['someone', mockMember({ id: 'someone', roleIds: [eligibilityRoleId] })]]);
    }) as typeof guild.members.fetch;
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } });

    await evaluateRosterReady(client as never, pickup.id);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('cancelled');
    expect(reviewMessage.edit).not.toHaveBeenCalled();
  });

  it('lets a newer evaluation win even if its lookup finishes before an older one that started earlier', async () => {
    // codex review finding on PR #31 (fifteenth pass): two reactions on the
    // same restricted, still-infeasible pickup each start an evaluation with
    // its own eligibility lookup (a real network round-trip) -- those can
    // resolve in EITHER order. Without a ticket, whichever finishes LAST
    // wins even if it started FIRST and is now working from a smaller, older
    // signup snapshot than the newer evaluation already wrote.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const guild = mockGuild({
      id: guildId,
      members: [
        mockMember({ id: 'alice', roleIds: [eligibilityRoleId] }),
        mockMember({ id: 'bob', roleIds: [eligibilityRoleId] }),
      ],
    });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } }) as {
      guilds: { fetch: (id: string) => Promise<unknown> };
    };

    // Gate the very first await each evaluation hits (client.guilds.fetch)
    // so the test controls exactly when each one's lookup resolves, rather
    // than relying on incidental microtask ordering.
    const gates: Array<() => void> = [];
    const realGuildsFetch = client.guilds.fetch;
    client.guilds.fetch = vi.fn(async (id: string) => {
      const index = gates.length;
      await new Promise<void>((resolve) => {
        gates[index] = resolve;
      });
      return realGuildsFetch(id);
    });

    // Reaction 1 (alice already signed up above) starts an evaluation --
    // its lookup is now pending at gates[0].
    const firstEvaluation = evaluateRosterReady(client as never, pickup.id);
    // Reaction 2 (bob) lands next, synchronously adding his signup before
    // his own evaluation starts -- its lookup is pending at gates[1].
    new SignupRepository(db).add(pickup.id, 'bob', 'solo', 2);
    const secondEvaluation = evaluateRosterReady(client as never, pickup.id);

    // The NEWER evaluation (bob's) resolves and writes first...
    gates[1]!();
    await secondEvaluation;
    // ...then the OLDER, now-superseded evaluation (alice's) catches up.
    gates[0]!();
    await firstEvaluation;

    // The older evaluation must not have overwritten the newer one's write
    // with its smaller, stale snapshot.
    const [payload] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('2/10 eligible players');
  });

  it('does not freeze a roster_ready draft from a stale "feasible" snapshot once a newer evaluation has already seen the pool shrink', async () => {
    // codex review finding on PR #31 (sixteenth pass): the fifteenth pass's
    // ticket guard only protected writeControlCard's INFEASIBLE branch. The
    // FEASIBLE branch -- the one that calls transitionStatus and freezes a
    // roster_ready draft -- had no ticket check at all, so a stale evaluation
    // that saw a since-completed pool as feasible could still freeze it after
    // a newer evaluation already observed the completing player withdraw.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    const signups = new SignupRepository(db);
    const soloA = `solo-a-${fakeId()}`;
    const soloB = `solo-b-${fakeId()}`;
    const userIds = [soloA, soloB];
    signups.add(pickup.id, soloA, 'solo', 2); // solo is one short -- 9/10 overall
    for (const role of ['jungle', 'mid', 'support', 'carry'] as const) {
      const a = `${role}-a-${fakeId()}`;
      const b = `${role}-b-${fakeId()}`;
      userIds.push(a, b);
      signups.add(pickup.id, a, role, 2);
      signups.add(pickup.id, b, role, 2);
    }
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const guild = mockGuild({
      id: guildId,
      members: userIds.map((id) => mockMember({ id, roleIds: [eligibilityRoleId] })),
    });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } }) as {
      guilds: { fetch: (id: string) => Promise<unknown> };
    };

    const gates: Array<() => void> = [];
    const realGuildsFetch = client.guilds.fetch;
    client.guilds.fetch = vi.fn(async (id: string) => {
      const index = gates.length;
      await new Promise<void>((resolve) => {
        gates[index] = resolve;
      });
      return realGuildsFetch(id);
    });

    // soloB signs up, completing the pool -- starts the OLDER evaluation
    // (ticket 1) on a feasible 10/10 snapshot, its lookup pending at gates[0].
    signups.add(pickup.id, soloB, 'solo', 2);
    const staleEvaluation = evaluateRosterReady(client as never, pickup.id);

    // soloB immediately withdraws again, before ticket 1's lookup resolves --
    // starts the NEWER evaluation (ticket 2) on the now-9/10, infeasible pool,
    // its lookup pending at gates[1].
    signups.remove(pickup.id, soloB, 'solo');
    const freshEvaluation = evaluateRosterReady(client as never, pickup.id);

    // The newer, correct evaluation resolves first and correctly finds the
    // pool not yet feasible -- it must not transition anything.
    gates[1]!();
    await freshEvaluation;
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');

    // The older, now-stale evaluation resolves after. Its "feasible"
    // conclusion was computed from a snapshot that still included soloB, who
    // isn't even signed up any more -- it must not be allowed to freeze a
    // roster_ready draft on top of the newer evaluation's correct read.
    gates[0]!();
    await staleEvaluation;

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('does not let a slow refreshReviewCard overwrite a newer, already-committed roster with stale occupants', async () => {
    // codex review finding on PR #31 (posted the same round as the sixteenth
    // pass, on refreshReviewCard specifically): slots/withdrawn/version are
    // all read up front, then two real network awaits happen before the
    // edit -- another call to refreshReviewCard can fully complete in that
    // gap (e.g. staff committing an Edit Roster swap and its own, faster
    // refresh), and this call's delayed edit would then silently revert the
    // card to the occupants it read before either of them changed.
    const pickup = createRosterReadyPickup();
    const before = new RosterSlotRepository(db).forPickup(pickup.id);
    const [slotA, slotB] = before;
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel } }) as {
      channels: { fetch: (id: string) => Promise<unknown> };
    };

    // Gate the first await refreshReviewCard hits once there's no eligibility
    // role to check (fetchStaffMessage's client.channels.fetch), same pattern
    // as the fifteenth/sixteenth-pass tests.
    const gates: Array<() => void> = [];
    const realChannelsFetch = client.channels.fetch;
    client.channels.fetch = vi.fn(async (id: string) => {
      const index = gates.length;
      await new Promise<void>((resolve) => {
        gates[index] = resolve;
      });
      return realChannelsFetch(id);
    });

    // An older refresh starts (some unrelated reaction event) -- its
    // channels.fetch is pending at gates[0]. One microtask tick is needed
    // before the gate exists: refreshReviewCard's own `await
    // ineligibleRosterUserIds(...)` (immediately resolved -- there's no
    // eligibility role here) suspends it once before it ever reaches
    // fetchStaffMessage's client.channels.fetch.
    const staleRefresh = refreshReviewCard(client as never, pickup.id);
    await Promise.resolve();

    // While it's stuck, staff commits an Edit Roster swap directly (what
    // handlePickTarget's swap branch does) and a newer refresh starts for
    // it -- its channels.fetch is pending at gates[1], same one-tick delay.
    new RosterSlotRepository(db).swapOccupants(slotA!.id, slotB!.id, true);
    const freshRefresh = refreshReviewCard(client as never, pickup.id);
    await Promise.resolve();

    // The newer, correct refresh resolves first and shows the swap.
    gates[1]!();
    await freshRefresh;

    // The older, now-stale refresh resolves after -- it must not overwrite
    // the card with the pre-swap occupants it originally read.
    gates[0]!();
    await staleRefresh;

    const after = new RosterSlotRepository(db).forPickup(pickup.id);
    const pickupAfter = new PickupRepository(db).byId(pickup.id)!;
    const [payload] = reviewMessage.edit.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toBe(
      renderReviewCard(pickupAfter, after, { withdrawnUserIds: new Set(), ineligibleUserIds: new Set() }),
    );
  });

  it('shows the flex-overlap message, not a shortage, when raw role counts look sufficient but matching still fails', async () => {
    const pickup = createOpenPickup();
    const signups = new SignupRepository(db);
    // Solo + Jungle need 4 seats between them but only 3 people qualify for
    // either; Mid/Support/Carry are filled cleanly. See tests/readiness.test.ts
    // for the full worked example this mirrors.
    for (const id of ['alice', 'bob', 'carol']) {
      signups.add(pickup.id, id, 'solo', 2);
      signups.add(pickup.id, id, 'jungle', 2);
    }
    for (const role of ['mid', 'support', 'carry'] as const) {
      signups.add(pickup.id, `${role}-a`, role, 2);
      signups.add(pickup.id, `${role}-b`, role, 2);
    }
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    await evaluateRosterReady(client as never, pickup.id);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');
    const [payload] = reviewMessage.edit.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('Roster not yet feasible');
    expect(payload.content).toContain('Role overlap prevents 10 unique assignments.');
    expect(payload.content).not.toContain('Waiting on:');
  });

  it("tells staff the eligibility role is broken, instead of showing readiness, when it no longer exists", async () => {
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    new SignupRepository(db).add(pickup.id, 'someone', 'solo', 2);
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const guildWithoutTheRole = mockGuild({ id: guildId, members: [], existingRoleIds: [] });
    const client = mockClient({
      channels: { [reviewChannelId]: reviewChannel },
      guilds: { [guildId]: guildWithoutTheRole },
    });

    await evaluateRosterReady(client as never, pickup.id);

    const [payload] = reviewMessage.edit.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('eligibility role no longer exists');
    expect(payload.content).not.toContain('Readiness');
  });

  it("tells staff a lookup temporarily failed, not that nobody is eligible, when membership can't be checked", async () => {
    // codex review finding on PR #31 (eighth pass): resolveEligibleUserIds
    // swallows its own fetch failure into an empty Set, which previously
    // rendered identically to "genuinely 0 eligible players" -- staff must
    // see this is a transient error, not their signup pool actually being empty.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    new SignupRepository(db).add(pickup.id, 'someone', 'solo', 2);
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    // The role itself is readable (existingRoleIds includes it) -- only the
    // member lookup fails.
    const guild = mockGuild({ id: guildId, members: [], existingRoleIds: [eligibilityRoleId] });
    guild.members.fetch = vi.fn(async () => {
      throw new Error('simulated rate limit');
    }) as typeof guild.members.fetch;
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } });

    await evaluateRosterReady(client as never, pickup.id);

    const [payload] = reviewMessage.edit.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('temporary error');
    expect(payload.content).not.toContain('eligibility role no longer exists');
    expect(payload.content).not.toContain('**Readiness**');
  });

  it("tells staff a lookup temporarily failed, not that the role was deleted, when the role check itself fails", async () => {
    // codex review finding on PR #31 (tenth pass): eligibilityRoleExists's
    // own fetch failure was previously indistinguishable from a confirmed
    // deletion, sending staff to cancel and recreate a perfectly fine pickup.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    new SignupRepository(db).add(pickup.id, 'someone', 'solo', 2);
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    // The member lookup would succeed fine -- only the role check fails.
    const guild = mockGuild({ id: guildId, members: [], existingRoleIds: [eligibilityRoleId] });
    guild.roles.fetch = vi.fn(async () => {
      throw new Error('simulated rate limit');
    }) as typeof guild.roles.fetch;
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } });

    await evaluateRosterReady(client as never, pickup.id);

    const [payload] = reviewMessage.edit.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('temporary error');
    expect(payload.content).not.toContain('eligibility role no longer exists');
    expect(payload.content).not.toContain('**Readiness**');
  });

  it('transitions to roster_ready, writes the draft, and posts the review card once the pool is feasible', async () => {
    const pickup = createOpenPickup();
    signUpEnoughForPickupVsPickup(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    await evaluateRosterReady(client as never, pickup.id);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(10);
    expect(reviewMessage.edit).toHaveBeenCalled();
  });

  it('records every reaction but only rosters current members of the optional eligibility role', async () => {
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleId,
    });
    signUpEnoughForPickupVsPickup(pickup.id);
    const userIds = new SignupRepository(db).forPickup(pickup.id).map((signup) => signup.userId);
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const oneIneligibleGuild = mockGuild({
      id: guildId,
      members: userIds.map((id, index) => mockMember({ id, roleIds: index === 0 ? [] : [eligibilityRoleId] })),
    });
    const firstClient = mockClient({
      channels: { [reviewChannelId]: reviewChannel },
      guilds: { [guildId]: oneIneligibleGuild },
    });
    await evaluateRosterReady(firstClient as never, pickup.id);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('open');

    const allEligibleGuild = mockGuild({
      id: guildId,
      members: userIds.map((id) => mockMember({ id, roleIds: [eligibilityRoleId] })),
    });
    const secondClient = mockClient({
      channels: { [reviewChannelId]: reviewChannel },
      guilds: { [guildId]: allEligibleGuild },
    });
    await evaluateRosterReady(secondClient as never, pickup.id);
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
  });

  it('only one of two concurrent evaluations posts the review card', async () => {
    const pickup = createOpenPickup();
    signUpEnoughForPickupVsPickup(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    await Promise.all([
      evaluateRosterReady(client as never, pickup.id),
      evaluateRosterReady(client as never, pickup.id),
    ]);

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(10);
  });
});

describe('handleReviewComponent', () => {
  it('refuses an unauthorized coordinator', async () => {
    const unauthorized = mockMember({ roleIds: [] });
    const pickup = createRosterReadyPickup();
    const interaction = mockComponentInteraction({ guildId, member: unauthorized, userId: unauthorized.id });
    await handleReviewComponent(interaction, { action: 'sh', pickupId: pickup.id, args: [String(pickup.version)] });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
  });

  it('reports a missing pickup', async () => {
    const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
    await handleReviewComponent(interaction, { action: 'sh', pickupId: 999999, args: ['0'] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'That pickup no longer exists.' }),
    );
  });

  it('does nothing for an action it does not recognize', async () => {
    const pickup = createRosterReadyPickup();
    const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
    await handleReviewComponent(interaction, { action: 'zz', pickupId: pickup.id, args: [] });

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('reports a mutation failure without changing the roster, replying (not yet acknowledged)', async () => {
    const pickup = createRosterReadyPickup();
    const before = new RosterSlotRepository(db).forPickup(pickup.id);
    const slotId = before[0]!.id;
    // handlePickTarget reads the source slot BEFORE deferring -- unlike most of
    // this file's actions, which defer first -- so this is the one path that
    // can exercise the "not yet acknowledged" branch of the outer catch.
    vi.spyOn(RosterSlotRepository.prototype, 'byId').mockImplementation(() => {
      throw new Error('simulated database failure');
    });

    const interaction = mockComponentInteraction({
      guildId, member: staff, userId: staff.id, kind: 'string-select', values: ['999'],
    });
    await handleReviewComponent(interaction, {
      action: 'ept', pickupId: pickup.id, args: [String(pickup.version), 'role', String(slotId)],
    });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Something went wrong') }),
    );
    vi.restoreAllMocks();
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toEqual(before);
  });

  it('reports a mutation failure via followUp once the interaction is already deferred', async () => {
    const pickup = createRosterReadyPickup();
    vi.spyOn(RosterSlotRepository.prototype, 'forPickup').mockImplementation(() => {
      throw new Error('simulated database failure');
    });

    const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, deferred: true });
    await handleReviewComponent(interaction, { action: 'esw', pickupId: pickup.id, args: [String(pickup.version)] });

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Something went wrong') }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  describe('draft-state guard (requireEditableDraft)', () => {
    it('refuses Shuffle on a pickup with no draft yet', async () => {
      const pickup = createOpenPickup();
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'sh', pickupId: pickup.id, args: ['0'] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('no roster draft') }),
      );
    });

    it('refuses Shuffle on an already-published pickup, pointing at Replace Player', async () => {
      const pickup = createRosterReadyPickup();
      new PickupRepository(db).transitionStatus(pickup.id, 'roster_ready', 'published');
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'sh', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Replace Player') }),
      );
    });
  });

  describe('staleness (isStale)', () => {
    it('refuses a click made against an outdated version and refreshes the card', async () => {
      const pickup = createRosterReadyPickup();
      const { client, reviewMessage } = clientFor();
      new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await handleReviewComponent(interaction, {
        action: 'sh', pickupId: pickup.id, args: [String(pickup.version + 1)],
      });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('changed since you opened it') }),
      );
      expect(reviewMessage.edit).toHaveBeenCalled();
    });
  });

  describe('Shuffle', () => {
    it('reports infeasibility without touching the roster', async () => {
      const pickup = createRosterReadyPickup();
      const before = new RosterSlotRepository(db).forPickup(pickup.id);
      vi.spyOn(rosterModule, 'generateDifferentRoster').mockReturnValue({
        result: { feasible: false, slots: [] },
        isDifferent: false,
      });

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'sh', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Not enough current signups') }),
      );
      expect(new RosterSlotRepository(db).forPickup(pickup.id)).toEqual(before);
    });

    it('reports no alternative when only one valid roster exists', async () => {
      const pickup = createRosterReadyPickup();
      const current = new RosterSlotRepository(db).forPickup(pickup.id);
      vi.spyOn(rosterModule, 'generateDifferentRoster').mockReturnValue({
        result: { feasible: true, slots: current },
        isDifferent: false,
      });

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'sh', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No alternative roster') }),
      );
    });

    it('writes the new roster and refreshes the card on a genuinely different result', async () => {
      const pickup = createRosterReadyPickup();
      const alternative = [
        { team: 'order' as const, role: 'solo' as const, userId: 'alt-solo-order' },
        { team: 'order' as const, role: 'jungle' as const, userId: 'alt-jungle-order' },
        { team: 'order' as const, role: 'mid' as const, userId: 'alt-mid-order' },
        { team: 'order' as const, role: 'support' as const, userId: 'alt-support-order' },
        { team: 'order' as const, role: 'carry' as const, userId: 'alt-carry-order' },
        { team: 'chaos' as const, role: 'solo' as const, userId: 'alt-solo-chaos' },
        { team: 'chaos' as const, role: 'jungle' as const, userId: 'alt-jungle-chaos' },
        { team: 'chaos' as const, role: 'mid' as const, userId: 'alt-mid-chaos' },
        { team: 'chaos' as const, role: 'support' as const, userId: 'alt-support-chaos' },
        { team: 'chaos' as const, role: 'carry' as const, userId: 'alt-carry-chaos' },
      ];
      vi.spyOn(rosterModule, 'generateDifferentRoster').mockReturnValue({
        result: { feasible: true, slots: alternative },
        isDifferent: true,
      });
      const { client, reviewMessage } = clientFor();
      new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await handleReviewComponent(interaction, { action: 'sh', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(new RosterSlotRepository(db).forPickup(pickup.id).map((s) => s.userId).sort()).toEqual(
        alternative.map((s) => s.userId).sort(),
      );
      expect(reviewMessage.edit).toHaveBeenCalled();
    });

    it('refuses a stale version claim even after a feasible different roster was found', async () => {
      const pickup = createRosterReadyPickup();
      const before = new RosterSlotRepository(db).forPickup(pickup.id);
      vi.spyOn(rosterModule, 'generateDifferentRoster').mockReturnValue({
        result: { feasible: true, slots: before },
        isDifferent: true,
      });
      // isStale() only catches a mismatch on the version carried in the
      // button, BEFORE anything is generated -- it can't observe a write that
      // lands after it passes. claimVersionIfEditable is the actual last line
      // of defense (see its own module comment), so its own failure is what
      // this test exercises directly, forced via spy: nothing short of a
      // second real write racing the same synchronous window between
      // generation and the claim call would trigger it naturally, and that
      // window doesn't exist within one process (see the equivalent note on
      // replace.test.ts's version-conflict test).
      vi.spyOn(PickupRepository.prototype, 'claimVersionIfEditable').mockReturnValue(false);

      const { client, reviewMessage } = clientFor();
      new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await handleReviewComponent(interaction, { action: 'sh', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('changed since you opened it') }),
      );
      vi.restoreAllMocks();
      expect(new RosterSlotRepository(db).forPickup(pickup.id)).toEqual(before);
    });
  });

  describe('Edit Roster -- Swap Players', () => {
    it('refuses on a Pickup vs Premade pickup, which has only one team', async () => {
      const pickup = new PickupRepository(db).create({
        guildId, createdBy: staff.id, format: 'pickup_vs_premade',
        startAt: Math.floor(Date.now() / 1000) + 3600, roleLimit: 1,
      });
      new SignupRepository(db).add(pickup.id, 'a', 'solo', 1);
      new PickupRepository(db).transitionStatus(pickup.id, 'open', 'roster_ready');
      new RosterSlotRepository(db).replaceAll(pickup.id, [{ team: 'pickup', role: 'solo', userId: 'a' }]);
      const fresh = new PickupRepository(db).byId(pickup.id)!;

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'esw', pickupId: fresh.id, args: [String(fresh.version)] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('single team') }),
      );
    });

    it('completes a full swap: menu -> pick role -> occupants exchanged', async () => {
      const pickup = createRosterReadyPickup();
      const guild = mockGuild({ members: [] });
      const client = mockClient({ guilds: { [guildId]: guild } });

      const menuInteraction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await handleReviewComponent(menuInteraction, { action: 'esw', pickupId: pickup.id, args: [String(pickup.version)] });
      expect(menuInteraction.deferUpdate).toHaveBeenCalled();
      expect(menuInteraction.editReply).toHaveBeenCalled();

      const slotsBefore = new RosterSlotRepository(db).forPickup(pickup.id);
      const orderSolo = slotsBefore.find((s) => s.role === 'solo' && s.team === 'order')!;
      const chaosSolo = slotsBefore.find((s) => s.role === 'solo' && s.team === 'chaos')!;

      const pickInteraction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, kind: 'string-select', values: ['solo'],
      });
      await handleReviewComponent(pickInteraction, {
        action: 'eps', pickupId: pickup.id, args: [String(pickup.version), 'swap'],
      });

      const after = new RosterSlotRepository(db).forPickup(pickup.id);
      expect(after.find((s) => s.id === orderSolo.id)!.userId).toBe(chaosSolo.userId);
      expect(after.find((s) => s.id === chaosSolo.id)!.userId).toBe(orderSolo.userId);
      expect(pickInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Swapped') }),
      );
    });
  });

  describe('Edit Roster -- Change Role Assignment', () => {
    it('completes a full exchange: pick first slot -> pick second slot -> occupants exchanged, marked staff-assigned', async () => {
      const pickup = createRosterReadyPickup();
      const guild = mockGuild({ members: [] });
      const client = mockClient({ guilds: { [guildId]: guild } });

      const slots = new RosterSlotRepository(db).forPickup(pickup.id);
      const first = slots[0]!;
      const second = slots[1]!;

      const pickFirst = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, kind: 'string-select', values: [String(first.id)],
      });
      await handleReviewComponent(pickFirst, {
        action: 'eps', pickupId: pickup.id, args: [String(pickup.version), 'role'],
      });
      expect(pickFirst.editReply).toHaveBeenCalled();

      const pickSecond = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, kind: 'string-select', values: [String(second.id)],
      });
      await handleReviewComponent(pickSecond, {
        action: 'ept', pickupId: pickup.id, args: [String(pickup.version), 'role', String(first.id)],
      });

      const after = new RosterSlotRepository(db).forPickup(pickup.id);
      expect(after.find((s) => s.id === first.id)!.userId).toBe(second.userId);
      expect(after.find((s) => s.id === second.id)!.userId).toBe(first.userId);
      expect(after.find((s) => s.id === first.id)!.staffAssigned).toBe(true);
    });
  });

  describe('Edit Roster -- Replace a Roster Slot', () => {
    it('seats a benched signup in the chosen slot', async () => {
      const pickup = createRosterReadyPickup();
      const slot = new RosterSlotRepository(db).forPickup(pickup.id)[0]!;
      const benchPlayerId = `bench-${fakeId()}`;
      new SignupRepository(db).add(pickup.id, benchPlayerId, slot.role, 2);

      const client = mockClient({ guilds: { [guildId]: mockGuild({ members: [] }) } });
      const pickSlot = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, kind: 'string-select', values: [String(slot.id)],
      });
      await handleReviewComponent(pickSlot, {
        action: 'eps', pickupId: pickup.id, args: [String(pickup.version), 'replace'],
      });

      const pickReplacement = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, kind: 'string-select', values: [benchPlayerId],
      });
      await handleReviewComponent(pickReplacement, {
        action: 'ept', pickupId: pickup.id, args: [String(pickup.version), 'replace', String(slot.id)],
      });

      expect(new RosterSlotRepository(db).byId(slot.id)!.userId).toBe(benchPlayerId);
    });

    it('refuses a replacement who was seated elsewhere between the two picks', async () => {
      const pickup = createRosterReadyPickup();
      const slots = new RosterSlotRepository(db).forPickup(pickup.id);
      const targetSlot = slots[0]!;
      const alreadyRostered = slots[1]!.userId; // holds a different slot already

      const client = mockClient({ guilds: { [guildId]: mockGuild({ members: [] }) } });
      const pickReplacement = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, kind: 'string-select', values: [alreadyRostered],
      });
      await handleReviewComponent(pickReplacement, {
        action: 'ept', pickupId: pickup.id, args: [String(pickup.version), 'replace', String(targetSlot.id)],
      });

      expect(pickReplacement.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'That player is already on this roster.', components: [] }),
      );
      expect(new RosterSlotRepository(db).byId(targetSlot.id)!.userId).not.toBe(alreadyRostered);
    });
  });

  describe('Publish', () => {
    it('blocks Publish when someone on the draft has withdrawn', async () => {
      const pickup = createRosterReadyPickup();
      const slot = new RosterSlotRepository(db).forPickup(pickup.id)[0]!;
      new SignupRepository(db).remove(pickup.id, slot.userId, slot.role); // withdrew

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'pub', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("Can't publish yet") }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    });

    it('refuses without a configured roster channel', async () => {
      new GuildConfigRepository(db).setField(guildId, 'roster_channel_id', null);
      const pickup = createRosterReadyPickup();
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'pub', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No public roster channel') }),
      );
    });

    it('shows a confirmation naming the target channel', async () => {
      const pickup = createRosterReadyPickup();
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'pub', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining(`<#${rosterChannelId}>`) }),
      );
    });
  });

  describe('PublishConfirm', () => {
    it('re-checks withdrawals at the moment of publishing, not just when confirm was shown', async () => {
      const pickup = createRosterReadyPickup();
      const slot = new RosterSlotRepository(db).forPickup(pickup.id)[0]!;
      new SignupRepository(db).remove(pickup.id, slot.userId, slot.role);

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReviewComponent(interaction, { action: 'pubc', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("Can't publish") }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    });

    it('publishes: posts the public roster, stores its message ID, and disables the staff card', async () => {
      const pickup = createRosterReadyPickup();
      const { client, reviewMessage, rosterChannel } = clientFor();
      new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await handleReviewComponent(interaction, { action: 'pubc', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
      expect(rosterChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({ allowedMentions: { parse: ['users'] } }),
      );
      expect(new PickupRepository(db).byId(pickup.id)?.rosterMessageId).toBeTruthy();
      expect(reviewMessage.edit).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('published') }),
      );
    });

    it('only one of two simultaneous publish confirmations actually posts', async () => {
      const pickup = createRosterReadyPickup();
      const { client, rosterChannel } = clientFor();

      const a = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      const b = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await Promise.all([
        handleReviewComponent(a, { action: 'pubc', pickupId: pickup.id, args: [String(pickup.version)] }),
        handleReviewComponent(b, { action: 'pubc', pickupId: pickup.id, args: [String(pickup.version)] }),
      ]);

      expect(rosterChannel.send).toHaveBeenCalledTimes(1);
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('published');
    });

    it('hands the pickup back to roster_ready when posting the public roster fails', async () => {
      const pickup = createRosterReadyPickup();
      const { reviewMessage } = clientFor();
      new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
      const failingRosterChannel = mockTextChannel();
      failingRosterChannel.send = vi.fn(async () => {
        throw new Error('simulated Discord outage');
      });
      const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
      const client = mockClient({
        channels: { [reviewChannelId]: reviewChannel, [rosterChannelId]: failingRosterChannel },
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await handleReviewComponent(interaction, { action: 'pubc', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("Couldn't post") }),
      );
      errorSpy.mockRestore();
    });
  });

  describe('PublishBack', () => {
    it('leaves the review card as-is and reports the cancellation', async () => {
      const pickup = createRosterReadyPickup();
      const before = new PickupRepository(db).byId(pickup.id);
      const { client, reviewMessage } = clientFor();
      new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, client });
      await handleReviewComponent(interaction, { action: 'pubb', pickupId: pickup.id, args: [String(pickup.version)] });

      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe(before?.status);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('cancelled') }),
      );
      expect(reviewMessage.edit).toHaveBeenCalled();
    });
  });
});
