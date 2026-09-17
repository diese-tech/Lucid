/**
 * Flow tests for post-publish player replacement -- src/discord/flows/replace.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { PickupEventRepository } from '../../src/db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../../src/db/repositories/pickup-notifications.js';
import { PickupProjectionRepository } from '../../src/db/repositories/pickup-projections.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import type { Pickup, PickupSpace } from '../../src/db/repositories/types.js';
import { UNAUTHORIZED_MESSAGE } from '../../src/discord/permissions.js';
import { handleReplaceComponent, handleReplaceModal } from '../../src/discord/flows/replace.js';
import { finishPickup } from '../../src/discord/flows/finish.js';
import {
  fakeId,
  mockClient,
  mockComponentInteraction,
  mockGuild,
  mockMember,
  mockMessage,
  mockModalInteraction,
  mockTextChannel,
} from '../helpers/discord-mocks.js';
import { seedSpace, spaceSnapshot } from '../helpers/fixtures.js';

/**
 * A select menu row's own toJSON() nests option labels under
 * `.components[0].options[...]`, unlike a button row where `.components[N]`
 * IS each rendered button -- easy to conflate, so this is factored out once
 * rather than risking the mistake per call site.
 */
function optionLabels(row: unknown): string[] {
  const json = (row as { toJSON: () => { components: { options: { label: string }[] }[] } }).toJSON();
  return json.components[0]!.options.map((option) => option.label);
}

function firstOptionLabel(row: unknown): string {
  return optionLabels(row)[0]!;
}

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let staff: ReturnType<typeof mockMember>;
let outgoing: ReturnType<typeof mockMember>;
let bench: ReturnType<typeof mockMember>;
let space: PickupSpace;

/**
 * A published pickup routed through a fully configured Pickup Space.
 *
 * `options.rosterChannelId` seeds a fresh space with that specific roster
 * channel (rather than the shared `space`) for tests that need to control
 * which channel the pickup's snapshot points at -- e.g. to match a mock
 * client's channel map.
 */
function createPublishedPickup(
  eligibilityRoleIds: string[] = [],
  options: { rosterChannelId?: string } = {},
): Pickup {
  const pickupSpace = options.rosterChannelId
    ? seedSpace(db, {
        guildId,
        authorizedRoleIds: [authorizedRoleId],
        rosterChannelId: options.rosterChannelId,
      })
    : space;
  const pickup = new PickupRepository(db).create({
    guildId,
    createdBy: staff.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    eligibilityRoleIds,
    ...spaceSnapshot(pickupSpace),
  });
  new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'published');
  // issue #35: the Replace button's canonical-message-ID check needs a real
  // rosterMessageId to compare against, even for tests that never render or
  // edit the public roster themselves.
  new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: fakeId() });
  return new PickupRepository(db).byId(pickup.id)!;
}

