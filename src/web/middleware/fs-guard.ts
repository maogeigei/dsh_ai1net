/**
 * Path-traversal guard for every filesystem-facing surface.
 *
 * `resolveWithinRoot` canonicalizes a user-supplied relative path against a
 * root and rejects anything that escapes it; `safeFilename` strips directory
 * components from an upload name.
 * @module dsh_ai1net/web/middleware/fs-guard
 */

import { basename, isAbsolute, posix, resolve, sep } from 'node:path'

/** The subset of `node:path` the guard needs, so a caller can pin POSIX
 * semantics for paths that are always POSIX-shaped regardless of the host
 * the control plane happens to run on. */
export interface PathFlavor {
  isAbsolute(path: string): boolean
  resolve(...paths: string[]): string
  readonly sep: string
}

const NATIVE: PathFlavor = { isAbsolute, resolve, sep }

/** POSIX flavor, for POSIX-style paths. */
export const POSIX: PathFlavor = { isAbsolute: posix.isAbsolute, resolve: posix.resolve, sep: posix.sep }

/** Sentinel error for a path that escapes its allowed root. */
export class PathEscapeError extends Error {
  constructor(path: string, root: string) {
    super(`path ${path} escapes root ${root}`)
    this.name = 'PathEscapeError'
  }
}

/**
 * Resolve `rel` against `root` and reject absolute paths, NUL bytes, and any
 * result that escapes the root (including `..` traversal).
 * @param root - the user's workspace root (absolute).
 * @param rel - a user-supplied relative path (`''` resolves to `root`).
 * @param flavor - path semantics; defaults to the host's. Pass {@link POSIX}
 * when `root` must be treated as a POSIX path regardless of the host.
 */
export function resolveWithinRoot(root: string, rel: string, flavor: PathFlavor = NATIVE): string {
  const { isAbsolute, resolve, sep } = flavor
  if (isAbsolute(rel)) throw new PathEscapeError(rel, root)
  if (rel.includes('\0')) throw new PathEscapeError('<nul>', root)
  const resolved = resolve(root, rel)
  const boundary = root.endsWith(sep) ? root : root + sep
  if (resolved !== root && !resolved.startsWith(boundary)) {
    throw new PathEscapeError(rel, root)
  }
  return resolved
}

/**
 * Reduce an upload filename to its base name, rejecting empty/dot/NUL names so
 * a client cannot smuggle a path component.
 */
export function safeFilename(name: string): string {
  const base = basename(name)
  if (base === '' || base === '.' || base === '..' || base.includes('\0')) {
    throw new PathEscapeError(name, '<filename>')
  }
  return base
}
