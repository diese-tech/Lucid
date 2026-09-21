/**
 * Shared VETTING sheet layout resolver (issue #71) -- resolves the
 * reviewer/vetter column block, Vote Summary, Consensus, and Final
 * Decision columns from VETTING's own row-2 header text instead of a
 * hard-coded `D:K`/`L:M`/`N` layout or a reviewer-count env var.
 *
 * Staff can add, remove, or rename reviewer columns on the live sheet
 * (they only ever need to keep `Vote Summary` immediately after the last
 * reviewer column, `Consensus` immediately after that, and `Final
 * Decision` immediately after that) without any Lucid/Railway change --
 * every formula builder and setup/repair script that needs VETTING
 * coordinates should resolve them once, here, rather than assuming a
 * fixed width.
 *
 * "Resolve once, validate once, derive every downstream range from that
 * same layout object" -- the resolver fails closed (throws
 * `VettingLayoutError`, never guesses) on any ambiguous or malformed
 * header row so a staff typo can never silently redirect a formula
 * install/clear into the wrong columns.
 */

import type { VettingConfig } from './config.js';
import type { VettingSheetsClient } from './sheets-client.js';

const DISCORD_ID_HEADER = 'Discord ID';
const DISPLAY_NAME_HEADER = 'Player';
const CURRENT_ROLES_HEADER = 'Current Roles';
const VOTE_SUMMARY_HEADER = 'Vote Summary';
const CONSENSUS_HEADER = 'Consensus';
const FINAL_DECISION_HEADER = 'Final Decision';

/**
 * Thrown for anything about the VETTING header row that makes its layout
 * ambiguous or unsafe to derive ranges from -- missing/duplicate
 * structural headers, out-of-order calculated columns, or an empty
 * reviewer block. Callers must treat this as "perform no formula writes,
 * clears, or Discord reconciliation based on this layout" (issue #71's own
 * fail-closed requirement), never as a warning to guess past.
 */
export class VettingLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VettingLayoutError';
  }
}

/**
 * A fully resolved, validated VETTING column layout. Every field is a
 * 1-based column index (A = 1) -- callers derive A1 letters only at the
 * Sheets boundary via `columnIndexToLetter`, matching the issue's own
 * "prefer one canonical representation" guidance.
 */
export interface VettingLayout {
  discordIdColumn: number;
  displayNameColumn: number;
  currentRolesColumn: number;
  reviewerStartColumn: number;
  reviewerEndColumn: number;
  reviewerCount: number;
  voteSummaryColumn: number;
  consensusColumn: number;
  finalDecisionColumn: number;
}

