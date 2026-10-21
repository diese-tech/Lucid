import { afterEach, expect, it, vi } from 'vitest';
import { logInteractionFailure } from '../src/discord/interaction-errors.js';
import { Action } from '../src/discord/ids.js';

afterEach(() => vi.restoreAllMocks());

it('preserves a safe type, source location and stable fingerprint for ordinary failures', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new TypeError('Cannot read SECRET_DATABASE_FIELD');
  failure.stack = 'TypeError: SECRET_DATABASE_FIELD\n    at handler (file:///app/dist/discord/flows/manage.js:80:5)\n    at https://discord.com/api/webhooks/SECRET_TOKEN';
  logInteractionFailure(failure, { stage: 'routing', action: Action.Manage, pickupId: 4 });
  logInteractionFailure(failure, { stage: 'routing', action: Action.Manage, pickupId: 4 });
  const diagnostic = log.mock.calls[0]?.[1].exception;
  expect(diagnostic).toMatchObject({ type: 'TypeError', fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
    locations: ['dist/discord/flows/manage.js:80:5'] });
  expect(log.mock.calls[1]?.[1].exception).toEqual(diagnostic);
  logInteractionFailure(new Error('Different database failure SECRET'), { stage: 'routing' });
  expect(log.mock.calls[2]?.[1].exception.fingerprint).not.toBe(diagnostic.fingerprint);
  expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
});

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
