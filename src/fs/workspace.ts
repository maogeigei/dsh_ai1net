/**
 * Per-user filesystem layout + low-level helpers. This module is the single
 * place that knows the `users/<id>/{home,ws}` shape — the control plane, the
 * spawner and the file helpers all derive their paths from here so they never
 * drift apart.
 *
 * Isolation is enforced by the caller (see fs-guard).
 * @module dsh_ai1net/fs/workspace
 */

import { mkdirSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { PathEscapeError } from '../web/middleware/fs-guard.js'

// Layout segment names. Exported so a caller can build the same layout with
// POSIX separators (`join` would emit backslashes when the control plane is
// developed/tested on Windows) without duplicating the literals.
export const USERS_DIR = 'users'
export const WORKSPACE_DIR = 'ws'
export const HOME_DIR = 'home'
export const HANDOFF_FILE = 'handoff.json'

/** A user's own data root (`<dataRoot>/users/<id>`). */
export function userRoot(dataRoot: string, userId: string): string {
  return join(dataRoot, USERS_DIR, userId)
}

/** The workspace (user-visible files) within a user root. */
export function workspaceRoot(root: string): string {
  return join(root, WORKSPACE_DIR)
}

/** DSH's own state (profiles/sessions/credentials) within a user root. */
export function homeRoot(root: string): string {
  return join(root, HOME_DIR)
}

/** The watchdog command handoff within a user root. */
export function handoffPath(root: string): string {
  return join(root, HANDOFF_FILE)
}

/** Create a directory (0700) if it does not exist. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

/**
 * Reject `abs` when any path component between `root` and `abs` (inclusive) is
 * a symbolic link. The lexical guard (`resolveWithinRoot`) cannot see links
 * planted INSIDE the workspace: an upload through `ws/link -> /etc` passes the
 * prefix check and lands outside the user's root with the caller's privileges.
 * The desktop surface never needs symlinks, so they are forbidden here; the
 * user's DSH process keeps its normal kernel view of links.
 *
 * Only components strictly below `root` are inspected — the data root itself
 * may legitimately sit behind a link. A missing (or not-a-directory) component
 * ends the walk: nothing can exist below it, and the caller's own open/stat
 * will surface that as its usual errno.
 */
export async function rejectSymlinkEscape(root: string, abs: string): Promise<void> {
  const rel = relative(root, abs)
  if (rel === '') return // abs IS the root
  if (rel.startsWith('..')) throw new PathEscapeError(abs, root)
  let current = root
  for (const segment of rel.split(sep)) {
    if (segment === '' || segment === '.') continue
    current = join(current, segment)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) throw new PathEscapeError(abs, root)
    } catch (err) {
      if (err instanceof PathEscapeError) throw err
      const code = (err as NodeJS.ErrnoException).code
      // Missing/not-a-directory component: nothing below it can exist either.
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw err
    }
  }
}

/** One filesystem entry as returned to the desktop. */
export interface FsEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  mtimeMs: number
}

/** List the immediate children of a directory (async, non-blocking). */
export async function listDir(absPath: string): Promise<FsEntry[]> {
  const entries = await readdir(absPath, { withFileTypes: true })
  const result: FsEntry[] = []
  for (const entry of entries) {
    const st = await stat(join(absPath, entry.name))
    result.push({
      name: entry.name,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : 0,
      mtimeMs: st.mtimeMs,
    })
  }
  return result
}
