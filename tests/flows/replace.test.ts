/**
 * Flow tests for post-publish player replacement -- src/discord/flows/replace.ts.
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
import { handleReplaceComponent, handleReplaceModal } from '../../src/discord/flows/replace.js';
import {
  fakeId,
  mockComponentInteraction,
  mockGuild,
  mockMember,
  mockMessage,
  mockModalInteraction,
  mockTextChannel,
} from '../helpers/discord-mocks.js';

/**
 * A select menu row's own toJSON() nests option labels under
 * `.components[0].options[...]`, unlike a button row where `.components[N]`
 * IS each rendered button -- easy to conflate, so this is factored out once
 * rather than risking the mistake per call site.
 */
function firstOptionLabel(row: unknown): string {
  const json = (row as { toJSON: () => { components: { options: { label: string }[] }[] } }).toJSON();
  return json.components[0]!.options[0]!.label;
}

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let staff: ReturnType<typeof mockMember>;
let outgoing: ReturnType<typeof mockMember>;
let bench: ReturnType<typeof mockMember>;

function createPublishedPickup(eligibilityRoleId: string | null = null): Pickup {
  const pickup = new PickupRepository(db).create({
    guildId,
    createdBy: staff.id,
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    eligibilityRoleId,
  });
  new PickupRepository(db).transitionStatusFromAny(pickup.id, ['open'], 'published');
  return new PickupRepository(db).byId(pickup.id)!;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  authorizedRoleId = fakeId();
  new GuildConfigRepository(db).setField(guildId, 'authorized_role_ids', [authorizedRoleId]);
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
    const unauthorized = mockMember({ roleIds: [] });
    const interaction = mockComponentInteraction({ guildId, member: unauthorized, userId: unauthorized.id });
    await handleReplaceComponent(interaction, { action: 'rep', pickupId: 1, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }),
    );
  });

  describe('Replace (step 1 -- pick the slot)', () => {
    it('refuses a pickup that has not been published yet', async () => {
      const pickup = new PickupRepository(db).create({
        guildId, createdBy: staff.id, format: 'pickup_vs_pickup',
        startAt: Math.floor(Date.now() / 1000) + 3600, roleLimit: 2,
      });
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Edit Roster') }),
      );
    });

    it('refuses a cancelled pickup', async () => {
      const pickup = createPublishedPickup();
      new PickupRepository(db).transitionStatusFromAny(pickup.id, ['published'], 'cancelled');
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('no roster to change') }),
      );
    });

    it('refuses a finished pickup', async () => {
      const pickup = createPublishedPickup();
      new PickupRepository(db).transitionStatusFromAny(pickup.id, ['published'], 'finished');
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReplaceComponent(interaction, { action: 'rep', pickupId: pickup.id, args: [] });

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('closed to further changes') }),
      );
    });

    it('reports no slots when the roster is empty', async () => {
      const pickup = createPublishedPickup();
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
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
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });
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
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });
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

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already holds a slot') }),
      );
    });

    it('re-checks the optional eligibility role before committing a published replacement', async () => {
      const eligibilityRoleId = fakeId();
      const pickup = createPublishedPickup(eligibilityRoleId);
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;
      const guild = mockGuild({ id: guildId, members: [bench] });
      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id, guild });

      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('does not hold'),
      }));
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
    });

    it('refuses on a version conflict rather than overwriting an unseen edit', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      // commitReplacement reads the pickup fresh immediately before its own
      // bumpVersion call, with no await between the two -- so within a single
      // process there is no window for another write to land in between and
      // make that call fail honestly. Forcing the return value is the direct
      // way to test this branch's own behavior (the message it shows, that it
      // touches nothing) without depending on how the race is actually
      // triggered in production (cross-process contention on the same DB file).
      const bumpVersionSpy = vi.spyOn(PickupRepository.prototype, 'bumpVersion').mockReturnValue(false);

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Reopen') }),
      );
      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(outgoing.id);
      bumpVersionSpy.mockRestore();
    });

    it('commits the replacement, edits the public roster, and posts a notice', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const rosterChannelId = fakeId();
      new GuildConfigRepository(db).setField(guildId, 'roster_channel_id', rosterChannelId);
      const rosterMessage = mockMessage();
      new PickupRepository(db).setMessageIds(pickup.id, { rosterMessageId: rosterMessage.id });
      const rosterChannel = mockTextChannel({ messages: { [rosterMessage.id]: rosterMessage } });

      const client = { channels: { fetch: async (id: string) => (id === rosterChannelId ? rosterChannel : null) } };
      const interaction = mockComponentInteraction({
        guildId, member: staff, userId: staff.id, client,
      });
      await handleReplaceComponent(interaction, {
        action: 'repcf', pickupId: pickup.id, args: [String(slotId), bench.id, 'yes'],
      });

      expect(new RosterSlotRepository(db).forPickup(pickup.id)[0]!.userId).toBe(bench.id);
      expect(rosterMessage.edit).toHaveBeenCalled();
      expect(rosterChannel.send).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Done') }),
      );
    });

    it('still commits and reports success when no roster channel is configured', async () => {
      const pickup = createPublishedPickup();
      new RosterSlotRepository(db).replaceAll(pickup.id, [
        { team: 'order', role: 'solo', userId: outgoing.id },
      ]);
      const slotId = new RosterSlotRepository(db).forPickup(pickup.id)[0]!.id;

      const interaction = mockComponentInteraction({ guildId, member: staff, userId: staff.id });
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
    const pickup = createPublishedPickup(eligibilityRoleId);
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
