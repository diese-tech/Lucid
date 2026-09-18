/**
 * Tests for the vetting subsystem's configuration contract (issue #54,
 * Phase 0). Every scenario here is one of that phase's own acceptance
 * criteria -- disabled by default, loud and specific failures when enabled
 * without everything it needs, no silent guessing on tier/role mapping.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadVettingConfig } from '../../src/vetting/config.js';

const ORIGINAL_ENV = { ...process.env };

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'lucid-vetting-sync@some-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});

function clearVettingEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VETTING_') || key === 'GOOGLE_SERVICE_ACCOUNT_JSON') delete process.env[key];
  }
}

/** A minimal fully-valid enabled config, as a baseline for negative tests to mutate. */
function setValidEnabledEnv(): void {
  process.env.VETTING_ENABLED = 'true';
  process.env.VETTING_SPREADSHEET_ID = 'sheet-123';
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SERVICE_ACCOUNT_JSON;
  for (const tier of [1, 2, 3, 4, 5]) {
    process.env[`VETTING_TIER_${tier}_ROLE_ID`] = `role-${tier}`;
  }
}

afterEach(() => {
  clearVettingEnv();
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('loadVettingConfig', () => {
  it('is disabled by default, with nothing else in the environment required', () => {
    clearVettingEnv();
    expect(loadVettingConfig()).toEqual({ enabled: false });
  });

  it('stays disabled for any value other than the exact string "true"', () => {
    clearVettingEnv();
    process.env.VETTING_ENABLED = 'yes';
    expect(loadVettingConfig()).toEqual({ enabled: false });
  });

  it('loads a fully valid enabled configuration with defaults applied', () => {
    setValidEnabledEnv();

    const config = loadVettingConfig();

    expect(config).toEqual({
      enabled: true,
      spreadsheetId: 'sheet-123',
      systemSheetName: 'SYSTEM',
      vettingSheetName: 'VETTING',
      pollIntervalSeconds: 120,
      tierRoleIds: { 1: 'role-1', 2: 'role-2', 3: 'role-3', 4: 'role-4', 5: 'role-5' },
      googleServiceAccountJson: SERVICE_ACCOUNT_JSON,
    });
  });

  it('honors overridden sheet names and poll interval', () => {
    setValidEnabledEnv();
    process.env.VETTING_SYSTEM_SHEET = 'Custom System';
    process.env.VETTING_SHEET = 'Custom Vetting';
    process.env.VETTING_POLL_INTERVAL_SECONDS = '90';

    const config = loadVettingConfig();
    if (!config.enabled) throw new Error('expected enabled config');
    expect(config.systemSheetName).toBe('Custom System');
    expect(config.vettingSheetName).toBe('Custom Vetting');
    expect(config.pollIntervalSeconds).toBe(90);
  });

  it('fails loudly when enabled without a spreadsheet ID', () => {
    setValidEnabledEnv();
    delete process.env.VETTING_SPREADSHEET_ID;

    expect(() => loadVettingConfig()).toThrow('VETTING_SPREADSHEET_ID');
  });

  it('fails loudly when enabled without the service-account JSON', () => {
    setValidEnabledEnv();
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    expect(() => loadVettingConfig()).toThrow('GOOGLE_SERVICE_ACCOUNT_JSON');
  });

  it('rejects a service-account value that is not valid JSON', () => {
    setValidEnabledEnv();
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '/path/to/key.json';

    expect(() => loadVettingConfig()).toThrow('not valid JSON');
  });

  it('rejects service-account JSON missing required fields', () => {
    setValidEnabledEnv();
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ some_other_field: true });

    expect(() => loadVettingConfig()).toThrow(/client_email.*private_key/);
  });

  it('fails loudly when a tier role ID is missing, naming that tier', () => {
    setValidEnabledEnv();
    delete process.env.VETTING_TIER_4_ROLE_ID;

    expect(() => loadVettingConfig()).toThrow('VETTING_TIER_4_ROLE_ID');
  });

  it('rejects two tiers mapped to the same Discord role', () => {
    setValidEnabledEnv();
    process.env.VETTING_TIER_2_ROLE_ID = process.env.VETTING_TIER_5_ROLE_ID!;

    expect(() => loadVettingConfig()).toThrow(/VETTING_TIER_2_ROLE_ID.*VETTING_TIER_5_ROLE_ID|VETTING_TIER_5_ROLE_ID.*VETTING_TIER_2_ROLE_ID/);
  });

  it('rejects a non-numeric poll interval', () => {
    setValidEnabledEnv();
    process.env.VETTING_POLL_INTERVAL_SECONDS = 'soon';

    expect(() => loadVettingConfig()).toThrow('VETTING_POLL_INTERVAL_SECONDS');
  });

  it('rejects a zero or negative poll interval', () => {
    setValidEnabledEnv();
    process.env.VETTING_POLL_INTERVAL_SECONDS = '0';

    expect(() => loadVettingConfig()).toThrow('VETTING_POLL_INTERVAL_SECONDS');
  });
});
