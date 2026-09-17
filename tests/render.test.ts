/**
 * Unit tests for src/discord/render.ts's message-length discipline.
 *
 * renderControlCard composes several independently-sized pieces (header,
 * eligibility mentions, team blocks, an unseated-signups list) into one
 * Discord message. Each piece looking individually bounded is not the same
 * as the WHOLE message staying under Discord's 2000-character cap -- see
 * DISCORD_MESSAGE_LIMIT's own doc comment and the codex review finding on
 * PR #39 this file exists to guard against regressing.
 */

import { describe, expect, it } from 'vitest';
import {
  DISCORD_MESSAGE_LIMIT,
  renderCompactPublishedCard,
  renderControlCard,
  renderExpandedPublishedCard,
  renderFinishedCard,
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

    const content = renderControlCard(pickup, working, eligibleRecords);

    expect(content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
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

    const content = renderControlCard(pickup, working, eligibleRecords);

    expect(content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(content).toContain('Unseated eligible signups');
    expect(content).toMatch(/\.\.\.and \d+ more\./);
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
    const content = renderCompactPublishedCard(basePickup({ status: 'published' }));
    expect(content).toContain('Pickup Published');
    expect(content.split('\n').length).toBeLessThanOrEqual(2);
  });
});

describe('renderExpandedPublishedCard -- issue #37', () => {
  it('flags the replacement-needed seat and lists unseated eligible candidates', () => {
    const pickup = basePickup({ status: 'published' });
    const slots = [
      baseSlot({ id: 1, userId: 'flagged-player', replacementNeeded: true }),
      baseSlot({ id: 2, team: 'chaos', userId: 'healthy-player' }),
    ];
    const content = renderExpandedPublishedCard(pickup, slots, [{ userId: 'bench-player', roles: 'Solo, Fill' }]);

    expect(content).toContain('Replacement Needed');
    expect(content).toContain('<@flagged-player> ⚠️ replacement needed');
    expect(content).toContain('<@bench-player>');
    expect(content).toContain('Solo, Fill');
    expect(content).toContain('Swap');
    expect(content).toContain('Replace Player');
  });

  it('omits the candidate section entirely when nobody unseated is eligible', () => {
    const pickup = basePickup({ status: 'published' });
    const slots = [baseSlot({ id: 1, userId: 'flagged-player', replacementNeeded: true })];
    const content = renderExpandedPublishedCard(pickup, slots, []);
    expect(content).not.toContain('Eligible unseated signups');
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
    const content = renderFinishedCard(pickup);
    expect(content).toContain('Pickup Finished');
    expect(content).toContain('Finished by <@staff-1>');
  });

  it('reads distinctly for an automatic timeout finish -- nobody is named', () => {
    const pickup = basePickup({
      status: 'finished',
      finishReason: 'timeout',
      finishedByUserId: null,
      finishedAt: Date.now(),
    });
    const content = renderFinishedCard(pickup);
    expect(content).toContain('Automatically finished');
    expect(content).not.toContain('Finished by');
  });
});
