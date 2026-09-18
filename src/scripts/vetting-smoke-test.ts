/**
 * One-off manual verification for the vetting Sheets adapter (issue #54,
 * Phase 1) -- confirms the service-account credentials actually work
 * end-to-end against the real spreadsheet before any bootstrap/sync logic
 * depends on them. Run with `npm run vetting:smoke-test`.
 *
 * Reads the SYSTEM tab's first few rows, then round-trips a harmless write
 * to a cell well outside the real column range (N1, one past the L column
 * the template actually uses) and clears it again -- never touches real
 * player data.
 */

import { loadEnv } from '../config.js';
import { createVettingSheetsClient } from '../vetting/sheets-client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.vetting.enabled) {
    console.error(
      'VETTING_ENABLED is not true -- set it and the rest of the vetting env vars (see .env.example) before running this.',
    );
    process.exit(1);
  }

  const client = createVettingSheetsClient(env.vetting);
  const systemSheet = env.vetting.systemSheetName;

  console.log(`Reading ${systemSheet}!A1:L5...`);
  const rows = await client.getValues(systemSheet, 'A1:L5');
  console.log(`Read ${rows.length} row(s):`);
  for (const row of rows) console.log('  ', row);

  const testCellRange = 'N1';
  const marker = `lucid-smoke-test-${Date.now()}`;
  console.log(`Writing a harmless marker to ${systemSheet}!${testCellRange}...`);
  await client.updateValues(systemSheet, testCellRange, [[marker]]);

  const readBackRows = await client.getValues(systemSheet, testCellRange);
  const readBack = readBackRows[0]?.[0];
  if (readBack !== marker) {
    throw new Error(`Wrote "${marker}" but read back "${readBack}" -- the write did not round-trip correctly.`);
  }
  console.log('Write round-tripped correctly. Clearing the test cell...');
  await client.updateValues(systemSheet, testCellRange, [['']]);

  console.log('Success: this service account can read and write the configured spreadsheet.');
}

main().catch((error) => {
  console.error('Vetting smoke test failed:', error);
  process.exit(1);
});
