/**
 * Guild inventory bootstrap (issue #54, Phase 2) -- run with
 * `npm run vetting:bootstrap`. Logs in just long enough to fetch every
 * guild's member list, syncs it into the SYSTEM tab (see
 * vetting/bootstrap.ts for exactly what that does and does not touch), then
 * disconnects. Safe to re-run at any time -- an existing SYSTEM row is
 * refreshed in place, never duplicated.
 */

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadEnv } from '../config.js';
import { bootstrapGuildInventory } from '../vetting/bootstrap.js';
import { createVettingSheetsClient } from '../vetting/sheets-client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.vetting.enabled) {
    console.error(
      'VETTING_ENABLED is not true -- set it and the rest of the vetting env vars (see .env.example) before running this.',
    );
    process.exit(1);
  }

  const sheetsClient = createVettingSheetsClient(env.vetting);

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(env.discordToken);
  await ready;

  try {
    for (const guild of client.guilds.cache.values()) {
      console.log(`Bootstrapping ${guild.name} (${guild.id})...`);
      const summary = await bootstrapGuildInventory(guild, sheetsClient, env.vetting);
      console.log(
        `  ${summary.totalMembers} non-bot member(s): ${summary.created} created, ${summary.updated} updated.`,
      );
      if (summary.conflicts.length > 0) {
        console.log(
          `  Conflict (multiple managed tier roles, Current Tier Role left blank) for: ${summary.conflicts.join(', ')}`,
        );
      }
    }
    console.log('Bootstrap complete.');
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error('Vetting bootstrap failed:', error);
  process.exit(1);
});
