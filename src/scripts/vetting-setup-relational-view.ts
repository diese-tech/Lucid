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
import type { VettingConfig } from '../vetting/config.js';
import type { VettingLayout } from '../vetting/vetting-layout.js';

/**
 * Pulled out as its own pure function -- issue #75's own regression, a
 * stale hard-coded coordinate string that silently drifted from what the
 * installer actually wrote, was only catchable by pinning this exact
 * text against a resolved layout in a test (see
 * tests/vetting/vetting-setup-scripts.test.ts), which a string inlined
 * into `main()` can't be.
 */
export function formatRelationalViewDoneMessage(config: VettingConfig, layout: VettingLayout): string {
  const discordIdLetter = columnIndexToLetter(layout.discordIdColumn);
  const currentRolesLetter = columnIndexToLetter(layout.currentRolesColumn);
  return (
    `Done. Installed the SYSTEM -> VETTING relational projection into ${config.vettingSheetName}!${discordIdLetter}3:${currentRolesLetter}3 -- ` +
    `${config.vettingSheetName}'s Discord ID/Player/Current Roles columns now mirror ${config.systemSheetName} automatically.`
  );
}

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
  console.log(formatRelationalViewDoneMessage(env.vetting, layout));
}

// Only runs `main()` when this file is executed directly (`npm run
// vetting:setup-relational-view`) -- guarding it lets
// tests/vetting/vetting-setup-scripts.test.ts import
// `formatRelationalViewDoneMessage` above without also loading env vars,
// hitting the real Sheets API, or calling `process.exit`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Vetting relational-view setup failed:', error);
    process.exit(1);
  });
}
