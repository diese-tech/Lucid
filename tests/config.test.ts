/**
 * Regression test for a real deployment bug, not just a code-review finding.
 *
 * Nothing in the codebase ever loaded .env into process.env — config.ts read
 * process.env directly, so filling in .env did nothing. Local dev (`npm run
 * dev`) failed with "Missing required environment variable" no matter what
 * .env contained. Fixed with Node's built-in
 * loadEnvFile, guarded so a missing file — the normal case in production,
 * where Railway injects real environment variables instead — doesn't crash
 * the app, while any other read error still surfaces.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnvFile } from '../src/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('loadDotEnvFile', () => {
  it('populates process.env from a real .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucid-config-test-'));
    const path = join(dir, '.env');
    writeFileSync(path, 'DISCORD_TOKEN=test-token-value\nDISCORD_CLIENT_ID=test-client-id\n');

    try {
      loadDotEnvFile(path);
      expect(process.env.DISCORD_TOKEN).toBe('test-token-value');
      expect(process.env.DISCORD_CLIENT_ID).toBe('test-client-id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when the file is missing — the normal production case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucid-config-test-'));
    const path = join(dir, '.env');

    try {
      expect(() => loadDotEnvFile(path)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never overwrites a variable the real environment already set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucid-config-test-'));
    const path = join(dir, '.env');
    writeFileSync(path, 'DISCORD_TOKEN=from-dotenv-file\n');
    process.env.DISCORD_TOKEN = 'from-real-platform-env';

    try {
      loadDotEnvFile(path);
      expect(process.env.DISCORD_TOKEN).toBe('from-real-platform-env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
