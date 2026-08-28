/**
 * Database connection.
 *
 * We use better-sqlite3 specifically because it is SYNCHRONOUS. That is not a
 * performance preference — it is what makes the role-limit check in the signup
 * repository correct. A synchronous transaction cannot be interleaved by
 * another event mid-flight, so "count the user's roles, then insert" is atomic
 * without any mutex or lock table. Swapping in an async driver would silently
 * reopen that race. See src/db/repositories/signups.ts.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';

let instance: Database.Database | null = null;

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // WAL keeps reads from blocking the write that a burst of reactions triggers.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

export function initDatabase(path: string): Database.Database {
  instance = openDatabase(path);
  return instance;
}

export function getDatabase(): Database.Database {
  if (!instance) throw new Error('Database not initialized — call initDatabase() first.');
  return instance;
}

export function setDatabaseForTesting(db: Database.Database | null): void {
  instance = db;
}
