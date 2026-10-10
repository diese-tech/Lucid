import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase, setDatabaseForTesting } from '../src/db/index.js';
import { PickupRepository } from '../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../src/db/repositories/roster-slots.js';
import { PickupEventRepository } from '../src/db/repositories/pickup-events.js';
import { PickupNotificationRepository } from '../src/db/repositories/pickup-notifications.js';
import { SignupRepository } from '../src/db/repositories/signups.js';
import { ROLES } from '../src/domain/roles.js';
import { PickupProjectionRepository } from '../src/db/repositories/pickup-projections.js';
import { seedSpace, spaceSnapshot } from './helpers/fixtures.js';
import { commitRosterChange, commitLifecycleChange } from '../src/discord/pickup-operations.js';

let db: Database.Database;
beforeEach(() => { db = openDatabase(':memory:'); setDatabaseForTesting(db); });
afterEach(() => { setDatabaseForTesting(null); db.close(); vi.restoreAllMocks(); });

function ready() {
  const space = seedSpace(db, { guildId: 'guild', authorizedRoleIds: ['staff'] });
  const pickup = new PickupRepository().create({ guildId: 'guild', createdBy: 'actor', format: 'pickup_vs_premade', startAt: 1000, roleLimit: 2, ...spaceSnapshot(space) });
  new PickupRepository().transitionStatus(pickup.id, 'open', 'roster_ready');
  const assignments = ROLES.map(role => ({ team: 'pickup' as const, role, userId: role }));
  for (const s of assignments) new SignupRepository().add(pickup.id, s.userId, s.role, 2);
  new RosterSlotRepository().replaceAll(pickup.id, assignments);
  return new PickupRepository().byId(pickup.id)!;
}

