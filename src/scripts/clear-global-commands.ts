/**
 * Clear Lucid's globally-registered slash commands.
 *
 * Run with `npm run unregister-global`.
 *
 * Global and guild-scoped commands are stored independently by Discord — if a
 * guild ever ends up with both (e.g. commands were registered globally once,
 * then DISCORD_TEST_GUILD_ID was set later and `npm run register` ran again),
 * every command shows up TWICE in that server's picker, both pointing at the
 * same bot. Discord doesn't deduplicate these; they're genuinely two separate
 * registrations.
 *
 * This clears the global set (an empty PUT), leaving only guild-scoped
 * commands in place — the right move while developing against one test
 * server. Re-run `npm run register` with DISCORD_TEST_GUILD_ID unset once
 * you're ready to actually publish for every server again.
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
