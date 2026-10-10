/** Canonical roster writes. Discord checks run before this synchronous transaction. */
import { getDatabase } from '../db/index.js';
import { PickupRepository } from '../db/repositories/pickups.js';
import { PickupEventRepository } from '../db/repositories/pickup-events.js';
import { RosterSlotRepository } from '../db/repositories/roster-slots.js';
import { PickupNotificationRepository } from '../db/repositories/pickup-notifications.js';
import { SignupRepository } from '../db/repositories/signups.js';
import { PickupProjectionRepository } from '../db/repositories/pickup-projections.js';
import { ROLES, teamsForFormat, type Role, type Team } from '../domain/roles.js';
import { rosterFingerprint, type SlotAssignment } from '../domain/roster.js';
import type { Pickup } from '../db/repositories/types.js';

export class OperationRefused extends Error {}

export type RosterChange = {
  kind: 'swap'; sourceSlotId: number; targetSlotId: number; staffAssigned: boolean;
} | { kind: 'replace'; slotId: number; userId: string }
  | { kind: 'shuffle'; slots: SlotAssignment[] };
export type SeatChange = { kind: 'seat'; team: Team; role: Role; userId: string };

export interface RosterChangeRequest {
  actorId: string;
  guildId: string;
  pickupId: number;
  expectedVersion: number;
  expectedRosterFingerprint?: string;
  proposalExpiresAt?: number;
  change: RosterChange | SeatChange;
}

function projectChangedRoster(pickup: Pickup): void {
  const projections = new PickupProjectionRepository();
  if (pickup.reviewMessageId) projections.begin(pickup.id, 'review', pickup.reviewMessageId);
  if (pickup.status === 'published' && pickup.rosterMessageId) projections.begin(pickup.id, 'roster', pickup.rosterMessageId);
}

export function commitRosterChange(request: RosterChangeRequest): void {
  getDatabase().transaction(() => {
    const pickups = new PickupRepository();
    const pickup = pickups.byId(request.pickupId);
    if (!pickup || pickup.guildId !== request.guildId) throw new OperationRefused('That pickup is not in this server.');
    if (request.proposalExpiresAt !== undefined && Date.now() >= request.proposalExpiresAt) throw new OperationRefused('That preview expired. Reopen management and preview again.');
    const staleMessage = 'Someone else changed this roster since you opened it. Reopen management and try again.';
    const allowed = request.change.kind === 'seat' ? ['open'] : ['roster_ready', 'published'];
    if (!allowed.includes(pickup.status) || pickup.version !== request.expectedVersion
      || ['publishing', 'repairing', 'uncertain'].includes(pickup.publicationStatus)) throw new OperationRefused(staleMessage);
    if (new PickupProjectionRepository().blockingForPickup(pickup.id, pickup.version).length) {
      throw new OperationRefused('Discord delivery is still pending. Repair delivery before making another change.');
    }
    const slots = new RosterSlotRepository();
    if (request.expectedRosterFingerprint !== undefined && rosterFingerprint(slots.forPickup(pickup.id)) !== request.expectedRosterFingerprint) {
      throw new OperationRefused(staleMessage);
    }
    if (request.change.kind === 'seat') {
      const change = request.change;
      if (!teamsForFormat(pickup.format).includes(change.team) || !ROLES.includes(change.role)) throw new OperationRefused('That seat is not part of this pickup.');
      if (!pickups.bumpVersion(pickup.id, request.expectedVersion)) throw new OperationRefused(staleMessage);
      const seated = slots.addFixedSlot(pickup.id, change.team, change.role, change.userId);
      if (seated.status !== 'added') throw new OperationRefused('That seat or signup changed. Reopen management and try again.');
      new PickupEventRepository().record(pickup.id, request.actorId, 'player_seated', {
        team: change.team, role: change.role, userId: change.userId,
      });
      projectChangedRoster(pickup);
      return;
    }
    if (request.change.kind === 'shuffle') {
      const proposed = request.change.slots;
      const locations = new Set(teamsForFormat(pickup.format).flatMap(team => ROLES.map(role => `${team}:${role}`)));
      if (proposed.length !== locations.size || new Set(proposed.map(s => s.userId)).size !== proposed.length
        || new Set(proposed.map(s => `${s.team}:${s.role}`)).size !== locations.size
        || proposed.some(s => !locations.has(`${s.team}:${s.role}`) || !new SignupRepository().hasSignedUpFor(pickup.id, s.userId, s.role))) {
        throw new OperationRefused('The proposed roster is no longer valid for the current signup pool.');
      }
      if (!pickups.claimVersionIfEditable(pickup.id, request.expectedVersion)) {
        throw new OperationRefused(staleMessage);
      }
      slots.replaceAll(pickup.id, proposed);
      new PickupEventRepository().record(pickup.id, request.actorId, 'roster_shuffled', { slots: proposed });
      projectChangedRoster(pickup);
      return;
    }
    if (request.change.kind === 'replace') {
      const change = request.change;
      const source = slots.byId(change.slotId);
      if (!source || source.pickupId !== pickup.id) throw new OperationRefused('That roster slot no longer exists.');
      if (slots.isUserRostered(pickup.id, change.userId)) throw new OperationRefused('That player is already on this roster.');
      if (pickup.status !== 'published' && !new SignupRepository().hasSignedUpFor(pickup.id, change.userId, source.role)) {
        throw new OperationRefused('That player is no longer signed up for this role or Fill.');
      }
      const claimed = pickup.status === 'published'
        ? pickups.claimVersionIfPublished(pickup.id, request.expectedVersion)
        : pickups.claimVersionIfEditable(pickup.id, request.expectedVersion);
      if (!claimed) throw new OperationRefused(staleMessage);
      slots.setOccupant(source.id, change.userId, pickup.status === 'published');
      new PickupEventRepository().record(pickup.id, request.actorId, 'player_replaced', {
        slotId: source.id, previousUserId: source.userId, newUserId: change.userId,
      });
      if (pickup.status === 'published' && pickup.rosterChannelId) new PickupNotificationRepository().schedule({
        pickupId: pickup.id, kind: 'replacement_notice',
        dedupeKey: `replacement_notice:${pickup.id}:${source.id}:${request.expectedVersion + 1}`,
        channelId: pickup.rosterChannelId, dueAt: Date.now(),
      });
      projectChangedRoster(pickup);
      return;
    }
    const source = slots.byId(request.change.sourceSlotId);
    const target = slots.byId(request.change.targetSlotId);
    if (!source || !target || source.pickupId !== pickup.id || target.pickupId !== pickup.id || source.id === target.id) {
      throw new OperationRefused('Those roster slots are no longer available.');
    }
    const claimed = pickup.status === 'published'
      ? pickups.claimVersionIfPublished(pickup.id, request.expectedVersion)
      : pickups.claimVersionIfEditable(pickup.id, request.expectedVersion);
    if (!claimed) throw new OperationRefused(staleMessage);
    slots.swapOccupants(source.id, target.id, request.change.staffAssigned);
    new PickupEventRepository().record(pickup.id, request.actorId,
      request.change.staffAssigned ? 'role_assignment_changed' : 'players_swapped', {
        sourceSlotId: source.id, targetSlotId: target.id, sourceUserId: source.userId, targetUserId: target.userId,
        ...(request.change.staffAssigned ? {} : { role: source.role, orderUserId: source.userId, chaosUserId: target.userId }),
      });
    projectChangedRoster(pickup);
  })();
}