describe('pickup operation transaction', () => {
  it('refuses a finish confirmation for a version the staff member never previewed', () => {
    const pickup = ready();
    new PickupRepository().transitionStatus(pickup.id, 'roster_ready', 'published');
    new PickupRepository().bumpVersion(pickup.id, pickup.version);
    expect(() => commitLifecycleChange({ actorId: 'actor', guildId: 'guild', pickupId: pickup.id,
      expectedVersion: pickup.version, kind: 'finish' })).toThrow('changed');
    expect(new PickupRepository().byId(pickup.id)?.status).toBe('published');
    expect(new PickupEventRepository().forPickup(pickup.id)).toEqual([]);
  });
  it('seats an eligible signup exactly once and claims the previewed open-roster version', () => {
    const space = seedSpace(db, { guildId: 'guild' });
    const pickup = new PickupRepository().create({ guildId: 'guild', createdBy: 'actor', format: 'pickup_vs_premade', startAt: 1000, roleLimit: 2, ...spaceSnapshot(space) });
    new SignupRepository().add(pickup.id, 'candidate', 'solo', 2);
    const request = { actorId: 'actor', guildId: 'guild', pickupId: pickup.id, expectedVersion: pickup.version,
      change: { kind: 'seat' as const, team: 'pickup' as const, role: 'solo' as const, userId: 'candidate' } };
    commitRosterChange(request);
    expect(new RosterSlotRepository().forPickup(pickup.id)).toEqual([expect.objectContaining({ userId: 'candidate', staffAssigned: true })]);
    expect(new PickupRepository().byId(pickup.id)?.version).toBe(pickup.version + 1);
    expect(() => commitRosterChange(request)).toThrow('changed');
  });
  it('refuses a mutation while publication is uncertain without advancing its version', () => {
    const pickup = ready();
    const slots = new RosterSlotRepository().forPickup(pickup.id);
    new PickupRepository().beginPublication(pickup.id, pickup.version, 'actor');
    new PickupRepository().markPublicationUncertain(pickup.id, 'timeout');
    const current = new PickupRepository().byId(pickup.id)!;
    expect(() => commitRosterChange({ actorId: 'actor', guildId: 'guild', pickupId: pickup.id, expectedVersion: current.version,
      change: { kind: 'swap', sourceSlotId: slots[0]!.id, targetSlotId: slots[1]!.id, staffAssigned: true } })).toThrow('changed');
    expect(new PickupRepository().byId(pickup.id)?.version).toBe(current.version);
    expect(new RosterSlotRepository().forPickup(pickup.id)).toEqual(slots);
  });
  it('rejects slots from another pickup and a request from another guild', () => {
    const pickup = ready(); const other = ready();
    const first = new RosterSlotRepository().forPickup(pickup.id)[0]!;
    const second = new RosterSlotRepository().forPickup(other.id)[0]!;
    const request = { actorId: 'actor', guildId: 'guild', pickupId: pickup.id, expectedVersion: pickup.version,
      change: { kind: 'swap' as const, sourceSlotId: first.id, targetSlotId: second.id, staffAssigned: true } };
    expect(() => commitRosterChange(request)).toThrow('slots');
    expect(() => commitRosterChange({ ...request, guildId: 'other-guild' })).toThrow('server');
    expect(new PickupRepository().byId(pickup.id)?.version).toBe(pickup.version);
  });
  it('records pending projection work in the same successful swap transaction', () => {
    const pickup = ready();
    new PickupRepository().setMessageIds(pickup.id, { reviewMessageId: 'staff-card' });
    const slots = new RosterSlotRepository().forPickup(pickup.id);
    commitRosterChange({ actorId: 'actor', guildId: 'guild', pickupId: pickup.id, expectedVersion: pickup.version,
      change: { kind: 'swap', sourceSlotId: slots[0]!.id, targetSlotId: slots[1]!.id, staffAssigned: true } });
    expect(new PickupProjectionRepository().unresolvedForPickup(pickup.id)).toEqual([
      expect.objectContaining({ surface: 'review', pickupVersion: pickup.version + 1, messageId: 'staff-card', status: 'pending' }),
    ]);
  });
  it('commits the exact shuffled assignments and rejects replay without changing them again', () => {
    const pickup = ready();
    const slots = new RosterSlotRepository().forPickup(pickup.id);
    const proposed = slots.map(s => ({ team: s.team, role: s.role, userId: s.userId }));
    const request = { actorId: 'actor', guildId: 'guild', pickupId: pickup.id, expectedVersion: pickup.version,
      change: { kind: 'shuffle' as const, slots: proposed } };
    commitRosterChange(request);
    expect(new RosterSlotRepository().forPickup(pickup.id).map(s => ({ team: s.team, role: s.role, userId: s.userId }))).toEqual(proposed);
    expect(() => commitRosterChange(request)).toThrow('changed');
    expect(new PickupEventRepository().forPickup(pickup.id)).toHaveLength(1);
  });
  it('rolls back replacement, version, and event if its durable notice cannot be scheduled', () => {
    const pickup = ready();
    new PickupRepository().transitionStatus(pickup.id, 'roster_ready', 'published');
    const slots = new RosterSlotRepository().forPickup(pickup.id);
    vi.spyOn(PickupNotificationRepository.prototype, 'schedule').mockImplementation(() => { throw new Error('outbox unavailable'); });
    expect(() => commitRosterChange({ actorId: 'actor', guildId: 'guild', pickupId: pickup.id, expectedVersion: pickup.version,
      change: { kind: 'replace', slotId: slots[0]!.id, userId: 'substitute' } })).toThrow('outbox unavailable');
    expect(new PickupRepository().byId(pickup.id)?.version).toBe(pickup.version);
    expect(new RosterSlotRepository().forPickup(pickup.id)).toEqual(slots);
    expect(new PickupEventRepository().forPickup(pickup.id)).toEqual([]);
  });
  it('rolls back the version and swap when the event cannot be recorded', () => {
    const pickup = ready();
    const slots = new RosterSlotRepository().forPickup(pickup.id);
    vi.spyOn(PickupEventRepository.prototype, 'record').mockImplementation(() => { throw new Error('event unavailable'); });
    expect(() => commitRosterChange({ actorId: 'actor', guildId: 'guild', pickupId: pickup.id, expectedVersion: pickup.version,
      change: { kind: 'swap', sourceSlotId: slots[0]!.id, targetSlotId: slots[1]!.id, staffAssigned: true } })).toThrow('event unavailable');
    expect(new PickupRepository().byId(pickup.id)?.version).toBe(pickup.version);
    expect(new RosterSlotRepository().forPickup(pickup.id)).toEqual(slots);
    expect(new PickupEventRepository().forPickup(pickup.id)).toEqual([]);
  });
});
