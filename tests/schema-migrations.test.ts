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

describe('006_multi_role_eligibility migration', () => {
  function migrateThrough005(db: Database.Database): void {
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.slice(0, 5)) db.exec(migration.sql);
  }

  it('wraps an existing singular eligibility_role_id into a one-element array', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough005(db);
      const pickup = db.prepare(`INSERT INTO pickups (
        guild_id, created_by, format, start_at, role_limit, status, eligibility_role_id, created_at, updated_at
      ) VALUES ('g1', 'staff', 'pickup_vs_pickup', 2000000000, 2, 'open', 'silver', 1, 1) RETURNING id`).get() as {
        id: number;
      };

      db.exec(MIGRATIONS[5]!.sql);

      const row = db.prepare('SELECT eligibility_role_ids FROM pickups WHERE id = ?').get(pickup.id) as {
        eligibility_role_ids: string;
      };
      expect(JSON.parse(row.eligibility_role_ids)).toEqual(['silver']);
    } finally {
      db.close();
    }
  });

  it('leaves eligibility_role_ids empty for a pickup that had no eligibility role', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough005(db);
      const pickup = db.prepare(`INSERT INTO pickups (
        guild_id, created_by, format, start_at, role_limit, status, created_at, updated_at
      ) VALUES ('g1', 'staff', 'pickup_vs_pickup', 2000000000, 2, 'open', 1, 1) RETURNING id`).get() as { id: number };

      db.exec(MIGRATIONS[5]!.sql);

      const row = db.prepare('SELECT eligibility_role_ids FROM pickups WHERE id = ?').get(pickup.id) as {
        eligibility_role_ids: string;
      };
      expect(JSON.parse(row.eligibility_role_ids)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('wraps an existing default_eligibility_role_id on a Pickup Space into a one-element array', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough005(db);
      const space = db.prepare(`INSERT INTO pickup_spaces (
        guild_id, name, default_eligibility_role_id, authorized_role_ids, created_at, updated_at
      ) VALUES ('g1', 'Public Pickups', 'gold', '[]', 1, 1) RETURNING id`).get() as { id: number };

      db.exec(MIGRATIONS[5]!.sql);

      const row = db.prepare('SELECT default_eligibility_role_ids FROM pickup_spaces WHERE id = ?').get(space.id) as {
        default_eligibility_role_ids: string;
      };
      expect(JSON.parse(row.default_eligibility_role_ids)).toEqual(['gold']);
    } finally {
      db.close();
    }
  });
});

