/**
 * Start-time parsing.
 *
 * `now` is injected everywhere below, so these tests behave the same whether
 * they run at noon or at 11:59pm on a daylight-saving boundary.
 */

import { describe, expect, it } from 'vitest';
import { isValidTimezone, parseStartTime, shortLabel } from '../src/domain/time.js';

const NEW_YORK = 'America/New_York';
// A fixed Friday afternoon: 2026-08-28 14:00 in New York (18:00 UTC).
const NOW = new Date('2026-08-28T18:00:00Z');

describe('isValidTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimezone(NEW_YORK)).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
  });

  it('rejects anything Intl cannot resolve', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('EST5EDT-nope')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('parseStartTime', () => {
  it('accepts a clearly future phrase', () => {
    const result = parseStartTime('tomorrow at 8pm', NEW_YORK, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.startAt).toBeGreaterThan(Math.floor(NOW.getTime() / 1000));
      // 8pm in New York on 2026-08-29 is 00:00 UTC on the 30th.
      expect(new Date(result.startAt * 1000).toISOString()).toBe('2026-08-30T00:00:00.000Z');
    }
  });

  it('reads the time in the guild timezone, not the machine timezone', () => {
    const newYork = parseStartTime('tomorrow at 8pm', NEW_YORK, NOW);
    const berlin = parseStartTime('tomorrow at 8pm', 'Europe/Berlin', NOW);

    expect(newYork.ok && berlin.ok).toBe(true);
    if (newYork.ok && berlin.ok) {
      // Berlin's 8pm happens six hours earlier in absolute terms.
      expect(newYork.startAt - berlin.startAt).toBe(6 * 3600);
    }
  });

  it('refuses a time that has already passed rather than rolling it forward', () => {
    const result = parseStartTime('yesterday at 8pm', NEW_YORK, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('in_past');
  });

  it('refuses an explicitly dated past time too', () => {
    const result = parseStartTime('12/25/2020 at 6pm', NEW_YORK, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('in_past');
  });

  it('reports gibberish as unparseable', () => {
    const result = parseStartTime('purple monkey dishwasher', NEW_YORK, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unparseable');
      expect(result.message).toContain('tonight at 8');
    }
  });

  it('treats an empty or blank entry as unparseable', () => {
    for (const input of ['', '   ']) {
      const result = parseStartTime(input, NEW_YORK, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unparseable');
    }
  });

  // Regression: a Codex review finding on PR #19. `now` is Aug 28 (EDT,
  // UTC-4). New York's clocks fall back to EST (UTC-5) on 2026-11-01, so a
  // pickup scheduled for the 2nd sits on the far side of that transition.
  // Passing a single fixed offset all the way through used to leave the result
  // an hour off; the input date being AFTER now (so forwardDate never comes
  // into play here) isn't what's being exercised — it's that the two dates
  // straddle a DST boundary.
  it('uses the target date’s own offset across a daylight-saving boundary', () => {
    const result = parseStartTime('11/2 at 8pm', NEW_YORK, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 8pm EST (UTC-5) on Nov 2, not 8pm EDT (UTC-4) carried over from `now`.
      expect(new Date(result.startAt * 1000).toISOString()).toBe('2026-11-03T01:00:00.000Z');
    }
  });

  it('does not misapply the DST correction to a date on the same side as now', () => {
    // Sanity check the fix is a no-op for the common case already covered
    // above: a same-month booking never crosses a transition.
    const result = parseStartTime('9/4 at 8pm', NEW_YORK, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Still EDT (UTC-4) — no transition between Aug 28 and Sep 4.
      expect(new Date(result.startAt * 1000).toISOString()).toBe('2026-09-05T00:00:00.000Z');
    }
  });

  it('honors an explicit zone in the text over the guild timezone, even across DST', () => {
    // The coordinator names a different zone outright. Chrono resolves this
    // correctly on its own; the DST fix must not override it with the guild's
    // configured zone.
    const result = parseStartTime('11/2 at 8pm PST', NEW_YORK, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 8pm PST (UTC-8), not reinterpreted as New York time.
      expect(new Date(result.startAt * 1000).toISOString()).toBe('2026-11-03T04:00:00.000Z');
    }
  });
});

describe('shortLabel', () => {
  it('labels a pickup by weekday and local time', () => {
    // 2026-08-29 00:00 UTC is Friday 8:00 PM in New York.
    const label = shortLabel(Math.floor(Date.parse('2026-08-29T00:00:00Z') / 1000), NEW_YORK);
    expect(label).toContain('Fri');
    expect(label).toContain('8:00');
  });
});
