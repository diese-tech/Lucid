/**
 * Read-only diagnostic -- run with `npm run vetting:audit-orphans`. Lists
 * every SYSTEM row whose Discord ID doesn't match a member Discord's API
 * currently returns for the guild (see vetting/audit-orphans.ts for exactly
 * what that does and does not mean). Never writes to the spreadsheet or
 * Discord; a row showing up here is something to review by hand.
 */

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadEnv } from '../config.js';
import { findOrphanedSystemRows } from '../vetting/audit-orphans.js';
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
    const guild = client.guilds.cache.get(env.vetting.guildId);
    if (!guild) {
      console.error(
        `VETTING_GUILD_ID (${env.vetting.guildId}) does not match any guild this bot is in -- check the ID and that the bot hasn't been removed from that server.`,
      );
      process.exit(1);
    }

    console.log(`Scanning ${env.vetting.systemSheetName} against ${guild.name} (${guild.id})'s live membership...`);
    const orphans = await findOrphanedSystemRows(guild, sheetsClient, env.vetting);

    if (orphans.length === 0) {
      console.log('No orphaned rows -- every SYSTEM row matches a current guild member.');
      return;
    }

    console.log(
      `${orphans.length} row(s) don't match a current member. This includes real players who have genuinely left --`,
    );
    console.log('check the ones you don\'t recognize, or whose roles look unfamiliar, before deleting anything:\n');
    for (const row of orphans) {
      console.log(`Row ${row.rowNumber}: ${row.discordId} (${row.username} / ${row.displayName})`);
      console.log(
        `  Active=${row.active || '(blank)'}  Joined=${row.joinedAt || '(blank)'}  Left=${row.leftAt || '(blank)'}`,
      );
      console.log(`  Current Roles: ${row.currentRoles || '(blank)'}\n`);
    }
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error('Vetting orphan audit failed:', error);
  process.exit(1);
});
