/**
 * One-time spreadsheet setup for issue #54 Phase 4 -- installs the
 * SYSTEM -> VETTING relational projection formulas. Run with
 * `npm run vetting:setup-relational-view`. Safe to re-run any time: see
 * src/vetting/vetting-tab-setup.ts for exactly what it writes and why.
 */

import { loadEnv } from '../config.js';
import { createVettingSheetsClient } from '../vetting/sheets-client.js';
import { installVettingRelationalFormulas } from '../vetting/vetting-tab-setup.js';
import { columnIndexToLetter } from '../vetting/vetting-layout.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.vetting.enabled) {
    console.error(
      'VETTING_ENABLED is not true -- set it and the rest of the vetting env vars (see .env.example) before running this.',
    );
    process.exit(1);
  }

  const client = createVettingSheetsClient(env.vetting);
  console.log(`Resolving ${env.vetting.vettingSheetName}'s current layout from its row-2 headers...`);
  // The exact install range depends on where VETTING's own header row
  // actually places Discord ID/Current Roles (issue #71) -- logging the
  // resolved range rather than a guess is itself one of that issue's
  // Phase 3/6 requirements.
  const layout = await installVettingRelationalFormulas(client, env.vetting);
  const discordIdLetter = columnIndexToLetter(layout.discordIdColumn);
  const currentRolesLetter = columnIndexToLetter(layout.currentRolesColumn);
  console.log(
    `Done. Installed the SYSTEM -> VETTING relational projection into ${env.vetting.vettingSheetName}!${discordIdLetter}3:${currentRolesLetter}3 -- ` +
      `${env.vetting.vettingSheetName}'s Discord ID/Player/Current Roles columns now mirror ${env.vetting.systemSheetName} automatically.`,
  );
}

main().catch((error) => {
  console.error('Vetting relational-view setup failed:', error);
  process.exit(1);
});
