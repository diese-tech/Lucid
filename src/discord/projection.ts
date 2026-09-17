/**
 * Durable Discord delivery recovery (issue #35).
 *
 * Audit (pickup_events) and delivery are separate concerns: a mutation's
 * database write is the source of truth the instant its transaction commits.
 * Everything below only tracks whether Lucid has since managed to make some
 * Discord message SHOW that truth -- never whether the truth itself is
 * correct, and never by rolling the mutation back over a delivery problem.
 *
 * `projectSurface` is the one place a caller attempts a Discord edit/send
 * that reflects an already-committed mutation. It always durably records the
 * attempt before making it, and always classifies the outcome afterward
 * instead of a bare swallow-all catch, so a genuinely uncertain response (a
 * timeout, not a definite rejection) stays distinguishable later from a
 * confirmed success or a confirmed, safely-retryable rejection.
 */

import { DiscordAPIError } from 'discord.js';
import { PickupProjectionRepository } from '../db/repositories/pickup-projections.js';
import type { ProjectionStatus, ProjectionSurface } from '../db/repositories/types.js';

/**
 * Told to staff whenever a mutation is refused because an earlier delivery
 * attempt for this exact pickup/version is still unresolved after Lucid just
 * tried, live, to resolve it -- issue #35's requirement that conflicting
 * mutations be blocked/serialized rather than layered onto an uncertain
 * projection.
 */
export const PROJECTION_CONFLICT_MESSAGE =
  "Lucid is still confirming an earlier update to this roster. Try again in a moment.";

/**
 * Sort a Discord failure into what's safe to do about it, never by guessing:
 *
 * - A `DiscordAPIError` means Discord itself gave a definite HTTP response --
 *   the message is gone, a permission is missing, the request was malformed.
 *   Whatever the specific problem, Lucid got an authoritative answer, so it
 *   is safe to simply leave the attempt 'pending' for a later retry; it is
 *   NOT safe to assume Discord silently accepted a write it explicitly
 *   rejected.
 * - Anything else -- a timeout, a dropped connection, discord.js giving up
 *   after its own internal retries -- means Lucid never got a definite
 *   answer at all. The edit may have landed anyway. Reporting that as a
 *   confirmed failure (and, worse, retrying in a way that could duplicate an
 *   already-landed send) is exactly the "blind duplicate send" issue #35
 *   forbids -- 'uncertain' says plainly that Lucid does not know.
 */
export function classifyProjectionFailure(error: unknown): { status: 'pending' | 'uncertain'; note: string } {
  if (error instanceof DiscordAPIError) {
    return { status: 'pending', note: `discord-error-${error.code}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'uncertain', note: `transport-uncertain: ${message}`.slice(0, 500) };
}

/**
 * Durably attempt one projection of an already-committed mutation onto
 * Discord.
 *
 * Begins a 'pending' row for (pickupId, surface, messageId) -- capturing the
 * pickup's CURRENT version, never a value the caller might be holding stale
 * -- immediately before calling `edit`, and resolves it to 'applied',
 * 'pending' (a confirmed, retryable rejection), or 'uncertain' (a genuinely
 * unknown outcome) once `edit` settles.
 *
 * Never THROWS: every call site this replaces already treated a Discord
 * failure as something to swallow and durably remember, not something to
 * abort the interaction over -- the database mutation this reflects already
 * committed and stands regardless of what happens here. Returns the
 * resulting status instead, for the rare caller (see refreshReviewCard/
 * writeControlCard in review.ts) that has its own pre-existing contract of
 * propagating a redraw failure to ITS callers and needs to keep doing so.
 */
export async function projectSurface(params: {
  pickupId: number;
  surface: ProjectionSurface;
  messageId: string | null;
  edit: () => Promise<unknown>;
}): Promise<ProjectionStatus> {
  const projections = new PickupProjectionRepository();
  const id = projections.begin(params.pickupId, params.surface, params.messageId);
  try {
    await params.edit();
    projections.markApplied(id);
    return 'applied';
  } catch (error) {
    const { status, note } = classifyProjectionFailure(error);
    if (status === 'uncertain') {
      console.error(
        `[projection] uncertain outcome projecting '${params.surface}' for pickup ${params.pickupId}`,
        error,
      );
      projections.markUncertain(id, note);
    } else {
      projections.markPending(id, note);
    }
    return status;
  }
}
