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
  return {
    discordToken: required('DISCORD_TOKEN'),
    discordClientId: required('DISCORD_CLIENT_ID'),
    // On Railway this must point inside a mounted volume, or the database is
    // wiped on every redeploy.
    databasePath: process.env.DATABASE_PATH?.trim() || './data/lucid.sqlite',
  };
}
