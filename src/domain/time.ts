/**
 * Natural-language start-time parsing.
 *
 * Coordinators type things like "tonight at 8" or "8/29 at 6pm". We interpret
 * that against the GUILD'S configured timezone (not a hardcoded one — Lucid is
 * guild-agnostic and an adopting league may not be on US Eastern) and store the
 * result as an absolute instant.
 *
 * Deliberate choice: a time that resolves into the past is REJECTED rather than
 * rolled forward to the next day. If someone types "tonight at 8" at 11pm,
 * quietly scheduling it for tomorrow night produces a pickup on a day nobody
 * intended, and nobody notices until players don't show up. Making them retype
 * is cheap; the preview then shows exactly what Lucid understood.
 */

import * as chrono from 'chrono-node';

export interface ParseSuccess {
  ok: true;
  /** Unix seconds — what Discord's <t:...> syntax wants. */
  startAt: number;
}

export interface ParseFailure {
  ok: false;
  reason: 'unparseable' | 'in_past';
  message: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** Validate an IANA timezone name without throwing. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The UTC offset, in minutes, that `timezone` is on at a given instant.
 *
 * chrono needs an explicit offset to anchor relative phrasings, and the correct
 * offset depends on the date because of daylight saving. We derive it by
 * formatting the instant in the target zone and diffing against UTC, which
 * avoids pulling in a full timezone library for this one calculation.
 */
export function timezoneOffsetMinutes(timezone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  // Intl renders midnight as hour "24" in some environments; normalize it.
  const hour = parts.hour === '24' ? '00' : parts.hour;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * Parse coordinator input into an absolute start time.
 *
 * `now` is injectable so tests don't depend on the wall clock.
 */
export function parseStartTime(
  input: string,
  timezone: string,
  now: Date = new Date(),
): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: 'unparseable',
      message: 'Please enter a start time, for example `tonight at 8` or `Friday 9:30pm`.',
    };
  }

  const referenceOffset = timezoneOffsetMinutes(timezone, now);

  // chrono's `en` locale reads 8/29 as US month/day, which matches how the
  // Dream Walkers coordinators already write dates.
  const parsed = chrono.parse(trimmed, { instant: now, timezone: referenceOffset }, {
    forwardDate: true,
  });

  const first = parsed[0];
  if (!first) {
    return {
      ok: false,
      reason: 'unparseable',
      message: `Couldn't read \`${trimmed}\` as a time. Try something like \`tonight at 8\`, \`tomorrow 7pm\`, or \`8/29 at 6pm\`.`,
    };
  }

  // chrono's `timezone` option only takes a single fixed numeric offset — it
  // has no idea "America/New_York" means "-240 in summer, -300 in winter" and
  // applies whatever we passed to the WHOLE result. referenceOffset is correct
  // for `now`, so this is fine for same-side-of-DST cases, but a target date on
  // the other side of a transition (e.g. scheduling into November while it's
  // still daylight time) comes out an hour off — chrono's own arithmetic is
  // right, only the offset it was given is wrong for that particular date.
  //
  // Only correct this when the offset came from OUR fallback: if the text
  // itself named a zone ("8pm PST"), chrono already resolved that explicit
  // offset correctly and get('timezoneOffset') is non-null — overriding it
  // with the guild's configured zone would replace a correct, user-specified
  // answer with a wrong one.
  const tentative = first.date();
  const usedExplicitOffset = first.start.get('timezoneOffset') !== null;

  const date = usedExplicitOffset
    ? tentative
    : (() => {
        // Re-derive the offset for the date chrono actually landed on (close
        // enough even when that tentative date is itself off by the DST delta
        // — an hour's error essentially never changes which side of a
        // transition a date falls on), then rebuild the instant from chrono's
        // extracted local wall-clock components against the corrected offset,
        // instead of trusting date() to have used the right one throughout.
        const correctedOffset = timezoneOffsetMinutes(timezone, tentative);
        const localWallClockMs = Date.UTC(
          first.start.get('year')!,
          first.start.get('month')! - 1,
          first.start.get('day')!,
          first.start.get('hour') ?? 0,
          first.start.get('minute') ?? 0,
          first.start.get('second') ?? 0,
        );
        return new Date(localWallClockMs - correctedOffset * 60_000);
      })();
  const startAt = Math.floor(date.getTime() / 1000);

  if (date.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason: 'in_past',
      message: `\`${trimmed}\` resolves to a time that has already passed. Enter a future time — include the day if you mean a later date.`,
    };
  }

  return { ok: true, startAt };
}

/** Discord renders these in each viewer's own local timezone. */
export function discordShortTime(unixSeconds: number): string {
  return `<t:${unixSeconds}:t>`;
}

export function discordRelative(unixSeconds: number): string {
  return `<t:${unixSeconds}:R>`;
}

export function discordLongDateTime(unixSeconds: number): string {
  return `<t:${unixSeconds}:F>`;
}

/** Human-readable label for pickup pickers, e.g. "Pickup vs Pickup — Fri 8:00 PM". */
export function shortLabel(unixSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}
