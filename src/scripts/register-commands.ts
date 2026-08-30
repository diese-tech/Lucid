/**
 * One-off script to publish slash commands to Discord.
 *
 * Run with `npm run register` after changing anything in src/discord/commands.ts.
 *
 * Global commands (the production default — Lucid is guild-agnostic, so it
 * needs to work in any server that adds it, not just one dev guild) can take
 * up to an hour to propagate the first time. That's fine for a real release,
 * but brutal while iterating locally against one test server.
 *
 * Set DISCORD_TEST_GUILD_ID in .env to skip that entirely: this script then
 * registers to that one guild instead, which Discord applies in seconds. Only
 * that guild sees the commands — never set this in production.
 */

import { REST, Routes } from 'discord.js';
import { loadEnv } from '../config.js';
import { commandJSON } from '../discord/commands.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const rest = new REST({ version: '10' }).setToken(env.discordToken);
  const testGuildId = process.env.DISCORD_TEST_GUILD_ID?.trim();

  if (testGuildId) {
    console.log(`Registering ${commandJSON.length} command(s) to test guild ${testGuildId}…`);
    await rest.put(Routes.applicationGuildCommands(env.discordClientId, testGuildId), {
      body: commandJSON,
    });
    console.log('Done — guild commands apply within seconds.');
    return;
  }

  console.log(`Registering ${commandJSON.length} command(s) globally…`);
  await rest.put(Routes.applicationCommands(env.discordClientId), { body: commandJSON });
  console.log('Done. Global commands may take up to an hour to propagate.');
}

main().catch((error) => {
  console.error('Failed to register commands:', error);
  process.exit(1);
});
