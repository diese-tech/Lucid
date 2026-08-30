/**
 * Flow tests for /pickup create -- src/discord/flows/create.ts.
 *
 * The wizard keeps its draft state in a module-level Map, keyed by a random
 * draft ID embedded in every component/modal custom ID it renders (never in
 * decoded.pickupId -- see draftIdFrom's own comment on why). Tests recover
 * that ID the same way Discord itself would hand it back: by reading it off
 * the real customId produced by the builders in the previous step's reply,
 * via extractDraftId() below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ActionRowBuilder } from 'discord.js';

import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { GuildConfigRepository } from '../../src/db/repositories/guild-config.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { UNAUTHORIZED_MESSAGE } from '../../src/discord/permissions.js';
import {
  handleCreateCommand,
  handleCreateComponent,
  handleCreateModal,
} from '../../src/discord/flows/create.js';
import {
  fakeId,
  mockChatInputInteraction,
  mockClient,
  mockComponentInteraction,
  mockMember,
  mockModalInteraction,
  mockTextChannel,
} from '../helpers/discord-mocks.js';

let db: Database.Database;
let guildId: string;
let authorizedRoleId: string;
let coordinator: ReturnType<typeof mockMember>;
let signupChannelId: string;
let reviewChannelId: string;

/** Pulls the wizard's draft ID off the real customId of its first rendered component. */
function extractDraftId(components: ActionRowBuilder[]): string {
  const row = components[0]!.toJSON() as { components: { custom_id: string }[] };
  const [, draftId] = row.components[0]!.custom_id.split(':');
  return draftId!;
}

function fullyConfigure(): void {
  const config = new GuildConfigRepository(db);
  config.setField(guildId, 'signup_channel_id', signupChannelId);
  config.setField(guildId, 'roster_channel_id', fakeId());
  config.setField(guildId, 'review_channel_id', reviewChannelId);
  config.setField(guildId, 'authorized_role_ids', [authorizedRoleId]);
  config.setAllEmoji(guildId, {
    solo: fakeId(),
    jungle: fakeId(),
    mid: fakeId(),
    support: fakeId(),
    carry: fakeId(),
  });
}

/** Runs the command and returns the draft ID the wizard assigned. */
async function openWizard() {
  const interaction = mockChatInputInteraction({ guildId, member: coordinator, userId: coordinator.id });
  await handleCreateCommand(interaction);
  const payload = interaction.reply.mock.calls[0]![0] as { components: ActionRowBuilder[] };
  return { draftId: extractDraftId(payload.components), interaction };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  guildId = fakeId();
  signupChannelId = fakeId();
  reviewChannelId = fakeId();
  authorizedRoleId = fakeId();
  coordinator = mockMember({ roleIds: [authorizedRoleId] });
});

afterEach(() => {
  setDatabaseForTesting(null);
  db.close();
  vi.restoreAllMocks();
});

describe('handleCreateCommand', () => {
  it('refuses outside a server', async () => {
    const interaction = mockChatInputInteraction({ guildId: null, member: coordinator });
    await handleCreateCommand(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Run this inside a server.' }),
    );
  });

  it('refuses an unauthorized coordinator', async () => {
    const stranger = mockMember({ roleIds: [] });
    fullyConfigure();
    const interaction = mockChatInputInteraction({ guildId, member: stranger });
    await handleCreateCommand(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: UNAUTHORIZED_MESSAGE }));
  });

  it('lists exactly what is missing when the guild is not fully configured', async () => {
    new GuildConfigRepository(db).setField(guildId, 'authorized_role_ids', [authorizedRoleId]);
    const interaction = mockChatInputInteraction({ guildId, member: coordinator });
    await handleCreateCommand(interaction);

    const [payload] = interaction.reply.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('not fully configured');
    expect(payload.content).toContain('signup channel');
  });

  it('opens the wizard with sensible defaults once fully configured', async () => {
    fullyConfigure();
    const { interaction } = await openWizard();

    const [payload] = interaction.reply.mock.calls[0]! as [{ content: string; flags?: number }];
    expect(payload.content).toContain('Pickup vs Pickup');
    expect(payload.content).toContain('2 roles');
    expect(payload.content).toContain('_not set_');
  });
});

