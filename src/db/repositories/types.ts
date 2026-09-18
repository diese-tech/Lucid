import type { PickupFormat, Role, SignupRole, Team } from '../../domain/roles.js';

export type PickupStatus = 'open' | 'roster_ready' | 'published' | 'cancelled' | 'finished';

/** 'manual' -- staff clicked Finish. 'timeout' -- Lucid closed it automatically at start+3h. See migration 013. */
export type FinishReason = 'manual' | 'timeout';

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
   * Optional staff-facing role pinged alongside `createdBy` when a seat needs
   * a replacement (issue #36). Distinct from signupPingRoleId, which is
   * player-facing. Snapshotted from the space at creation like the rest of
   * this pickup's routing.
   */
  organizerPingRoleId: string | null;
  /**
   * Set once, the first time this pickup's working roster becomes complete —
   * see migration 008. Never cleared, so a roster that later goes
   * incomplete-then-complete-again (a withdrawal followed by a refill) does
   * not re-notify the creator.
   */
  readyNotifiedAt: number | null;
  /**
   * Completion attribution (issue #37) -- all three null until `status`
   * reaches 'finished'. `finishedByUserId` is null for a 'timeout' finish,
   * never a placeholder actor: nobody clicked anything, so nobody is named.
   */
  finishedAt: number | null;
  finishedByUserId: string | null;
  finishReason: FinishReason | null;
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
  /**
   * True once the seated player has said they can't play (issue #36). The
   * player deliberately stays in the seat — this only marks that staff need
   * to resolve it, so the roster keeps full context until a replacement
   * actually exists. Cleared when the seat is resolved.
   */
  replacementNeeded: boolean;
  /** When replacementNeeded was raised; null whenever it is false. */
  replacementRequestedAt: number | null;
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
  | 'pickup_finished'
  /** A seated player reported they can no longer play (issue #36's Can't Play). */
  | 'player_unavailable';

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

/** Which player-facing notification a durable PickupNotification row schedules -- see its own doc comment. */
export type PickupNotificationKind = 'roster_reminder' | 'availability_alert' | 'replacement_notice' | 'roster_ready';

/**
 * 'pending' -- not yet due, or due but not yet claimed.
 * 'attempted' -- claimed; a send is in flight or the attempt just completed.
 * A row should not observably sit here between worker ticks.
 * 'sent' -- confirmed delivered.
 * 'skipped' -- resolved at delivery time that sending is no longer appropriate.
 * 'uncertain' -- terminal: the send's outcome is genuinely unknown. Never
 * auto-retried -- mirrors ProjectionStatus's own 'uncertain' and the same
 * reasoning: retrying could duplicate a message that already went out.
 * 'cleaned' -- terminal: a formerly-'sent' row whose Discord message has
 * since been deleted by the staleness sweep in message-cleanup.ts (see
 * migration 014). Only ever reached from 'sent'.
 */
export type PickupNotificationStatus = 'pending' | 'attempted' | 'sent' | 'skipped' | 'uncertain' | 'cleaned';

/**
 * One durable, one-shot player-facing notification (issue #36) -- a T-15
 * roster reminder, an organizer availability alert, a replacement notice, or
 * a staff-facing "roster ready" notice (issue #53 follow-up). Deliberately
 * separate from PickupEvent (proves a mutation happened) and
 * PickupProjectionUpdate (tracks whether an existing Discord message
 * reflects an already-committed mutation): this tracks whether a one-shot,
 * time- or event-triggered message has been sent at all.
 *
 * Content/recipients are never cached here at scheduling time -- only
 * routing/identity (pickupId, kind, dedupeKey, channelId, dueAt) is. The
 * actual message is resolved fresh from live pickup/roster state the moment
 * a worker tick claims the row, so a reminder scheduled hours earlier still
 * reflects any replacement that happened since. payloadSnapshot freezes what
 * was actually about to be sent at the moment of that claim, purely so an
 * 'uncertain' delivery has a durable record for human review -- not so it
 * can be replayed automatically.
 */
export interface PickupNotification {
  id: number;
  pickupId: number;
  kind: PickupNotificationKind;
  dedupeKey: string;
  channelId: string;
  dueAt: number;
  payloadSnapshot: string | null;
  status: PickupNotificationStatus;
  attemptedAt: number | null;
  sentAt: number | null;
  messageId: string | null;
  skippedReason: string | null;
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
  /**
   * Optional staff-facing role pinged alongside a pickup's creator when a
   * seat needs a replacement (issue #36). Snapshotted onto each new pickup.
   */
  organizerPingRoleId: string | null;
  /** Seeded onto a new pickup's own eligibilityRoleIds -- see the Pickup doc comment. */
  defaultEligibilityRoleIds: string[];
  authorizedRoleIds: string[];
  createdAt: number;
  updatedAt: number;
}
