/**
 * Environment configuration.
 *
 * Values are read once at startup and validated loudly — a missing token should
 * fail immediately with a clear message, not surface later as a confusing
 * Discord login error.
 */

export interface Env {
  discordToken: string;
  discordClientId: string;
  databasePath: string;
}

/**
 * Load .env into process.env, if one exists.
 *
 * Local development relies on this — without it, filling in .env does
 * nothing, since nothing else in the codebase reads the file. In production
 * (Railway) there is no .env file at all; the platform injects real
 * environment variables directly, so a missing file here is expected and
 * silently fine. Anything else (a malformed file, a permissions problem)
 * should still surface loudly rather than leave `required()` below to fail
 * with a confusing "missing variable" for a file that's actually just broken.
 *
 * Uses Node's built-in loadEnvFile rather than the `dotenv` package — no
 * extra dependency needed now that the runtime does this natively. It never
 * overwrites a variable the environment already set, so a real platform value
 * always wins over whatever a stray .env file says.
 *
 * `path` is only for tests, which need to point this at a fixture file rather
 * than the cwd-relative `.env` that real callers always want.
 */
export function loadDotEnvFile(path?: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

export function loadEnv(): Env {
  loadDotEnvFile();
  return {
    discordToken: required('DISCORD_TOKEN'),
    discordClientId: required('DISCORD_CLIENT_ID'),
    // On Railway this must point inside a mounted volume, or the database is
    // wiped on every redeploy.
    databasePath: process.env.DATABASE_PATH?.trim() || './data/lucid.sqlite',
  };
}
