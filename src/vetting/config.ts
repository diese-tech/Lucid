/**
 * Configuration contract for the Google Sheets-backed player vetting
 * pipeline (issue #54, Phase 0) -- entirely separate from `src/config.ts`'s
 * `loadEnv()` because vetting is opt-in and every other field there is
 * required for Lucid to run at all. Disabled by default so existing pickup
 * behavior is completely unaffected until a guild explicitly turns this on.
 */

export const VETTING_TIERS = [1, 2, 3, 4, 5, 6, 7] as const;
export type VettingTier = (typeof VETTING_TIERS)[number];

export interface VettingConfig {
  enabled: true;
  spreadsheetId: string;
  systemSheetName: string;
  vettingSheetName: string;
  pollIntervalSeconds: number;
  /** Numeric tier (1 = highest) -> the Discord role ID Lucid manages for it. */
  tierRoleIds: Record<VettingTier, string>;
  /**
   * Raw service-account key JSON, unparsed -- the Sheets adapter (issue #54
   * Phase 1) is what actually authenticates with it. Validated here only
   * enough to fail loudly at startup on a malformed or incomplete key, never
   * logged or included in any thrown error.
   */
  googleServiceAccountJson: string;
}

export type VettingSettings = { enabled: false } | VettingConfig;

function requiredVettingVar(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `VETTING_ENABLED is true but ${name} is missing. Copy .env.example's vetting section to .env and fill it in, or set VETTING_ENABLED=false to disable this subsystem.`,
    );
  }
  return value.trim();
}

/**
 * Parses only enough of the service-account key to catch a copy-paste
 * mistake at startup instead of at the first Sheets API call -- not a
 * substitute for Google actually accepting the credentials.
 */
function assertValidServiceAccountJson(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON -- paste the full contents of the downloaded service-account key file, not a path to it.',
    );
  }
  const record = parsed as Record<string, unknown>;
  const missing = ['client_email', 'private_key'].filter((field) => typeof record[field] !== 'string');
  if (missing.length > 0) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is missing required field(s): ${missing.join(', ')}. It should be the unmodified JSON key downloaded for the service account.`,
    );
  }
}

export function loadVettingConfig(): VettingSettings {
  const enabled = (process.env.VETTING_ENABLED?.trim() ?? '').toLowerCase() === 'true';
  if (!enabled) return { enabled: false };

  const spreadsheetId = requiredVettingVar('VETTING_SPREADSHEET_ID');
  const googleServiceAccountJson = requiredVettingVar('GOOGLE_SERVICE_ACCOUNT_JSON');
  assertValidServiceAccountJson(googleServiceAccountJson);

  const tierRoleIds = {} as Record<VettingTier, string>;
  const seenRoleIds = new Map<string, VettingTier>();
  for (const tier of VETTING_TIERS) {
    const roleId = requiredVettingVar(`VETTING_TIER_${tier}_ROLE_ID`);
    const earlierTier = seenRoleIds.get(roleId);
    if (earlierTier !== undefined) {
      throw new Error(
        `VETTING_TIER_${tier}_ROLE_ID and VETTING_TIER_${earlierTier}_ROLE_ID both point at Discord role ${roleId} -- each tier must map to a distinct role.`,
      );
    }
    seenRoleIds.set(roleId, tier);
    tierRoleIds[tier] = roleId;
  }

  const pollIntervalRaw = process.env.VETTING_POLL_INTERVAL_SECONDS?.trim();
  const pollIntervalSeconds = pollIntervalRaw ? Number(pollIntervalRaw) : 120;
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error(
      `VETTING_POLL_INTERVAL_SECONDS must be a positive number, got "${pollIntervalRaw}".`,
    );
  }

  return {
    enabled: true,
    spreadsheetId,
    systemSheetName: process.env.VETTING_SYSTEM_SHEET?.trim() || 'SYSTEM',
    vettingSheetName: process.env.VETTING_SHEET?.trim() || 'VETTING',
    pollIntervalSeconds,
    tierRoleIds,
    googleServiceAccountJson,
  };
}
