/**
 * SQLite connection lifecycle: open, WAL, foreign keys, migration.
 * @module dsh_ai1net/db/connection
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runSqliteMigrations } from './schema.js'

/** The better-sqlite3 instance type. */
export type Database = Database.Database

/**
 * Open (creating parent directories as needed), enable WAL + foreign keys,
 * then run migrations.
 * @param path - database file path, or `:memory:`.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db: Database = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runSqliteMigrations(db)
  return db
}
