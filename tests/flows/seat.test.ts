/**
 * Flow tests for manual seating -- src/discord/flows/seat.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { PickupEventRepository } from '../../src/db/repositories/pickup-events.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import type { Pickup, PickupSpace } from '../../src/db/repositories/types.js';
import { UNAUTHORIZED_MESSAGE } from '../../src/discord/permissions.js';
import { Action } from '../../src/discord/ids.js';
import { handleSeatComponent } from '../../src/discord/flows/seat.js';
import { evaluateRosterReady } from '../../src/discord/flows/review.js';
import { generateWorkingRoster } from '../../src/domain/roster.js';
import {
  fakeId,
  mockClient,
  mockComponentInteraction,
  mockGuild,
  mockMember,
  mockMessage,
  mockTextChannel,
} from '../helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from '../helpers/fixtures.js';

function firstOptionValues(row: unknown): string[] {
  const json = (row as { toJSON: () => { components: { options: { value: string }[] }[] } }).toJSON();
  return json.components[0]!.options.map((option) => option.value);
}

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let staff: ReturnType<typeof mockMember>;
let space: PickupSpace;
let reviewChannelId: string;

function createOpenPickup(): Pickup {
  return new PickupRepository(db).create({
    guildId,
    createdBy: staff.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    ...spaceSnapshot(space),
  });
}

/**
 * issue #35: commit-time target revalidation means commitSeat now always
 * re-verifies the chosen player's guild membership via `interaction.guild`,
 * regardless of whether this pickup has eligibility roles configured. The
 * permissive default guild (no `members` passed -- see mockGuild's own doc
 * comment) synthesizes a valid member for whichever candidate ID a test
 * happens to use, so tests that aren't about membership itself don't each
 * need to name their candidate up front.
 */
function clientFor(reviewMessage = mockMessage(), guild = mockGuild({ id: guildId })) {
  const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
  return {
    client: mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } }),
    reviewMessage,
    guild,
  };
}

function interactionFor(kind: 'button' | 'string-select', extra: Record<string, unknown> = {}) {
  return mockComponentInteraction({
    guildId,
    member: staff,
    userId: staff.id,
    kind,
    ...extra,
  } as never);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  authorizedRoleId = fakeId();
  reviewChannelId = fakeId();
  space = seedSpace(db, { guildId, authorizedRoleIds: [authorizedRoleId], reviewChannelId });
  staff = mockMember({ roleIds: [authorizedRoleId], username: 'coordinator' });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('handleSeatComponent -- authorization', () => {
  it('refuses an unauthorized member before doing anything else', async () => {
    const pickup = createOpenPickup();
    const unauthorized = mockMember({ roleIds: [] });
    const interaction = mockComponentInteraction({ guildId, member: unauthorized, userId: unauthorized.id });

    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
  });

  it('refuses when the pickup no longer exists', async () => {
    const interaction = interactionFor('button');
    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: 999999, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'That pickup no longer exists.' }),
    );
  });

  it('refuses a later step even though an earlier step in this same flow was authorized -- access re-checked every step, not cached', async () => {
    // issue #35: "every state-changing entry and continuation must re-read
    // the space's current authorized roles." Staff opens Seat Player while
    // authorized, then their authorized role is revoked before they reach
    // the confirm step -- the revocation must take effect immediately, not
    // only on the next fresh entry click.
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'jungle', 2);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const openInteraction = interactionFor('button', { client, message: reviewMessage });
    await handleSeatComponent(openInteraction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });
    expect(openInteraction.reply).not.toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));

    const revoked = mockMember({ id: staff.id, roleIds: [] });
    const confirmInteraction = mockComponentInteraction({
      guildId,
      member: revoked,
      userId: revoked.id,
      client,
      customId: `${Action.SeatConfirm}:${pickup.id}:order:jungle:alice:yes`,
    });
    await handleSeatComponent(confirmInteraction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'alice', 'yes'],
    });

    expect(confirmInteraction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
    // alice's own lone jungle signup was already auto-matched by the first
    // (authorized) interaction's own working-roster recompute -- that's
    // background behavior unrelated to this test. What must NOT have
    // happened is the MANUAL seat this refused confirm click would have
    // performed, which always records its own audit event.
    expect(
      new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_seated'),
    ).toHaveLength(0);
  });
});

