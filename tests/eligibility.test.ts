import { describe, expect, it, vi } from 'vitest';
import {
  eligibilityRolesExist,
  hasEligibilityRole,
  isMemberEligible,
  resolveEligibleUserIds,
  resolveEligibleUserIdsChecked,
} from '../src/discord/eligibility.js';
import { mockGuild, mockMember } from './helpers/discord-mocks.js';

describe('pickup eligibility roles', () => {
  it('allows everyone when no roles are configured', () => {
    expect(hasEligibilityRole({ has: () => false }, [])).toBe(true);
  });

  it('filters current guild members by the configured role', async () => {
    const eligible = mockMember({ id: 'eligible', roleIds: ['silver'] });
    const ineligible = mockMember({ id: 'ineligible', roleIds: [] });
    const guild = mockGuild({ members: [eligible, ineligible] });

    expect(await resolveEligibleUserIds(guild, ['eligible', 'ineligible', 'left-server'], ['silver']))
      .toEqual(new Set(['eligible']));
  });

  it('is eligible with ANY one of several configured roles (OR semantics), not all of them', async () => {
    const silverOnly = mockMember({ id: 'silver-only', roleIds: ['silver'] });
    const goldOnly = mockMember({ id: 'gold-only', roleIds: ['gold'] });
    const neither = mockMember({ id: 'neither', roleIds: ['bronze'] });
    const guild = mockGuild({ members: [silverOnly, goldOnly, neither] });

    expect(await resolveEligibleUserIds(guild, ['silver-only', 'gold-only', 'neither'], ['silver', 'gold']))
      .toEqual(new Set(['silver-only', 'gold-only']));
  });
});

describe('hasEligibilityRole', () => {
  it('is true when the member holds any one of several configured roles', () => {
    expect(hasEligibilityRole({ has: (id: string) => id === 'gold' }, ['silver', 'gold'])).toBe(true);
  });

  it('is false when the member holds none of the configured roles', () => {
    expect(hasEligibilityRole({ has: () => false }, ['silver', 'gold'])).toBe(false);
  });
});

describe('resolveEligibleUserIdsChecked', () => {
  it('reports ok:true with the eligible set on a normal lookup', async () => {
    const eligible = mockMember({ id: 'eligible', roleIds: ['silver'] });
    const guild = mockGuild({ members: [eligible] });

    expect(await resolveEligibleUserIdsChecked(guild, ['eligible'], ['silver']))
      .toEqual({ ok: true, eligible: new Set(['eligible']) });
  });

  it('reports ok:false -- not a confirmed empty set -- when the lookup itself fails', async () => {
    // codex review finding on PR #31 (eighth pass): resolveEligibleUserIds
    // previously collapsed a fetch failure into the same empty Set a
    // genuinely empty pool would produce, indistinguishable to any caller.
    const guild = mockGuild({ members: [] });
    guild.members.fetch = vi.fn(async () => {
      throw new Error('simulated rate limit');
    }) as typeof guild.members.fetch;

    expect(await resolveEligibleUserIdsChecked(guild, ['someone'], ['silver']))
      .toEqual({ ok: false, eligible: new Set() });
  });
});

describe('isMemberEligible', () => {
  it('is always "eligible" when no eligibility roles are configured', async () => {
    const guild = mockGuild({ members: [] });
    expect(await isMemberEligible(guild, 'anyone', [])).toBe('eligible');
  });

  it('is "eligible" for a member currently holding the role', async () => {
    const member = mockMember({ id: 'p1', roleIds: ['silver'] });
    const guild = mockGuild({ members: [member] });
    expect(await isMemberEligible(guild, 'p1', ['silver'])).toBe('eligible');
  });

  it('is "eligible" for a member holding just one of several configured roles', async () => {
    const member = mockMember({ id: 'p1', roleIds: ['gold'] });
    const guild = mockGuild({ members: [member] });
    expect(await isMemberEligible(guild, 'p1', ['silver', 'gold'])).toBe('eligible');
  });

  it('is "ineligible" for a member found in the guild but lacking every configured role', async () => {
    const member = mockMember({ id: 'p1', roleIds: [] });
    const guild = mockGuild({ members: [member] });
    expect(await isMemberEligible(guild, 'p1', ['silver', 'gold'])).toBe('ineligible');
  });

  it('is "unknown" -- not "ineligible" -- when the member fetch itself fails', async () => {
    // codex review finding on PR #31 (sixth pass): a fetch failure (left the
    // server, a rate limit, a network blip) is not a confirmed answer and
    // must be distinguishable from a real "checked, and they lack the role".
    const guild = mockGuild({ members: [] });
    expect(await isMemberEligible(guild, 'left-server', ['silver'])).toBe('unknown');
  });
});

describe('eligibilityRolesExist', () => {
  it('is "exists" by default (the mock guild assumes every role exists unless told otherwise)', async () => {
    const guild = mockGuild({});
    expect(await eligibilityRolesExist(guild, ['silver'])).toBe('exists');
  });

  it('is "exists" when the role is in the guild', async () => {
    const guild = mockGuild({ existingRoleIds: ['silver', 'gold'] });
    expect(await eligibilityRolesExist(guild, ['silver'])).toBe('exists');
  });

  it('is "exists" when only one of several configured roles still exists (OR semantics)', async () => {
    const guild = mockGuild({ existingRoleIds: ['gold'] });
    expect(await eligibilityRolesExist(guild, ['silver', 'gold'])).toBe('exists');
  });

  it('is "missing" only once EVERY configured role has been deleted out from under the pickup', async () => {
    const guild = mockGuild({ existingRoleIds: [] });
    expect(await eligibilityRolesExist(guild, ['silver', 'gold'])).toBe('missing');
  });

  it('is "missing" when the sole configured role has been deleted', async () => {
    const guild = mockGuild({ existingRoleIds: ['gold'] });
    expect(await eligibilityRolesExist(guild, ['silver'])).toBe('missing');
  });

  it('is "unknown" -- not "missing" -- when a lookup fails and no other configured role was confirmed to exist', async () => {
    // codex review finding on PR #31 (tenth pass): a role-lookup failure
    // (rate limit, network blip) is not the same fact as a confirmed
    // deletion and must not send staff to cancel and recreate a fine pickup.
    const guild = mockGuild({ existingRoleIds: [] });
    guild.roles.fetch = (async () => {
      throw new Error('simulated API failure');
    }) as typeof guild.roles.fetch;
    expect(await eligibilityRolesExist(guild, ['silver'])).toBe('unknown');
  });

  it('is "exists" -- not "unknown" -- when an earlier role\'s lookup fails but a later one is confirmed live', async () => {
    const guild = mockGuild({ existingRoleIds: ['gold'] });
    const realFetch = guild.roles.fetch;
    guild.roles.fetch = (async (roleId: string) => {
      if (roleId === 'silver') throw new Error('simulated API failure');
      return realFetch(roleId);
    }) as typeof guild.roles.fetch;
    expect(await eligibilityRolesExist(guild, ['silver', 'gold'])).toBe('exists');
  });
});
