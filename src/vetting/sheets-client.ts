/**
 * Thin Google Sheets API boundary for the vetting pipeline (issue #54,
 * Phase 1) -- every Sheets call in the codebase should go through this, so
 * auth, retries, and error shape live in one place instead of being
 * reinvented at each call site as later phases add bootstrap/sync/reconcile.
 *
 * Uses `google-auth-library`'s `JWT` client only for service-account token
 * exchange -- not the full `googleapis` package, which pulls in generated
 * clients for every Google API Lucid will never call. Actual reads/writes
 * are plain `fetch` calls against the Sheets API v4 REST endpoints, so the
 * retry policy below is one this module fully owns rather than whatever the
 * SDK happens to do internally.
 */

import { JWT } from 'google-auth-library';
import type { VettingConfig } from './config.js';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * Thrown for anything the Sheets API itself rejected or a transport failure
 * -- never for a locally-detected config problem (that's config.ts's job).
 * `recoverable` distinguishes a rate limit/transient 5xx (worth retrying on
 * a later poll tick, once a caller does that in a later phase) from
 * something that will keep failing until a human fixes it (bad range,
 * permission denied, spreadsheet not shared with the service account).
 */
export class VettingSheetsError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, options: { recoverable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'VettingSheetsError';
    this.recoverable = options.recoverable;
  }
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function backoffMs(attempt: number): number {
  return 250 * 2 ** (attempt - 1);
}

/**
 * Reads just enough of the Sheets API's own JSON error body to log
 * something useful -- Google's error responses don't echo back request
 * credentials, so this is safe to include in a thrown message.
 */
async function describeErrorResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * Builds an A1-notation range from a sheet name and a cell range, e.g.
 * `('SYSTEM', 'A2:L1000')` -> `'SYSTEM'!A2:L1000`. Always single-quotes the
 * sheet name (doubling any embedded quote) rather than trying to detect
 * which names "need" it -- Google's Sheets API accepts a quoted sheet name
 * unconditionally, so always quoting removes an entire class of bugs rather
 * than trading one edge case for another. Config.ts's `systemSheetName`/
 * `vettingSheetName` are free-form (Half-Shell's PR #59 finding: an earlier
 * version built ranges as plain template strings, which broke the moment a
 * configured sheet name contained a space, something #58 explicitly allows).
 */
function quotedSheetRange(sheetName: string, cellRange: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${cellRange}`;
}

export class VettingSheetsClient {
  private readonly auth: JWT;

  constructor(
    private readonly spreadsheetId: string,
    serviceAccountJson: string,
    /** Injected only by tests -- real callers always want the actual clock. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    const key = JSON.parse(serviceAccountJson) as ServiceAccountKey;
    this.auth = new JWT({ email: key.client_email, key: key.private_key, scopes: [SHEETS_SCOPE] });
  }

  /**
   * Reads a bounded range, e.g. `getValues('SYSTEM', 'A2:L1000')`. `sheetName`
   * is always safely quoted into A1 notation (see quotedSheetRange), so
   * callers never construct a range string themselves. Returns `[]` for a
   * range with no data yet, never `undefined` -- callers never need to guard
   * against a missing `values` key the way the raw API response does.
   */
  async getValues(sheetName: string, cellRange: string): Promise<string[][]> {
    const response = await this.request(
      'GET',
      `values/${encodeURIComponent(quotedSheetRange(sheetName, cellRange))}`,
    );
    const body = (await response.json()) as { values?: string[][] };
    return body.values ?? [];
  }

  /**
   * Overwrites a bounded range with `values`, row-major. Uses
   * `valueInputOption=RAW` -- every value Lucid writes (IDs, booleans as
   * TRUE/FALSE strings, timestamps) is meant to land literally, never be
   * reinterpreted as a formula or auto-formatted by Sheets.
   */
  async updateValues(sheetName: string, cellRange: string, values: string[][]): Promise<void> {
    await this.request(
      'PUT',
      `values/${encodeURIComponent(quotedSheetRange(sheetName, cellRange))}?valueInputOption=RAW`,
      { values },
    );
  }

  /**
   * Writes many disjoint ranges in a single HTTP request -- issue #54 Phase
   * 2's bootstrap updates two ranges per existing SYSTEM row (A:H, then K:L,
   * skipping the Final Decision formula in I and Last Applied Tier in J), and
   * doing that as separate `updateValues` calls for every member in a guild
   * would mean hundreds of round trips per bootstrap run. A no-op for an
   * empty list, so callers never need to guard the call themselves.
   */
  async batchUpdateValues(
    updates: { sheetName: string; cellRange: string; values: string[][] }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.request('POST', 'values:batchUpdate', {
      valueInputOption: 'RAW',
      data: updates.map((update) => ({
        range: quotedSheetRange(update.sheetName, update.cellRange),
        values: update.values,
      })),
    });
  }

  /**
   * Appends rows after the last row with data in `cellRange` -- used for
   * brand-new rows so Lucid never computes "the next empty row" itself and
   * races a concurrent write for it. `INSERT_ROWS` inserts new rows rather
   * than overwriting whatever the sheet's current last row happens to be.
   */
  async appendValues(sheetName: string, cellRange: string, values: string[][]): Promise<void> {
    await this.request(
      'POST',
      `values/${encodeURIComponent(quotedSheetRange(sheetName, cellRange))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values },
    );
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}/${path}`;
    // Fetched once, outside the retry loop below: an auth failure already
    // carries its own correct `recoverable` flag (see getAccessToken), and
    // retrying the exact same token exchange a few milliseconds later isn't
    // going to turn a bad/revoked key into a good one -- lumping it into the
    // network-retry loop would misclassify it as transient instead.
    const accessToken = await this.getAccessToken();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          throw new VettingSheetsError(
            `Network error calling the Google Sheets API after ${MAX_ATTEMPTS} attempts: ${(error as Error).message}`,
            { recoverable: true, cause: error },
          );
        }
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.ok) return response;

      if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
        await this.sleep(backoffMs(attempt));
        continue;
      }

      const detail = await describeErrorResponse(response);
      throw new VettingSheetsError(`Google Sheets API returned ${response.status}: ${detail}`, {
        recoverable: isRetryableStatus(response.status),
      });
    }

    // Unreachable -- the loop above always either returns or throws.
    throw new VettingSheetsError('Google Sheets API request failed for an unknown reason.', {
      recoverable: true,
    });
  }

  private async getAccessToken(): Promise<string> {
    try {
      const { token } = await this.auth.getAccessToken();
      if (!token) {
        throw new VettingSheetsError('Google returned no access token for the vetting service account.', {
          recoverable: false,
        });
      }
      return token;
    } catch (error) {
      if (error instanceof VettingSheetsError) throw error;
      throw new VettingSheetsError(
        `Failed to authenticate the vetting service account: ${(error as Error).message}`,
        { recoverable: false, cause: error },
      );
    }
  }
}

/** Builds a client from an already-validated, enabled vetting config (see config.ts). */
export function createVettingSheetsClient(config: VettingConfig): VettingSheetsClient {
  return new VettingSheetsClient(config.spreadsheetId, config.googleServiceAccountJson);
}