describe('SeatPlayer (step 1 -- pick the open seat)', () => {
  it('refuses a pickup that is not open', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);
    new PickupRepository(db).transitionStatus(pickup.id, 'open', 'cancelled');

    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = interactionFor('button', { client, message: reviewMessage });
    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer collecting a working roster') }),
    );
  });

  it('refuses a click from a message that is not the current control card, without mutating anything', async () => {
    // issue #35: canonical-message-ID binding. This button lives directly on
    // the persistent control card -- a click attributed to any OTHER message
    // must be refused before it can do anything.
    const pickup = createOpenPickup();
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = interactionFor('button', { client, message: mockMessage() });
    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not on the current message') }),
    );
  });

  it('says there is nothing to seat when no eligible signups are unseated', async () => {
    const pickup = createOpenPickup();
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = interactionFor('button', { client, message: reviewMessage });

    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No eligible signed-up players') }),
    );
  });

  it('offers every open location when eligible unseated signups exist', async () => {
    const pickup = createOpenPickup();
    // Three Solo signups for two Solo seats: the matcher auto-fills both
    // Solo locations, leaving the third (latest) signup genuinely unseated
    // -- exactly the state Seat Player exists for.
    const signups = new SignupRepository(db);
    signups.add(pickup.id, 'alice', 'solo', 2);
    signups.add(pickup.id, 'bob', 'solo', 2);
    signups.add(pickup.id, 'carol', 'solo', 2);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = interactionFor('button', { client, message: reviewMessage });

    await handleSeatComponent(interaction, { action: Action.SeatPlayer, pickupId: pickup.id, args: [] });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
    const values = firstOptionValues(payload.components[0]);
    // Solo is fully seated (order + chaos); every other location is open.
    expect(values).toHaveLength(8);
    expect(values).not.toContain('order:solo');
    expect(values).not.toContain('chaos:solo');
  });
});

describe('SeatPickSlot (step 2 -- pick the player)', () => {
  it('refuses when the chosen seat was just filled by someone else', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);
    new SignupRepository(db).add(pickup.id, 'bob', 'jungle', 2);
    new SignupRepository(db).add(pickup.id, 'someone-else', 'jungle', 2);
    // Simulate a race: this exact seat got filled between the slot menu
    // rendering and this selection landing.
    new RosterSlotRepository(db).addFixedSlot(pickup.id, 'chaos', 'jungle', 'someone-else');

    const { client } = clientFor();
    const interaction = interactionFor('string-select', { client, customId: `${Action.SeatPickSlot}:${pickup.id}`, values: ['chaos:jungle'] });

    await handleSeatComponent(interaction, { action: Action.SeatPickSlot, pickupId: pickup.id, args: [] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('was just filled') }),
    );
  });

  it('lists unseated eligible signups with their declared roles', async () => {
    const pickup = createOpenPickup();
    // Three Solo-only signups for two Solo seats: alice and bob auto-fill
    // Solo, leaving carol (latest) unseated -- Jungle has no signups at all,
    // so chaos:jungle stays open for her to be placed into by hand.
    const signups = new SignupRepository(db);
    signups.add(pickup.id, 'alice', 'solo', 2);
    signups.add(pickup.id, 'bob', 'solo', 2);
    signups.add(pickup.id, 'carol', 'solo', 2);

    const { client } = clientFor();
    const interaction = interactionFor('string-select', {
      client,
      customId: `${Action.SeatPickSlot}:${pickup.id}`,
      values: ['chaos:jungle'],
    });

    await handleSeatComponent(interaction, { action: Action.SeatPickSlot, pickupId: pickup.id, args: [] });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
    const values = firstOptionValues(payload.components[0]);
    expect(values).toEqual(['carol']);
  });

  /**
   * 28 solo-only signups for 2 solo seats -- 2 get auto-seated, leaving 26
   * unseated. Zero-padded names in insertion order keep the outcome
   * deterministic regardless of whether Date.now() ties within the loop
   * (the matcher's tie-break falls back to userId order either way -- see
   * the "zz-latecomer" fixture note elsewhere in this file).
   */
  function seedManyUnseated(pickupId: number): void {
    const signups = new SignupRepository(db);
    for (let i = 0; i < 28; i++) {
      signups.add(pickupId, `p${String(i).padStart(2, '0')}`, 'solo', 2);
    }
  }

  it('paginates when more than 25 eligible players are unseated, instead of silently dropping the rest', async () => {
    // codex review finding on PR #39: a heavily oversubscribed role could
    // leave more unseated players than a single select menu can hold, making
    // everyone past the 25th permanently unreachable through Seat Player.
    const pickup = createOpenPickup();
    seedManyUnseated(pickup.id);

    const { client } = clientFor();
    const interaction = interactionFor('string-select', {
      client,
      customId: `${Action.SeatPickSlot}:${pickup.id}`,
      values: ['order:jungle'],
    });

    await handleSeatComponent(interaction, { action: Action.SeatPickSlot, pickupId: pickup.id, args: [] });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
    const values = firstOptionValues(payload.components[0]);
    expect(values).toHaveLength(25);

    const buttonRow = (payload.components[1] as { toJSON: () => { components: { label: string }[] } }).toJSON();
    expect(buttonRow.components[0]?.label).toContain('Next page');
  });

  it('the Next page button reaches players past the first 25', async () => {
    const pickup = createOpenPickup();
    seedManyUnseated(pickup.id);

    const { client } = clientFor();
    const interaction = interactionFor('button', {
      client,
      customId: `${Action.SeatNextPlayerPage}:${pickup.id}:order:jungle:1`,
    });

    await handleSeatComponent(interaction, {
      action: Action.SeatNextPlayerPage,
      pickupId: pickup.id,
      args: ['order', 'jungle', '1'],
    });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
    const values = firstOptionValues(payload.components[0]);
    // 26 unseated total, 25 on page 0 -- exactly 1 left for page 1.
    expect(values).toHaveLength(1);
  });
});

