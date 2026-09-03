import type { Client, Guild } from 'discord.js';
import type { SignupRecord } from '../domain/roster.js';

export function hasEligibilityRole(
  roleIds: { has(roleId: string): boolean },
  eligibilityRoleId: string | null,
): boolean {
  return !eligibilityRoleId || roleIds.has(eligibilityRoleId);
}

export async function resolveEligibleUserIds(
  guild: Guild,
  userIds: Iterable<string>,
  eligibilityRoleId: string | null,
): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (!eligibilityRoleId) return new Set(unique);
  if (unique.length === 0) return new Set();
  try {
    const eligible = new Set<string>();
    for (let index = 0; index < unique.length; index += 100) {
      const members = await guild.members.fetch({ user: unique.slice(index, index + 100) });
      for (const [id, member] of members) {
        if (member.roles.cache.has(eligibilityRoleId)) eligible.add(id);
      }
    }
    return eligible;
  } catch {
    return new Set();
  }
}

/**
 * The result of checking one member against an eligibility role.
 *
 * 'unknown' is not the same fact as 'ineligible' and callers must not treat it
 * as one: it means the check itself failed (a rate limit, a network blip),
 * not that Lucid confirmed the member lacks the role. Telling a player "you
 * need this role" when Lucid actually just couldn't check is false guidance —
 * see the caller in signups.ts for how the two are handled differently.
 */
export type MemberEligibility = 'eligible' | 'ineligible' | 'unknown';

/**
 * Does this one member currently hold the eligibility role?
 *
 * Used at the moment a reaction comes in, where fetching every guild member up
 * front (as resolveEligibleUserIds does for a whole signup pool) would be
 * wasteful for a single click.
 */
export async function isMemberEligible(
  guild: Guild,
  userId: string,
  eligibilityRoleId: string | null,
): Promise<MemberEligibility> {
  if (!eligibilityRoleId) return 'eligible';
  try {
    const member = await guild.members.fetch(userId);
    return member.roles.cache.has(eligibilityRoleId) ? 'eligible' : 'ineligible';
  } catch {
    return 'unknown';
  }
}

/**
 * Has staff's configured eligibility role been deleted (or otherwise become
 * unreadable) out from under this pickup?
 *
 * A deleted role must never be silently treated as "no restriction" — every
 * member would fail the `.has()` check above anyway, which looks identical to
 * "the role exists and genuinely nobody holds it yet". This distinguishes the
 * two so staff can be told their configuration is broken instead of just
 * watching readiness telemetry stay stuck at 0.
 */
export async function eligibilityRoleExists(guild: Guild, eligibilityRoleId: string): Promise<boolean> {
  try {
    const role = await guild.roles.fetch(eligibilityRoleId);
    return role !== null;
  } catch {
    return false;
  }
}

export async function eligibleSignupRecords(
  client: Client,
  guildId: string,
  records: SignupRecord[],
  eligibilityRoleId: string | null,
): Promise<SignupRecord[]> {
  if (!eligibilityRoleId) return records;
  try {
    const guild = await client.guilds.fetch(guildId);
    const eligible = await resolveEligibleUserIds(guild, records.map((record) => record.userId), eligibilityRoleId);
    return records.filter((record) => eligible.has(record.userId));
  } catch {
    return [];
  }
}