describe('007_unique_space_origin_channel migration', () => {
  function migrateThrough006(db: Database.Database): void {
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.slice(0, 6)) db.exec(migration.sql);
  }

  it('refuses a second space in the same guild claiming an origin channel another space already has', () => {
    // The app-level pre-check in spaces.ts is only a courtesy -- this index
    // is what actually closes the race between two admins editing two
    // spaces at once. Prove it at the raw SQL level, independent of the app.
    const db = new Database(':memory:');
    try {
      migrateThrough006(db);
      db.prepare(`INSERT INTO pickup_spaces (
        guild_id, name, origin_channel_id, authorized_role_ids, created_at, updated_at
      ) VALUES ('g1', 'Public Pickups', 'chan-1', '[]', 1, 1)`).run();

      db.exec(MIGRATIONS[6]!.sql);

      expect(() =>
        db.prepare(`INSERT INTO pickup_spaces (
          guild_id, name, origin_channel_id, authorized_role_ids, created_at, updated_at
        ) VALUES ('g1', 'Restricted Lane', 'chan-1', '[]', 1, 1)`).run(),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it('allows any number of spaces to leave their origin channel unset (partial index)', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough006(db);
      db.exec(MIGRATIONS[6]!.sql);

      expect(() => {
        db.prepare(`INSERT INTO pickup_spaces (
          guild_id, name, authorized_role_ids, created_at, updated_at
        ) VALUES ('g1', 'Space A', '[]', 1, 1)`).run();
        db.prepare(`INSERT INTO pickup_spaces (
          guild_id, name, authorized_role_ids, created_at, updated_at
        ) VALUES ('g1', 'Space B', '[]', 1, 1)`).run();
      }).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('allows the same origin channel to be reused in a different guild', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough006(db);
      db.exec(MIGRATIONS[6]!.sql);

      expect(() => {
        db.prepare(`INSERT INTO pickup_spaces (
          guild_id, name, origin_channel_id, authorized_role_ids, created_at, updated_at
        ) VALUES ('g1', 'Public Pickups', 'chan-1', '[]', 1, 1)`).run();
        db.prepare(`INSERT INTO pickup_spaces (
          guild_id, name, origin_channel_id, authorized_role_ids, created_at, updated_at
        ) VALUES ('g2', 'Public Pickups', 'chan-1', '[]', 1, 1)`).run();
      }).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('008_ready_notified_at migration', () => {
  function migrateThrough007(db: Database.Database): void {
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.slice(0, 7)) db.exec(migration.sql);
  }

  it("backfills ready_notified_at for pickups that had already reached roster_ready or beyond, so the new notification path doesn't fire a retroactive DM", () => {
    // codex review finding on PR #39 (round 10): without this backfill,
    // deploying this column onto a database with existing roster_ready (or
    // published/finished) pickups would leave it NULL on all of them --
    // startup reconciliation, or the next revisit of any of those pickups,
    // would then treat that as an interrupted brand-new transition and send
    // the creator a "ready for review" DM long after the roster actually
    // completed.
    const db = new Database(':memory:');
    try {
      migrateThrough007(db);
      const insert = (status: string) =>
        (
          db
            .prepare(
              `INSERT INTO pickups (
                guild_id, created_by, format, start_at, role_limit, status, created_at, updated_at
              ) VALUES ('g1', 'staff', 'pickup_vs_pickup', 2000000000, 2, ?, 1000, 5000) RETURNING id`,
            )
            .get(status) as { id: number }
        ).id;
      const openId = insert('open');
      const rosterReadyId = insert('roster_ready');
      const publishedId = insert('published');
      const finishedId = insert('finished');
      const cancelledId = insert('cancelled');

      db.exec(MIGRATIONS[7]!.sql);

      const readyNotifiedAt = (id: number) =>
        (db.prepare('SELECT ready_notified_at FROM pickups WHERE id = ?').get(id) as {
          ready_notified_at: number | null;
        }).ready_notified_at;

      expect(readyNotifiedAt(openId)).toBeNull();
      expect(readyNotifiedAt(cancelledId)).toBeNull();
      expect(readyNotifiedAt(rosterReadyId)).toBe(5000);
      expect(readyNotifiedAt(publishedId)).toBe(5000);
      expect(readyNotifiedAt(finishedId)).toBe(5000);
    } finally {
      db.close();
    }
  });
});

describe('010_pickup_projection_updates migration', () => {
  function migrateThrough009(db: Database.Database): void {
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.slice(0, 9)) db.exec(migration.sql);
  }

  function insertPickup(db: Database.Database, version = 0): number {
    return (
      db
        .prepare(
          `INSERT INTO pickups (
            guild_id, created_by, format, start_at, role_limit, status, version, created_at, updated_at
          ) VALUES ('g1', 'staff', 'pickup_vs_pickup', 2000000000, 2, 'open', ?, 1, 1) RETURNING id`,
        )
        .get(version) as { id: number }
    ).id;
  }

  it('captures the pickup version and a null message ID for a first-post attempt', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough009(db);
      db.exec(MIGRATIONS[9]!.sql);
      const pickupId = insertPickup(db, 3);

      db.prepare(
        `INSERT INTO pickup_projection_updates (pickup_id, pickup_version, surface, message_id, status, attempted_at, created_at)
         SELECT id, version, 'roster', NULL, 'pending', 1000, 1000 FROM pickups WHERE id = ?`,
      ).run(pickupId);

      const row = db.prepare('SELECT * FROM pickup_projection_updates WHERE pickup_id = ?').get(pickupId) as {
        pickup_version: number;
        surface: string;
        message_id: string | null;
        status: string;
      };
      expect(row).toMatchObject({ pickup_version: 3, surface: 'roster', message_id: null, status: 'pending' });
    } finally {
      db.close();
    }
  });

  it('rejects a surface outside signup/review/roster', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough009(db);
      db.exec(MIGRATIONS[9]!.sql);
      const pickupId = insertPickup(db);

      expect(() =>
        db
          .prepare(
            `INSERT INTO pickup_projection_updates (pickup_id, pickup_version, surface, status, created_at)
             VALUES (?, 0, 'nonsense', 'pending', 1)`,
          )
          .run(pickupId),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('rejects a status outside pending/applied/uncertain', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough009(db);
      db.exec(MIGRATIONS[9]!.sql);
      const pickupId = insertPickup(db);

      expect(() =>
        db
          .prepare(
            `INSERT INTO pickup_projection_updates (pickup_id, pickup_version, surface, status, created_at)
             VALUES (?, 0, 'review', 'delivered', 1)`,
          )
          .run(pickupId),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('cascades deletes from its parent pickup, like pickup_events does', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough009(db);
      db.exec(MIGRATIONS[9]!.sql);
      const pickupId = insertPickup(db);
      db.prepare(
        `INSERT INTO pickup_projection_updates (pickup_id, pickup_version, surface, status, created_at)
         VALUES (?, 0, 'review', 'pending', 1)`,
      ).run(pickupId);

      db.prepare('DELETE FROM pickups WHERE id = ?').run(pickupId);

      expect(db.prepare('SELECT COUNT(*) AS n FROM pickup_projection_updates').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
