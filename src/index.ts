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
import { registerGuildCommands } from './discord/register.js';
import { handleReactionAdd, handleReactionRemove } from './discord/flows/signups.js';
import { tryHandleEmojiBind } from './discord/flows/config.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = initDatabase(env.databasePath);
  console.log(`Database ready at ${env.databasePath}`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      // Not privileged, but easy to forget: without this, the gateway never
      // sends guild emoji data, so client.emojis.cache stays effectively
      // empty. That cache is exactly what the emoji-binding flow checks to
      // confirm Lucid can use a reacted-with emoji (config.ts,
      // tryHandleEmojiBind) — omitting this intent makes every custom emoji
      // from every guild look unusable, not just ones from elsewhere.
      GatewayIntentBits.GuildExpressions,
      // Privileged. Needed to search members by name during player
      // replacement — must be enabled for the application in the Discord
      // Developer Portal or the bot will fail to log in.
      GatewayIntentBits.GuildMembers,
    ],
    // Reactions arrive on messages that predate this process (after a restart,
    // or on an old signup post), so we must opt into partials and fetch them.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Lucid is online as ${ready.user.tag}`);

    // Guild-scoped registration applies in seconds, so every guild Lucid is
    // already in gets freshly synced on every boot — covering any command
    // change made since it last ran — without the up-to-an-hour propagation
    // delay a global registration would carry. GuildCreate below covers
    // guilds it joins after this point.
    for (const guild of ready.guilds.cache.values()) {
      try {
        await registerGuildCommands(ready, guild.id);
      } catch (error) {
        console.error(`Failed to register commands for guild ${guild.id} (${guild.name}):`, error);
      }
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    try {
      await registerGuildCommands(guild.client, guild.id);
      console.log(`Registered commands for newly joined guild ${guild.id} (${guild.name}).`);
    } catch (error) {
      console.error(`Failed to register commands for newly joined guild ${guild.id} (${guild.name}):`, error);
    }
  });

  // Gateway lifecycle logging. Kept as ordinary operational logging rather
  // than debug scaffolding: when Lucid stops responding, the first question is
  // always "is it still connected?", and these four lines answer it from the
  // logs alone without a redeploy. They are quiet on a healthy process.
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`Shard ${shardId} disconnected — code=${event.code} reason=${event.reason || '(none)'}`);
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    console.warn(`Shard ${shardId} reconnecting…`);
  });
  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    console.warn(`Shard ${shardId} resumed — ${replayedEvents} event(s) replayed from the gap`);
  });
  client.on(Events.ShardError, (error, shardId) => {
    console.warn(`Shard ${shardId} error:`, error);
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

  // Graceful shutdown — previously missing entirely. Found by comparing
  // against Ratatoskr (a sibling bot in the same server), which closes its
  // client and database on SIGINT/SIGTERM; Lucid just let Node's default
  // signal handling kill the process outright.
  //
  // This was added while chasing interaction failures that turned out to have
  // a different cause entirely (two processes sharing one bot token — see
  // docs/setup.md). It is kept because it is correct on its own merits, not
  // because it fixed that: an ungracefully killed process never sends Discord
  // a clean WebSocket close, so the gateway takes multiple heartbeat intervals
  // to notice the session is gone, and the SQLite handle is left for the OS to
  // reap rather than closed with its WAL checkpointed.
  // If client.destroy() hangs (a stalled network call has no guaranteed
  // bound) or rejects, the shutdown must still finish: db.close() and
  // process.exit() run in `finally` regardless, and SHUTDOWN_TIMEOUT_MS
  // stops waiting on a client that isn't closing rather than blocking exit
  // indefinitely. A second signal during shutdown means "stop waiting," not
  // "try again" — it forces an immediate exit rather than being silently
  // dropped by the in-progress guard, which would otherwise leave Ctrl+C
  // looking dead if the first attempt ever got stuck.
  const SHUTDOWN_TIMEOUT_MS = 5000;
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      console.warn(`Received ${signal} again during shutdown — forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down…`);
    try {
      await Promise.race([
        client.destroy(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    } catch (error) {
      console.error('Error while closing the Discord client (continuing anyway):', error);
    } finally {
      db.close();
      process.exit(0);
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(env.discordToken);
}

main().catch((error) => {
  console.error('Lucid failed to start:', error);
  process.exit(1);
});
