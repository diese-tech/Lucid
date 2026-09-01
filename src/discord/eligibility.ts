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
