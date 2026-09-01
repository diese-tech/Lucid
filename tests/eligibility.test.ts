import { describe, expect, it } from 'vitest';
import { hasEligibilityRole, resolveEligibleUserIds } from '../src/discord/eligibility.js';
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
