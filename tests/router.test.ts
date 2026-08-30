/**
 * Dispatch tests for src/discord/router.ts.
 *
 * router.ts's entire value is correctly sorting every Action into the right
 * flow handler -- it holds no business logic of its own (that's what the
 * flow-level tests in tests/flows/ cover). A router bug is exactly the
 * copy-paste-prone kind: an action left out of every set (silently
 * dropped) or added to the wrong one (dispatched to the wrong handler).
 * Both are invisible from reading any single Set in isolation, so this file
 * mocks every flow module's handlers and dispatches EVERY Action value from
 * the real enum, one at a time, asserting exactly one mock fired -- rather
 * than spot-checking a handful and hoping the rest are consistent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Action } from '../src/discord/ids.js';

const mocks = vi.hoisted(() => ({
  handleConfigAutocomplete: vi.fn(async () => undefined),
  handleConfigCommand: vi.fn(async () => undefined),
  handleConfigComponent: vi.fn(async () => undefined),
  handleCreateCommand: vi.fn(async () => undefined),
  handleCreateComponent: vi.fn(async () => undefined),
  handleCreateModal: vi.fn(async () => undefined),
  handleReviewComponent: vi.fn(async () => undefined),
  handleReplaceComponent: vi.fn(async () => undefined),
  handleReplaceModal: vi.fn(async () => undefined),
  handleCancelCommand: vi.fn(async () => undefined),
  handleCancelComponent: vi.fn(async () => undefined),
}));

vi.mock('../src/discord/flows/config.js', () => ({
  handleConfigAutocomplete: mocks.handleConfigAutocomplete,
  handleConfigCommand: mocks.handleConfigCommand,
  handleConfigComponent: mocks.handleConfigComponent,
}));
vi.mock('../src/discord/flows/create.js', () => ({
  handleCreateCommand: mocks.handleCreateCommand,
  handleCreateComponent: mocks.handleCreateComponent,
  handleCreateModal: mocks.handleCreateModal,
}));
vi.mock('../src/discord/flows/review.js', () => ({
  handleReviewComponent: mocks.handleReviewComponent,
}));
vi.mock('../src/discord/flows/replace.js', () => ({
  handleReplaceComponent: mocks.handleReplaceComponent,
  handleReplaceModal: mocks.handleReplaceModal,
}));
vi.mock('../src/discord/flows/cancel.js', () => ({
  handleCancelCommand: mocks.handleCancelCommand,
  handleCancelComponent: mocks.handleCancelComponent,
}));

const { routeInteraction } = await import('../src/discord/router.js');

function allMocks() {
  return Object.values(mocks);
}

function calledMocks() {
  return Object.entries(mocks)
    .filter(([, fn]) => fn.mock.calls.length > 0)
    .map(([name]) => name);
}

interface FakeInteractionOptions {
  type: 'autocomplete' | 'chatInput' | 'modal' | 'component';
  commandName?: string;
  subcommand?: string;
  customId?: string;
  replied?: boolean;
  deferred?: boolean;
  repliable?: boolean;
  reply?: ReturnType<typeof vi.fn>;
}

function fakeInteraction(options: FakeInteractionOptions) {
  return {
    isAutocomplete: () => options.type === 'autocomplete',
    isChatInputCommand: () => options.type === 'chatInput',
    isModalSubmit: () => options.type === 'modal',
    isMessageComponent: () => options.type === 'component',
    isRepliable: () => options.repliable ?? true,
    commandName: options.commandName ?? 'pickup',
    customId: options.customId ?? '',
    options: { getSubcommand: () => options.subcommand ?? '' },
    replied: options.replied ?? false,
    deferred: options.deferred ?? false,
    reply: options.reply ?? vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  for (const mock of allMocks()) mock.mockClear();
});

describe('autocomplete', () => {
  it('routes /pickup autocomplete to the config handler', async () => {
    await routeInteraction(fakeInteraction({ type: 'autocomplete' }) as never);
    expect(mocks.handleConfigAutocomplete).toHaveBeenCalledTimes(1);
  });

  it('ignores autocomplete for any other command', async () => {
    await routeInteraction(fakeInteraction({ type: 'autocomplete', commandName: 'notpickup' }) as never);
    expect(calledMocks()).toEqual([]);
  });
});

describe('chat input commands', () => {
  it('ignores a command that is not /pickup', async () => {
    await routeInteraction(fakeInteraction({ type: 'chatInput', commandName: 'notpickup', subcommand: 'create' }) as never);
    expect(calledMocks()).toEqual([]);
  });

  it.each([
    ['create', 'handleCreateCommand'],
    ['config', 'handleConfigCommand'],
    ['cancel', 'handleCancelCommand'],
  ] as const)('routes /pickup %s to %s', async (subcommand, expected) => {
    await routeInteraction(fakeInteraction({ type: 'chatInput', subcommand }) as never);
    expect(calledMocks()).toEqual([expected]);
  });

  it('dispatches nothing for a subcommand it does not recognize', async () => {
    await routeInteraction(fakeInteraction({ type: 'chatInput', subcommand: 'not-a-real-subcommand' }) as never);
    expect(calledMocks()).toEqual([]);
  });
});

describe('modal submissions', () => {
  it('ignores a customId decodeId cannot parse', async () => {
    await routeInteraction(fakeInteraction({ type: 'modal', customId: 'not-a-valid-id' }) as never);
    expect(calledMocks()).toEqual([]);
  });

  it('routes ReplaceSearchModal to the replace-modal handler', async () => {
    await routeInteraction(fakeInteraction({ type: 'modal', customId: `${Action.ReplaceSearchModal}:1:2` }) as never);
    expect(calledMocks()).toEqual(['handleReplaceModal']);
  });

  it('routes a create-wizard modal to the create-modal handler', async () => {
    await routeInteraction(fakeInteraction({ type: 'modal', customId: `${Action.CreateDetailsModal}:123456789` }) as never);
    expect(calledMocks()).toEqual(['handleCreateModal']);
  });

  it('dispatches nothing for an action that owns no modal', async () => {
    await routeInteraction(fakeInteraction({ type: 'modal', customId: `${Action.Shuffle}:1:0` }) as never);
    expect(calledMocks()).toEqual([]);
  });
});

describe('message components -- every Action dispatches to exactly the right flow, or to none', () => {
  it('ignores a customId decodeId cannot parse', async () => {
    await routeInteraction(fakeInteraction({ type: 'component', customId: 'not-a-valid-id' }) as never);
    expect(calledMocks()).toEqual([]);
  });

  const EXPECTED: Record<string, string> = {
    // Create wizard
    [Action.CreateFormat]: 'handleCreateComponent',
    [Action.CreateRoleLimit]: 'handleCreateComponent',
    [Action.CreateOpenDetails]: 'handleCreateComponent',
    [Action.CreatePost]: 'handleCreateComponent',
    [Action.CreateEdit]: 'handleCreateComponent',
    [Action.CreateCancel]: 'handleCreateComponent',
    // Guild config panel
    [Action.ConfigChannel]: 'handleConfigComponent',
    [Action.ConfigRole]: 'handleConfigComponent',
    [Action.ConfigBindEmoji]: 'handleConfigComponent',
    // Staff review card + Edit Roster + Publish
    [Action.Shuffle]: 'handleReviewComponent',
    [Action.EditRoster]: 'handleReviewComponent',
    [Action.Publish]: 'handleReviewComponent',
    [Action.PublishConfirm]: 'handleReviewComponent',
    [Action.PublishBack]: 'handleReviewComponent',
    [Action.EditSwap]: 'handleReviewComponent',
    [Action.EditChangeRole]: 'handleReviewComponent',
    [Action.EditReplaceSlot]: 'handleReviewComponent',
    [Action.EditPickSlot]: 'handleReviewComponent',
    [Action.EditPickTarget]: 'handleReviewComponent',
    [Action.EditBack]: 'handleReviewComponent',
    // Cancel
    [Action.Cancel]: 'handleCancelComponent',
    [Action.CancelPick]: 'handleCancelComponent',
    [Action.CancelConfirm]: 'handleCancelComponent',
    // Post-publish replacement
    [Action.Replace]: 'handleReplaceComponent',
    [Action.ReplacePickSlot]: 'handleReplaceComponent',
    [Action.ReplacePickBench]: 'handleReplaceComponent',
    [Action.ReplaceSearch]: 'handleReplaceComponent',
    [Action.ReplacePickCandidate]: 'handleReplaceComponent',
    [Action.ReplaceConfirm]: 'handleReplaceComponent',
  };

  // CreateDetailsModal is a real Action value but only ever arrives as a modal
  // submission (covered above), never a message component click -- excluded
  // from this table on purpose, not an oversight.
  const untested = Object.values(Action).filter(
    (action) => !(action in EXPECTED) && action !== Action.CreateDetailsModal && action !== Action.ReplaceSearchModal,
  );
  it('accounts for every Action value (fails loudly if a new one is added here without updating this test)', () => {
    expect(untested).toEqual([]);
  });

  it.each(Object.entries(EXPECTED))('%s routes to %s', async (action, expected) => {
    await routeInteraction(fakeInteraction({ type: 'component', customId: `${action}:1:0` }) as never);
    expect(calledMocks()).toEqual([expected]);
  });
});

describe('error handling', () => {
  it('logs and replies ephemerally when a handler throws and nothing has answered yet', async () => {
    mocks.handleCancelCommand.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reply = vi.fn(async () => undefined);

    await routeInteraction(fakeInteraction({ type: 'chatInput', subcommand: 'cancel', reply }) as never);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Something went wrong handling that action.' }),
    );
    errorSpy.mockRestore();
  });

  it('does not try to reply again if the interaction was already answered', async () => {
    mocks.handleReviewComponent.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reply = vi.fn(async () => undefined);

    await routeInteraction(
      fakeInteraction({ type: 'component', customId: `${Action.Shuffle}:1:0`, deferred: true, reply }) as never,
    );

    expect(reply).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not propagate if the fallback reply itself fails (expired token)', async () => {
    mocks.handleCancelComponent.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reply = vi.fn(async () => {
      throw new Error('Unknown interaction');
    });

    await expect(
      routeInteraction(fakeInteraction({ type: 'component', customId: `${Action.Cancel}:1:0`, reply }) as never),
    ).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });

  it('skips the fallback reply entirely when the interaction is not repliable', async () => {
    mocks.handleCancelComponent.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reply = vi.fn(async () => undefined);

    await routeInteraction(
      fakeInteraction({ type: 'component', customId: `${Action.Cancel}:1:0`, repliable: false, reply }) as never,
    );

    expect(reply).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