/** Converts a 1-based column index to A1 column letters (1 -> "A", 27 -> "AA", 702 -> "ZZ"). */
export function columnIndexToLetter(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`columnIndexToLetter expects a 1-based integer, got ${index}.`);
  }
  let letters = '';
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Converts A1 column letters to a 1-based column index ("A" -> 1, "AA" -> 27, "ZZ" -> 702). */
export function columnLetterToIndex(letters: string): number {
  if (!/^[A-Za-z]+$/.test(letters)) {
    throw new RangeError(`columnLetterToIndex expects only letters, got "${letters}".`);
  }
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

/**
 * Every distinct header found, and every column index it appeared in --
 * powers both "missing" (empty array) and "duplicated" (2+ entries)
 * detection with the same lookup, and lets error messages describe the
 * actual header row rather than just "not found".
 */
function indexHeaderRow(headerRow: readonly string[]): Map<string, number[]> {
  const columnsByHeader = new Map<string, number[]>();
  headerRow.forEach((rawCell, i) => {
    const cell = (rawCell ?? '').trim();
    if (cell === '') return;
    const columns = columnsByHeader.get(cell) ?? [];
    columns.push(i + 1);
    columnsByHeader.set(cell, columns);
  });
  return columnsByHeader;
}

function describeHeaderRow(headerRow: readonly string[]): string {
  const nonBlank = headerRow
    .map((cell, i) => [i + 1, (cell ?? '').trim()] as const)
    .filter(([, cell]) => cell !== '');
  if (nonBlank.length === 0) return '(the header row is completely blank)';
  return nonBlank.map(([column, cell]) => `${columnIndexToLetter(column)}="${cell}"`).join(', ');
}

function requireSingleColumn(
  columnsByHeader: Map<string, number[]>,
  headerName: string,
  headerRow: readonly string[],
): number {
  const columns = columnsByHeader.get(headerName) ?? [];
  if (columns.length === 0) {
    throw new VettingLayoutError(
      `VETTING header row is missing a "${headerName}" column. Found headers: ${describeHeaderRow(headerRow)}.`,
    );
  }
  if (columns.length > 1) {
    throw new VettingLayoutError(
      `VETTING header row has "${headerName}" duplicated in columns ${columns.map(columnIndexToLetter).join(', ')} -- it must appear exactly once.`,
    );
  }
  return columns[0]!;
}

/**
 * Resolves VETTING's structural layout from its row-2 header text. Fails
 * closed with `VettingLayoutError` (no downstream range is ever returned)
 * when any structural header is missing, duplicated, out of order, or the
 * reviewer block between `Current Roles` and `Vote Summary` is empty --
 * every one of issue #71's malformed-layout cases is a rejection here,
 * never a guess.
 *
 * `headerRow` is VETTING's row 2, column A onward (index 0 = column A) --
 * callers read it fresh before every formula install/repair rather than
 * caching a previous resolution, since staff can edit reviewer columns at
 * any time between runs.
 */
export function resolveVettingLayout(headerRow: readonly string[]): VettingLayout {
  const columnsByHeader = indexHeaderRow(headerRow);

  const discordIdColumn = requireSingleColumn(columnsByHeader, DISCORD_ID_HEADER, headerRow);
  const displayNameColumn = requireSingleColumn(columnsByHeader, DISPLAY_NAME_HEADER, headerRow);
  const currentRolesColumn = requireSingleColumn(columnsByHeader, CURRENT_ROLES_HEADER, headerRow);
  const voteSummaryColumn = requireSingleColumn(columnsByHeader, VOTE_SUMMARY_HEADER, headerRow);
  const consensusColumn = requireSingleColumn(columnsByHeader, CONSENSUS_HEADER, headerRow);
  const finalDecisionColumn = requireSingleColumn(columnsByHeader, FINAL_DECISION_HEADER, headerRow);

  if (displayNameColumn !== discordIdColumn + 1 || currentRolesColumn !== displayNameColumn + 1) {
    throw new VettingLayoutError(
      `"${DISCORD_ID_HEADER}", "${DISPLAY_NAME_HEADER}", and "${CURRENT_ROLES_HEADER}" must be three consecutive columns -- found them at ${columnIndexToLetter(discordIdColumn)}, ${columnIndexToLetter(displayNameColumn)}, and ${columnIndexToLetter(currentRolesColumn)}.`,
    );
  }

  if (currentRolesColumn >= voteSummaryColumn) {
    throw new VettingLayoutError(
      `"${VOTE_SUMMARY_HEADER}" (${columnIndexToLetter(voteSummaryColumn)}) must come after "${CURRENT_ROLES_HEADER}" (${columnIndexToLetter(currentRolesColumn)}).`,
    );
  }

  if (consensusColumn !== voteSummaryColumn + 1) {
    throw new VettingLayoutError(
      `"${CONSENSUS_HEADER}" must be the column immediately after "${VOTE_SUMMARY_HEADER}" -- found "${VOTE_SUMMARY_HEADER}" at ${columnIndexToLetter(voteSummaryColumn)} and "${CONSENSUS_HEADER}" at ${columnIndexToLetter(consensusColumn)}.`,
    );
  }

  if (finalDecisionColumn !== consensusColumn + 1) {
    throw new VettingLayoutError(
      `"${FINAL_DECISION_HEADER}" must be the column immediately after "${CONSENSUS_HEADER}" -- found "${CONSENSUS_HEADER}" at ${columnIndexToLetter(consensusColumn)} and "${FINAL_DECISION_HEADER}" at ${columnIndexToLetter(finalDecisionColumn)}.`,
    );
  }

  const reviewerStartColumn = currentRolesColumn + 1;
  const reviewerEndColumn = voteSummaryColumn - 1;
  const reviewerCount = reviewerEndColumn - reviewerStartColumn + 1;
  if (reviewerCount < 1) {
    throw new VettingLayoutError(
      `No reviewer columns found between "${CURRENT_ROLES_HEADER}" (${columnIndexToLetter(currentRolesColumn)}) and "${VOTE_SUMMARY_HEADER}" (${columnIndexToLetter(voteSummaryColumn)}) -- at least one reviewer column is required.`,
    );
  }

  return {
    discordIdColumn,
    displayNameColumn,
    currentRolesColumn,
    reviewerStartColumn,
    reviewerEndColumn,
    reviewerCount,
    voteSummaryColumn,
    consensusColumn,
    finalDecisionColumn,
  };
}

/** An open-ended (unbounded row) A1 column range, e.g. `columnRange(4, 11)` -> `"D:K"`. Used to build formula ranges like `D3:K`. */
export function columnRange(startColumn: number, endColumn: number): string {
  return `${columnIndexToLetter(startColumn)}:${columnIndexToLetter(endColumn)}`;
}

/**
 * Reads VETTING's row-2 header text and resolves its current layout.
 * Every vetting component that needs VETTING coordinates (voting-formula
 * install, relational-projection install, future setup/repair scripts)
 * should call this rather than resolving its own copy, so "resolve once,
 * validate once" (issue #71) holds across the whole codebase. The read
 * range is wide enough to cover any realistic reviewer count well past
 * column Z without needing to know the width in advance.
 */
export async function readVettingLayout(
  sheetsClient: VettingSheetsClient,
  config: VettingConfig,
): Promise<VettingLayout> {
  const [headerRow = []] = await sheetsClient.getValues(config.vettingSheetName, '2:2');
  return resolveVettingLayout(headerRow);
}
