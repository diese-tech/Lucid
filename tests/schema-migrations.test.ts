import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/schema.js';

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
