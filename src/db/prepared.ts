/**
 * Prepared-statement cache. better-sqlite3 does not cache `db.prepare`, so
 * re-preparing the same SQL on every call re-parses it. This memoizes prepared
 * statements per connection (WeakMap), which matters for hot paths such as
 * authentication and the reverse proxy.
 * @module dsh_ai1net/db/prepared
 */

import type Database from 'better-sqlite3'
import type { Database as Db } from './connection.js'

type Statement = Database.Statement<unknown[], unknown>

const caches = new WeakMap<Db, Map<string, Statement>>()

/** Prepare (and cache) a statement for a connection. */
export function prepare(db: Db, sql: string): Statement {
  let cache = caches.get(db)
  if (cache === undefined) {
    cache = new Map()
    caches.set(db, cache)
  }
  let statement = cache.get(sql)
  if (statement === undefined) {
    statement = db.prepare(sql)
    cache.set(sql, statement)
  }
  return statement
}
