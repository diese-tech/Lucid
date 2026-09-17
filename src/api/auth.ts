/**
 * Authentication for the read-only pickup data API (issue #45).
 *
 * One shared static secret, checked via a header -- `X-API-Key`, not
 * `Authorization: Bearer`, deliberately. Bearer conventionally signals an
 * OAuth-style token with expiry/scope/refresh semantics this system doesn't
 * have; X-API-Key is the honest name for "one non-expiring shared secret,"
 * without implying capabilities v1 doesn't offer.
 *
 * There is no per-guild scoping here -- see docs/api.md. One key grants
 * read access to every guild this Lucid instance manages; building a
 * per-key guild ACL table for a single-guild deployment with one trusted
 * consumer is exactly the unnecessary v1 infrastructure the issue warns
 * against. The key must only ever be held server-side by that consumer's
 * backend, never shipped to browser JS -- a leaked key exposes everything.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Constant-time comparison against the configured key, so a byte-by-byte
 * mismatch can't be timed to guess the secret. `timingSafeEqual` throws on
 * a length mismatch rather than returning false, so that case is checked
 * explicitly first -- a length mismatch is itself not secret (an attacker
 * already knows their own guess's length), so short-circuiting on it here
 * leaks nothing timingSafeEqual's own protection is meant to hide.
 */
export function isAuthorized(req: IncomingMessage, apiKey: string): boolean {
  const provided = req.headers['x-api-key'];
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(apiKey);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
