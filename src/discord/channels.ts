import type { Client, GuildTextBasedChannel } from 'discord.js';

/**
 * Fetch a guild text channel Lucid can send/edit in, or null for any ordinary
 * failure — the channel was deleted, the bot lost access, or it isn't a
 * DM-less text channel at all. Shared by every flow that edits a pickup's
 * signup/review/roster message, so channel-fetch failure handling lives in
 * exactly one place rather than being re-approximated per flow.
 */
export async function textChannel(client: Client, channelId: string | null): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
    return channel;
  } catch {
    return null;
  }
}
