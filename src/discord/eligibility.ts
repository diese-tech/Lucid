import type { Client, Guild } from 'discord.js';
import type { SignupRecord } from '../domain/roster.js';

/** Eligible if the member holds ANY of the configured roles (OR semantics); no roles means everyone qualifies. */
export function hasEligibilityRole(
  roleIds: { has(roleId: string): boolean },
  eligibilityRoleIds: readonly string[],
): boolean {
  return eligibilityRoleIds.length === 0 || eligibilityRoleIds.some((roleId) => roleIds.has(roleId));
}

export interface EligibilityLookup {
  /** False means the lookup itself failed — `eligible` is empty but NOT a confirmed zero. */
  ok: boolean;
  eligible: Set<string>;
}

/**
 * Same membership check as resolveEligibleUserIds, but tells the caller
 * whether the lookup itself succeeded instead of silently collapsing a
 * failure into "nobody is eligible" — a caller that shows staff a "0
 * eligible" readiness number must be able to tell that apart from "Lucid
 * couldn't check". Callers that need to fail closed for safety (roster
 * generation, publish gating) should keep using resolveEligibleUserIds below,
 * which is exactly this with the distinction dropped.
 */
export async function resolveEligibleUserIdsChecked(
  guild: Guild,
  userIds: Iterable<string>,
  eligibilityRoleIds: readonly string[],
): Promise<EligibilityLookup> {
  const unique = [...new Set(userIds)];
  if (eligibilityRoleIds.length === 0) return { ok: true, eligible: new Set(unique) };
  if (unique.length === 0) return { ok: true, eligible: new Set() };
  try {
    const eligible = new Set<string>();
    for (let index = 0; index < unique.length; index += 100) {
      const members = await guild.members.fetch({ user: unique.slice(index, index + 100) });
      for (const [id, member] of members) {
        if (eligibilityRoleIds.some((roleId) => member.roles.cache.has(roleId))) eligible.add(id);
      }
    }
    return { ok: true, eligible };
  } catch {
    return { ok: false, eligible: new Set() };
  }
}

export async function resolveEligibleUserIds(
  guild: Guild,
  userIds: Iterable<string>,
  eligibilityRoleIds: readonly string[],
): Promise<Set<string>> {
  return (await resolveEligibleUserIdsChecked(guild, userIds, eligibilityRoleIds)).eligible;
}

/**
 * The result of checking one member against the configured eligibility roles.
 *
 * 'unknown' is not the same fact as 'ineligible' and callers must not treat it
 * as one: it means the check itself failed (a rate limit, a network blip),
 * not that Lucid confirmed the member holds none of the roles. Telling a
 * player "you need one of these roles" when Lucid actually just couldn't
 * check is false guidance — see the caller in signups.ts for how the two are
 * handled differently.
 */
export type MemberEligibility = 'eligible' | 'ineligible' | 'unknown';

/**
 * Does this one member currently hold any of the configured eligibility roles?
 *
 * Used at the moment a reaction comes in, where fetching every guild member up
 * front (as resolveEligibleUserIds does for a whole signup pool) would be
 * wasteful for a single click.
 */
export async function isMemberEligible(
  guild: Guild,
  userId: string,
  eligibilityRoleIds: readonly string[],
): Promise<MemberEligibility> {
  if (eligibilityRoleIds.length === 0) return 'eligible';
  try {
    const member = await guild.members.fetch(userId);
    return eligibilityRoleIds.some((roleId) => member.roles.cache.has(roleId)) ? 'eligible' : 'ineligible';
  } catch {
    return 'unknown';
  }
}

/**
 * Whether at least one of staff's configured eligibility roles can still be
 * found.
 *
 * 'missing' means Lucid successfully checked EVERY configured role and every
 * one is genuinely gone — a confirmed staff configuration problem. Under OR
 * semantics, a single surviving role is enough for some members to still
 * qualify, so this only fails closed once none of them do. 'unknown' means at
 * least one check failed (a rate limit, a network blip) while none of the
 * others were confirmed to still exist, and must NOT be reported as
 * 'missing': that would send staff to cancel and recreate a perfectly fine
 * pickup over a transient error. See isMemberEligible above for the same
 * distinction applied to membership checks.
 */
