import { afterEach, expect, it, vi } from 'vitest';
import { logInteractionFailure } from '../src/discord/interaction-errors.js';
import { Action } from '../src/discord/ids.js';

afterEach(() => vi.restoreAllMocks());

it('logs the failed component path without webhook tokens, request bodies, or raw error messages', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logInteractionFailure({ code: 50035, status: 400, message: 'SECRET error',
    url: 'https://discord.com/api/webhooks/SECRET', requestBody: { content: 'SECRET content' },
    rawError: { errors: { components: { 1: { components: { 1: { custom_id: {
      _errors: [{ code: 'COMPONENT_CUSTOM_ID_DUPLICATED', message: 'SECRET message' }],
    } } } } } } } }, { stage: 'routing', action: Action.PublishedSwap, pickupId: 4, version: 9 });
  expect(log).toHaveBeenCalledWith('Interaction handler failed:', expect.objectContaining({
    stage: 'routing', action: Action.PublishedSwap, pickupId: 4, version: 9, code: 50035, status: 400,
    fields: [{ path: 'components.1.components.1.custom_id', code: 'COMPONENT_CUSTOM_ID_DUPLICATED' }],
  }));
  expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
});

it('bounds malformed API errors and never echoes arbitrary action or error text', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const error of [null, 'SECRET', new Error('SECRET'), { code: 'SECRET', rawError: { errors: {
    SECRET: { _errors: [{ code: 'SECRET' }] }, components: { _errors: Array.from({ length: 50 }, () => ({ code: 'INVALID' })) },
  } } }]) logInteractionFailure(error, { stage: 'workspace_open', action: 'SECRET' });
  expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  expect(log.mock.calls.at(-1)?.[1].fields).toHaveLength(10);
});
