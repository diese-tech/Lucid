/**
 * One-time spreadsheet setup for issue #54 Phase 5 -- installs the human
 * voting workflow's calculated fields. Run with `npm run vetting:setup-voting`.
 * Safe to re-run any time: see src/vetting/vetting-voting-setup.ts for
 * exactly what it writes and why.
 */

import { loadEnv } from '../config.js';
import { createVettingSheetsClient } from '../vetting/sheets-client.js';
import { installVotingWorkflowFormulas } from '../vetting/vetting-voting-setup.js';
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
  console.log(`Resolving ${env.vetting.vettingSheetName}'s current reviewer layout from its row-2 headers...`);
  // The exact install range depends on the current reviewer count (issue
  // #71) -- logging the resolved range rather than a guess is itself one
  // of that issue's Phase 3/6 requirements.
  const layout = await installVotingWorkflowFormulas(client, env.vetting);
  const voteSummaryLetter = columnIndexToLetter(layout.voteSummaryColumn);
  const consensusLetter = columnIndexToLetter(layout.consensusColumn);
  const finalDecisionLetter = columnIndexToLetter(layout.finalDecisionColumn);
  console.log(
    `Done. Installed Vote Summary/Consensus formulas into ${env.vetting.vettingSheetName}!${voteSummaryLetter}3:${consensusLetter}3 ` +
      `(tallying ${layout.reviewerCount} reviewer column(s)), and the Final Decision lookup into ${env.vetting.systemSheetName}!I3, ` +
      `reading ${env.vetting.vettingSheetName}!${finalDecisionLetter} by Discord ID -- ` +
      `${env.vetting.vettingSheetName}'s Vote Summary/Consensus now calculate automatically from the reviewer columns, and setting Final Decision there now shows up in ${env.vetting.systemSheetName}!I for the same player.`,
  );
}

main().catch((error) => {
  console.error('Vetting voting-workflow setup failed:', error);
  process.exit(1);
});
