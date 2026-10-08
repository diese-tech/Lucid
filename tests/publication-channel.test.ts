import { ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { publicationChannel } from '../src/discord/channels.js';
import { mockClient, mockTextChannel } from './helpers/discord-mocks.js';

const guildId = 'guild-1';
const channelId = 'roster-1';
const required = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

async function check(options: Parameters<typeof mockTextChannel>[0] = {}) {
  const channel = mockTextChannel({ id: channelId, guildId, permissions: required, ...options });
  const client = mockClient({ channels: { [channelId]: channel } });
  return publicationChannel(client as never, { guildId, rosterChannelId: channelId });
}

describe('publicationChannel', () => {
  it('accepts the snapshotted same-guild text channel with every required permission', async () => {
    await expect(check()).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['ViewChannel', 'missing-view-channel'],
    ['SendMessages', 'missing-send-messages'],
    ['EmbedLinks', 'missing-embed-links'],
    ['ReadMessageHistory', 'missing-read-message-history'],
  ])('reports a missing %s permission precisely', async (permission, category) => {
    const result = await check({ permissions: required.filter((value) => value !== permission) });
    expect(result).toMatchObject({ ok: false, category });
  });

  it('rejects a channel from another guild', async () => {
    await expect(check({ guildId: 'guild-2' })).resolves.toMatchObject({ ok: false, category: 'wrong-guild' });
  });

  it('rejects a sendable but unsupported channel type', async () => {
    await expect(check({ type: ChannelType.PublicThread })).resolves.toMatchObject({
      ok: false,
      category: 'wrong-channel-type',
    });
  });

  it('reports a deleted channel', async () => {
    const client = mockClient({ channels: {} });
    await expect(publicationChannel(client as never, { guildId, rosterChannelId: channelId })).resolves.toMatchObject({
      ok: false,
      category: 'channel-deleted-or-inaccessible',
    });
  });

  it("keeps a second Pickup Space's missing permission isolated to its snapshotted channel", async () => {
    const firstId = 'space-one-roster';
    const secondId = 'space-two-roster';
    const first = mockTextChannel({ id: firstId, guildId, permissions: required });
    const second = mockTextChannel({
      id: secondId,
      guildId,
      permissions: required.filter((permission) => permission !== 'SendMessages'),
    });
    const client = mockClient({ channels: { [firstId]: first, [secondId]: second } });

    await expect(
      publicationChannel(client as never, { guildId, rosterChannelId: firstId }),
    ).resolves.toMatchObject({ ok: true, channel: first });
    await expect(
      publicationChannel(client as never, { guildId, rosterChannelId: secondId }),
    ).resolves.toMatchObject({ ok: false, category: 'missing-send-messages' });
    expect(client.channels.fetch).toHaveBeenNthCalledWith(1, firstId);
    expect(client.channels.fetch).toHaveBeenNthCalledWith(2, secondId);
  });
});
