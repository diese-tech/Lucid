/**
 * Shared JSON-array-of-role-IDs parsing, used by every `*_role_ids` column
 * (authorized_role_ids, eligibility_role_ids, default_eligibility_role_ids).
 */

/**
 * Stands in for a role list that failed to parse. Never a real Discord
 * snowflake (those are purely numeric), so every membership check treats it
 * as "configured but unresolvable" rather than a role nobody happens to
 * hold — which plugs straight into the existing role-missing/unknown
 * staff-facing error path (see eligibility.ts's eligibilityRolesExist)
 * instead of needing new plumbing.
 */
export const CORRUPTED_ROLE_SENTINEL = '__corrupted__';

/**
 * Parse a `*_role_ids` JSON blob into a real string array.
 *
 * A blob that fails to parse, isn't an array, or contains a non-string
 * entry is corruption, not "no roles configured" — those are different
 * facts and must not collapse to the same empty list. For a column where
 * empty legitimately means "unrestricted" (eligibility), silently returning
 * `[]` here would flip a restricted pickup open the moment its stored JSON
 * got damaged. Pass `failClosed: true` for those columns so corruption
 * produces a role that can never be held instead of no restriction at all.
 * Columns where empty already means the safe/closed state (authorized_role_ids
 * — nobody authorized) don't need it; a corrupt blob failing to that same
 * state is correct on its own.
 */
export function parseRoleIds(blob: string, options: { failClosed?: boolean } = {}): string[] {
  try {
    const parsed = JSON.parse(blob);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const ids = parsed.filter((id) => typeof id === 'string');
    if (ids.length !== parsed.length) throw new Error('array contained a non-string entry');
    return ids;
  } catch (error) {
    console.error(`[db] corrupted role-ID JSON blob, treating as ${options.failClosed ? 'fail-closed' : 'empty'}:`, blob, error);
    return options.failClosed ? [CORRUPTED_ROLE_SENTINEL] : [];
  }
}