describe('SeatPickPlayer (step 3 -- confirm)', () => {
  it('offers a plain Confirm when the player declared that role', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'jungle', 2);

    const { client } = clientFor();
    const interaction = interactionFor('string-select', {
      client,
      customId: `${Action.SeatPickPlayer}:${pickup.id}:order:jungle`,
      values: ['alice'],
    });

    await handleSeatComponent(interaction, {
      action: Action.SeatPickPlayer,
      pickupId: pickup.id,
      args: ['order', 'jungle'],
    });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ content: string; components: unknown[] }];
    expect(payload.content).not.toContain('⚠️');
    const buttons = (payload.components[0] as { toJSON: () => { components: { label: string }[] } }).toJSON();
    expect(buttons.components.map((b) => b.label)).toContain('Confirm');
  });

  it('warns and offers Seat Anyway when the player did not declare that role', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);

    const { client } = clientFor();
    const interaction = interactionFor('string-select', {
      client,
      customId: `${Action.SeatPickPlayer}:${pickup.id}:order:jungle`,
      values: ['alice'],
    });

    await handleSeatComponent(interaction, {
      action: Action.SeatPickPlayer,
      pickupId: pickup.id,
      args: ['order', 'jungle'],
    });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ content: string; components: unknown[] }];
    expect(payload.content).toContain('⚠️');
    expect(payload.content).toContain('did not sign up for Jungle');
    const buttons = (payload.components[0] as { toJSON: () => { components: { label: string }[] } }).toJSON();
    expect(buttons.components.map((b) => b.label)).toContain('Seat Anyway');
  });
});

