/**
 * Account-level isolation helpers. Linux-only: each user maps to a deterministic
 * OS uid so the orchestrator can spawn its DSH as that account (via setuid) and
 * per-user 0700 directories become a real boundary.
 *
 * `hashUid` is the *legacy* deterministic hash (stable across restarts and
 * hosts); new users get `baseUid + row_id` from the DB instead (collision-free,
 * see `src/db`). `hashUid` remains as the backfill value for pre-existing rows
 * and the fallback when a uid is not yet assigned.
 * @module dsh_ai1net/isolation
 */

/**
 * Deterministic OS uid for a user id (stable across restarts and hosts).
 * `baseUid` should sit above the distro's system uid range (typically < 1000).
 */
export function hashUid(userId: string, baseUid: number): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return baseUid + (hash % 100000)
}
