import type { PickupFormat, Role, SignupRole, Team } from '../../domain/roles.js';

export type PickupStatus = 'open' | 'roster_ready' | 'published' | 'cancelled' | 'finished';

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
  /**
   * The Pickup Space this pickup belongs to, and a snapshot of that space's
   * routing/ping-role as it stood at creation time. Null only for a pickup
   * that predates migration 005 in a guild whose legacy config was never
   * completed, so there was nothing to snapshot -- see schema.ts.
   */
  pickupSpaceId: number | null;
  originChannelId: string | null;
  signupChannelId: string | null;
  rosterChannelId: string | null;
  reviewChannelId: string | null;
  signupPingRoleId: string | null;
  organizerPingRoleId: string | null;
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

/**
 * A Pickup Space: one independently configured pickup lane within a guild
 * (e.g. "Public Pickups" and a separate restricted lower-skill lane). Owns
 * the channel routing, ping roles, eligibility default and authorized staff
 * roles that used to live on the single guild-wide GuildConfig.
 */
export interface PickupSpace {
  id: number;
  guildId: string;
  name: string;
  /** Where organizers normally run `/pickup create` to reach this space. */
  originChannelId: string | null;
  signupChannelId: string | null;
  rosterChannelId: string | null;
  reviewChannelId: string | null;
  /** Player-facing role pinged when a signup post is created. */
  signupPingRoleId: string | null;
  /** Staff/organizer role that may be mentioned for readiness/exception alerts. */
  organizerPingRoleId: string | null;
  defaultEligibilityRoleId: string | null;
  authorizedRoleIds: string[];
  createdAt: number;
  updatedAt: number;
}
