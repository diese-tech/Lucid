/**
 * Unit tests for src/discord/render.ts's message-length discipline and
 * staff-card embed shape (issue #53).
 *
 * renderControlCard composes several independently-sized pieces (header,
 * eligibility mentions, team blocks, an unseated-signups list) into one
 * embed description. Each piece looking individually bounded is not the same
 * as the WHOLE description staying under the budget these tests still use
 * (DISCORD_MESSAGE_LIMIT, unchanged from before the embed conversion -- see
 * that constant's own doc comment) -- see the codex review finding on PR #39
 * this file exists to guard against regressing.
 */

import { describe, expect, it } from 'vitest';
import {
  DISCORD_MESSAGE_LIMIT,
  boundedLines,
  renderCompactPublishedCard,
  renderControlCard,
  renderExpandedPublishedCard,
  renderFinishedCard,
  renderFinishedSignupPost,
  renderReviewCard,
  rosterNavLinks,
} from '../src/discord/render.js';
import type { Pickup, RosterSlot } from '../src/db/repositories/types.js';
import type { WorkingRosterResult, SignupRecord } from '../src/domain/roster.js';

function basePickup(overrides: Partial<Pickup> = {}): Pickup {
  return {
    id: 1,
    guildId: 'g1',
    createdBy: 'staff',
    format: 'pickup_vs_pickup',
    startAt: Math.floor(Date.now() / 1000) + 3600,
    roleLimit: 2,
    note: null,
    premadeName: null,
    eligibilityRoleIds: [],
    status: 'open',
    signupMessageId: null,
    reviewMessageId: null,
    rosterMessageId: null,
    version: 0,
    pickupSpaceId: 1,
    originChannelId: 'c1',
    signupChannelId: 'c2',
    rosterChannelId: 'c3',
    reviewChannelId: 'c4',
    signupPingRoleId: null,
    readyNotifiedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('renderControlCard -- message length', () => {
  it('stays under the Discord cap with a large bench and a long eligibility mention', () => {
    // A long list of eligibility roles bloats the header well beyond what
    // boundedLines' own default budget (applied to the unseated section in
    // isolation) would have accounted for.
    const eligibilityRoleIds = Array.from({ length: 20 }, (_, i) => `999999999999999${i}`);
    const pickup = basePickup({ eligibilityRoleIds });

    // Two seated players; a large bench of unseated eligible signups, each
    // with several declared roles, to stress the unseated-list budgeting.
    const working: WorkingRosterResult = {
      complete: false,
      slots: [
        { team: 'order', role: 'solo', userId: 'seated-1' },
        { team: 'chaos', role: 'solo', userId: 'seated-2' },
      ],
      missingLocations: [
        { team: 'order', role: 'jungle' },
        { team: 'chaos', role: 'jungle' },
        { team: 'order', role: 'mid' },
        { team: 'chaos', role: 'mid' },
        { team: 'order', role: 'support' },
        { team: 'chaos', role: 'support' },
        { team: 'order', role: 'carry' },
        { team: 'chaos', role: 'carry' },
      ],
      unseatedUserIds: Array.from({ length: 80 }, (_, i) => `999999999999999${String(i).padStart(3, '0')}`),
    };
    const eligibleRecords: SignupRecord[] = working.unseatedUserIds.flatMap((userId) => [
      { userId, role: 'jungle' as const, createdAt: 1 },
      { userId, role: 'mid' as const, createdAt: 2 },
      { userId, role: 'support' as const, createdAt: 3 },
    ]);

    const embed = renderControlCard(pickup, working, eligibleRecords);

    expect(embed.description.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
  });

  it('still shows the unseated section (truncated) rather than dropping it entirely', () => {
    const pickup = basePickup();
    const working: WorkingRosterResult = {
      complete: false,
      slots: [],
      missingLocations: [{ team: 'order', role: 'solo' }],
      unseatedUserIds: Array.from({ length: 80 }, (_, i) => `999999999999999${String(i).padStart(3, '0')}`),
    };
    const eligibleRecords: SignupRecord[] = working.unseatedUserIds.map((userId) => ({
      userId,
      role: 'fill' as const,
      createdAt: 1,
    }));

    const embed = renderControlCard(pickup, working, eligibleRecords);

    expect(embed.description.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(embed.description).toContain('Unseated eligible signups');
    expect(embed.description).toMatch(/\.\.\.and \d+ more\./);
  });
});

describe('boundedLines -- reservedTrailingLines (issue #53 phase 2)', () => {
  it('leaves an item out rather than crowding out the reserved trailing content', () => {
    const result = boundedLines(
      ['header'],
      ['a'.repeat(40)],
      () => '',
      50, // header (6) + item (40) fits alone, but not with a 20-char reservation
      ['b'.repeat(20)],
    );
    expect(result).toEqual(['header']);
  });

  it('still includes an item that fits even after the reservation', () => {
    const result = boundedLines(['header'], ['a'.repeat(10)], () => '', 50, ['b'.repeat(20)]);
    expect(result).toEqual(['header', 'a'.repeat(10)]);
  });

  it('behaves exactly as before when no trailing lines are reserved', () => {
    const result = boundedLines(['header'], ['a'.repeat(40)], () => '', 50);
    expect(result).toEqual(['header', 'a'.repeat(40)]);
  });
});

function baseSlot(overrides: Partial<RosterSlot> = {}): RosterSlot {
  return {
    id: 1,
    pickupId: 1,
    team: 'order',
    role: 'solo',
    userId: 'player-1',
    staffAssigned: false,
    replacementNeeded: false,
    replacementRequestedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('renderCompactPublishedCard -- issue #37', () => {
  it('is a short healthy-roster summary, not the full draft', () => {
    const embed = renderCompactPublishedCard(basePickup({ status: 'published' }));
    expect(embed.title).toContain('Pickup Published');
    expect(embed.description.split('\n').length).toBeLessThanOrEqual(1);
  });
});

describe('renderExpandedPublishedCard -- issue #37', () => {
  it('flags the replacement-needed seat and lists unseated eligible candidates', () => {
    const pickup = basePickup({ status: 'published' });
    const slots = [
      baseSlot({ id: 1, userId: 'flagged-player', replacementNeeded: true }),
      baseSlot({ id: 2, team: 'chaos', userId: 'healthy-player' }),
    ];
    const embed = renderExpandedPublishedCard(pickup, slots, [{ userId: 'bench-player', roles: 'Solo, Fill' }]);

    expect(embed.title).toContain('Replacement Needed');
    expect(embed.description).toContain('<@flagged-player> ⚠️ replacement needed');
    expect(embed.description).toContain('<@bench-player>');
    expect(embed.description).toContain('Solo, Fill');
    expect(embed.description).toContain('Swap');
    expect(embed.description).toContain('Replace Player');
  });

  it('omits the candidate section entirely when nobody unseated is eligible', () => {
    const pickup = basePickup({ status: 'published' });
    const slots = [baseSlot({ id: 1, userId: 'flagged-player', replacementNeeded: true })];
    const embed = renderExpandedPublishedCard(pickup, slots, []);
    expect(embed.description).not.toContain('Eligible unseated signups');
  });

  it('never crowds out the closing instruction, even with a maximally-packed bench (issue #53 phase 2)', () => {
    // Before boundedLines reserved space for it, this closing line was
    // pushed unconditionally AFTER the budgeted section -- a bench large
    // enough to fill the section's own budget exactly could push the total
    // description past DISCORD_MESSAGE_LIMIT once this line landed too.
    const pickup = basePickup({ status: 'published' });
    const slots = [baseSlot({ id: 1, userId: 'flagged-player', replacementNeeded: true })];
    const unseatedEligible = Array.from({ length: 200 }, (_, i) => ({
      userId: `999999999999999${String(i).padStart(3, '0')}`,
      roles: 'Solo, Jungle, Mid, Support, Carry, Fill',
    }));
    const embed = renderExpandedPublishedCard(pickup, slots, unseatedEligible);

    expect(embed.description.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(embed.description).toContain('Use **Swap** or **Replace Player** to resolve the flagged seat(s).');
  });
});

describe('renderReviewCard -- inline eligibility context (issue #53 phase 2)', () => {
  it('names the missing role(s) once, in the warning banner, not on the occupant line', () => {
    // codex review finding on PR #56: an earlier version of this repeated
    // eligibilityMentions() on EVERY ineligible occupant's own line -- with
    // up to 25 configured roles that string alone can run past 600
    // characters, and several ineligible seats each repeating it risked
    // pushing the whole embed description past Discord's 4096-character
    // cap. It must appear exactly once, in the banner, regardless of how
    // many seats are affected.
    const eligibilityRoleId = '888888888888888888';
    const pickup = basePickup({ eligibilityRoleIds: [eligibilityRoleId] });
    const slots = [baseSlot({ id: 1, userId: 'stale-player' })];

    const embed = renderReviewCard(pickup, slots, { ineligibleUserIds: new Set(['stale-player']) });

    expect(embed.description).toContain('<@stale-player> ⚠️ no longer eligible');
    expect(embed.description).not.toContain(`<@stale-player> ⚠️ no longer eligible — missing`);
    expect(embed.description).toContain(`no longer hold an eligibility role (<@&${eligibilityRoleId}>)`);
    expect(embed.description.match(new RegExp(`<@&${eligibilityRoleId}>`, 'g'))).toHaveLength(1);
  });

  it('stays comfortably under the embed cap with the maximum 25 eligibility roles and a full ineligible roster', () => {
    const eligibilityRoleIds = Array.from({ length: 25 }, (_, i) => `9999999999999999${String(i).padStart(2, '0')}`);
    const pickup = basePickup({ eligibilityRoleIds });
    const userIds = Array.from({ length: 10 }, (_, i) => `ineligible-${i}`);
    const slots = [
      baseSlot({ id: 1, team: 'order', role: 'solo', userId: userIds[0]! }),
      baseSlot({ id: 2, team: 'order', role: 'jungle', userId: userIds[1]! }),
      baseSlot({ id: 3, team: 'order', role: 'mid', userId: userIds[2]! }),
      baseSlot({ id: 4, team: 'order', role: 'support', userId: userIds[3]! }),
      baseSlot({ id: 5, team: 'order', role: 'carry', userId: userIds[4]! }),
      baseSlot({ id: 6, team: 'chaos', role: 'solo', userId: userIds[5]! }),
      baseSlot({ id: 7, team: 'chaos', role: 'jungle', userId: userIds[6]! }),
      baseSlot({ id: 8, team: 'chaos', role: 'mid', userId: userIds[7]! }),
      baseSlot({ id: 9, team: 'chaos', role: 'support', userId: userIds[8]! }),
      baseSlot({ id: 10, team: 'chaos', role: 'carry', userId: userIds[9]! }),
    ];

    const embed = renderReviewCard(pickup, slots, { ineligibleUserIds: new Set(userIds) });

    expect(embed.description.length).toBeLessThan(4096);
  });

  it('combines withdrawn and ineligible into one banner, not two duplicate call-to-actions', () => {
    const pickup = basePickup({ eligibilityRoleIds: ['888888888888888888'] });
    const slots = [
      baseSlot({ id: 1, userId: 'withdrawn-player' }),
      baseSlot({ id: 2, team: 'chaos', userId: 'ineligible-player' }),
    ];

    const embed = renderReviewCard(pickup, slots, {
      withdrawnUserIds: new Set(['withdrawn-player']),
      ineligibleUserIds: new Set(['ineligible-player']),
    });

    expect(embed.description).toContain('withdrawn their signup or no longer hold an eligibility role');
    // Exactly one call-to-action sentence, not the old two stacked paragraphs.
    expect(embed.description.match(/Use Shuffle or Edit Roster/g)).toHaveLength(1);
  });

  it('shows only the withdrawn banner when ineligible is empty', () => {
    const pickup = basePickup();
    const slots = [baseSlot({ id: 1, userId: 'withdrawn-player' })];
    const embed = renderReviewCard(pickup, slots, { withdrawnUserIds: new Set(['withdrawn-player']) });

    expect(embed.description).toContain('One or more players have withdrawn their signup.');
    expect(embed.description).not.toContain('no longer hold an eligibility role');
  });

  it('shows only the ineligible banner when withdrawn is empty', () => {
    const eligibilityRoleId = '888888888888888888';
    const pickup = basePickup({ eligibilityRoleIds: [eligibilityRoleId] });
    const slots = [baseSlot({ id: 1, userId: 'stale-player' })];
    const embed = renderReviewCard(pickup, slots, { ineligibleUserIds: new Set(['stale-player']) });

    expect(embed.description).toContain(`One or more players no longer hold an eligibility role (<@&${eligibilityRoleId}>).`);
    expect(embed.description).not.toContain('withdrawn their signup');
  });
});

describe('rosterNavLinks -- issue #37', () => {
  it('includes Manage Pickup while the pickup is still active', () => {
    const pickup = basePickup({
      status: 'published',
      signupMessageId: 'sig1',
      reviewMessageId: 'rev1',
    });
    const labels = rosterNavLinks(pickup).map((l) => l.label);
    expect(labels).toEqual(['View Signup', 'Manage Pickup']);
  });

  it('drops Manage Pickup once the pickup is finished -- nothing left to manage', () => {
    const pickup = basePickup({
      status: 'finished',
      signupMessageId: 'sig1',
      reviewMessageId: 'rev1',
    });
    const labels = rosterNavLinks(pickup).map((l) => l.label);
    expect(labels).toEqual(['View Signup']);
  });
});

describe('renderFinishedSignupPost -- issue #37', () => {
  it('links to the final roster', () => {
    const pickup = basePickup({ status: 'finished', rosterMessageId: 'roster1' });
    const content = renderFinishedSignupPost(pickup);
    expect(content).toContain('Pickup finished');
    expect(content).toContain('[View Final Roster]');
  });

  it('omits the link entirely when no roster message was ever recorded', () => {
    const pickup = basePickup({ status: 'finished', rosterMessageId: null });
    const content = renderFinishedSignupPost(pickup);
    expect(content).not.toContain('[View Final Roster]');
  });
});

describe('renderFinishedCard -- issue #37', () => {
  it('names the finishing staff member for a manual finish', () => {
    const pickup = basePickup({
      status: 'finished',
      finishReason: 'manual',
      finishedByUserId: 'staff-1',
      finishedAt: Date.now(),
    });
    const embed = renderFinishedCard(pickup);
    expect(embed.title).toContain('Pickup Finished');
    expect(embed.description).toContain('Finished by <@staff-1>');
  });

  it('reads distinctly for an automatic timeout finish -- nobody is named', () => {
    const pickup = basePickup({
      status: 'finished',
      finishReason: 'timeout',
      finishedByUserId: null,
      finishedAt: Date.now(),
    });
    const embed = renderFinishedCard(pickup);
    expect(embed.description).toContain('Automatically finished');
    expect(embed.description).not.toContain('Finished by');
  });

  it('never claims an automatic finish for a legacy row with unrecorded attribution (codex review finding on PR #51)', () => {
    // finishReason is null for any pickup that reached 'finished' before
    // migration 013 added these columns. Claiming "automatically finished"
    // for one would misrepresent a real human decision nobody recorded the
    // actor for.
    const pickup = basePickup({
      status: 'finished',
      finishReason: null,
      finishedByUserId: null,
      finishedAt: null,
    });
    const embed = renderFinishedCard(pickup);
    expect(embed.description).not.toContain('Automatically finished');
    expect(embed.description).not.toContain('Finished by');
    expect(embed.description).toContain('attribution not recorded');
  });
});
