/**
 * Clear Lucid's globally-registered slash commands.
 *
 * Run with `npm run unregister-global`.
 *
 * Lucid registers guild-scoped commands only now (src/discord/register.ts),
 * automatically, on every boot and on joining a new guild — there is no code
 * path left that registers globally. This script exists for the one-time
 * migration off any global registration made before that change, and as an
 * escape hatch if one is ever made by accident again.
 *
 * Global and guild-scoped commands are stored independently by Discord — if a
 * guild has both, every command shows up TWICE in that server's picker, both
 * pointing at the same bot. Discord doesn't deduplicate these; they're
 * genuinely two separate registrations, and only clearing the global set
 * removes the duplicate. The bot's own guild-scoped registration is
 * untouched by this and re-applies on its next boot regardless.
 */

import { REST, Routes } from 'discord.js';
import { loadEnv } from '../config.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const rest = new REST({ version: '10' }).setToken(env.discordToken);

  console.log('Clearing globally-registered commands…');
  await rest.put(Routes.applicationCommands(env.discordClientId), { body: [] });
  console.log('Done. Global commands cleared — any guild-scoped registrations are untouched.');
}

main().catch((error) => {
  console.error('Failed to clear global commands:', error);
  process.exit(1);
});
