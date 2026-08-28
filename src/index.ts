/**
 * Lucid entry point.
 *
 * A single long-running process: one Discord gateway connection, one SQLite
 * file. Lucid's scope — one guild's worth of pickups at a time, driven entirely
 * by slash commands and message components — does not call for a queue, a
 * worker pool, or a hosted database.
 */

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { loadEnv } from './config.js';
import { initDatabase } from './db/index.js';
import { routeInteraction } from './discord/router.js';
import { handleReactionAdd, handleReactionRemove } from './discord/flows/signups.js';
import { tryHandleEmojiBind } from './discord/flows/config.js';

async function main(): Promise<void> {
  const env = loadEnv();
  initDatabase(env.databasePath);
  console.log(`Database ready at ${env.databasePath}`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      // Privileged. Needed to search members by name during player
      // replacement — must be enabled for the application in the Discord
      // Developer Portal or the bot will fail to log in.
      GatewayIntentBits.GuildMembers,
    ],
    // Reactions arrive on messages that predate this process (after a restart,
    // or on an old signup post), so we must opt into partials and fetch them.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`Lucid is online as ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, routeInteraction);

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // The config flow's react-to-bind step consumes reactions on its own
    // prompt message. It gets first refusal so those never leak into signups.
    const consumed = await tryHandleEmojiBind(reaction, user).catch(() => false);
    if (consumed) return;
    await handleReactionAdd(reaction, user);
  });

  client.on(Events.MessageReactionRemove, handleReactionRemove);

  client.on(Events.Error, (error) => console.error('Discord client error:', error));

  // A rejected promise anywhere in an event handler should be logged loudly,
  // never silently swallowed — and never take the process down mid-pickup.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });

  await client.login(env.discordToken);
}

main().catch((error) => {
  console.error('Lucid failed to start:', error);
  process.exit(1);
});
