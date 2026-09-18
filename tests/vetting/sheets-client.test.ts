/**
 * Tests for the low-level Sheets API boundary (issue #54, Phase 1). Auth is
 * stubbed at `JWT.prototype.getAccessToken` -- constructing a `JWT` with a
 * fake key never itself signs anything, only calling that method does, so
 * this exercises this module's own retry/error logic without ever making a
 * real network or crypto call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JWT } from 'google-auth-library';
import { VettingSheetsClient, VettingSheetsError } from '../../src/vetting/sheets-client.js';

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'lucid-vetting-sync@some-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(status: number, statusText: string): Response {
  return new Response('not json', { status, statusText });
}

/** Recovers the plain (un-encoded) A1 range this client actually requested. */
function requestedRange(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const [url] = fetchMock.mock.calls[callIndex]!;
  const encoded = (url as string).split('/values/')[1]!.split('?')[0]!;
  return decodeURIComponent(encoded);
}

describe('VettingSheetsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sleepCalls: number[];
  let sleep: (ms: number) => Promise<void>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(JWT.prototype, 'getAccessToken').mockResolvedValue({ token: 'fake-access-token' } as never);
    sleepCalls = [];
    sleep = (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function client(): VettingSheetsClient {
    return new VettingSheetsClient('sheet-123', SERVICE_ACCOUNT_JSON, sleep);
  }

  describe('getValues', () => {
    it('returns the values array from a successful GET', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { values: [['a', 'b'], ['c', 'd']] }));

      const values = await client().getValues('SYSTEM', 'A2:L1000');

      expect(values).toEqual([['a', 'b'], ['c', 'd']]);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/'SYSTEM'!A2%3AL1000");
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer fake-access-token');
    });

    it('returns an empty array when the range has no data yet', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

      expect(await client().getValues('SYSTEM', 'A2:L1000')).toEqual([]);
    });
  });

  describe('A1 range construction', () => {
    // Half-Shell's blocking finding on PR #59: config.ts's VETTING_SYSTEM_SHEET
    // / VETTING_SHEET are free-form, but an earlier version of this client
    // built ranges as a plain template string, which breaks the moment a
    // configured sheet name contains a space or other special character --
    // Google's A1 notation requires such a name to be single-quoted.
    it('quotes a sheet name containing spaces', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { values: [] }));

      await client().getValues('Custom System', 'A1:L5');

      expect(requestedRange(fetchMock)).toBe("'Custom System'!A1:L5");
    });

    it('doubles an embedded single quote in a sheet name', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { values: [] }));

      await client().getValues("O'Brien's Sheet", 'A1');

      expect(requestedRange(fetchMock)).toBe("'O''Brien''s Sheet'!A1");
    });

    it('quotes even a plain alphanumeric sheet name, which Sheets accepts unconditionally', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { values: [] }));

      await client().getValues('SYSTEM', 'A1');

      expect(requestedRange(fetchMock)).toBe("'SYSTEM'!A1");
    });
  });

  describe('updateValues', () => {
    it('PUTs the values with valueInputOption=RAW', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { updatedCells: 2 }));

      await client().updateValues('SYSTEM', 'A2:B2', [['x', 'y']]);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toContain('valueInputOption=RAW');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ values: [['x', 'y']] });
    });
  });

  describe('setFormulas', () => {
    it('PUTs the formulas with valueInputOption=USER_ENTERED, not RAW', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

      await client().setFormulas('VETTING', 'A2:C2', [['=ARRAYFORMULA(A1)', '=B1', '=C1']]);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toContain('valueInputOption=USER_ENTERED');
      expect(url).not.toContain('RAW');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ values: [['=ARRAYFORMULA(A1)', '=B1', '=C1']] });
    });
  });

  describe('batchUpdateValues', () => {
    it('sends every range in one POST to values:batchUpdate', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

      await client().batchUpdateValues([
        { sheetName: 'SYSTEM', cellRange: 'A2:H2', values: [['a']] },
        { sheetName: 'SYSTEM', cellRange: 'K2:L2', values: [['b', 'c']] },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values:batchUpdate');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        valueInputOption: 'RAW',
        data: [
          { range: "'SYSTEM'!A2:H2", values: [['a']] },
          { range: "'SYSTEM'!K2:L2", values: [['b', 'c']] },
        ],
      });
    });

    it('is a no-op for an empty list of updates', async () => {
      await client().batchUpdateValues([]);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('appendValues', () => {
    it('POSTs to values/{range}:append with INSERT_ROWS', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

      await client().appendValues('SYSTEM', 'A2:L100000', [['x', 'y']]);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toContain(":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
      expect(url).toContain(encodeURIComponent("'SYSTEM'!A2:L100000"));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ values: [['x', 'y']] });
    });
  });

  describe('retry behavior', () => {
    it('retries a 429 and succeeds on a later attempt, backing off exponentially', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'Rate limit exceeded' } }))
        .mockResolvedValueOnce(jsonResponse(200, { values: [['ok']] }));

      const values = await client().getValues('SYSTEM', 'A1');

      expect(values).toEqual([['ok']]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleepCalls).toEqual([250]);
    });

    it('gives up after exhausting retries on a persistent 500, marking it recoverable', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'Internal Server Error'));

      await expect(client().getValues('SYSTEM', 'A1')).rejects.toMatchObject({
        recoverable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleepCalls).toEqual([250, 500]);
    });

    it('does not retry a non-retryable status, and marks it unrecoverable', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(403, { error: { message: 'The caller does not have permission' } }),
      );

      await expect(client().getValues('SYSTEM', 'A1')).rejects.toMatchObject({
        recoverable: false,
        message: expect.stringContaining('The caller does not have permission'),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleepCalls).toEqual([]);
    });

    it('retries a network-level failure and succeeds on a later attempt', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse(200, { values: [] }));

      await expect(client().getValues('SYSTEM', 'A1')).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after exhausting retries on a persistent network failure, marking it recoverable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client().getValues('SYSTEM', 'A1')).rejects.toBeInstanceOf(VettingSheetsError);
      await expect(client().getValues('SYSTEM', 'A1')).rejects.toMatchObject({ recoverable: true });
    });
  });

  describe('authentication failures', () => {
    it('surfaces a failed token fetch as unrecoverable without ever calling fetch', async () => {
      vi.spyOn(JWT.prototype, 'getAccessToken').mockRejectedValueOnce(new Error('invalid_grant'));

      await expect(client().getValues('SYSTEM', 'A1')).rejects.toMatchObject({
        recoverable: false,
        message: expect.stringContaining('invalid_grant'),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats a missing access token as unrecoverable', async () => {
      vi.spyOn(JWT.prototype, 'getAccessToken').mockResolvedValueOnce({ token: null } as never);

      await expect(client().getValues('SYSTEM', 'A1')).rejects.toMatchObject({ recoverable: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
