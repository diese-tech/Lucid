import { describe, expect, it } from 'vitest';
import {
  eligibilityRoleExists,
  hasEligibilityRole,
  isMemberEligible,
  resolveEligibleUserIds,
} from '../src/discord/eligibility.js';
import { mockGuild, mockMember } from './helpers/discord-mocks.js';

describe('pickup eligibility role', () => {
  it('allows everyone when no role is configured', () => {
    expect(hasEligibilityRole({ has: () => false }, null)).toBe(true);
  });

  it('filters current guild members by the configured role', async () => {
    const eligible = mockMember({ id: 'eligible', roleIds: ['silver'] });
    const ineligible = mockMember({ id: 'ineligible', roleIds: [] });
    const guild = mockGuild({ members: [eligible, ineligible] });

    expect(await resolveEligibleUserIds(guild, ['eligible', 'ineligible', 'left-server'], 'silver'))
      .toEqual(new Set(['eligible']));
  });
});

describe('isMemberEligible', () => {
  it('is always true when no eligibility role is configured', async () => {
    const guild = mockGuild({ members: [] });
    expect(await isMemberEligible(guild, 'anyone', null)).toBe(true);
  });

  it('is true for a member currently holding the role', async () => {
    const member = mockMember({ id: 'p1', roleIds: ['silver'] });
    const guild = mockGuild({ members: [member] });
    expect(await isMemberEligible(guild, 'p1', 'silver')).toBe(true);
  });

  it('is false for a member who lacks the role', async () => {
    const member = mockMember({ id: 'p1', roleIds: [] });
    const guild = mockGuild({ members: [member] });
    expect(await isMemberEligible(guild, 'p1', 'silver')).toBe(false);
  });

  it('fails closed when the member cannot be fetched (left the server, rate limit, ...)', async () => {
    const guild = mockGuild({ members: [] });
    expect(await isMemberEligible(guild, 'left-server', 'silver')).toBe(false);
  });
});

describe('eligibilityRoleExists', () => {
  it('is true by default (the mock guild assumes every role exists unless told otherwise)', async () => {
    const guild = mockGuild({});
    expect(await eligibilityRoleExists(guild, 'silver')).toBe(true);
  });

  it('is true when the role is in the guild', async () => {
    const guild = mockGuild({ existingRoleIds: ['silver', 'gold'] });
    expect(await eligibilityRoleExists(guild, 'silver')).toBe(true);
  });

  it('is false when the role has been deleted out from under the pickup', async () => {
    const guild = mockGuild({ existingRoleIds: ['gold'] });
    expect(await eligibilityRoleExists(guild, 'silver')).toBe(false);
  });

  it('fails closed (reports missing) if the fetch itself throws', async () => {
    const guild = mockGuild({ existingRoleIds: [] });
    guild.roles.fetch = (async () => {
      throw new Error('simulated API failure');
    }) as typeof guild.roles.fetch;
    expect(await eligibilityRoleExists(guild, 'silver')).toBe(false);
  });
});
