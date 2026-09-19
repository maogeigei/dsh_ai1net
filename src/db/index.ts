/**
 * DB adapter factory. Picks the backend from config: Postgres when a
 * `DSH_AI1NET_DB_URL` is set (shared HA), else local SQLite.
 * Also backfills legacy users' uids once (see manual/architecture.md).
 * @module dsh_ai1net/db
 */

import type { ServerConfig } from '../config.js'
import { hashUid } from '../isolation.js'
import type { DbAdapter } from './adapter.js'
import { SqliteAdapter } from './sqlite.js'
import { openPgAdapter } from './pg.js'

export type { DbAdapter } from './adapter.js'
export * from './types.js'
export { DbError, UniqueViolationError, ForeignKeyViolationError } from './errors.js'

/** Create the configured backend. SQLite is synchronous-open; Postgres is async. */
export async function createDbAdapter(config: ServerConfig): Promise<DbAdapter> {
  const adapter =
    config.dbUrl !== undefined
      ? await openPgAdapter(config.dbUrl, config.baseUid)
      : new SqliteAdapter(config.dbPath, config.baseUid)
  // Backfill rows created before the uid column with their stable hash uid so
  // existing workspace file ownership is preserved. New users get `baseUid +
  // row_id` (set inside createUser), which needs no backfill.
  for (const userId of await adapter.listUsersWithoutUid()) {
    await adapter.setUserUid(userId, hashUid(userId, config.baseUid))
  }
  return adapter
}