/** The published roster's mock message, matching whatever rosterMessageId the pickup has. */
function rosterMessageFor(pickup: Pickup) {
  return mockMessage({ id: pickup.rosterMessageId! });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  authorizedRoleId = fakeId();
  space = seedSpace(db, { guildId, authorizedRoleIds: [authorizedRoleId] });
  staff = mockMember({ roleIds: [authorizedRoleId], username: 'coordinator' });
  outgoing = mockMember({ username: 'outgoing-player', displayName: 'Outgoing Player' });
  bench = mockMember({ username: 'bench-player', displayName: 'Bench Player' });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('handleReplaceComponent', () => {
  it('refuses an unauthorized coordinator before doing anything else', async () => {
    // handleReplaceComponent now loads the pickup BEFORE authorizing (it
    // needs the pickup to resolve which space's roles apply), so this must
    // target a pickup that actually exists -- a nonexistent pickupId would
    // now hit the "no longer exists" branch first instead of this one.
    const pickup = createPublishedPickup();
    const unauthorized = mockMember({ roleIds: [] });
    const interaction = mockComponentInteraction({ guildId, member: unauthorized, userId: unauthorized.id });
    await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }),
    );
  });

  it('refuses ReplaceConfirm even though the entry step in this same flow was authorized -- access re-checked every step, not cached', async () => {
    // issue #35 scenario 5: the router re-runs authorize() before every
    // single action, not just the entry click -- this proves a revocation
    // between opening Replace Player and confirming it takes effect
    // immediately, not only on the next fresh entry.
    const pickup = createPublishedPickup();
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
    ]);
    const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

    const openInteraction = mockComponentInteraction({
      guildId, member: staff, userId: staff.id, message: rosterMessageFor(pickup),
    });
    await handleReplaceComponent(openInteraction, { action: 'rep', pickupId: pickup.id, args: [] });
    expect(openInteraction.reply).not.toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));

    const revoked = mockMember({ id: staff.id, roleIds: [] });
    const confirmInteraction = mockComponentInteraction({ guildId, member: revoked, userId: revoked.id });
    await handleReplaceComponent(confirmInteraction, {
      action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
    });

    expect(confirmInteraction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
    expect(new RosterSlotRepository(db).byId(slotId)!.userId).toBe(outgoing.id);
    expect(new PickupEventRepository(db).forPickup(pickup.id)).toHaveLength(0);
  });

  describe('Replace (step 1 -- pick the slot)', () => {
    it('refuses a pickup that has not been published yet', async () => {
      const pickup = new PickupRepository(db).create({
        guildId, createdBy: staff.id, format: 'pickup_vs_pickup',
        startAt: Math.floor(Date.now() / 1000) + 3600, roleLimit: 2,
        ...spaceSnapshot(space),
      });
      new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: fakeId() });
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, message: rosterMessageFor(new PickupRepository(db).byId(pickup.id)!),
      });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Edit Roster') }),
      );
    });

    it('refuses a click from a message that is not the current published roster, without mutating anything', async () => {
      // issue #35: canonical-message-ID binding. This button lives directly
      // on the published public roster -- a click attributed to any OTHER
      // message must be refused before it can do anything.
      const pickup = createPublishedPickup();
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, message: mockMessage({ id: fakeId() }),
      });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not on the current message') }),
      );
    });

    it('refuses a cancelled pickup', async () => {
      const pickup = createPublishedPickup();
      new PickupRepository(db).transitionStatusFromAny(pickup.id, ['published'], 'cancelled');
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, message: rosterMessageFor(pickup),
      });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('no roster to change') }),
      );
    });

    it('refuses a finished pickup', async () => {
      const pickup = createPublishedPickup();
      new PickupRepository(db).transitionStatusFromAny(pickup.id, ['published'], 'finished');
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, message: rosterMessageFor(pickup),
      });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('closed to further changes') }),
      );
    });

    it('reports no slots when the roster is empty', async () => {
      const pickup = createPublishedPickup();
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, message: rosterMessageFor(pickup),
      });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'That roster has no slots to replace.' }),
      );
    });

    it('defers, resolves display names, and offers every rostered slot', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const guild = mockGuild({ members: [outgoing] });
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, guild, message: rosterMessageFor(pickup),
      });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.deferReply).toHaveBeenCalled();
      const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
      expect(firstOptionLabel(payload.components[0])).toContain('Outgoing Player');
    });

    it('falls back to the raw ID when the occupant cannot be resolved', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: 'someone-who-left' },
      ]);
      const guild = mockGuild({ members: [] }); // nobody -- fetch() will throw
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, guild, message: rosterMessageFor(pickup),
      });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
      expect(firstOptionLabel(payload.components[0])).toContain('someone-who-left');
    });
  });

  describe('ReplacePickSlot (step 2 -- bench first)', () => {
    it('jumps straight to the search modal when nobody is on the bench', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, kind: 'string-select', values: [String(slotId)],
      });
      await handleReplaceComponent(interaction, { action: 'reps', pickupId: pickup.id, args: [] });

      expect(interaction.showModal).toHaveBeenCalledTimes(1);
      expect(interaction.deferUpdate).not.toHaveBeenCalled();
    });

    it('offers the bench before opening search when players signed up for the role', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      new SignupRepository(db).add(pickup.id, bench.id, 'solo', 2);

      const guild = mockGuild({ members: [bench] });
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, guild, kind: 'string-select', values: [String(slotId)],
      });
      await handleReplaceComponent(interaction, { action: 'reps', pickupId: pickup.id, args: [] });

      expect(interaction.deferUpdate).toHaveBeenCalled();
      const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
      expect(payload.components).toHaveLength(2); // bench select + search button
      expect(firstOptionLabel(payload.components[0])).toContain('Bench Player');
    });

    it('does not offer a bench player who is already rostered elsewhere', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
        { team: 'order', role: 'jungle', userId: bench.id },
      ]);
      const slotId = new RosterSlotRepository(db)
        .forPickup(pickup.id)
        .find((s) => s.role === 'solo')!.id;
      // bench signed up for solo too, but already holds the jungle slot.
      new SignupRepository(db).add(pickup.id, bench.id, 'solo', 2);

      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, kind: 'string-select', values: [String(slotId)],
      });
      await handleReplaceComponent(interaction, { action: 'reps', pickupId: pickup.id, args: [] });

      // No one left on the bench once the rostered player is excluded -- straight to search.
      expect(interaction.showModal).toHaveBeenCalledTimes(1);
    });

    it('offers the players who asked for this exact role first, then Fill, then marked off-role ones', async () => {
      // issue #36 scenario 16. Signed up in the opposite order to the one the
      // menu must render, so only the role-aware ranking -- not signup time --
      // can produce this result.
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const offRolePlayer = mockMember({ username: 'mid-player', displayName: 'Mid Player' });
      const filler = mockMember({ username: 'fill-player', displayName: 'Fill Player' });
      const exact = mockMember({ username: 'solo-player', displayName: 'Solo Player' });
      new SignupRepository(db).add(pickup.id, offRolePlayer.id, 'mid', 2);
      new SignupRepository(db).add(pickup.id, filler.id, 'fill', 2);
      new SignupRepository(db).add(pickup.id, exact.id, 'solo', 2);

      const guild = mockGuild({ members: [offRolePlayer, filler, exact] });
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, guild, kind: 'string-select', values: [String(slotId)],
      });
      await handleReplaceComponent(interaction, { action: 'reps', pickupId: pickup.id, args: [] });

      const [payload] = interaction.editReply.mock.calls[0]! as [{ components: unknown[] }];
      expect(optionLabels(payload.components[0])).toEqual([
        '@Solo Player — Solo',
        '@Fill Player — Fill',
        '@Mid Player — Mid · off-role',
      ]);
    });
  });

  describe('ReplacePickBench (off-role confirmation)', () => {
    it('confirms an off-role pick as an override, and changes nothing until that confirmation is clicked', async () => {
      // issue #36 scenario 18: an off-role candidate is offered on purpose,
      // but must never land on the roster on the same unremarkable green
      // button as someone who actually asked to play the role.
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      new SignupRepository(db).add(pickup.id, bench.id, 'mid', 2);

      const pick = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, kind: 'string-select', values: [bench.id],
      });
      await handleReplaceComponent(pick, { action: 'repb', pickupId: pickup.id, args: [String(slotId)] });

      const [payload] = pick.editReply.mock.calls[0]! as [{ content: string; components: unknown[] }];
      expect(payload.content).toContain(`Solo is outside <@${bench.id}>'s declared roles`);
      const buttons = (payload.components[0] as { toJSON: () => { components: { label: string }[] } }).toJSON();
      expect(buttons.components.map((button) => button.label)).toEqual(['Replace Anyway', 'Cancel']);
      // Choosing them is not committing them.
      expect(new RosterSlotRepository(db).byId(slotId)!.userId).toBe(outgoing.id);
      expect(new PickupEventRepository(db).forPickup(pickup.id)).toHaveLength(0);

      const confirm = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, guild: mockGuild({ id: guildId }),
      });
      await handleReplaceComponent(confirm, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(new RosterSlotRepository(db).byId(slotId)!.userId).toBe(bench.id);
    });

    it('leaves a player who signed up for the role with the ordinary confirmation', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      new SignupRepository(db).add(pickup.id, bench.id, 'solo', 2);

      const pick = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, kind: 'string-select', values: [bench.id],
      });
      await handleReplaceComponent(pick, { action: 'repb', pickupId: pickup.id, args: [String(slotId)] });

      const [payload] = pick.editReply.mock.calls[0]! as [{ content: string; components: unknown[] }];
      expect(payload.content).not.toContain('declared roles');
      const buttons = (payload.components[0] as { toJSON: () => { components: { label: string }[] } }).toJSON();
      expect(buttons.components.map((button) => button.label)).toEqual(['Confirm', 'Cancel']);
    });
  });

  describe('ReplaceConfirm', () => {
    it('changes nothing on "no"', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'no'],
      });

      expect(interaction.update).toHaveBeenCalledWith({
        content: 'No changes made. The roster is unchanged.',
        components: [],
      });
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
    });

    it('acknowledges the interaction before the commit-time candidate check, not after', async () => {
      // codex review finding on PR #44: verifyCurrentCandidate performs a
      // real, forced Discord REST call. Discord invalidates an interaction's
      // token if it goes unacknowledged for 3 seconds -- if that fetch were
      // slow, an un-deferred interaction would fail every response below it,
      // even on a path that otherwise commits successfully.
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      const guild = mockGuild({ id: guildId, members: [bench] });
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });

      let deferredBeforeFetch = false;
      const originalFetch = guild.members.fetch;
      guild.members.fetch = vi.fn(async (...args: Parameters<typeof originalFetch>) => {
        deferredBeforeFetch = interaction.deferred;
        return originalFetch(...args);
      }) as typeof originalFetch;

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(deferredBeforeFetch).toBe(true);
    });

    it('refuses a candidate who already holds a slot on this roster', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
        { team: 'order', role: 'jungle', userId: bench.id },
      ]);
      const slotId = new RosterSlotRepository(db)
        .forPickup(pickup.id)
        .find((s) => s.role === 'solo')!.id;

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      // Acknowledged via deferUpdate first, then edited -- codex review
      // finding on PR #44: the commit-time candidate check below is a real
      // network wait, so the interaction must be acknowledged before it runs.
      expect(interaction.deferUpdate).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already holds a slot') }),
      );
      // issue #35: the refused replacement must never record an audit event.
      expect(new PickupEventRepository(db).forPickup(pickup.id)).toHaveLength(0);
    });

    it('refuses a candidate seated elsewhere while the commit-time candidate check is in flight', async () => {
      // codex review finding on PR #44: verifyCurrentCandidate's own network
      // wait opened a window between the first "already rostered" check and
      // the write where a DIFFERENT, concurrent replacement could seat the
      // same candidate elsewhere -- nothing async stood between a stale
      // pre-fetch result and the write, so this replacement could still
      // silently seat them a second time.
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
        { team: 'order', role: 'jungle', userId: 'someone-else' },
      ]);
      const slots = new RosterSlotRepository(db);
      const soloSlotId = slots.forPickup(pickup.id).find((s) => s.role === 'solo')!.id;
      const jungleSlotId = slots.forPickup(pickup.id).find((s) => s.role === 'jungle')!.id;

      const guild = mockGuild({ id: guildId, members: [bench] });
      const originalFetch = guild.members.fetch;
      guild.members.fetch = vi.fn(async (...args: Parameters<typeof originalFetch>) => {
        slots.setOccupant(jungleSlotId, bench.id);
        return originalFetch(...args);
      }) as typeof originalFetch;
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(soloSlotId), bench.id, 'yes'],
      });

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already holds a slot') }),
      );
      expect(slots.byId(soloSlotId)!.userId).toBe(outgoing.id);
      expect(new PickupEventRepository(db).forPickup(pickup.id)).toHaveLength(0);
    });

    it('re-checks the optional eligibility role before committing a published replacement', async () => {
      const eligibilityRoleId = fakeId();
      const pickup = createPublishedPickup([eligibilityRoleId]);
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      const guild = mockGuild({ id: guildId, members: [bench] });
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('does not hold'),
      }));
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
    });

    it('refuses a replacement who has left the guild since being benched, even with no eligibility roles configured', async () => {
      // issue #35: commit-time target revalidation. Previously, guild
      // membership was only re-checked as a side effect of the eligibility
      // role lookup, so a pickup with no eligibility roles at all (the
      // default) never re-verified it -- a departed member could still be
      // replaced in on the strength of a stale bench signup.
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      const guild = mockGuild({ id: guildId, members: [] }); // bench has left -- fetch() will throw
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('no longer a member of this server'),
      }));
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
      expect(new PickupEventRepository(db).forPickup(pickup.id)).toHaveLength(0);
    });

    it('refuses on a version conflict rather than overwriting an unseen edit', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      // commitReplacement reads the pickup fresh immediately before its own
      // claimVersionIfPublished call, with no await between the two -- so
      // within a single process there is no window for another write to land
      // in between and make that call fail honestly. Forcing the return value
      // is the direct way to test this branch's own behavior (the message it
      // shows, that it touches nothing) without depending on how the race is
      // actually triggered in production (cross-process contention on the
      // same DB file).
      const claimVersionSpy = vi.spyOn(PickupRepository.prototype, 'claimVersionIfPublished').mockReturnValue(false);

      // issue #35: commit-time target revalidation means commitReplacement
      // always re-verifies the candidate's guild membership now -- a
      // permissive mock guild (no `members` passed) synthesizes a valid
      // member for bench.id on demand, since this test is about the version
      // claim, not membership.
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, guild: mockGuild({ id: guildId }),
      });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Reopen') }),
      );
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
      claimVersionSpy.mockRestore();
    });

    it('lets exactly one of two genuinely concurrent replacements of the same slot win', async () => {
      // issue #35 requirement: "two staff replacing the same slot
      // concurrently" must produce one winner and one stale/refused action.
      // Unlike the mocked version-conflict test above, this drives two real
      // handleReplaceComponent calls via Promise.all so the race is decided
      // by claimVersionIfPublished's own atomic claim, not a forced return
      // value -- the same single-process interleaving Lucid's real
      // deployment (one bot process handling every interaction) actually
      // faces.
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      const otherBench = mockMember({ username: 'bench-player-2' });

      const guild = mockGuild({ id: guildId });
      const a = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });
      const b = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });

      await Promise.all([
        handleReplaceComponent(a, { action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'] }),
        handleReplaceComponent(b, { action: 'repcf', pickupId: pickup.id, args: [String(slotId), otherBench.id, 'yes'] }),
      ]);

      const slot = new RosterSlotRepository(db).byId(slotId)!;
      expect([bench.id, otherBench.id]).toContain(slot.userId);
      // Exactly one replacement actually landed -- version bumped once.
      expect(new PickupRepository(db).byId(pickup.id)?.version).toBe(pickup.version + 1);
      expect(
        new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_replaced'),
      ).toHaveLength(1);

      // codex review finding on PR #47: DB state alone doesn't prove the
      // LOSING interaction was actually told it lost -- a regression where it
      // hangs or times out silently would still pass the assertions above.
      // Both staff members must receive a definitive, distinct response.
      const [winner, loser] = slot.userId === bench.id ? [a, b] : [b, a];
      expect(winner.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Done') }),
      );
      expect(loser.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Reopen') }),
      );
    });

    it('refuses instead of committing when the pickup is finished while the eligibility lookup is in flight', async () => {
      // codex review finding on PR #33 (P1): the version claim alone can't
      // see a concurrent Finish, since Finish never touches `version` --
      // exactly the gap claimVersionIfEditable's own doc comment already
      // warns about for a concurrent Publish. Simulate Finish completing
      // during the eligibility check's real network wait (the same technique
      // the "cancelled while the eligibility check was in flight" tests
      // elsewhere in this codebase use), then confirm the claim -- now
      // status-aware -- refuses rather than letting the replacement land on
      // a roster that's already closed.
      const eligibilityRoleId = fakeId();
      const pickup = createPublishedPickup([eligibilityRoleId]);
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const eligibleBench = mockMember({ id: bench.id, roleIds: [eligibilityRoleId] });
      const guild = mockGuild({ id: guildId, members: [eligibleBench] });
      const originalFetch = guild.members.fetch;
      guild.members.fetch = vi.fn(async (...args: Parameters<typeof originalFetch>) => {
        new PickupRepository(db).transitionStatus(pickup.id, 'published', 'finished');
        return originalFetch(...args);
      }) as typeof originalFetch;
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Reopen') }),
      );
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
    });

    it('preserves the finished form when Finish completes after this replacement already claimed and mutated, but before its own roster edit', async () => {
      // codex review finding on PR #33 (P2, follow-up after the P1 fix
      // above): the status-aware claim only guards the mutation itself. The
      // roster-message edit that follows still reads deferUpdate/
      // textChannel/messages.fetch -- more real network waits -- from the
      // STALE `pickup` snapshot read at the top of the function. If Finish
      // completes in that later window (after this replacement's own
      // mutation already safely landed), the stale edit would clobber
      // Finish's correct write with enabled controls and no finished note,
      // even though the database has already moved on.
      const rosterChannelId = fakeId();
      const pickup = createPublishedPickup(null, { rosterChannelId });
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const rosterMessage = mockMessage();
      new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: rosterMessage.id });
      const rosterChannel = mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } });
      const client = mockClient({ channels: { [rosterChannelId]: rosterChannel } }) as {
        channels: { fetch: (id: string) => Promise<unknown> };
      };

      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, guild: mockGuild({ id: guildId }),
      });
      // codex review finding on PR #44: commitReplacement now defers (and
      // therefore acknowledges the interaction) BEFORE its own claim and
      // mutation, not after -- textChannel's own client.channels.fetch call
      // is the first await once those have already landed, exactly where
      // the finding says a concurrent Finish can still complete unseen.
      // Guarded to fire only once -- finishPickup's own writeFinishedMessages
      // fetches this same channel too, and that inner fetch must go straight
      // through rather than recursing.
      let triggered = false;
      const realChannelsFetch = client.channels.fetch;
      client.channels.fetch = vi.fn(async (id: string) => {
        if (!triggered) {
          triggered = true;
          await finishPickup(client as never, pickup.id);
        }
        return realChannelsFetch(id);
      });

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
      // The replacement itself was valid and must still be reflected...
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(bench.id);
      // ...but this replacement's OWN final edit -- the last one made to the
      // message -- must render the current, finished state, not overwrite
      // Finish's correct write with a stale "still open" one.
      const [payload] = rosterMessage.edit.mock.calls.at(-1)! as [{ content: string }];
      expect(payload.content).toContain('finished');
    });

    it('preserves the finished form when Finish completes while fetching the roster message itself, not just during deferUpdate', async () => {
      // codex review finding on PR #33 (P2, third round on the same bug
      // class): the previous fix re-read the pickup right after textChannel
      // resolved, but channel.messages.fetch below is ITS OWN real network
      // wait between that re-read and the actual edit -- moving the read one
      // await earlier each round just relocated the gap one await later.
      // This test targets that specific window: Finish completing while
      // THIS fetch is in flight, after the re-read already ran and computed
      // a stale `finished: false`.
      const rosterChannelId = fakeId();
      const pickup = createPublishedPickup(null, { rosterChannelId });
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const rosterMessage = mockMessage();
      new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: rosterMessage.id });
      const rosterChannel = mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } });
      const client = mockClient({ channels: { [rosterChannelId]: rosterChannel } });
      // Guarded to fire only once -- finishPickup's own writeFinishedMessages
      // fetches this same roster message to write its finished form, and
      // that inner fetch must go straight through rather than recursing.
      let triggered = false;
      const originalFetch = rosterChannel.messages.fetch;
      rosterChannel.messages.fetch = vi.fn(async (...args: Parameters<typeof originalFetch>) => {
        if (!triggered) {
          triggered = true;
          await finishPickup(client as never, pickup.id);
        }
        return originalFetch(...args);
      }) as typeof originalFetch;

      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, guild: mockGuild({ id: guildId }),
      });

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(new PickupRepository(db).byId(pickup.id)?.status).toBe('finished');
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(bench.id);
      const [payload] = rosterMessage.edit.mock.calls.at(-1)! as [{ content: string }];
      expect(payload.content).toContain('finished');
    });

    it('commits the replacement, edits the public roster, and posts a notice', async () => {
      const rosterChannelId = fakeId();
      const pickup = createPublishedPickup(null, { rosterChannelId });
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const rosterMessage = mockMessage();
      new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: rosterMessage.id });
      const rosterChannel = mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } });

      const client = { channels: { fetch: async (id: string) => (id === rosterChannelId ? rosterChannel : null) } };
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, guild: mockGuild({ id: guildId }),
      });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(bench.id);
      expect(rosterMessage.edit).toHaveBeenCalled();
      // The public notice is no longer sent inline -- it is scheduled onto the
      // durable notification substrate (issue #36) and delivered by the worker.
      expect(rosterChannel.send).not.toHaveBeenCalled();
      expect(
        new PickupNotificationRepository(db)
          .forPickup(pickup.id)
          .filter((n) => n.kind === 'replacement_notice'),
      ).toHaveLength(1);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Done') }),
      );

      // issue #35: the published replacement records exactly one durable
      // audit event, carrying the confirming staff member as its actor.
      const events = new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_replaced');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: staff.id,
        payload: { slotId, previousUserId: outgoing.id, newUserId: bench.id },
      });
    });

    it('resolves an earlier unresolved roster delivery live before committing a new replacement, rather than layering onto it', async () => {
      // issue #35 requirement 7: a prior attempt for this exact pickup
      // version was left uncertain (a crash, a timeout) -- Lucid must try to
      // resolve it before allowing a NEW mutation to build on top of an
      // unconfirmed surface, not silently ignore it.
      const rosterChannelId = fakeId();
      const pickup = createPublishedPickup(null, { rosterChannelId });
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const rosterMessage = mockMessage();
      new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: rosterMessage.id });
      new PickupProjectionRepository(db).begin(pickup.id, 'roster', rosterMessage.id);
      const rosterChannel = mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } });

      const client = { channels: { fetch: async (id: string) => (id === rosterChannelId ? rosterChannel : null) } };
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, guild: mockGuild({ id: guildId }),
      });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      // The stale delivery resolved live (an extra edit against the same
      // message, ahead of this replacement's own), and the new replacement
      // then proceeded normally.
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(bench.id);
      expect(new PickupProjectionRepository(db).unresolvedForPickup(pickup.id)).toHaveLength(0);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Done') }),
      );
    });

    it('refuses a new replacement while an earlier delivery for this exact version remains unresolved after Lucid just tried to fix it', async () => {
      const rosterChannelId = fakeId();
      const pickup = createPublishedPickup(null, { rosterChannelId });
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      // The tracked message ID no longer resolves in the channel -- the live
      // retry the guard attempts will fail exactly like the original attempt
      // did, leaving it genuinely unresolved.
      new PickupProjectionRepository(db).begin(pickup.id, 'roster', pickup.rosterMessageId);
      const rosterChannel = mockTextChannel({ messages: {} });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const client = { channels: { fetch: async (id: string) => (id === rosterChannelId ? rosterChannel : null) } };
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, guild: mockGuild({ id: guildId }),
      });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });
      errorSpy.mockRestore();

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('still confirming an earlier update') }),
      );
      // Nothing about the new replacement was allowed to proceed.
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
      expect(new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_replaced')).toHaveLength(0);
    });

    it('leaves the mutation standing and records an uncertain outcome, without a duplicate notice, when the roster edit response is ambiguous', async () => {
      // issue #35's delivery-recovery contract: a genuinely uncertain
      // Discord response (not a confirmed rejection) must never be treated
      // as a reason to roll back an already-committed mutation, and must
      // never trigger a second, duplicate send to compensate.
      const rosterChannelId = fakeId();
      const pickup = createPublishedPickup(null, { rosterChannelId });
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const rosterMessage = mockMessage();
      rosterMessage.edit = vi.fn(async () => {
        throw new Error('simulated transport timeout');
      }) as typeof rosterMessage.edit;
      new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: rosterMessage.id });
      const rosterChannel = mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const client = { channels: { fetch: async (id: string) => (id === rosterChannelId ? rosterChannel : null) } };
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client, guild: mockGuild({ id: guildId }),
      });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });
      errorSpy.mockRestore();

      // The database mutation stands -- never rolled back over a delivery
      // problem.
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(bench.id);
      expect(new PickupEventRepository(db).forPickup(pickup.id).filter((e) => e.eventType === 'player_replaced')).toHaveLength(1);
      // Exactly one public notice -- no blind duplicate send to compensate
      // for the uncertain edit. Scheduled onto the durable notification
      // substrate (issue #36) rather than sent inline, so the uncertain
      // roster EDIT above and the notice's own delivery stay independent.
      expect(rosterChannel.send).not.toHaveBeenCalled();
      expect(
        new PickupNotificationRepository(db)
          .forPickup(pickup.id)
          .filter((n) => n.kind === 'replacement_notice'),
      ).toHaveLength(1);
      // The uncertain attempt is durably recorded, not silently dropped.
      expect(new PickupProjectionRepository(db).unresolvedForPickup(pickup.id)).toContainEqual(
        expect.objectContaining({ surface: 'roster', status: 'uncertain' }),
      );
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Done') }),
      );
    });

    it('still commits and reports success when no roster channel is configured', async () => {
      // The pickup's roster channel is snapshotted from its Pickup Space at
      // creation time; simulate it being cleared afterward (e.g. the
      // channel was removed from the space's configuration) rather than a
      // guild_config field, which no longer has any bearing on this path.
      const pickup = createPublishedPickup();
      db.prepare('UPDATE pickups SET roster_channel_id = NULL WHERE id = ?').run(pickup.id);
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, guild: mockGuild({ id: guildId }),
      });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(bench.id);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Done') }),
      );
    });
  });
});

