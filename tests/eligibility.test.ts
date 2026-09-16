import { describe, expect, it, vi } from 'vitest';
import {
  candidateRefusalMessage,
  eligibilityRolesExist,
  eligibleSignupRecords,
  eligibleSignupRecordsChecked,
  hasEligibilityRole,
  isMemberEligible,
  resolveEligibleUserIds,
  resolveEligibleUserIdsChecked,
  verifyCurrentCandidate,
} from '../src/discord/eligibility.js';
import { mockClient, mockGuild, mockMember } from './helpers/discord-mocks.js';

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

describe('verifyCurrentCandidate', () => {
  it('is ok:true for a current, non-bot member with no eligibility roles configured', async () => {
    const guild = mockGuild({ members: [mockMember({ id: 'p1' })] });
    expect(await verifyCurrentCandidate(guild, 'p1', [])).toEqual({ ok: true });
  });

  it('forces the fetch past the client member cache rather than trusting a cached snapshot', async () => {
    // codex review finding on PR #44: a plain fetch(userId) happily returns
    // an already-cached member without a real request, so a departure or
    // role change whose gateway update hasn't landed yet (or was missed)
    // would sail through on stale cached state -- defeating the point of
    // re-verifying immediately before the write.
    const guild = mockGuild({ members: [mockMember({ id: 'p1' })] });
    const fetchSpy = vi.spyOn(guild.members, 'fetch');
    await verifyCurrentCandidate(guild, 'p1', []);
    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ user: 'p1', force: true }));
  });

  it('is ok:true for a current member holding a configured eligibility role', async () => {
    const guild = mockGuild({ members: [mockMember({ id: 'p1', roleIds: ['silver'] })] });
    expect(await verifyCurrentCandidate(guild, 'p1', ['silver'])).toEqual({ ok: true });
  });

  it('is "not-in-guild" when Discord confirms the member is unknown', async () => {
    // The mock throws exactly the DiscordAPIError (coded UnknownMember) real
    // discord.js throws for a single-ID fetch that finds nobody.
    const guild = mockGuild({ members: [] });
    expect(await verifyCurrentCandidate(guild, 'left-server', [])).toEqual({ ok: false, reason: 'not-in-guild' });
  });

  it('is "lookup-failed" -- not "not-in-guild" -- when the fetch fails for another reason', async () => {
    // codex review finding on PR #44: the previous version mapped EVERY
    // fetch rejection to "not-in-guild", so a rate limit, timeout, or outage
    // would tell staff a candidate permanently left when Lucid actually just
    // couldn't check. Only Discord's own confirmed UnknownMember response
    // may report a departure.
    const guild = mockGuild({ members: [] });
    guild.members.fetch = vi.fn(async () => {
      throw new Error('simulated rate limit');
    }) as typeof guild.members.fetch;
    expect(await verifyCurrentCandidate(guild, 'someone', [])).toEqual({ ok: false, reason: 'lookup-failed' });
  });

  it('is "bot" for a bot account, even with no eligibility roles configured', async () => {
    const guild = mockGuild({ members: [mockMember({ id: 'p1', bot: true })] });
    expect(await verifyCurrentCandidate(guild, 'p1', [])).toEqual({ ok: false, reason: 'bot' });
  });

  it('is "ineligible" for a current member lacking every configured eligibility role', async () => {
    const guild = mockGuild({ members: [mockMember({ id: 'p1', roleIds: [] })] });
    expect(await verifyCurrentCandidate(guild, 'p1', ['silver'])).toEqual({ ok: false, reason: 'ineligible' });
  });

  it('is "lookup-failed" when there is no guild to check against', async () => {
    expect(await verifyCurrentCandidate(null, 'someone', [])).toEqual({ ok: false, reason: 'lookup-failed' });
  });
});

describe('candidateRefusalMessage', () => {
  it('names the candidate for every reason', () => {
    expect(candidateRefusalMessage('not-in-guild', 'p1')).toContain('<@p1>');
    expect(candidateRefusalMessage('bot', 'p1')).toContain('<@p1>');
    expect(candidateRefusalMessage('ineligible', 'p1')).toContain('<@p1>');
    expect(candidateRefusalMessage('lookup-failed', 'p1')).not.toContain('<@p1>');
  });
});

