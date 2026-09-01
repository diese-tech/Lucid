import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { handleHelpCommand, helpCommand } from '../src/discord/help.js';

describe('/help', () => {
  it('replies privately with a complete plain-English pickup quickstart', async () => {
    const reply = vi.fn(async () => undefined);

    await handleHelpCommand({ reply } as never);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]![0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);

    const rendered = JSON.stringify(payload.embeds[0].toJSON());
    for (const expected of [
      '/pickup create',
      '/pickup cancel',
      '/pickup config',
      'eligibility role',
      'Fill',
      'same time',
      'Shuffle',
      'Publish',
      'Replace Player',
    ]) {
      expect(rendered).toContain(expected);
    }
  });

  it('registers as the help slash command with a readable description', () => {
    expect(helpCommand.toJSON()).toMatchObject({
      name: 'help',
      description: "Show a quick guide to Lucid's commands.",
    });
  });
});
