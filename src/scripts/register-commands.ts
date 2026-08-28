/**
 * One-off script to publish slash commands to Discord.
 *
 * Run with `npm run register` after changing anything in src/discord/commands.ts.
 * Global commands can take up to an hour to appear in every guild the first
 * time; subsequent updates are usually quick.
 */

import { REST, Routes } from 'discord.js';
import { loadEnv } from '../config.js';
import { commandJSON } from '../discord/commands.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const rest = new REST({ version: '10' }).setToken(env.discordToken);

  console.log(`Registering ${commandJSON.length} command(s) globally…`);
  await rest.put(Routes.applicationCommands(env.discordClientId), { body: commandJSON });
  console.log('Done. Global commands may take up to an hour to propagate.');
}

main().catch((error) => {
  console.error('Failed to register commands:', error);
  process.exit(1);
});
