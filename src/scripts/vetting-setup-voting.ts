/**
 * One-time spreadsheet setup for issue #54 Phase 5 -- installs the human
 * voting workflow's calculated fields. Run with `npm run vetting:setup-voting`.
 * Safe to re-run any time: see src/vetting/vetting-voting-setup.ts for
 * exactly what it writes and why.
 */

import { loadEnv } from '../config.js';
import { createVettingSheetsClient } from '../vetting/sheets-client.js';
import { installVotingWorkflowFormulas } from '../vetting/vetting-voting-setup.js';

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
    `Installing Vote Summary/Consensus formulas into ${env.vetting.vettingSheetName}!L2:M2, and the Final Decision lookup into ${env.vetting.systemSheetName}!I2...`,
  );
  await installVotingWorkflowFormulas(client, env.vetting);
  console.log(
    `Done. ${env.vetting.vettingSheetName}'s Vote Summary/Consensus now calculate automatically from the vetter columns, and setting Final Decision there now shows up in ${env.vetting.systemSheetName}!I for the same player.`,
  );
}

main().catch((error) => {
  console.error('Vetting voting-workflow setup failed:', error);
  process.exit(1);
});
