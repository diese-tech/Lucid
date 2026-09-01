/**
 * Schema and migrations.
 *
 * Migrations are plain SQL applied in order and recorded in `migrations`, so a
 * restart or redeploy re-applies only what's new. Keep them append-only: never
 * edit a migration that has already shipped, add another one instead.
 */

import type Database from 'better-sqlite3';

interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id            TEXT PRIMARY KEY,
        signup_channel_id   TEXT,
        roster_channel_id   TEXT,
        review_channel_id   TEXT,
        ping_role_id        TEXT,
        -- JSON array of role IDs. SQLite has no array type and this list is
        -- only ever read whole, so a JSON blob beats a join table here.
        authorized_role_ids TEXT NOT NULL DEFAULT '[]',
        solo_emoji_id       TEXT,
        jungle_emoji_id     TEXT,
        mid_emoji_id        TEXT,
        support_emoji_id    TEXT,
        carry_emoji_id      TEXT,
        -- IANA zone used to interpret natural-language start times. Defaulted
        -- for Dream Walkers, overridable so other leagues can adopt Lucid.
        timezone            TEXT NOT NULL DEFAULT 'America/New_York',
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pickups (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT NOT NULL,
        created_by        TEXT NOT NULL,
        format            TEXT NOT NULL,
        start_at          INTEGER NOT NULL,
        role_limit        INTEGER NOT NULL,
        note              TEXT,
        premade_name      TEXT,
        status            TEXT NOT NULL DEFAULT 'open',
        signup_message_id TEXT,
        review_message_id TEXT,
        roster_message_id TEXT,
        -- Bumped on every roster mutation. Staff interactions carry the version
        -- they were rendered from, so a stale click is rejected instead of
        -- silently clobbering someone else's edit.
        version           INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pickups_guild_status ON pickups (guild_id, status);
      CREATE INDEX IF NOT EXISTS idx_pickups_signup_message ON pickups (signup_message_id);

      CREATE TABLE IF NOT EXISTS signups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        pickup_id  INTEGER NOT NULL REFERENCES pickups (id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        -- Guards against a double-delivered reaction event duplicating a row.
        -- Note this does NOT enforce the per-pickup role limit; distinct roles
        -- are distinct rows. That limit is enforced transactionally in the
        -- signup repository.
        UNIQUE (pickup_id, user_id, role)
      );

      CREATE INDEX IF NOT EXISTS idx_signups_pickup ON signups (pickup_id);

      CREATE TABLE IF NOT EXISTS roster_slots (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        pickup_id  INTEGER NOT NULL REFERENCES pickups (id) ON DELETE CASCADE,
        team       TEXT NOT NULL,
        role       TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (pickup_id, team, role)
      );

      CREATE INDEX IF NOT EXISTS idx_roster_slots_pickup ON roster_slots (pickup_id);
    `,
  },
  {
    name: '002_roster_slot_staff_assigned',
    sql: `
      -- Marks a slot whose occupant was placed there by a staff override rather
      -- than by Lucid's own generation.
      --
      -- Without this flag, two intended behaviours cancel each other out: staff
      -- are allowed to assign a player to a role they never signed up for, but
      -- Lucid also blocks publishing whenever a rostered player has no signup
      -- for their slot's role. A deliberate override would therefore look
      -- identical to a player who quietly withdrew, and permanently grey out
      -- the Publish button.
      --
      -- Slots carrying this flag are exempt from the withdrawal check, because
      -- a human already decided the player belongs there.
      ALTER TABLE roster_slots ADD COLUMN staff_assigned INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '003_optional_fill_signup',
    sql: `
      ALTER TABLE guild_config ADD COLUMN fill_emoji_id TEXT;

      CREATE TABLE signups_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        pickup_id  INTEGER NOT NULL REFERENCES pickups (id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('solo', 'jungle', 'mid', 'support', 'carry', 'fill')),
        created_at INTEGER NOT NULL,
        UNIQUE (pickup_id, user_id, role)
      );
      INSERT INTO signups_new (id, pickup_id, user_id, role, created_at)
        SELECT id, pickup_id, user_id, role, created_at FROM signups;
      DROP TABLE signups;
      ALTER TABLE signups_new RENAME TO signups;
      CREATE INDEX idx_signups_pickup ON signups (pickup_id);
    `,
  },
  {
    name: '004_pickup_eligibility_role',
    sql: `
      ALTER TABLE pickups ADD COLUMN eligibility_role_id TEXT;
    `,
  },
];

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((row) => (row as { name: string }).name),
  );

  const record = db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.name, Date.now());
    })();
  }
}
