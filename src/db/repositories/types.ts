import type { PickupFormat, Role, SignupRole, Team } from '../../domain/roles.js';

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
  eligibilityRoleId: string | null;
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
  role: SignupRole;
  createdAt: number;
}

export interface RosterSlot {
  id: number;
  pickupId: number;
  team: Team;
  role: Role;
  userId: string;
  /**
   * True when staff placed this player here via an override rather than Lucid
   * generating the assignment. Such slots are exempt from the withdrawn-signup
   * check — see migration 002.
   */
  staffAssigned: boolean;
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
  fillEmojiId: string | null;
  timezone: string;
  createdAt: number;
  updatedAt: number;
}
