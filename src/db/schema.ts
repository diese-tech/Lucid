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
  {
    name: '005_pickup_spaces',
    sql: `
      -- A guild can now run several independently configured Pickup Spaces
      -- (e.g. a public lane and a restricted lower-skill lane) instead of the
      -- one guild-wide config row. Channels/roles that used to live on
      -- guild_config move here; guild_config keeps only what genuinely stays
      -- guild-scoped (timezone, role emoji).
      CREATE TABLE IF NOT EXISTS pickup_spaces (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id                    TEXT NOT NULL,
        name                        TEXT NOT NULL,
        origin_channel_id           TEXT,
        signup_channel_id           TEXT,
        roster_channel_id           TEXT,
        review_channel_id           TEXT,
        signup_ping_role_id         TEXT,
        default_eligibility_role_id TEXT,
        authorized_role_ids         TEXT NOT NULL DEFAULT '[]',
        created_at                  INTEGER NOT NULL,
        updated_at                  INTEGER NOT NULL,
        UNIQUE (guild_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_pickup_spaces_guild ON pickup_spaces (guild_id);
      CREATE INDEX IF NOT EXISTS idx_pickup_spaces_origin ON pickup_spaces (guild_id, origin_channel_id);

      -- Each pickup snapshots the space's routing at creation time, so editing
      -- a space later never silently moves where an already-open pickup posts.
      ALTER TABLE pickups ADD COLUMN pickup_space_id INTEGER REFERENCES pickup_spaces (id);
      ALTER TABLE pickups ADD COLUMN origin_channel_id TEXT;
      ALTER TABLE pickups ADD COLUMN signup_channel_id TEXT;
      ALTER TABLE pickups ADD COLUMN roster_channel_id TEXT;
      ALTER TABLE pickups ADD COLUMN review_channel_id TEXT;
      ALTER TABLE pickups ADD COLUMN signup_ping_role_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_pickups_space ON pickups (pickup_space_id);

      -- Migrate each guild's existing singleton config into exactly one
      -- default space, named "Public Pickups", carrying over its channels,
      -- ping role and authorized staff roles. A guild whose config was never
      -- completed (missing a required channel) has nothing usable to copy, so
      -- it gets no space -- an admin sets one up fresh with /pickup space create.
      INSERT INTO pickup_spaces (
        guild_id, name, origin_channel_id, signup_channel_id, roster_channel_id, review_channel_id,
        signup_ping_role_id, default_eligibility_role_id, authorized_role_ids,
        created_at, updated_at
      )
      SELECT
        guild_id, 'Public Pickups', review_channel_id, signup_channel_id, roster_channel_id, review_channel_id,
        ping_role_id, NULL, authorized_role_ids,
        created_at, updated_at
      FROM guild_config
      WHERE signup_channel_id IS NOT NULL AND roster_channel_id IS NOT NULL AND review_channel_id IS NOT NULL;

      -- Backfill existing pickups onto their guild's new default space and
      -- snapshot the same routing that was live when they were created --
      -- the closest available approximation, since no per-pickup routing was
      -- ever recorded before this migration.
      UPDATE pickups
      SET
        pickup_space_id = (SELECT id FROM pickup_spaces WHERE pickup_spaces.guild_id = pickups.guild_id),
        origin_channel_id = (SELECT origin_channel_id FROM pickup_spaces WHERE pickup_spaces.guild_id = pickups.guild_id),
        signup_channel_id = (SELECT signup_channel_id FROM pickup_spaces WHERE pickup_spaces.guild_id = pickups.guild_id),
        roster_channel_id = (SELECT roster_channel_id FROM pickup_spaces WHERE pickup_spaces.guild_id = pickups.guild_id),
        review_channel_id = (SELECT review_channel_id FROM pickup_spaces WHERE pickup_spaces.guild_id = pickups.guild_id),
        signup_ping_role_id = (SELECT signup_ping_role_id FROM pickup_spaces WHERE pickup_spaces.guild_id = pickups.guild_id)
      WHERE EXISTS (SELECT 1 FROM pickup_spaces WHERE pickup_spaces.guild_id = pickups.guild_id);
    `,
  },
  {
    name: '006_multi_role_eligibility',
    sql: `
      -- Eligibility moves from "at most one required role" to "eligible if
      -- you hold at least one of these roles" (OR semantics) -- a space
      -- running, say, "Verified" and "Trusted" as separate roles no longer
      -- has to pick one and lock the other out. The old singular columns are
      -- kept (migrations are append-only) but nothing reads or writes them
      -- after this point.
      ALTER TABLE pickups ADD COLUMN eligibility_role_ids TEXT NOT NULL DEFAULT '[]';
      UPDATE pickups SET eligibility_role_ids = '["' || eligibility_role_id || '"]'
        WHERE eligibility_role_id IS NOT NULL;

      ALTER TABLE pickup_spaces ADD COLUMN default_eligibility_role_ids TEXT NOT NULL DEFAULT '[]';
      UPDATE pickup_spaces SET default_eligibility_role_ids = '["' || default_eligibility_role_id || '"]'
        WHERE default_eligibility_role_id IS NOT NULL;
    `,
  },
  {
    name: '007_unique_space_origin_channel',
    sql: `
      -- byOriginChannel() (pickup-spaces.ts) does an unconstrained lookup by
      -- (guild_id, origin_channel_id) to resolve which space /pickup create
      -- belongs to -- if two spaces ever shared an origin channel, that
      -- resolution would be arbitrary and could apply the wrong space's
      -- authorization, eligibility and routing to a new pickup. The app
      -- layer already refuses to set a colliding origin channel, but only a
      -- real constraint closes the race between two admins editing two
      -- spaces at once -- the same protection (guild_id, name) already has.
      -- Partial: multiple spaces may all leave their origin channel unset.
      -- Supersedes migration 005's plain (non-unique) index on the same
      -- columns, which this drops rather than leaving redundant.
      DROP INDEX IF EXISTS idx_pickup_spaces_origin;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pickup_spaces_guild_origin_channel_unique
        ON pickup_spaces (guild_id, origin_channel_id)
        WHERE origin_channel_id IS NOT NULL;
    `,
  },
  {
    name: '008_ready_notified_at',
    sql: `
      -- The first transition from an incomplete working roster to a complete
      -- one notifies the pickup creator exactly once (see roster.ts's
      -- generateWorkingRoster and review.ts's evaluateRosterReady). Reactions
      -- can flip a roster complete -> incomplete -> complete repeatedly
      -- (a withdrawal after the first completion, followed by a new signup
      -- refilling it), and this column is what stops that from re-notifying
      -- every time -- it is set once, the first time, and never cleared.
      ALTER TABLE pickups ADD COLUMN ready_notified_at INTEGER;
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