describe('handleCreateComponent', () => {
  beforeEach(fullyConfigure);

  it('treats an unknown draft as expired', async () => {
    const interaction = mockComponentInteraction({
      guildId,
      member: coordinator, userId: coordinator.id,
      kind: 'string-select',
      customId: 'cf:999999999999',
      values: ['pickup_vs_premade'],
    });
    await handleCreateComponent(interaction, { action: 'cf', pickupId: 999999999999, args: [] });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer active') }),
    );
  });

  it("refuses a component click from someone other than the wizard's owner", async () => {
    const { draftId } = await openWizard();
    const stranger = mockMember({ roleIds: [] });
    const interaction = mockComponentInteraction({
      guildId,
      member: stranger,
      kind: 'string-select',
      customId: `cf:${draftId}`,
      values: ['pickup_vs_premade'],
    });
    await handleCreateComponent(interaction, { action: 'cf', pickupId: Number(draftId), args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'That setup belongs to someone else.' }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('switches format and clears the premade name when leaving Pickup vs Premade', async () => {
    const { draftId } = await openWizard();

    await handleCreateComponent(
      mockComponentInteraction({
        guildId, member: coordinator, userId: coordinator.id, kind: 'string-select', customId: `cf:${draftId}`, values: ['pickup_vs_premade'],
      }),
      { action: 'cf', pickupId: Number(draftId), args: [] },
    );
    await handleCreateComponent(
      mockModalInteraction({
        guildId, member: coordinator, userId: coordinator.id, customId: `cdm:${draftId}`,
        fields: { start_time: 'tomorrow at 8pm', note: '', premade_name: 'Dream Walkers' },
      }) as never,
      { action: 'cdm', pickupId: Number(draftId), args: [] },
    );

    const backToPickup = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'string-select', customId: `cf:${draftId}`, values: ['pickup_vs_pickup'],
    });
    await handleCreateComponent(backToPickup, { action: 'cf', pickupId: Number(draftId), args: [] });

    const [payload] = backToPickup.update.mock.calls[0]! as [{ content: string }];
    expect(payload.content).not.toContain('Dream Walkers');
  });

  it('ignores a CreateFormat event that is not actually a select menu', async () => {
    const { draftId } = await openWizard();
    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cf:${draftId}`,
    });
    await handleCreateComponent(interaction, { action: 'cf', pickupId: Number(draftId), args: [] });
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('sets the role limit from the select value', async () => {
    const { draftId } = await openWizard();
    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'string-select', customId: `crl:${draftId}`, values: ['1'],
    });
    await handleCreateComponent(interaction, { action: 'crl', pickupId: Number(draftId), args: [] });

    const [payload] = interaction.update.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('1 role');
  });

  it('opens the details modal', async () => {
    const { draftId } = await openWizard();
    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cod:${draftId}`,
    });
    await handleCreateComponent(interaction, { action: 'cod', pickupId: Number(draftId), args: [] });
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
  });

  it('returns to the wizard on Edit, keeping earlier answers', async () => {
    const { draftId } = await openWizard();
    await handleCreateComponent(
      mockComponentInteraction({
        guildId, member: coordinator, userId: coordinator.id, kind: 'string-select', customId: `crl:${draftId}`, values: ['1'],
      }),
      { action: 'crl', pickupId: Number(draftId), args: [] },
    );

    const editInteraction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `ce:${draftId}`,
    });
    await handleCreateComponent(editInteraction, { action: 'ce', pickupId: Number(draftId), args: [] });

    const [payload] = editInteraction.update.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('1 role');
  });

  it('cancelling deletes the draft, so a later click on it is treated as expired', async () => {
    const { draftId } = await openWizard();
    const cancelInteraction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cc:${draftId}`,
    });
    await handleCreateComponent(cancelInteraction, { action: 'cc', pickupId: Number(draftId), args: [] });
    expect(cancelInteraction.update).toHaveBeenCalledWith({ content: 'Cancelled.', components: [] });

    const afterCancel = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cod:${draftId}`,
    });
    await handleCreateComponent(afterCancel, { action: 'cod', pickupId: Number(draftId), args: [] });
    expect(afterCancel.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer active') }),
    );
  });

  it('does nothing for an action it does not recognize', async () => {
    const { draftId } = await openWizard();
    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `zz:${draftId}`,
    });
    await handleCreateComponent(interaction, { action: 'zz', pickupId: Number(draftId), args: [] });
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe('handleCreateModal', () => {
  beforeEach(fullyConfigure);

  it('treats an unknown draft as expired', async () => {
    const interaction = mockModalInteraction({
      guildId, member: coordinator, userId: coordinator.id, customId: 'cdm:999999999999',
      fields: { start_time: 'tomorrow at 8pm' },
    });
    await handleCreateModal(interaction, { action: 'cdm', pickupId: 999999999999, args: [] });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer active') }),
    );
  });

  it("refuses a submission from someone other than the wizard's owner", async () => {
    const { draftId } = await openWizard();
    const stranger = mockMember({ roleIds: [] });
    const interaction = mockModalInteraction({
      guildId, member: stranger, customId: `cdm:${draftId}`, fields: { start_time: 'tomorrow at 8pm' },
    });
    await handleCreateModal(interaction, { action: 'cdm', pickupId: Number(draftId), args: [] });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'That setup belongs to someone else.' }),
    );
  });

  it('rejects an unparseable start time and leaves the draft postable-blocked', async () => {
    const { draftId } = await openWizard();
    const interaction = mockModalInteraction({
      guildId, member: coordinator, userId: coordinator.id, customId: `cdm:${draftId}`,
      fields: { start_time: 'not a time at all, sorry', note: '' },
    });
    await handleCreateModal(interaction, { action: 'cdm', pickupId: Number(draftId), args: [] });

    const [payload] = interaction.reply.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('Edit details');

    // startAt was never set, so trying to post still refuses.
    const postInteraction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`,
    });
    await handleCreateComponent(postInteraction, { action: 'cp', pickupId: Number(draftId), args: [] });
    expect(postInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Enter a start time before posting.' }),
    );
  });

  it('accepts a valid start time and shows the preview, suppressing real pings', async () => {
    const { draftId } = await openWizard();
    const interaction = mockModalInteraction({
      guildId, member: coordinator, userId: coordinator.id, customId: `cdm:${draftId}`,
      fields: { start_time: 'tomorrow at 8pm', note: 'bring your A game' },
    });
    (interaction as unknown as { isFromMessage: () => boolean }).isFromMessage = () => true;
    await handleCreateModal(interaction, { action: 'cdm', pickupId: Number(draftId), args: [] });

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Pickup games at'),
        allowedMentions: { parse: [] },
      }),
    );
  });

  it('replies instead of updating when the modal was not opened from the wizard message', async () => {
    const { draftId } = await openWizard();
    const interaction = mockModalInteraction({
      guildId, member: coordinator, userId: coordinator.id, customId: `cdm:${draftId}`,
      fields: { start_time: 'tomorrow at 8pm', note: '' },
    });
    (interaction as unknown as { isFromMessage: () => boolean }).isFromMessage = () => false;
    await handleCreateModal(interaction, { action: 'cdm', pickupId: Number(draftId), args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.any(Number) }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('trims the optional note and premade name, treating blank as unset', async () => {
    await new GuildConfigRepository(db).get(guildId); // sanity: config exists
    const { draftId } = await openWizard();
    await handleCreateComponent(
      mockComponentInteraction({
        guildId, member: coordinator, userId: coordinator.id, kind: 'string-select', customId: `cf:${draftId}`, values: ['pickup_vs_premade'],
      }),
      { action: 'cf', pickupId: Number(draftId), args: [] },
    );

    const interaction = mockModalInteraction({
      guildId, member: coordinator, userId: coordinator.id, customId: `cdm:${draftId}`,
      fields: { start_time: 'tomorrow at 8pm', note: '   ', premade_name: '  Dream Walkers  ' },
    });
    await handleCreateModal(interaction, { action: 'cdm', pickupId: Number(draftId), args: [] });

    const [payload] = interaction.reply.mock.calls[0]! as [{ content: string }];
    expect(payload.content).toContain('Dream Walkers');
  });
});

describe('CreatePost (posting a pickup)', () => {
  beforeEach(fullyConfigure);

  async function draftReadyToPost() {
    const { draftId } = await openWizard();
    const modal = mockModalInteraction({
      guildId, member: coordinator, userId: coordinator.id, customId: `cdm:${draftId}`,
      fields: { start_time: 'tomorrow at 8pm', note: '' },
    });
    await handleCreateModal(modal, { action: 'cdm', pickupId: Number(draftId), args: [] });
    return draftId;
  }

  it('refuses when the configured channels have disappeared since the wizard opened', async () => {
    const draftId = await draftReadyToPost();
    new GuildConfigRepository(db).setField(guildId, 'signup_channel_id', null);

    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`,
    });
    await handleCreateComponent(interaction, { action: 'cp', pickupId: Number(draftId), args: [] });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer configured') }),
    );
  });

  it('posts the signup message, seeds all five reactions in role order, and posts the control card', async () => {
    const draftId = await draftReadyToPost();
    const signupChannel = mockTextChannel();
    const reviewChannel = mockTextChannel();
    const client = mockClient({ channels: { [signupChannelId]: signupChannel, [reviewChannelId]: reviewChannel } });

    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`, client,
    });
    await handleCreateComponent(interaction, { action: 'cp', pickupId: Number(draftId), args: [] });

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(signupChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Pickup games at') }),
    );

    const posted = new PickupRepository(db).cancellable(guildId);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.signupMessageId).toBeTruthy();
    expect(posted[0]!.reviewMessageId).toBeTruthy();

    expect(reviewChannel.send).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Pickup posted:') }),
    );

    // Draft consumed -- clicking Post again on the same ID is now "expired".
    const again = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`, client,
    });
    await handleCreateComponent(again, { action: 'cp', pickupId: Number(draftId), args: [] });
    expect(again.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer active') }),
    );
  });

  it('leaves no pickup row behind when the signup channel is not sendable', async () => {
    const draftId = await draftReadyToPost();
    const client = mockClient({
      channels: { [signupChannelId]: mockTextChannel({ isTextBased: false }) },
    });
    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`, client,
    });
    await handleCreateComponent(interaction, { action: 'cp', pickupId: Number(draftId), args: [] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('cannot post') }),
    );
    expect(new PickupRepository(db).cancellable(guildId)).toHaveLength(0);
  });

  it('leaves no pickup row behind when sending the signup message throws', async () => {
    const draftId = await draftReadyToPost();
    const signupChannel = mockTextChannel();
    signupChannel.send = vi.fn(async () => {
      throw new Error('simulated Discord outage');
    });
    const client = mockClient({ channels: { [signupChannelId]: signupChannel } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`, client,
    });
    await handleCreateComponent(interaction, { action: 'cp', pickupId: Number(draftId), args: [] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Couldn't post the signup message") }),
    );
    expect(new PickupRepository(db).cancellable(guildId)).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('still fully posts the pickup even if one reaction fails on every retry', async () => {
    vi.useFakeTimers();
    try {
      const draftId = await draftReadyToPost();
      const signupChannel = mockTextChannel();
      const signupMessage = (await signupChannel.send({ content: '' })) as unknown as {
        id: string;
        react: ReturnType<typeof vi.fn>;
      };
      signupChannel.send = vi.fn(async () => signupMessage);
      signupMessage.react = vi.fn(async () => {
        throw new Error('rate limited');
      });
      const client = mockClient({ channels: { [signupChannelId]: signupChannel, [reviewChannelId]: mockTextChannel() } });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const interaction = mockComponentInteraction({
        guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`, client,
      });
      const done = handleCreateComponent(interaction, { action: 'cp', pickupId: Number(draftId), args: [] });
      await vi.runAllTimersAsync();
      await done;

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Pickup posted:') }),
      );
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports success even when the staff control card fails to post', async () => {
    const draftId = await draftReadyToPost();
    const signupChannel = mockTextChannel();
    const reviewChannel = mockTextChannel({ isTextBased: false }); // not sendable
    const client = mockClient({ channels: { [signupChannelId]: signupChannel, [reviewChannelId]: reviewChannel } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const interaction = mockComponentInteraction({
      guildId, member: coordinator, userId: coordinator.id, kind: 'button', customId: `cp:${draftId}`, client,
    });
    await handleCreateComponent(interaction, { action: 'cp', pickupId: Number(draftId), args: [] });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Pickup posted:') }),
    );
    const posted = new PickupRepository(db).cancellable(guildId);
    expect(posted[0]!.reviewMessageId).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
