import { createHash } from 'node:crypto';
import { Action } from './ids.js';

interface FailureContext {
  stage: 'workspace_open' | 'confirmation' | 'routing';
  action?: string;
  pickupId?: number | null;
  version?: number | null;
  outcome?: 'saved' | 'not_saved' | 'unknown';
}
const actions = new Set<string>(Object.values(Action));
const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'SqliteError', 'DiscordAPIError']);
const errorKeys = new Set(['components', 'custom_id', 'embeds', 'content', 'fields', 'options', 'label',
  'value', 'description', 'title', 'footer', 'text', 'author', 'name', 'url']);

/** Discord errors can contain webhook tokens and entire request bodies. Log only allowlisted metadata. */
export function logInteractionFailure(error: unknown, context: FailureContext): void {
  const data = error as { code?: unknown; status?: unknown; rawError?: { errors?: unknown } } | null;
  const fields: { path: string; code: string }[] = [];
  function visit(value: unknown, path: string[], depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 10 || fields.length >= 10) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '_errors' && Array.isArray(child)) {
        for (const item of child.slice(0, 10 - fields.length)) {
          if (typeof item?.code === 'string' && /^[A-Z_]{1,80}$/.test(item.code)) {
            fields.push({ path: path.join('.'), code: item.code });
          }
        }
      } else if (errorKeys.has(key) || /^\d{1,2}$/.test(key)) visit(child, [...path, key], depth + 1);
      if (fields.length >= 10) break;
    }
  }
  visit(data?.rawError?.errors, []);
  const exception = error instanceof Error ? {
    type: errorTypes.has(error.name) ? error.name : 'Error',
    // Retain correlation without exposing arbitrary exception text or request URLs.
    fingerprint: createHash('sha256').update(`${error.name}\n${error.message}\n${error.stack ?? ''}`).digest('hex').slice(0, 16),
    locations: [...(error.stack ?? '').replaceAll('\\', '/').matchAll(
      /\b((?:src|dist)\/(?:discord|db|api|domain|vetting)\/[a-z0-9_./-]+\.(?:[cm]?js|ts):\d+:\d+)/gi,
    )].slice(0, 3).map(match => match[1]!.slice(0, 180)),
  } : undefined;
  console.error('Interaction handler failed:', {
    stage: context.stage,
    action: context.action && actions.has(context.action) ? context.action : undefined,
    pickupId: Number.isSafeInteger(context.pickupId) ? context.pickupId : undefined,
    version: Number.isSafeInteger(context.version) ? context.version : undefined,
    outcome: context.outcome ?? 'unknown',
    code: typeof data?.code === 'number' ? data.code : undefined,
    status: typeof data?.status === 'number' ? data.status : undefined,
    fields,
    exception,
  });
}
