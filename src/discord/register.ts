/**
 * Registers Lucid's slash commands to one guild.
 *
 * Guild-scoped registration applies within seconds. A global registration
 * (`Routes.applicationCommands`, with no guild ID) can take up to an hour to
 * propagate the first time — tolerable for a bot installed once and left
 * alone, a poor fit while its command set is still actively changing.
 *
 * index.ts calls this for every guild Lucid is already in on every boot, and
 * again the moment it joins a new one, so no server it's in is ever more
 * than one restart — or a join event — away from having current commands,
 * and no manual registration step is needed for either case.
 */

import { Routes } from 'discord.js';
import type { Client } from 'discord.js';
import { commandJSON } from './commands.js';

export async function registerGuildCommands(client: Client, guildId: string): Promise<void> {
  await client.rest.put(Routes.applicationGuildCommands(client.application!.id, guildId), {
    body: commandJSON,
  });
}