export type RoleLookup = 'exists' | 'missing' | 'unknown';

/**
 * Have ALL of staff's configured eligibility roles been deleted (or
 * otherwise become unreadable) out from under this pickup?
 *
 * A fully deleted role set must never be silently treated as "no
 * restriction" — every member would fail the `.has()` checks above anyway,
 * which looks identical to "the roles exist and genuinely nobody holds them
 * yet". This distinguishes the two so staff can be told their configuration
 * is broken instead of just watching readiness telemetry stay stuck at 0.
 */
export async function eligibilityRolesExist(guild: Guild, eligibilityRoleIds: readonly string[]): Promise<RoleLookup> {
  let sawFailure = false;
  for (const roleId of eligibilityRoleIds) {
    try {
      const role = await guild.roles.fetch(roleId);
      // OR semantics: one live role is enough for the configuration to be sound.
      if (role !== null) return 'exists';
    } catch {
      sawFailure = true;
    }
  }
  return sawFailure ? 'unknown' : 'missing';
}

export async function eligibleSignupRecords(
  client: Client,
  guildId: string,
  records: SignupRecord[],
  eligibilityRoleIds: readonly string[],
): Promise<SignupRecord[]> {
  if (eligibilityRoleIds.length === 0) return records;
  try {
    const guild = await client.guilds.fetch(guildId);
    const eligible = await resolveEligibleUserIds(guild, records.map((record) => record.userId), eligibilityRoleIds);
    return records.filter((record) => eligible.has(record.userId));
  } catch {
    return [];
  }
}

/** Why a candidate failed commit-time revalidation -- see verifyCurrentCandidate. */
export type CandidateRefusal = 'not-in-guild' | 'bot' | 'ineligible' | 'lookup-failed';

/**
 * The check every commit that seats or replaces a NEW candidate into a
 * roster slot must run immediately before writing (issue #35's commit-time
 * target revalidation) -- independent of whether the pickup has any
 * eligibility roles configured at all.
 *
 * Signing up (a reaction) and appearing in a member-search result both
 * require Discord to currently consider the user a real, non-bot guild
 * member -- but time passes between then and a staff confirmation, and
 * neither fact is re-checked at all once a pickup has no eligibility roles
 * configured: resolveEligibleUserIds's whole-pool lookup short-circuits to
 * "everyone qualifies" in that case (isMemberEligible does the same for a
 * single member), so a stale signup from someone who has since left the
 * guild would otherwise sail through with zero re-verification. A user who
 * left the guild, or somehow reached this point as a bot account, must
 * never be seated or replaced in on that basis alone, regardless of the
 * pickup's own eligibility configuration.
 */
export async function verifyCurrentCandidate(
  guild: Guild | null,
  userId: string,
  eligibilityRoleIds: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: CandidateRefusal }> {
  if (!guild) return { ok: false, reason: 'lookup-failed' };
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, reason: 'not-in-guild' };
  if (member.user.bot) return { ok: false, reason: 'bot' };
  if (!hasEligibilityRole(member.roles.cache, eligibilityRoleIds)) return { ok: false, reason: 'ineligible' };
  return { ok: true };
}

/** A refusal message for verifyCurrentCandidate's result, ready to show staff verbatim. */
export function candidateRefusalMessage(reason: CandidateRefusal, userId: string): string {
  switch (reason) {
    case 'not-in-guild':
      return `<@${userId}> is no longer a member of this server. Reopen the workflow and pick someone else.`;
    case 'bot':
      return `<@${userId}> is a bot account and cannot hold a roster slot.`;
    case 'ineligible':
      return `<@${userId}> does not hold any of this pickup's eligibility roles.`;
    case 'lookup-failed':
      return 'Lucid could not verify that player just now. Try again in a moment.';
  }
}
