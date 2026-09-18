/**
 * One-time spreadsheet setup for issue #54 Phase 4 -- installs the
 * SYSTEM -> VETTING relational projection formulas. Run with
 * `npm run vetting:setup-relational-view`. Safe to re-run any time: see
 * src/vetting/vetting-tab-setup.ts for exactly what it writes and why.
 */

import { loadEnv } from '../config.js';
import { createVettingSheetsClient } from '../vetting/sheets-client.js';
import { installVettingRelationalFormulas } from '../vetting/vetting-tab-setup.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.vetting.enabled) {
    console.error(
      'VETTING_ENABLED is not true -- set it and the rest of the vetting env vars (see .env.example) before running this.',
    );
    process.exit(1);
  }

  const client = createVettingSheetsClient(env.vetting);
  console.log(
    `Installing the SYSTEM -> VETTING relational projection into ${env.vetting.vettingSheetName}!A2:C2...`,
  );
  await installVettingRelationalFormulas(client, env.vetting);
  console.log(
    `Done. ${env.vetting.vettingSheetName}'s Discord ID/Player/Current Roles columns now mirror ${env.vetting.systemSheetName} automatically.`,
  );
}

main().catch((error) => {
  console.error('Vetting relational-view setup failed:', error);
  process.exit(1);
});
