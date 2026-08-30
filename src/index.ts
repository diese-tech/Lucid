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

  client.once(Events.ClientReady, (ready) => {
    console.log(`Lucid is online as ${ready.user.tag}`);
  });

  // --- Diagnostic logging (round 2).
  //
  // Round 1 ruled out the dropped-gateway-connection theory directly: a live
  // failure logged age=401ms at receipt — well inside Discord's 3-second
  // window — with no shardDisconnect/Reconnecting/Resume anywhere near it.
  // The interaction was fresh when we got it and still failed as "Unknown
  // interaction" on .reply().
  //
  // Also ruled out by reading the code: handleConfigCommand's own logic
  // before that .reply() call is one synchronous SQLite read and some string
  // building — microseconds, not seconds.
  //
  // What's left is the .reply() call itself — the actual outbound HTTPS
  // request to Discord's REST API. Round 1 never measured that; it only
  // logged the moment the gateway event arrived. This measures the full
  // routeInteraction() duration (success or failure) to see whether the time
  // is going into that network call specifically.
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`[diag] shard ${shardId} disconnected — code=${event.code} reason=${event.reason || '(none)'}`);
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    console.warn(`[diag] shard ${shardId} reconnecting…`);
  });
  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    console.warn(`[diag] shard ${shardId} resumed — ${replayedEvents} event(s) replayed from the gap`);
  });
  client.on(Events.ShardError, (error, shardId) => {
    console.warn(`[diag] shard ${shardId} error:`, error);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    const ageMs = Date.now() - interaction.createdTimestamp;
    const start = Date.now();
    console.log(`[diag] interaction received — type=${interaction.type} age=${ageMs}ms`);
    return routeInteraction(interaction).finally(() => {
      console.log(`[diag] interaction handled — type=${interaction.type} handlerMs=${Date.now() - start}ms`);
    });
  });

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
  // against Ratatoskr (a sibling bot in the same server, confirmed working),
  // which closes its client and database on SIGINT/SIGTERM; Lucid just let
  // Node's default signal handling kill the process outright.
  //
  // Why that matters here specifically: on plain Ctrl+C, an ungracefully
  // killed process never sends Discord a clean WebSocket close, so Discord's
  // gateway can take a while (multiple heartbeat intervals) to notice that
  // session is actually gone. The exact test cycle in use while iterating
  // locally — Ctrl+C, then `npm run dev` again seconds later — can therefore
  // leave two sessions briefly alive under the same bot token, which is a
  // very plausible source of interactions failing to resolve cleanly. Worth
  // fixing regardless of whether it's the whole explanation: an ungraceful
  // shutdown is wrong on its own merits, and this closes the SQLite handle
  // properly too rather than relying on the OS to clean it up.
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
