import type { PickupFormat, Role, Team } from '../../domain/roles.js';

export type PickupStatus = 'open' | 'roster_ready' | 'published' | 'cancelled';

export interface Pickup {
  id: number;
  guildId: string;
  createdBy: string;
  format: PickupFormat;
  /** Unix seconds. */
  startAt: number;
  roleLimit: number;
  note: string | null;
  premadeName: string | null;
  status: PickupStatus;
  signupMessageId: string | null;
  reviewMessageId: string | null;
  rosterMessageId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface Signup {
  id: number;
  pickupId: number;
  userId: string;
  role: Role;
  createdAt: number;
}

export interface RosterSlot {
  id: number;
  pickupId: number;
  team: Team;
  role: Role;
  userId: string;
  createdAt: number;
  updatedAt: number;
}

export interface GuildConfig {
  guildId: string;
  signupChannelId: string | null;
  rosterChannelId: string | null;
  reviewChannelId: string | null;
  pingRoleId: string | null;
  authorizedRoleIds: string[];
  soloEmojiId: string | null;
  jungleEmojiId: string | null;
  midEmojiId: string | null;
  supportEmojiId: string | null;
  carryEmojiId: string | null;
  timezone: string;
  createdAt: number;
  updatedAt: number;
}
