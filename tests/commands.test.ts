import { describe, expect, it } from 'vitest';
import { commandJSON } from '../src/discord/commands.js';

describe('slash command registration', () => {
  it('registers both /pickup and /help', () => {
    expect(commandJSON.map((command) => command.name)).toEqual(['pickup', 'help']);
  });

  it('describes every pickup command and option in plain English', () => {
    const pickup = commandJSON.find((command) => command.name === 'pickup')!;
    const options = pickup.options ?? [];
    const create = options.find((option) => option.name === 'create')!;
    const cancel = options.find((option) => option.name === 'cancel')!;
    const config = options.find((option) => option.name === 'config')!;
    const configOptions = 'options' in config ? (config.options ?? []) : [];

    expect(pickup.description).toBe('Create, configure, or cancel pickup games.');
    expect(create.description).toBe('Set up a pickup, preview it, then post it for signups.');
    expect(cancel.description).toBe('Cancel an open pickup after confirmation.');
    expect(config.description).toBe('Set the channels, staff roles, timezone, and signup emojis for this server.');
    expect(configOptions.find((option) => option.name === 'timezone')?.description).toBe(
      'Timezone used to read pickup times, such as America/New_York.',
    );
    expect(configOptions.find((option) => option.name === 'bind_emoji')?.description).toBe(
      'Bind five role emojis and optional Fill.',
    );
  });
});
