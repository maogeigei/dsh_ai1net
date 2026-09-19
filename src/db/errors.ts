/**
 * Driver-agnostic DB error hierarchy. Each adapter maps its driver's error
 * codes onto these classes, so the route layer catches a single exception type
 * regardless of backend (SQLite or Postgres).
 * @module dsh_ai1net/db/errors
 */

export class DbError extends Error {}
export class UniqueViolationError extends DbError {}
export class ForeignKeyViolationError extends DbError {}

/** Map a better-sqlite3 constraint error onto the shared hierarchy. */
export function mapSqliteError(e: unknown): never {
  const code = (e as { code?: string }).code
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') throw new UniqueViolationError()
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new ForeignKeyViolationError()
  throw e
}

/** Map a node-postgres error onto the shared hierarchy. */
export function mapPgError(e: unknown): never {
  const code = (e as { code?: string }).code
  if (code === '23505') throw new UniqueViolationError()
  if (code === '23503') throw new ForeignKeyViolationError()
  throw e
}
