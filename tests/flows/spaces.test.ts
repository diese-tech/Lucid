/**
 * Flow tests for /pickup space create|edit|list|delete -- src/discord/flows/spaces.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { PickupSpaceRepository } from '../../src/db/repositories/pickup-spaces.js';
import type { PickupSpace } from '../../src/db/repositories/types.js';
import {
  handleSpaceAutocomplete,
  handleSpaceCommand,
  handleSpaceComponent,
  handleSpaceModal,
} from '../../src/discord/flows/spaces.js';
import {
  fakeId,
  mockAutocompleteInteraction,
  mockChatInputInteraction,
  mockComponentInteraction,
  mockModalInteraction,
} from '../helpers/discord-mocks.js';

let db: Database.Database;
let guildId: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
});

const NO_MANAGE_GUILD = 'You need the **Manage Server** permission to manage Pickup Spaces.';

describe('handleSpaceCommand', () => {
  it('refuses without the Manage Server permission', async () => {
    const interaction = mockChatInputInteraction({
      guildId,
      memberPermissions: [],
      subcommand: 'create',
      stringOptions: { name: 'Public Pickups' },
    });
    await handleSpaceCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: NO_MANAGE_GUILD }),
    );
    expect(new PickupSpaceRepository(db).list(guildId)).toHaveLength(0);
  });

  describe('create', () => {
    it('creates a space and shows the channels panel', async () => {
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'create',
        stringOptions: { name: 'Public Pickups' },
      });
      await handleSpaceCommand(interaction);

      const spaces = new PickupSpaceRepository(db).list(guildId);
      expect(spaces).toHaveLength(1);
      expect(spaces[0]!.name).toBe('Public Pickups');

      const [payload] = interaction.reply.mock.calls[0]! as [{ content: string; components: unknown[] }];
      expect(payload.content).toContain('Public Pickups');
      expect(payload.components).toHaveLength(5);
    });

    it('refuses a blank name', async () => {
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'create',
        stringOptions: { name: '   ' },
      });
      await handleSpaceCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('name') }),
      );
      expect(new PickupSpaceRepository(db).list(guildId)).toHaveLength(0);
    });

    it('refuses a duplicate name in the same guild', async () => {
      new PickupSpaceRepository(db).create({ guildId, name: 'Public Pickups' });
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'create',
        stringOptions: { name: 'Public Pickups' },
      });
      await handleSpaceCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already exists') }),
      );
      expect(new PickupSpaceRepository(db).list(guildId)).toHaveLength(1);
    });
  });

  describe('edit', () => {
    it('shows the panel for an existing space', async () => {
      new PickupSpaceRepository(db).create({ guildId, name: 'Public Pickups' });
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'edit',
        stringOptions: { space: 'Public Pickups' },
      });
      await handleSpaceCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Public Pickups') }),
      );
    });

    it('reports an unknown space name', async () => {
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'edit',
        stringOptions: { space: 'Nope' },
      });
      await handleSpaceCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No Pickup Space named') }),
      );
    });
  });

  describe('list', () => {
    it('reports when there are no spaces yet', async () => {
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'list',
      });
      await handleSpaceCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No Pickup Spaces yet') }),
      );
    });

    it('marks a complete space and an incomplete one differently', async () => {
      const repo = new PickupSpaceRepository(db);
      const complete = repo.create({ guildId, name: 'Complete' });
      if (!complete.ok) throw new Error('setup failed');
      repo.setField(complete.space.id, 'origin_channel_id', fakeId());
      repo.setField(complete.space.id, 'signup_channel_id', fakeId());
      repo.setField(complete.space.id, 'roster_channel_id', fakeId());
      repo.setField(complete.space.id, 'review_channel_id', fakeId());
      repo.setField(complete.space.id, 'authorized_role_ids', [fakeId()]);
      repo.create({ guildId, name: 'Incomplete' });

      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'list',
      });
      await handleSpaceCommand(interaction);

      const [payload] = interaction.reply.mock.calls[0]! as [{ content: string }];
      expect(payload.content).toContain('✅ **Complete**');
      expect(payload.content).toContain('⬜ **Incomplete**');
    });

    it('truncates rather than exceeding Discord\'s 2000-character message limit', async () => {
      // codex review finding on PR #38: an unbounded list of enough spaces
      // (each name up to the 90-character maximum) can exceed Discord's
      // message limit and make /pickup space list fail outright.
      const repo = new PickupSpaceRepository(db);
      for (let i = 0; i < 60; i += 1) {
        repo.create({ guildId, name: `Space with a fairly long descriptive name number ${i}`.padEnd(80, '-') });
      }

      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'list',
      });
      await handleSpaceCommand(interaction);

      const [payload] = interaction.reply.mock.calls[0]! as [{ content: string }];
      expect(payload.content.length).toBeLessThan(2000);
      expect(payload.content).toContain('more. Use `/pickup space edit');
    });

    it('does not add a truncation note when every space fits', async () => {
      new PickupSpaceRepository(db).create({ guildId, name: 'Public Pickups' });

      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'list',
      });
      await handleSpaceCommand(interaction);

      const [payload] = interaction.reply.mock.calls[0]! as [{ content: string }];
      expect(payload.content).not.toContain('more. Use `/pickup space edit');
    });
  });

  describe('delete', () => {
    it('reports an unknown space name', async () => {
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'delete',
        stringOptions: { space: 'Nope' },
      });
      await handleSpaceCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No Pickup Space named') }),
      );
    });

    it('asks for confirmation on an unused space', async () => {
      new PickupSpaceRepository(db).create({ guildId, name: 'Public Pickups' });
      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'delete',
        stringOptions: { space: 'Public Pickups' },
      });
      await handleSpaceCommand(interaction);

      const [payload] = interaction.reply.mock.calls[0]! as [{ content: string; components: unknown[] }];
      expect(payload.content).toContain('Delete **Public Pickups**?');
      expect(payload.components).toHaveLength(1);
    });

    it('refuses a space that has pickups on record', async () => {
      const repo = new PickupSpaceRepository(db);
      const result = repo.create({ guildId, name: 'Public Pickups' });
      if (!result.ok) throw new Error('setup failed');
      repo.setField(result.space.id, 'origin_channel_id', fakeId());
      repo.setField(result.space.id, 'signup_channel_id', fakeId());
      repo.setField(result.space.id, 'roster_channel_id', fakeId());
      repo.setField(result.space.id, 'review_channel_id', fakeId());
      new PickupRepository(db).create({
        guildId,
        createdBy: 'staff',
        format: 'pickup_vs_pickup',
        startAt: Math.floor(Date.now() / 1000) + 3600,
        roleLimit: 2,
        pickupSpaceId: result.space.id,
        originChannelId: result.space.originChannelId,
        signupChannelId: result.space.signupChannelId!,
        rosterChannelId: result.space.rosterChannelId!,
        reviewChannelId: result.space.reviewChannelId!,
      });

      const interaction = mockChatInputInteraction({
        guildId,
        memberPermissions: ['ManageGuild'],
        subcommand: 'delete',
        stringOptions: { space: 'Public Pickups' },
      });
      await handleSpaceCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("can't be deleted") }),
      );
    });
  });
});

describe('handleSpaceComponent', () => {
  let space: PickupSpace;

  beforeEach(() => {
    const result = new PickupSpaceRepository(db).create({ guildId, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    space = result.space;
  });

  it('refuses without the Manage Server permission', async () => {
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: [],
      kind: 'channel-select',
      values: [fakeId()],
    });
    await handleSpaceComponent(interaction, { action: 'spc', pickupId: space.id, args: ['origin_channel_id'] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: NO_MANAGE_GUILD }),
    );
  });

  it('commits a channel select immediately and re-renders the channels page', async () => {
    const channelId = fakeId();
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'channel-select',
      values: [channelId],
    });
    await handleSpaceComponent(interaction, { action: 'spc', pickupId: space.id, args: ['origin_channel_id'] });

    expect(new PickupSpaceRepository(db).get(space.id)?.originChannelId).toBe(channelId);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Public Pickups') }),
    );
  });

  it('commits a non-origin channel select without checking for a collision', async () => {
    const channelId = fakeId();
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'channel-select',
      values: [channelId],
    });
    await handleSpaceComponent(interaction, { action: 'spc', pickupId: space.id, args: ['signup_channel_id'] });

    expect(new PickupSpaceRepository(db).get(space.id)?.signupChannelId).toBe(channelId);
  });

  it("refuses an origin channel already claimed by another space, rather than resolving /pickup create arbitrarily", async () => {
    // codex review finding on PR #38: byOriginChannel() does an unconstrained
    // lookup, so two spaces sharing one origin channel would make /pickup
    // create's space resolution arbitrary -- applying the wrong space's
    // authorization, eligibility and routing to a new pickup.
    const repo = new PickupSpaceRepository(db);
    const claimedChannelId = fakeId();
    const other = repo.create({ guildId, name: 'Restricted Lane' });
    if (!other.ok) throw new Error('setup failed');
    repo.setField(other.space.id, 'origin_channel_id', claimedChannelId);

    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'channel-select',
      values: [claimedChannelId],
    });
    await handleSpaceComponent(interaction, { action: 'spc', pickupId: space.id, args: ['origin_channel_id'] });

    expect(repo.get(space.id)?.originChannelId).toBeNull();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('already the origin channel for **Restricted Lane**'),
      }),
    );
  });

  it('allows re-selecting the same channel a space already owns as its own origin channel', async () => {
    const repo = new PickupSpaceRepository(db);
    const channelId = fakeId();
    repo.setField(space.id, 'origin_channel_id', channelId);

    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'channel-select',
      values: [channelId],
    });
    await handleSpaceComponent(interaction, { action: 'spc', pickupId: space.id, args: ['origin_channel_id'] });

    expect(repo.get(space.id)?.originChannelId).toBe(channelId);
    expect(interaction.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already the origin channel') }),
    );
  });

  it('shows the "just claimed" warning when migration 007\'s unique index catches a race the pre-check missed', async () => {
    // The app-level pre-check above (byOriginChannel before setField) is only
    // a courtesy -- it cannot see another admin's edit that lands in the gap
    // between the check and the write. Simulate that gap directly: make the
    // pre-check's own lookup the moment the other space claims the channel,
    // so byOriginChannel still (correctly, at that instant) reports it free,
    // and only the real UNIQUE index from migration 007 catches the race.
    const repo = new PickupSpaceRepository(db);
    const channelId = fakeId();
    const other = repo.create({ guildId, name: 'Sniper Lane' });
    if (!other.ok) throw new Error('setup failed');

    const spy = vi
      .spyOn(PickupSpaceRepository.prototype, 'byOriginChannel')
      .mockImplementationOnce(() => {
        repo.setField(other.space.id, 'origin_channel_id', channelId);
        return null;
      });

    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'channel-select',
      values: [channelId],
    });
    await handleSpaceComponent(interaction, { action: 'spc', pickupId: space.id, args: ['origin_channel_id'] });

    spy.mockRestore();

    expect(repo.get(space.id)?.originChannelId).toBeNull();
    expect(repo.get(other.space.id)?.originChannelId).toBe(channelId);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('was just claimed as the origin channel for **Sniper Lane**'),
      }),
    );
  });

  it('stores authorized_role_ids as the full multi-select list', async () => {
    const roleA = fakeId();
    const roleB = fakeId();
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'role-select',
      values: [roleA, roleB],
    });
    await handleSpaceComponent(interaction, { action: 'spr', pickupId: space.id, args: ['authorized_role_ids'] });

    expect(new PickupSpaceRepository(db).get(space.id)?.authorizedRoleIds).toEqual([roleA, roleB]);
  });

  it('stores an optional single-select role field as one ID', async () => {
    const roleId = fakeId();
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'role-select',
      values: [roleId],
    });
    await handleSpaceComponent(interaction, { action: 'spr', pickupId: space.id, args: ['signup_ping_role_id'] });

    expect(new PickupSpaceRepository(db).get(space.id)?.signupPingRoleId).toBe(roleId);
  });

  it('stores the organizer ping role, and shows it configurable on the roles panel (codex review finding on PR #50)', async () => {
    // The column existed since the notification-substrate work landed, but
    // nothing in /pickup space edit ever exposed a select for it -- every
    // pickup snapshotted null regardless of what staff wanted, and
    // availability alerts could only ever ping the pickup's creator.
    const roleId = fakeId();
    const interaction = mockComponentInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      kind: 'role-select',
      values: [roleId],
    });
    await handleSpaceComponent(interaction, { action: 'spr', pickupId: space.id, args: ['organizer_ping_role_id'] });

    expect(new PickupSpaceRepository(db).get(space.id)?.organizerPingRoleId).toBe(roleId);
    const [payload] = interaction.update.mock.calls.at(-1)! as [{ content: string }];
    expect(payload.content).toContain('Organizer ping role');
    expect(payload.content).toContain(`<@&${roleId}>`);
  });

  it('switches to the roles page on "Next: Roles" and back on "Back: Channels"', async () => {
    const more = mockComponentInteraction({ guildId, memberPermissions: ['ManageGuild'], kind: 'button' });
    await handleSpaceComponent(more, { action: 'spm', pickupId: space.id, args: [] });
    const [morePayload] = more.update.mock.calls[0]! as [{ content: string }];
    expect(morePayload.content).toContain('Authorized staff roles');

    const back = mockComponentInteraction({ guildId, memberPermissions: ['ManageGuild'], kind: 'button' });
    await handleSpaceComponent(back, { action: 'spb', pickupId: space.id, args: [] });
    const [backPayload] = back.update.mock.calls[0]! as [{ content: string }];
    expect(backPayload.content).toContain('Origin channel');
  });

  it('opens a rename modal', async () => {
    const interaction = mockComponentInteraction({ guildId, memberPermissions: ['ManageGuild'], kind: 'button' });
    await handleSpaceComponent(interaction, { action: 'spn', pickupId: space.id, args: [] });

    expect(interaction.showModal).toHaveBeenCalled();
  });

  it('treats a missing space as expired for any component action', async () => {
    const interaction = mockComponentInteraction({ guildId, memberPermissions: ['ManageGuild'], kind: 'button' });
    await handleSpaceComponent(interaction, { action: 'spm', pickupId: 999999, args: [] });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer exists') }),
    );
  });

  describe('SpaceDeleteConfirm', () => {
    it('deletes an unused space on "yes"', async () => {
      const interaction = mockComponentInteraction({ guildId, memberPermissions: ['ManageGuild'], kind: 'button' });
      await handleSpaceComponent(interaction, { action: 'spdc', pickupId: space.id, args: ['yes'] });

      expect(new PickupSpaceRepository(db).get(space.id)).toBeNull();
      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('was deleted') }),
      );
    });

    it('changes nothing on "no"', async () => {
      const interaction = mockComponentInteraction({ guildId, memberPermissions: ['ManageGuild'], kind: 'button' });
      await handleSpaceComponent(interaction, { action: 'spdc', pickupId: space.id, args: ['no'] });

      expect(new PickupSpaceRepository(db).get(space.id)).not.toBeNull();
      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Nothing was deleted.' }),
      );
    });

    it('refuses when a pickup was created in this space after the confirmation was shown', async () => {
      const repo = new PickupSpaceRepository(db);
      repo.setField(space.id, 'origin_channel_id', fakeId());
      repo.setField(space.id, 'signup_channel_id', fakeId());
      repo.setField(space.id, 'roster_channel_id', fakeId());
      repo.setField(space.id, 'review_channel_id', fakeId());
      const current = repo.get(space.id)!;
      new PickupRepository(db).create({
        guildId,
        createdBy: 'staff',
        format: 'pickup_vs_pickup',
        startAt: Math.floor(Date.now() / 1000) + 3600,
        roleLimit: 2,
        pickupSpaceId: current.id,
        originChannelId: current.originChannelId,
        signupChannelId: current.signupChannelId!,
        rosterChannelId: current.rosterChannelId!,
        reviewChannelId: current.reviewChannelId!,
      });

      const interaction = mockComponentInteraction({ guildId, memberPermissions: ['ManageGuild'], kind: 'button' });
      await handleSpaceComponent(interaction, { action: 'spdc', pickupId: space.id, args: ['yes'] });

      expect(repo.get(space.id)).not.toBeNull();
      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('can no longer be deleted') }),
      );
    });
  });
});

describe('handleSpaceModal (rename)', () => {
  let space: PickupSpace;

  beforeEach(() => {
    const result = new PickupSpaceRepository(db).create({ guildId, name: 'Public Pickups' });
    if (!result.ok) throw new Error('setup failed');
    space = result.space;
  });

  it('refuses without the Manage Server permission', async () => {
    const interaction = mockModalInteraction({
      guildId,
      memberPermissions: [],
      fields: { name: 'Renamed' },
    });
    await handleSpaceModal(interaction, { action: 'spnm', pickupId: space.id, args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: NO_MANAGE_GUILD }),
    );
    expect(new PickupSpaceRepository(db).get(space.id)?.name).toBe('Public Pickups');
  });

  it('renames the space', async () => {
    const interaction = mockModalInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      fields: { name: 'Renamed' },
    });
    await handleSpaceModal(interaction, { action: 'spnm', pickupId: space.id, args: [] });

    expect(new PickupSpaceRepository(db).get(space.id)?.name).toBe('Renamed');
  });

  it('refuses a rename that collides with another space in the same guild', async () => {
    new PickupSpaceRepository(db).create({ guildId, name: 'Taken' });
    const interaction = mockModalInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      fields: { name: 'Taken' },
    });
    await handleSpaceModal(interaction, { action: 'spnm', pickupId: space.id, args: [] });

    expect(new PickupSpaceRepository(db).get(space.id)?.name).toBe('Public Pickups');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already exists') }),
    );
  });

  it('allows renaming a space to the name it already has', async () => {
    const interaction = mockModalInteraction({
      guildId,
      memberPermissions: ['ManageGuild'],
      fields: { name: 'Public Pickups' },
    });
    await handleSpaceModal(interaction, { action: 'spnm', pickupId: space.id, args: [] });

    expect(new PickupSpaceRepository(db).get(space.id)?.name).toBe('Public Pickups');
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already exists') }),
    );
  });
});

describe('handleSpaceAutocomplete', () => {
  it('suggests spaces matching the typed query', async () => {
    new PickupSpaceRepository(db).create({ guildId, name: 'Public Pickups' });
    new PickupSpaceRepository(db).create({ guildId, name: 'Restricted Lane' });

    const interaction = mockAutocompleteInteraction({ guildId, focusedName: 'space', focusedValue: 'pub' });
    await handleSpaceAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([{ name: 'Public Pickups', value: 'Public Pickups' }]);
  });

  it('responds with nothing for an unrelated focused option', async () => {
    const interaction = mockAutocompleteInteraction({ guildId, focusedName: 'name', focusedValue: 'anything' });
    await handleSpaceAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});
