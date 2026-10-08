import { ChannelType, DiscordAPIError, type Client, type GuildTextBasedChannel } from 'discord.js';
import type { Pickup } from '../db/repositories/types.js';

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

export type PublicationChannelError =
  | 'channel-not-configured'
  | 'channel-deleted-or-inaccessible'
  | 'wrong-channel-type'
  | 'wrong-guild'
  | 'missing-view-channel'
  | 'missing-send-messages'
  | 'missing-embed-links'
  | 'missing-read-message-history'
  | 'channel-lookup-failed';

export type PublicationChannelCheck =
  | { ok: true; channel: GuildTextBasedChannel }
  | { ok: false; category: PublicationChannelError; detail: string };

const PERMISSION_ERRORS = [
  ['ViewChannel', 'missing-view-channel'],
  ['SendMessages', 'missing-send-messages'],
  ['EmbedLinks', 'missing-embed-links'],
  ['ReadMessageHistory', 'missing-read-message-history'],
] as const;

/**
 * Validate the exact destination snapshotted onto a pickup. This is advisory:
 * Discord permissions can still change after it returns, so the actual send
 * must retain its own definite-vs-uncertain error handling.
 */
export async function publicationChannel(
  client: Client,
  pickup: Pick<Pickup, 'guildId' | 'rosterChannelId'>,
): Promise<PublicationChannelCheck> {
  if (!pickup.rosterChannelId) {
    return { ok: false, category: 'channel-not-configured', detail: 'No roster channel is configured.' };
  }

  let candidate;
  try {
    candidate = await client.channels.fetch(pickup.rosterChannelId);
  } catch (error) {
    const definite = error instanceof DiscordAPIError;
    return {
      ok: false,
      category: definite ? 'channel-deleted-or-inaccessible' : 'channel-lookup-failed',
      detail: definite ? 'Discord says the channel is missing or inaccessible.' : 'Lucid could not check the channel just now.',
    };
  }

  if (!candidate) {
    return { ok: false, category: 'channel-deleted-or-inaccessible', detail: 'The roster channel no longer exists.' };
  }
  if (!candidate.isTextBased() || candidate.isDMBased() || !candidate.isSendable()) {
    return { ok: false, category: 'wrong-channel-type', detail: 'The roster destination must be a server text channel.' };
  }
  // Pickup Space channel selectors only allow GuildText. Keep the runtime
  // check equally strict so a stale/legacy ID cannot point at a thread, voice
  // text surface, or another sendable-but-unsupported channel type.
  if ('type' in candidate && candidate.type !== ChannelType.GuildText) {
    return { ok: false, category: 'wrong-channel-type', detail: 'The roster destination must be a server text channel.' };
  }
  if ('guildId' in candidate && typeof candidate.guildId === 'string' && candidate.guildId !== pickup.guildId) {
    return { ok: false, category: 'wrong-guild', detail: 'The roster channel belongs to a different server.' };
  }

  const permissions = candidate.permissionsFor(client.user!);
  if (!permissions) {
    return { ok: false, category: 'missing-view-channel', detail: 'Lucid cannot resolve its permissions in this channel.' };
  }
  for (const [permission, category] of PERMISSION_ERRORS) {
    if (!permissions.has(permission)) {
      return { ok: false, category, detail: `Lucid is missing ${permission.replace(/([A-Z])/g, ' $1').trim()} in this channel.` };
    }
  }
  return { ok: true, channel: candidate };
}

export function publicationChannelErrorMessage(check: Extract<PublicationChannelCheck, { ok: false }>, channelId: string | null): string {
  const target = channelId ? `<#${channelId}>` : 'the configured roster channel';
  return `Can't publish to ${target}: ${check.detail} Fix the channel or its permissions, then use **Retry Publication**.`;
}
