/**
 * Ranking logic for "who did the coordinator mean?" during player replacement.
 *
 * Kept free of Discord types so it can be tested against fixtures. The caller
 * supplies candidates already fetched from the guild; this module only decides
 * which ones match and in what order.
 */

export interface MemberCandidate {
  userId: string;
  /** Discord username (the @handle, no discriminator in the modern system). */
  username: string;
  /** Global display name, if the user set one. */
  displayName?: string | null;
  /** Per-guild nickname, if set. */
  nickname?: string | null;
  isBot?: boolean;
}

export interface RankedCandidate extends MemberCandidate {
  /** Lower sorts first: 0 exact, 1 starts-with, 2 contains. */
  rank: 0 | 1 | 2;
}

export const MAX_CANDIDATES = 8;

function namesOf(member: MemberCandidate): string[] {
  return [member.username, member.displayName, member.nickname].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
}

/**
 * Rank guild members against a typed query.
 *
 * Bots are excluded outright — a coordinator is never trying to roster Lucid.
 * `excludeUserIds` keeps players who already hold a slot on this roster out of
 * the list, since seating one person twice is invalid by construction.
 */
export function rankCandidates(
  query: string,
  members: MemberCandidate[],
  excludeUserIds: Iterable<string> = [],
): RankedCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const excluded = new Set(excludeUserIds);
  const ranked: RankedCandidate[] = [];

  for (const member of members) {
    if (member.isBot) continue;
    if (excluded.has(member.userId)) continue;

    // Best (lowest) rank across all of this member's names.
    let best: 0 | 1 | 2 | null = null;
    for (const name of namesOf(member)) {
      const haystack = name.toLowerCase();
      let rank: 0 | 1 | 2 | null = null;
      if (haystack === needle) rank = 0;
      else if (haystack.startsWith(needle)) rank = 1;
      else if (haystack.includes(needle)) rank = 2;

      if (rank !== null && (best === null || rank < best)) best = rank;
    }

    if (best !== null) ranked.push({ ...member, rank: best });
  }

  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Stable, predictable secondary ordering so the same query always produces
    // the same list for the coordinator.
    return a.username.localeCompare(b.username);
  });

  return ranked.slice(0, MAX_CANDIDATES);
}

/** "Display Name (@username)" — the label format used in candidate select menus. */
export function candidateLabel(member: MemberCandidate): string {
  const display = member.nickname || member.displayName;
  return display && display !== member.username
    ? `${display} (@${member.username})`
    : `@${member.username}`;
}