export function commitLifecycleChange(request: {
  actorId: string; guildId: string; pickupId: number; expectedVersion: number; kind: 'cancel' | 'finish';
  expectedRosterFingerprint?: string;
  proposalExpiresAt?: number;
}): void {
  getDatabase().transaction(() => {
    const pickups = new PickupRepository();
    const pickup = pickups.byId(request.pickupId);
    if (!pickup || pickup.guildId !== request.guildId) throw new OperationRefused('That pickup is not in this server.');
    if (request.proposalExpiresAt !== undefined && Date.now() >= request.proposalExpiresAt) throw new OperationRefused('That preview expired. Reopen management and preview again.');
    if (pickup.version !== request.expectedVersion) throw new OperationRefused('This pickup changed. Reopen management and preview again.');
    if (request.expectedRosterFingerprint !== undefined && rosterFingerprint(new RosterSlotRepository().forPickup(pickup.id)) !== request.expectedRosterFingerprint) {
      throw new OperationRefused('This roster changed. Reopen management and preview again.');
    }
    if (new PickupProjectionRepository().blockingForPickup(pickup.id, pickup.version).length) throw new OperationRefused('Discord delivery is still pending. Repair delivery first.');
    const changed = request.kind === 'finish'
      ? pickups.finishWithAttribution(pickup.id, request.actorId, 'manual')
      : pickups.transitionStatusFromAny(pickup.id, ['open', 'roster_ready'], 'cancelled');
    if (!changed) throw new OperationRefused('That action is no longer available for this pickup.');
    if (!pickups.bumpVersion(pickup.id, request.expectedVersion)) throw new OperationRefused('This pickup changed. Preview again.');
    new PickupEventRepository().record(pickup.id, request.actorId,
      request.kind === 'finish' ? 'pickup_finished' : 'pickup_cancelled', request.kind === 'finish' ? { reason: 'manual' } : {});
    projectChangedRoster(pickup);
    if (pickup.signupMessageId) new PickupProjectionRepository().begin(pickup.id, 'signup', pickup.signupMessageId);
  })();
}
