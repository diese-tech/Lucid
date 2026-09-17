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
  /**
   * Eligible if the member holds ANY of these roles (OR semantics); an empty
   * array means everyone is eligible. Snapshotted once at creation and
   * write-once thereafter, same as the rest of this pickup's routing.
   */
  eligibilityRoleIds: string[];
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
  /**
   * Set once, the first time this pickup's working roster becomes complete —
   * see migration 008. Never cleared, so a roster that later goes
   * incomplete-then-complete-again (a withdrawal followed by a refill) does
   * not re-notify the creator.
   */
  readyNotifiedAt: number | null;
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
 * Every kind of durable, append-only event PickupEventRepository can record —
 * see its own doc comment. Deliberately scoped to the mutations issue #35's
 * first phase actually implements; add a new type here only alongside the
 * flow change it describes, not speculatively.
 */
export type PickupEventType =
  | 'working_roster_generated'
  | 'player_seated'
  | 'players_swapped'
  | 'role_assignment_changed'
  | 'player_replaced'
  | 'roster_shuffled'
  | 'roster_published'
  | 'pickup_cancelled'
  | 'pickup_finished';

/**
 * One row of a pickup's durable operational history — see
 * PickupEventRepository's doc comment for what this is (and is not) for.
 */
export interface PickupEvent {
  id: number;
  pickupId: number;
  pickupVersion: number;
  /** Null for events with no human actor, e.g. automatic roster regeneration. */
  actorUserId: string | null;
  eventType: PickupEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** Which persisted message a delivery attempt targets -- see PickupProjectionUpdate. */
export type ProjectionSurface = 'signup' | 'review' | 'roster';

/**
 * 'pending' -- not yet confirmed applied; either never attempted, or a
 * confirmed Discord rejection safe to simply retry later.
 * 'applied' -- confirmed the edit/send landed.
 * 'uncertain' -- Discord's response was ambiguous (a timeout, a dropped
 * connection); whether the edit actually landed is genuinely unknown, and
 * must never be treated as a confirmed failure (retrying could duplicate a
 * send that already went through) or a confirmed success.
 */
export type ProjectionStatus = 'pending' | 'applied' | 'uncertain';

/**
 * One durable record of attempting to project an already-committed roster
 * mutation onto a Discord message -- issue #35's delivery-recovery contract.
 * Deliberately separate from PickupEvent: an event proves a semantic
 * mutation happened exactly once; this proves (or honestly leaves
 * unresolved) whether Discord has since been made to show it, and any number
 * of delivery attempts -- retries at startup, at a later interaction -- can
 * follow one event without ever implying a second mutation.
 */
export interface PickupProjectionUpdate {
  id: number;
  pickupId: number;
  pickupVersion: number;
  surface: ProjectionSurface;
  messageId: string | null;
  status: ProjectionStatus;
  attemptedAt: number | null;
  appliedAt: number | null;
  errorContext: string | null;
  createdAt: number;
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
  /** Seeded onto a new pickup's own eligibilityRoleIds -- see the Pickup doc comment. */
  defaultEligibilityRoleIds: string[];
  authorizedRoleIds: string[];
  createdAt: number;
  updatedAt: number;
}