describe('handleReplaceModal (search)', () => {
  it('reports no match when the search finds nobody', async () => {
    const pickup = createPublishedPickup();
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
    ]);
    const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

    const guild = mockGuild({ members: [] });
    const interaction = mockModalInteraction({
      guildId, member: staff, userId: staff.id, guild, fields: { query: 'nobody-like-this' },
    });
    await handleReplaceModal(interaction, { action: 'repsm', pickupId: pickup.id, args: [String(slotId)] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No member found') }),
    );
  });

  it('excludes search matches that lack the pickup eligibility role', async () => {
    const eligibilityRoleId = fakeId();
    const pickup = createPublishedPickup([eligibilityRoleId]);
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
    ]);
    const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
    const guild = mockGuild({ id: guildId, members: [bench] });
    const interaction = mockModalInteraction({
      guildId, member: staff, userId: staff.id, guild, fields: { query: 'bench' },
    });

    await handleReplaceModal(interaction, { action: 'repsm', pickupId: pickup.id, args: [String(slotId)] });

    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('No member found'),
    }));
  });

  it('goes straight to confirmation on exactly one match', async () => {
    const pickup = createPublishedPickup();
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
    ]);
    const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

    const guild = mockGuild({ members: [bench] });
    const interaction = mockModalInteraction({
      guildId, member: staff, userId: staff.id, guild, fields: { query: bench.user.username },
    });
    await handleReplaceModal(interaction, { action: 'repsm', pickupId: pickup.id, args: [String(slotId)] });

    const [payload] = interaction.editReply.mock.calls[0]! as [{ content: string; components: unknown[] }];
    expect(payload.content).toContain(`Replace <@${outgoing.id}> with <@${bench.id}>`);
    const confirmRow = (payload.components[0] as { toJSON: () => { components: { label: string }[] } }).toJSON();
    expect(confirmRow.components.map((c) => c.label)).toEqual(['Confirm', 'Cancel']);
  });

  it('excludes bots and already-rostered members from the results', async () => {
    const pickup = createPublishedPickup();
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
      { team: 'order', role: 'jungle', userId: bench.id },
    ]);
    const slotId = new RosterSlotRepository(db)
      .forPickup(pickup.id)
      .find((s) => s.role === 'solo')!.id;

    const aBot = mockMember({ username: 'matching-bot', bot: true });
    const guild = mockGuild({ members: [bench, aBot] }); // both would match a broad query
    const interaction = mockModalInteraction({
      guildId, member: staff, userId: staff.id, guild, fields: { query: 'matching' },
    });
    await handleReplaceModal(interaction, { action: 'repsm', pickupId: pickup.id, args: [String(slotId)] });

    // Neither the bot nor the already-rostered bench player qualifies -- zero left.
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No member found') }),
    );
  });

  it('still enforces the bot, already-rostered and eligibility checks now that the bench is role-aware', async () => {
    // issue #36 scenario 17: the broader guild-member search is the emergency
    // escape hatch -- it reaches players who never signed up at all, and must
    // keep doing so, but never at the cost of the three checks that make a
    // candidate seatable in the first place.
    const eligibilityRoleId = fakeId();
    const pickup = createPublishedPickup([eligibilityRoleId]);
    const seated = mockMember({ username: 'sub-seated', roleIds: [eligibilityRoleId] });
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
      { team: 'order', role: 'jungle', userId: seated.id },
    ]);
    const slotId = new RosterSlotRepository(db)
      .forPickup(pickup.id)
      .find((s) => s.role === 'solo')!.id;

    const aBot = mockMember({ username: 'sub-bot', bot: true, roleIds: [eligibilityRoleId] });
    const ineligible = mockMember({ username: 'sub-ineligible' });
    const free = mockMember({ username: 'sub-free', roleIds: [eligibilityRoleId] });
    const guild = mockGuild({ id: guildId, members: [aBot, ineligible, free, seated] });
    const interaction = mockModalInteraction({
      guildId, member: staff, userId: staff.id, guild, fields: { query: 'sub' },
    });
    await handleReplaceModal(interaction, { action: 'repsm', pickupId: pickup.id, args: [String(slotId)] });

    // Only the eligible, non-bot, unseated member survives -- and reaching
    // someone with no signup at all is the escape hatch working as intended,
    // so no off-role override warning is raised over it.
    const [payload] = interaction.editReply.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain(`Replace <@${outgoing.id}> with <@${free.id}>`);
    expect(payload.content).not.toContain('declared roles');
  });

  it('shows a picker on multiple matches', async () => {
    const pickup = createPublishedPickup();
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
    ]);
    const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

    const alice = mockMember({ username: 'alice-player' });
    const alicia = mockMember({ username: 'alicia-player' });
    const guild = mockGuild({ members: [alice, alicia] });
    const interaction = mockModalInteraction({
      guildId, member: staff, userId: staff.id, guild, fields: { query: 'ali' },
    });
    await handleReplaceModal(interaction, { action: 'repsm', pickupId: pickup.id, args: [String(slotId)] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Several members match') }),
    );
  });

  it('treats a failed member search the same as zero results, rather than throwing', async () => {
    const pickup = createPublishedPickup();
    new RosterSlotRepository(db).replaceAll(pickup.id, [
      { team: 'order', role: 'solo', userId: outgoing.id },
    ]);
    const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

    const guild = mockGuild({ members: [bench] });
    (guild.members.fetch as unknown as () => Promise<never>) = async () => {
      throw new Error('simulated Discord API failure');
    };
    const interaction = mockModalInteraction({
      guildId, member: staff, userId: staff.id, guild, fields: { query: bench.user.username },
    });
    await expect(
      handleReplaceModal(interaction, { action: 'repsm', pickupId: pickup.id, args: [String(slotId)] }),
    ).resolves.toBeUndefined();

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No member found') }),
    );
  });
});
