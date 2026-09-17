/**
 * Candidate ordering for post-publish replacement — "who on this pickup's
 * signup list can take the seat that just opened up?".
 *
 * Kept free of Discord types so it can be tested against fixtures, and
 * deliberately separate from member-resolver.ts: that one ranks arbitrary
 * guild members against a typed query for the emergency search, this one
 * ranks people who already signed up for THIS pickup against a role.
 */

import type { Signup } from '../db/repositories/types.js';
import type { Role, SignupRole } from './roles.js';

export interface ReplacementCandidate {
  userId: string;
  /** Every distinct role this player signed up for, in signup order. */
  roles: SignupRole[];
  /** True when none of their signups cover the target role. */
  offRole: boolean;
}

/** Fill is a standing offer to play anything, so it covers every role. */
function covers(signupRole: SignupRole, role: Role): boolean {
  return signupRole === role || signupRole === 'fill';
}

/**
 * Collapse a pickup's signups into one candidate per player, role matches first.
 *
 * Anyone in `rosteredUserIds` is dropped outright: a player cannot be their own
 * replacement, and nobody may hold two seats.
 *
 * The sort separates on-role from off-role and nothing else, and is stable, so
 * every finer ordering question — exact role ahead of Fill, earliest signup
 * first — stays the caller's to answer through the order it passes signups in.
 */
export function rankReplacementCandidates(
  signups: readonly Signup[],
  rosteredUserIds: ReadonlySet<string>,
  role: Role,
): ReplacementCandidate[] {
  const byUser = new Map<string, ReplacementCandidate>();

  for (const signup of signups) {
    if (rosteredUserIds.has(signup.userId)) continue;

    const candidate = byUser.get(signup.userId);
    if (!candidate) {
      byUser.set(signup.userId, {
        userId: signup.userId,
        roles: [signup.role],
        offRole: !covers(signup.role, role),
      });
      continue;
    }
    if (!candidate.roles.includes(signup.role)) candidate.roles.push(signup.role);
    if (covers(signup.role, role)) candidate.offRole = false;
  }

  return [...byUser.values()].sort((a, b) => Number(a.offRole) - Number(b.offRole));
}