describe('SeatConfirm (step 4 -- commit)', () => {
  function confirmInteraction(
    pickupId: number,
    team: string,
    role: string,
    userId: string,
    decision: string,
    client: unknown,
    guild: unknown = mockGuild({ id: guildId }),
  ) {
    return interactionFor('button', {
      client,
      guild,
      customId: `${Action.SeatConfirm}:${pickupId}:${team}:${role}:${userId}:${decision}`,
    });
  }

  it('makes no changes when the coordinator cancels', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'solo', 2);
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'alice', 'no', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'alice', 'no'],
    });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'No changes made. The roster is unchanged.' }),
    );
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  /**
   * Alice, bob and carol all sign up Solo-only for the pickup's two Solo
   * seats. Alice and bob auto-fill Solo; carol is the latest signup and
   * stays genuinely unseated -- exactly the fixture every commit test below
   * needs, since a single signup for any role always gets auto-seated
   * (capacity 2) and so can never be a realistic "still unseated" target.
   */
  function seedOversubscribedSolo(pickupId: number): void {
    const signups = new SignupRepository(db);
    signups.add(pickupId, 'alice', 'solo', 2);
    signups.add(pickupId, 'bob', 'solo', 2);
    signups.add(pickupId, 'carol', 'solo', 2);
  }

  it('seats the player as staff_assigned and redraws the control card', async () => {
    const pickup = createOpenPickup();
    seedOversubscribedSolo(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Done') }),
    );
    const slots = new RosterSlotRepository(db).forPickup(pickup.id);
    const seat = slots.find((s) => s.team === 'order' && s.role === 'jungle');
    expect(seat?.userId).toBe('carol');
    expect(seat?.staffAssigned).toBe(true);

    // evaluateRosterReady's own recompute+redraw ran as part of the commit.
    expect(reviewMessage.edit).toHaveBeenCalled();

    // issue #35: the manual seat itself records exactly one durable audit
    // event, carrying the confirming staff member as its actor.
    const events = new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_seated');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: staff.id,
      payload: { team: 'order', role: 'jungle', userId: 'carol' },
    });
  });

  it('refuses to seat a signed-up player who has since left the guild, even with no eligibility roles configured', async () => {
    // issue #35: commit-time target revalidation. Previously, guild
    // membership was only re-checked as a side effect of the eligibility
    // role lookup, so a pickup with no eligibility roles at all (the
    // default here) never re-verified it -- a departed member could still
    // be seated on the strength of a stale signup alone.
    const pickup = createOpenPickup();
    seedOversubscribedSolo(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const guild = mockGuild({ id: guildId, members: [] }); // carol has left -- fetch() will throw
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client, guild);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer a member of this server') }),
    );
    // Alice and bob's automatic solo seats stand -- only carol's manual
    // placement must have been refused.
    expect(new RosterSlotRepository(db).forPickup(pickup.id).some((s) => s.userId === 'carol')).toBe(false);
    expect(new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_seated')).toHaveLength(0);
  });

  it('lets a genuinely open seat be filled after its stale automatic occupant loses eligibility', async () => {
    // codex review finding on PR #39 (round 12): when an automatically-
    // seated player loses their eligibility role without ever changing a
    // reaction, nothing but a SIGNUP change triggers evaluateRosterReady's
    // own persist -- a pure role change alone leaves their stale automatic
    // row sitting in roster_slots untouched. Before this fix, the picker
    // (built from a fresh, correct computation) would keep advertising that
    // location as open while addFixedSlot's own DB-level conflict check kept
    // finding the stale occupant and refusing every attempt, with no way
    // out short of an unrelated signup event.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleIds: [eligibilityRoleId],
      ...spaceSnapshot(space),
    });
    const signups = new SignupRepository(db);
    // jungle is exactly filled by alice + bob (capacity 2) -- once alice
    // drops out of eligibility, only bob remains, so ONE jungle seat
    // genuinely frees up rather than immediately being absorbed by someone
    // else eligible for it.
    signups.add(pickup.id, 'alice', 'jungle', 2);
    signups.add(pickup.id, 'bob', 'jungle', 2);
    // carol/dave/eve oversubscribe solo (capacity 2, 3 signups) so exactly
    // one of them stays genuinely unseated regardless of alice's status --
    // decoupled entirely from the jungle scenario above.
    signups.add(pickup.id, 'carol', 'solo', 2);
    signups.add(pickup.id, 'dave', 'solo', 2);
    signups.add(pickup.id, 'eve', 'solo', 2);
    // Persist the automatic roster as it stood the LAST time a reaction
    // triggered evaluation, back when alice was still eligible -- she took
    // one of jungle's two automatic seats, bob the other.
    const slots = new RosterSlotRepository(db);
    slots.replaceWorkingRoster(pickup.id, [
      { team: 'order', role: 'jungle', userId: 'alice' },
      { team: 'chaos', role: 'jungle', userId: 'bob' },
    ]);

    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    // alice has since lost the eligibility role -- no reaction changed, so
    // nothing has recomputed the roster since.
    const guild = mockGuild({
      id: guildId,
      members: [
        mockMember({ id: 'alice', roleIds: [] }),
        ...['bob', 'carol', 'dave', 'eve'].map((id) => mockMember({ id, roleIds: [eligibilityRoleId] })),
      ],
    });
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } });

    // The location and player a freshly-reopened Seat Player picker would
    // actually offer, computed independently of any internal tie-break the
    // matcher uses to decide which team keeps bob's seat, or which of
    // carol/dave/eve stays unseated.
    const eligibleRecords = new SignupRepository(db).recordsForPickup(pickup.id).filter((r) => r.userId !== 'alice');
    const working = generateWorkingRoster(eligibleRecords, 'pickup_vs_pickup', { fixedSlots: [] });
    const openLocation = working.missingLocations.find((location) => location.role === 'jungle')!;
    const targetUserId = working.unseatedUserIds[0]!;

    const interaction = confirmInteraction(pickup.id, openLocation.team, openLocation.role, targetUserId, 'yes', client, guild);
    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: [openLocation.team, openLocation.role, targetUserId, 'yes'],
    });

    const [payload] = interaction.editReply.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('Done');
    const after = slots.forPickup(pickup.id);
    const seat = after.find((s) => s.team === openLocation.team && s.role === openLocation.role);
    expect(seat?.userId).toBe(targetUserId);
    expect(seat?.staffAssigned).toBe(true);
    expect(after.find((s) => s.userId === 'alice')).toBeUndefined();
  });

  it('reconciles the automatic roster using a fresh snapshot, not one captured before the commit-time candidate check', async () => {
    // codex review finding on PR #44: verifyCurrentCandidate's own network
    // wait must resolve BEFORE the working-roster snapshot used for
    // reconciliation is captured, not after -- otherwise a concurrent
    // withdrawal landing during that wait would go unseen, and the stale
    // snapshot would be written back over the newer, correct state.
    const pickup = createOpenPickup();
    const signups = new SignupRepository(db);
    // jungle is exactly filled by alice + bob (capacity 2) -- once alice
    // withdraws, only bob remains, so ONE jungle seat genuinely frees up.
    signups.add(pickup.id, 'alice', 'jungle', 2);
    signups.add(pickup.id, 'bob', 'jungle', 2);
    // carol/dave/eve oversubscribe solo so exactly one of them stays
    // genuinely unseated regardless of alice's status.
    signups.add(pickup.id, 'carol', 'solo', 2);
    signups.add(pickup.id, 'dave', 'solo', 2);
    signups.add(pickup.id, 'eve', 'solo', 2);
    // Persist the automatic roster as it stood the LAST time a reaction
    // triggered evaluation, back when alice was still signed up.
    const slots = new RosterSlotRepository(db);
    slots.replaceWorkingRoster(pickup.id, [
      { team: 'order', role: 'jungle', userId: 'alice' },
      { team: 'chaos', role: 'jungle', userId: 'bob' },
    ]);

    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    // Permissive, and this pickup has no eligibility roles configured, so
    // the ONLY guild.members.fetch call anywhere in this flow is the
    // target's own commit-time candidate check.
    const guild = mockGuild({ id: guildId });
    const originalFetch = guild.members.fetch;
    guild.members.fetch = vi.fn(async (...args: Parameters<typeof originalFetch>) => {
      new SignupRepository(db).remove(pickup.id, 'alice', 'jungle');
      return originalFetch(...args);
    }) as typeof originalFetch;
    const client = mockClient({ channels: { [reviewChannelId]: reviewChannel }, guilds: { [guildId]: guild } });

    const eligibleRecords = new SignupRepository(db).recordsForPickup(pickup.id).filter((r) => r.userId !== 'alice');
    const working = generateWorkingRoster(eligibleRecords, 'pickup_vs_pickup', { fixedSlots: [] });
    const openLocation = working.missingLocations.find((location) => location.role === 'jungle')!;
    const targetUserId = working.unseatedUserIds[0]!;

    const interaction = confirmInteraction(pickup.id, openLocation.team, openLocation.role, targetUserId, 'yes', client, guild);
    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: [openLocation.team, openLocation.role, targetUserId, 'yes'],
    });

    const after = slots.forPickup(pickup.id);
    expect(after.find((s) => s.userId === 'alice')).toBeUndefined();
    const seat = after.find((s) => s.team === openLocation.team && s.role === openLocation.role);
    expect(seat?.userId).toBe(targetUserId);
  });

  it('never overwrites an already-frozen roster with a stale partial snapshot', async () => {
    // codex review finding on PR #39 (round 13): the round-12 reconciliation
    // write was unconditional. If a concurrent reaction completes the roster
    // and freezes it to roster_ready while THIS call's own currentWorkingRoster
    // lookup is still awaiting Discord, resuming with that now-stale, partial
    // `working` snapshot would delete the just-finalized automatic slots and
    // replace them with the older, incomplete ones -- addFixedSlot's own
    // status check catches the manual seat itself, but by then the frozen
    // roster is already corrupted, with nothing left to ever regenerate it.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleIds: [eligibilityRoleId],
      ...spaceSnapshot(space),
    });
    const signups = new SignupRepository(db);
    for (const role of ['solo', 'jungle', 'support'] as const) {
      signups.add(pickup.id, `${role}-a`, role, 2);
      signups.add(pickup.id, `${role}-b`, role, 2);
    }
    // mid is oversubscribed by one -- whichever of these three the matcher
    // doesn't seat stays genuinely unseated no matter how the rest of the
    // roster fills in.
    signups.add(pickup.id, 'mid-a', 'mid', 2);
    signups.add(pickup.id, 'mid-b', 'mid', 2);
    signups.add(pickup.id, 'mid-c', 'mid', 2);
    // carry starts one short -- carry-b hasn't signed up yet.
    signups.add(pickup.id, 'carry-a', 'carry', 2);

    const allUserIds = [
      'solo-a', 'solo-b', 'jungle-a', 'jungle-b', 'support-a', 'support-b',
      'mid-a', 'mid-b', 'mid-c', 'carry-a', 'carry-b',
    ];
    const guild = mockGuild({
      id: guildId,
      members: allUserIds.map((id) => mockMember({ id, roleIds: [eligibilityRoleId] })),
    });
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const client = mockClient({
      channels: { [reviewChannelId]: reviewChannel },
      guilds: { [guildId]: guild },
    }) as { guilds: { fetch: (id: string) => Promise<unknown> } };

    // Gate only the first TWO calls to client.guilds.fetch -- commitSeat's
    // own currentWorkingRoster lookup, and the concurrent evaluateRosterReady's
    // eligibilityContext lookup. Once that evaluation freezes the roster, it
    // also calls refreshReviewCard, whose own ineligibleRosterUserIds makes a
    // THIRD guilds.fetch call this test doesn't care about racing -- let that
    // (and anything further) resolve immediately rather than creating more
    // indefinitely-pending gates.
    const gates: Array<() => void> = [];
    let guildsFetchCalls = 0;
    const realGuildsFetch = client.guilds.fetch;
    client.guilds.fetch = vi.fn(async (id: string) => {
      const index = guildsFetchCalls++;
      if (index < 2) {
        await new Promise<void>((resolve) => {
          gates[index] = resolve;
        });
      }
      return realGuildsFetch(id);
    });

    // Staff opens Seat Player against the current (9/10) roster -- carry's
    // second seat is the only genuinely open location, mid's loser the only
    // unseated player. Its lookup is now pending at gates[0].
    const eligibleBefore = new SignupRepository(db).recordsForPickup(pickup.id);
    const workingBefore = generateWorkingRoster(eligibleBefore, 'pickup_vs_pickup', { fixedSlots: [] });
    const openLocation = workingBefore.missingLocations.find((location) => location.role === 'carry')!;
    const midLoser = workingBefore.unseatedUserIds[0]!;
    const interaction = confirmInteraction(pickup.id, openLocation.team, openLocation.role, midLoser, 'yes', client, guild);
    const commit = handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: [openLocation.team, openLocation.role, midLoser, 'yes'],
    });
    // Authorization and deferUpdate both resolve through their own
    // microtask hops before commitSeat ever reaches its guilds.fetch call --
    // wait for the gate to actually exist rather than guessing a tick count.
    await vi.waitFor(() => expect(gates[0]).toBeDefined());

    // Before that resolves, carry-b signs up -- completing the pool -- and a
    // separate, faster evaluation (an unrelated reaction) runs to completion
    // on this now-genuinely-complete pool, freezing the roster. Its own
    // lookup is pending at gates[1].
    signups.add(pickup.id, 'carry-b', 'carry', 2);
    const freeze = evaluateRosterReady(client as never, pickup.id);
    await vi.waitFor(() => expect(gates[1]).toBeDefined());
    gates[1]!();
    await freeze;
    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    const frozen = new RosterSlotRepository(db).forPickup(pickup.id);
    expect(frozen).toHaveLength(10);

    // The older, now-stale Seat Player commit resolves after -- it must not
    // touch the roster the freeze above already finalized.
    gates[0]!();
    await commit;

    const [payload] = interaction.editReply.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('no longer collecting');
    const after = new RosterSlotRepository(db).forPickup(pickup.id);
    expect(after).toEqual(frozen);
  });

  it('still confirms the committed seat even when the shared roster refresh fails', async () => {
    // codex review finding on PR #39: this interaction is deferred before
    // any of this runs, so an uncaught throw from evaluateRosterReady (e.g.
    // the shared card's own message.edit rejecting) would skip the
    // confirmation reply entirely AND arrive too late for the router's own
    // fallback -- the coordinator would see a permanently "failed"
    // interaction despite the seat having genuinely committed.
    const pickup = createOpenPickup();
    seedOversubscribedSolo(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    reviewMessage.edit = vi.fn(async () => {
      throw new Error('simulated Discord error');
    }) as typeof reviewMessage.edit;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    const [payload] = interaction.editReply.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('Done');
    expect(payload.content).toContain('could not be refreshed');
    const seat = new RosterSlotRepository(db).forPickup(pickup.id).find((s) => s.userId === 'carol');
    expect(seat?.staffAssigned).toBe(true);
    errorSpy.mockRestore();
  });

  it('reports the accurate outcome when independent eligibility recomputation immediately prunes the just-placed seat', async () => {
    // codex review finding on PR #39: evaluateRosterReady runs its OWN
    // independent eligibility lookup, a real network round-trip separate
    // from the one currentWorkingRoster just did a moment earlier to build
    // this confirmation. The player can genuinely lose the pickup's
    // eligibility role in the gap between the two -- in which case that
    // evaluation correctly prunes the seat this call just placed. The
    // confirmation must reflect the seat's actual final state, not just
    // that the placement transaction itself succeeded.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleIds: [eligibilityRoleId],
      ...spaceSnapshot(space),
    });
    // alice and bob fill jungle's two automatic seats; carol -- the latest
    // signup -- stays genuinely unseated, exactly like seedOversubscribedSolo
    // above. She's placed off-role into mid, an entirely empty location the
    // fresh automatic computation never touches -- codex review finding on
    // PR #39 (round 12) made commitSeat reconcile the automatic portion of
    // the roster to the fresh computation before this insert, so targeting
    // an already-auto-filled location (jungle) would now correctly refuse
    // as `location_taken` before the race this test exists to exercise ever
    // gets a chance to run.
    const signups = new SignupRepository(db);
    signups.add(pickup.id, 'alice', 'jungle', 2);
    signups.add(pickup.id, 'bob', 'jungle', 2);
    signups.add(pickup.id, 'carol', 'jungle', 2);
    const reviewMessage = mockMessage();
    const reviewChannel = mockTextChannel({ messages: { [reviewMessage.id]: reviewMessage } });
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    // Everyone is eligible on the FIRST two lookups (currentWorkingRoster's
    // own internal pre-warm evaluateRosterReady call, then its own extra
    // read) -- carol has lost the role by the THIRD, independent lookup
    // (commitSeat's explicit evaluateRosterReady, right after the seat is
    // placed).
    const members = ['alice', 'bob', 'carol'].map((id) => mockMember({ id, roleIds: [eligibilityRoleId] }));
    const eligibleGuild = mockGuild({ id: guildId, members });
    const ineligibleGuild = mockGuild({
      id: guildId,
      members: [
        mockMember({ id: 'alice', roleIds: [eligibilityRoleId] }),
        mockMember({ id: 'bob', roleIds: [eligibilityRoleId] }),
        mockMember({ id: 'carol', roleIds: [] }),
      ],
    });
    const client = mockClient({
      channels: { [reviewChannelId]: reviewChannel },
      guilds: { [guildId]: eligibleGuild },
    }) as { guilds: { fetch: (id: string) => Promise<unknown> } };
    let call = 0;
    client.guilds.fetch = vi.fn(async () => {
      call += 1;
      return call <= 2 ? eligibleGuild : ineligibleGuild;
    });

    const interaction = confirmInteraction(pickup.id, 'order', 'mid', 'carol', 'yes', client, eligibleGuild);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'mid', 'carol', 'yes'],
    });

    const [payload] = interaction.editReply.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).not.toContain('Done —');
    expect(payload.content).toContain('no longer eligible');
    const seat = new RosterSlotRepository(db).forPickup(pickup.id).find((s) => s.userId === 'carol');
    expect(seat).toBeUndefined();
  });

  it('refuses when the seat was just claimed by a concurrent placement', async () => {
    const pickup = createOpenPickup();
    seedOversubscribedSolo(pickup.id);
    new SignupRepository(db).add(pickup.id, 'someone-else', 'jungle', 2);
    new RosterSlotRepository(db).addFixedSlot(pickup.id, 'order', 'jungle', 'someone-else');
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('was just filled') }),
    );
    const seat = new RosterSlotRepository(db).forPickup(pickup.id).find((s) => s.team === 'order' && s.role === 'jungle');
    expect(seat?.userId).toBe('someone-else');
    // issue #35: the refused placement must never record a player_seated event.
    expect(
      new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_seated'),
    ).toHaveLength(0);
  });

  it('refuses when the chosen player already holds a different seat', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'jungle', 2);
    new RosterSlotRepository(db).addFixedSlot(pickup.id, 'chaos', 'mid', 'alice');
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'alice', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'alice', 'yes'],
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('is no longer an eligible unseated signup') }),
    );
  });

  it('refuses when the player withdrew between confirmation and commit', async () => {
    const pickup = createOpenPickup();
    new SignupRepository(db).add(pickup.id, 'alice', 'jungle', 2);
    new SignupRepository(db).remove(pickup.id, 'alice', 'jungle');
    const { client } = clientFor();
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'alice', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'alice', 'yes'],
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('is no longer an eligible unseated signup') }),
    );
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('freezes the pickup into roster_ready when the manual seat completes the roster', async () => {
    const pickup = createOpenPickup();
    const signups = new SignupRepository(db);
    for (const role of ['solo', 'mid', 'support', 'carry'] as const) {
      signups.add(pickup.id, `${role}-a`, role, 2);
      signups.add(pickup.id, `${role}-b`, role, 2);
    }
    // Jungle is one short of its two seats -- 'zz-latecomer' fills it
    // manually. Named to sort alphabetically AFTER solo-a/solo-b on
    // purpose: SignupRepository.add's createdAt comes from Date.now(),
    // which several back-to-back calls in the same test can tie on --
    // generateWorkingRoster's deterministic tie-break then falls to userId
    // order, and this name guarantees this signup is still the one left
    // unseated by the automatic matcher regardless of that tie.
    signups.add(pickup.id, 'jungle-a', 'jungle', 2);
    signups.add(pickup.id, 'zz-latecomer', 'solo', 2); // off-role, unseated eligible signup

    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const interaction = confirmInteraction(pickup.id, 'chaos', 'jungle', 'zz-latecomer', 'yes', client);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['chaos', 'jungle', 'zz-latecomer', 'yes'],
    });

    expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('roster_ready');
    const slots = new RosterSlotRepository(db).forPickup(pickup.id);
    expect(slots).toHaveLength(10);
    const manual = slots.find((s) => s.userId === 'zz-latecomer');
    expect(manual?.staffAssigned).toBe(true);
  });

  it('refuses to seat a candidate who still belongs to the guild but has lost the eligibility role, at commit time', async () => {
    // issue #35: commit-time target revalidation's eligibility-role check
    // (verifyCurrentCandidate), distinct from evaluateRosterReady's later,
    // independent recompute -- this candidate is refused on the FIRST
    // lookup, before any write is attempted at all.
    const eligibilityRoleId = fakeId();
    const pickup = new PickupRepository(db).create({
      guildId,
      createdBy: staff.id,
      format: 'pickup_vs_pickup',
      startAt: Math.floor(Date.now() / 1000) + 3600,
      roleLimit: 2,
      eligibilityRoleIds: [eligibilityRoleId],
      ...spaceSnapshot(space),
    });
    seedOversubscribedSolo(pickup.id);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
    const guild = mockGuild({
      id: guildId,
      members: [mockMember({ id: 'carol', roleIds: [] })], // still in the guild, but never held the role
    });
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client, guild);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('does not hold any of this pickup') }),
    );
    expect(new RosterSlotRepository(db).forPickup(pickup.id)).toHaveLength(0);
    expect(new PickupEventRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  it('refuses when the candidate is seated into a different slot during the commit-time candidate check itself', async () => {
    // issue #35: the candidate check (verifyCurrentCandidate) is a real
    // network wait; a DIFFERENT concurrent seat placement landing during
    // that exact window must still be caught before this commit writes,
    // not just when the conflict was already there before the check began.
    const pickup = createOpenPickup();
    seedOversubscribedSolo(pickup.id); // carol is the excess signup, genuinely unseated
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const guild = mockGuild({ id: guildId });
    const originalFetch = guild.members.fetch;
    guild.members.fetch = vi.fn(async (...args: Parameters<typeof originalFetch>) => {
      new RosterSlotRepository(db).addFixedSlot(pickup.id, 'chaos', 'mid', 'carol');
      return originalFetch(...args);
    }) as typeof originalFetch;
    const interaction = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client, guild);

    await handleSeatComponent(interaction, {
      action: Action.SeatConfirm,
      pickupId: pickup.id,
      args: ['order', 'jungle', 'carol', 'yes'],
    });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('is no longer an eligible unseated signup') }),
    );
    const seat = new RosterSlotRepository(db).forPickup(pickup.id).find((s) => s.team === 'order' && s.role === 'jungle');
    expect(seat).toBeUndefined();
    // The race-injected placement was a direct repository call (simulating a
    // different, already-completed commit), not this commit's own write --
    // this refused attempt itself must never record an event.
    expect(
      new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_seated'),
    ).toHaveLength(0);
  });

  it('lets exactly one of two genuinely concurrent seat commits for the same location win', async () => {
    // issue #35 requirement: "two staff replacing the same slot concurrently"
    // must produce one winner and one stale/refused action, never two writes
    // to the same location. addFixedSlot's own atomic transaction is the
    // only guard here (commitSeat never claims a pickup version) -- this
    // proves that guard actually holds under a genuine Promise.all race, not
    // just a pre-seeded sequential conflict.
    const pickup = createOpenPickup();
    // Four solo signups against solo's 2-slot capacity: alice/bob are
    // auto-matched, leaving carol and dave both genuinely unseated -- two
    // real candidates available to race for the same OFF-role open location
    // (jungle has no signups at all, so it stays fully open).
    const signups = new SignupRepository(db);
    signups.add(pickup.id, 'alice', 'solo', 2);
    signups.add(pickup.id, 'bob', 'solo', 2);
    signups.add(pickup.id, 'carol', 'solo', 2);
    signups.add(pickup.id, 'dave', 'solo', 2);
    const { client, reviewMessage } = clientFor();
    new PickupRepository(db).setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });

    const a = confirmInteraction(pickup.id, 'order', 'jungle', 'carol', 'yes', client);
    const b = confirmInteraction(pickup.id, 'order', 'jungle', 'dave', 'yes', client);

    await Promise.all([
      handleSeatComponent(a, { action: Action.SeatConfirm, pickupId: pickup.id, args: ['order', 'jungle', 'carol', 'yes'] }),
      handleSeatComponent(b, { action: Action.SeatConfirm, pickupId: pickup.id, args: ['order', 'jungle', 'dave', 'yes'] }),
    ]);

    const slots = new RosterSlotRepository(db).forPickup(pickup.id);
    const seat = slots.find((s) => s.team === 'order' && s.role === 'jungle');
    expect(seat).toBeDefined();
    expect(['carol', 'dave']).toContain(seat!.userId);
    // Exactly one placement actually landed -- no double-booking of the seat.
    expect(slots.filter((s) => s.team === 'order' && s.role === 'jungle')).toHaveLength(1);
    expect(
      new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_seated'),
    ).toHaveLength(1);

    // codex review finding on PR #47: DB state alone doesn't prove the LOSING
    // interaction was actually told it lost -- a regression where it hangs or
    // times out silently would still pass the assertions above. Both staff
    // members must receive a definitive, distinct response.
    const [winner, loser] = seat!.userId === 'carol' ? [a, b] : [b, a];
    expect(winner.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Done') }));
    expect(loser.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('was just filled') }),
    );
  });
});