describe('eligibleSignupRecords', () => {
  const guildId = 'g1';

  function record(userId: string): { userId: string; role: 'solo'; createdAt: number } {
    return { userId, role: 'solo', createdAt: Date.now() };
  }

  it('excludes a signer who has left the guild, even with no eligibility roles configured', async () => {
    // codex review finding on PR #44: Shuffle drew straight from the stored
    // signup pool without any current-membership check when a pickup has no
    // eligibility roles -- the common case -- so a player who signed up and
    // then left the guild could still be introduced into the roster.
    const guild = mockGuild({ members: [mockMember({ id: 'still-here' })] });
    const client = mockClient({ guilds: { [guildId]: guild } });

    const result = await eligibleSignupRecords(
      client as never,
      guildId,
      [record('still-here'), record('left-server')],
      [],
    );

    expect(result.map((r) => r.userId)).toEqual(['still-here']);
  });

  it('excludes a bot account from the pool, even with no eligibility roles configured', async () => {
    const guild = mockGuild({ members: [mockMember({ id: 'human' }), mockMember({ id: 'a-bot', bot: true })] });
    const client = mockClient({ guilds: { [guildId]: guild } });

    const result = await eligibleSignupRecords(client as never, guildId, [record('human'), record('a-bot')], []);

    expect(result.map((r) => r.userId)).toEqual(['human']);
  });

  it('still applies the eligibility role filter on top of current membership when configured', async () => {
    const guild = mockGuild({
      members: [mockMember({ id: 'eligible', roleIds: ['silver'] }), mockMember({ id: 'ineligible', roleIds: [] })],
    });
    const client = mockClient({ guilds: { [guildId]: guild } });

    const result = await eligibleSignupRecords(
      client as never,
      guildId,
      [record('eligible'), record('ineligible')],
      ['silver'],
    );

    expect(result.map((r) => r.userId)).toEqual(['eligible']);
  });

  it('fails closed to an empty pool when the guild lookup itself fails', async () => {
    const client = mockClient({}); // no guild registered -- client.guilds.fetch throws
    const result = await eligibleSignupRecords(client as never, guildId, [record('someone')], []);
    expect(result).toEqual([]);
  });
});

describe('eligibleSignupRecordsChecked', () => {
  const guildId = 'g1';

  function record(userId: string): { userId: string; role: 'solo'; createdAt: number } {
    return { userId, role: 'solo', createdAt: Date.now() };
  }

  it('reports ok:true with the narrowed records on a normal lookup', async () => {
    const guild = mockGuild({ members: [mockMember({ id: 'still-here' })] });
    const client = mockClient({ guilds: { [guildId]: guild } });
    const stillHere = record('still-here');

    const result = await eligibleSignupRecordsChecked(client as never, guildId, [stillHere], []);

    expect(result).toEqual({ ok: true, records: [stillHere] });
  });

  it('reports ok:false -- not a confirmed empty pool -- when the lookup itself fails', async () => {
    // codex review finding on PR #44 (Half-Shell Review, HS-44-01): the
    // previous version collapsed a transient Discord failure into the same
    // empty array a genuine "nobody currently qualifies" would produce,
    // indistinguishable to handleShuffle -- which then told staff there
    // weren't enough signups, a roster fact that was never actually checked.
    const client = mockClient({}); // no guild registered -- client.guilds.fetch throws
    const result = await eligibleSignupRecordsChecked(client as never, guildId, [record('someone')], []);
    expect(result).toEqual({ ok: false, records: [] });
  });

  it('reports ok:true with an empty pool for a genuinely empty signup list', async () => {
    const client = mockClient({}); // never touched -- no records to look up
    const result = await eligibleSignupRecordsChecked(client as never, guildId, [], []);
    expect(result).toEqual({ ok: true, records: [] });
  });
});
