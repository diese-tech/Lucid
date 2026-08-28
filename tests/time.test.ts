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
});

describe('shortLabel', () => {
  it('labels a pickup by weekday and local time', () => {
    // 2026-08-29 00:00 UTC is Friday 8:00 PM in New York.
    const label = shortLabel(Math.floor(Date.parse('2026-08-29T00:00:00Z') / 1000), NEW_YORK);
    expect(label).toContain('Fri');
    expect(label).toContain('8:00');
  });
});
