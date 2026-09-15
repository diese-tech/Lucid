import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db/schema.js';

describe('scout-flow migrations', () => {
  it('preserves existing pickup and signup data while adding Fill and eligibility', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(MIGRATIONS[0]!.sql);
      db.exec(MIGRATIONS[1]!.sql);
      db.prepare(`INSERT INTO guild_config (guild_id, created_at, updated_at) VALUES ('g1', 1, 1)`).run();
      const pickup = db.prepare(`INSERT INTO pickups (
        guild_id, created_by, format, start_at, role_limit, status, created_at, updated_at
      ) VALUES ('g1', 'staff', 'pickup_vs_pickup', 2000000000, 2, 'open', 1, 1) RETURNING id`).get() as { id: number };
      db.prepare(`INSERT INTO signups (pickup_id, user_id, role, created_at) VALUES (?, 'player', 'solo', 1)`).run(pickup.id);

      db.exec(MIGRATIONS[2]!.sql);
      db.exec(MIGRATIONS[3]!.sql);

      expect(db.prepare('SELECT user_id, role FROM signups').get()).toEqual({ user_id: 'player', role: 'solo' });
      expect(db.prepare('SELECT fill_emoji_id FROM guild_config').get()).toEqual({ fill_emoji_id: null });
      expect(db.prepare('SELECT eligibility_role_id FROM pickups').get()).toEqual({ eligibility_role_id: null });
      expect(() => db.prepare(`INSERT INTO signups (pickup_id, user_id, role, created_at) VALUES (?, 'flex', 'fill', 2)`).run(pickup.id)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('005_pickup_spaces migration', () => {
  function migrateThrough004(db: Database.Database): void {
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration.sql);
  }

  it('creates exactly one default space per guild with a complete legacy config, copying its routing and staff roles', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough004(db);

      db.prepare(
        `INSERT INTO guild_config
           (guild_id, signup_channel_id, roster_channel_id, review_channel_id, ping_role_id, authorized_role_ids, created_at, updated_at)
         VALUES ('g1', 'signup-chan', 'roster-chan', 'review-chan', 'ping-role', '["staff-role"]', 100, 200)`,
      ).run();

      db.exec(MIGRATIONS[4]!.sql);

      const spaces = db.prepare('SELECT * FROM pickup_spaces WHERE guild_id = ?').all('g1') as Array<{
        id: number;
        name: string;
        origin_channel_id: string;
        signup_channel_id: string;
        roster_channel_id: string;
        review_channel_id: string;
        signup_ping_role_id: string;
        organizer_ping_role_id: string | null;
        authorized_role_ids: string;
      }>;

      expect(spaces).toHaveLength(1);
      const space = spaces[0]!;
      expect(space.name).toBe('Public Pickups');
      // The legacy review channel becomes the initial origin channel — see
      // schema.ts's migration comment.
      expect(space.origin_channel_id).toBe('review-chan');
      expect(space.signup_channel_id).toBe('signup-chan');
      expect(space.roster_channel_id).toBe('roster-chan');
      expect(space.review_channel_id).toBe('review-chan');
      expect(space.signup_ping_role_id).toBe('ping-role');
      expect(space.organizer_ping_role_id).toBeNull();
      expect(JSON.parse(space.authorized_role_ids)).toEqual(['staff-role']);
    } finally {
      db.close();
    }
  });

  it('does not create a space for a guild whose legacy config was never completed', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough004(db);
      // Only the signup channel was ever set -- an incomplete config, same as
      // a guild mid-setup that never finished /pickup config.
      db.prepare(
        `INSERT INTO guild_config (guild_id, signup_channel_id, authorized_role_ids, created_at, updated_at)
         VALUES ('g2', 'signup-chan', '[]', 1, 1)`,
      ).run();

      db.exec(MIGRATIONS[4]!.sql);

      expect(db.prepare('SELECT * FROM pickup_spaces WHERE guild_id = ?').all('g2')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('backfills existing pickups onto their guild default space, snapshotting its routing', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough004(db);
      db.prepare(
        `INSERT INTO guild_config
           (guild_id, signup_channel_id, roster_channel_id, review_channel_id, ping_role_id, authorized_role_ids, created_at, updated_at)
         VALUES ('g1', 'signup-chan', 'roster-chan', 'review-chan', 'ping-role', '[]', 1, 1)`,
      ).run();
      const pickup = db.prepare(`INSERT INTO pickups (
        guild_id, created_by, format, start_at, role_limit, status, created_at, updated_at
      ) VALUES ('g1', 'staff', 'pickup_vs_pickup', 2000000000, 2, 'open', 1, 1) RETURNING id`).get() as { id: number };

      db.exec(MIGRATIONS[4]!.sql);

      const space = db.prepare('SELECT id FROM pickup_spaces WHERE guild_id = ?').get('g1') as { id: number };
      const row = db.prepare('SELECT * FROM pickups WHERE id = ?').get(pickup.id) as {
        pickup_space_id: number;
        signup_channel_id: string;
        roster_channel_id: string;
        review_channel_id: string;
        signup_ping_role_id: string;
      };

      expect(row.pickup_space_id).toBe(space.id);
      expect(row.signup_channel_id).toBe('signup-chan');
      expect(row.roster_channel_id).toBe('roster-chan');
      expect(row.review_channel_id).toBe('review-chan');
      expect(row.signup_ping_role_id).toBe('ping-role');
    } finally {
      db.close();
    }
  });

  it('leaves a pickup unassigned to any space when its guild had no completable legacy config', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough004(db);
      db.prepare(
        `INSERT INTO guild_config (guild_id, authorized_role_ids, created_at, updated_at) VALUES ('g2', '[]', 1, 1)`,
      ).run();
      const pickup = db.prepare(`INSERT INTO pickups (
        guild_id, created_by, format, start_at, role_limit, status, created_at, updated_at
      ) VALUES ('g2', 'staff', 'pickup_vs_pickup', 2000000000, 2, 'open', 1, 1) RETURNING id`).get() as { id: number };

      db.exec(MIGRATIONS[4]!.sql);

      const row = db.prepare('SELECT pickup_space_id FROM pickups WHERE id = ?').get(pickup.id) as {
        pickup_space_id: number | null;
      };
      expect(row.pickup_space_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('via migrate(), never re-applies on a second run -- the real safety net, not the raw SQL alone', () => {
    const db = new Database(':memory:');
    try {
      // Unlike the raw-SQL checks above, this goes through the real migrate()
      // runner (see db/schema.ts) so the `migrations` table guard is exercised
      // too. The raw ALTER TABLE statements in 005 are NOT self-idempotent
      // (re-running them throws on the duplicate column) -- migrate() is what
      // makes a restart/redeploy safe, by tracking which migrations already
      // landed and skipping them, not by the SQL tolerating repetition.
      db.pragma('foreign_keys = ON');
      migrate(db);
      db.prepare(
        `INSERT INTO guild_config
           (guild_id, signup_channel_id, roster_channel_id, review_channel_id, authorized_role_ids, created_at, updated_at)
         VALUES ('g1', 'signup-chan', 'roster-chan', 'review-chan', '[]', 1, 1)`,
      ).run();

      // guild_config already existed before 005 ran as part of the first
      // migrate() call above, so nothing was migrated into pickup_spaces yet
      // -- confirms restart safety, not retroactive backfill.
      expect(db.prepare('SELECT COUNT(*) AS n FROM pickup_spaces').get()).toEqual({ n: 0 });

      expect(() => migrate(db)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM pickup_spaces').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
