/**
 * Direct-filesystem {@link UserFs}: the control plane owns the users volume and
 * touches it in-process. This is the `deployMode=local` implementation.
 * @module dsh_ai1net/fs/local-user-fs
 */

import { chownSync, chmodSync } from 'node:fs'
import { chmod, chown, mkdir, readFile, writeFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PathEscapeError, resolveWithinRoot, safeFilename } from '../web/middleware/fs-guard.js'
import { listInstalledPlugins, type PluginInfo } from './plugins.js'
import { UserFsError, isHomeFileName, type HomeFileName, type UserFs } from './user-fs.js'
import { ensureDir, handoffPath, homeRoot, listDir, rejectSymlinkEscape, workspaceRoot, type FsEntry } from './workspace.js'

/** Resolve a user id to that user's data root (`<dataRoot>/users/<id>`). */
export type UserRootResolver = (userId: string) => string

/** Map a Node errno onto the wire code the desktop already handles. */
function fsError(err: unknown, onMissing: 'not_found' | 'parent_missing'): never {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EEXIST') throw new UserFsError('exists')
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new UserFsError(onMissing)
  throw err
}

export class LocalUserFs implements UserFs {
  constructor(private readonly rootFor: UserRootResolver) {}

  async initUserRoot(userId: string, uid?: number): Promise<void> {
    const root = this.rootFor(userId)
    ensureDir(homeRoot(root))
    ensureDir(workspaceRoot(root))
    // The roots were created by the (possibly root) control plane; the DSH child
    // runs as the user's own uid and must be able to traverse + write them.
    // chown the user root + home/ws so the child can mkdir profiles/, etc.
    if (uid !== undefined && typeof process.getuid === 'function' && process.getuid() === 0) {
      chownSync(root, uid, uid)
      chownSync(homeRoot(root), uid, uid)
      chownSync(workspaceRoot(root), uid, uid)
      // 0700 + sticky-ish owner only; keep group/other off.
      chmodSync(homeRoot(root), 0o700)
      chmodSync(workspaceRoot(root), 0o700)
    }
  }

  resolvePath(userId: string, relPath: string): string {
    return this.resolve(userId, relPath)
  }

  async listDir(userId: string, relPath: string): Promise<FsEntry[]> {
    const abs = this.resolve(userId, relPath)
    await this.assertNoLinks(userId, abs)
    try {
      return await listDir(abs)
    } catch (err) {
      fsError(err, 'not_found')
    }
  }

  async mkdir(userId: string, relPath: string): Promise<void> {
    const abs = this.resolve(userId, relPath)
    await this.assertNoLinks(userId, abs)
    try {
      await mkdir(abs)
    } catch (err) {
      fsError(err, 'parent_missing')
    }
  }

  async createEntry(userId: string, relPath: string, name: string, type: 'file' | 'dir'): Promise<string> {
    const dirAbs = this.resolve(userId, relPath)
    const filename = this.sanitize(name)
    const target = join(dirAbs, filename)
    await this.assertNoLinks(userId, target)
    try {
      if (type === 'dir') await mkdir(target)
      else await writeFile(target, '')
    } catch (err) {
      fsError(err, 'parent_missing')
    }
    return filename
  }

  async upload(userId: string, relPath: string, name: string, data: Buffer): Promise<string> {
    const dirAbs = this.resolve(userId, relPath)
    const filename = this.sanitize(name)
    const target = join(dirAbs, filename)
    await this.assertNoLinks(userId, target)
    try {
      await writeFile(target, data)
    } catch (err) {
      fsError(err, 'parent_missing')
    }
    return filename
  }

  /** 读取工作区内的**文件**（门户/实例页「我的文件」下载用）。 */
  async readFile(
    userId: string,
    relPath: string,
    maxBytes = 32 * 1024 * 1024,
  ): Promise<{ name: string; data: Buffer }> {
    const abs = this.resolve(userId, relPath)
    await this.assertNoLinks(userId, abs)
    let st
    try {
      st = await stat(abs)
    } catch (err) {
      fsError(err, 'not_found')
    }
    if (st.isDirectory()) throw new UserFsError('not_a_file')
    if (st.size > maxBytes) throw new UserFsError('too_large')
    try {
      return { name: basename(abs), data: await readFile(abs) }
    } catch (err) {
      fsError(err, 'not_found')
    }
  }

  async isDirectory(userId: string, relPath: string): Promise<boolean> {
    const abs = this.resolve(userId, relPath)
    await this.assertNoLinks(userId, abs)
    try {
      return (await stat(abs)).isDirectory()
    } catch (err) {
      fsError(err, 'not_found')
    }
  }

  async listInstalledPlugins(userId: string): Promise<PluginInfo[]> {
    return listInstalledPlugins(this.rootFor(userId))
  }

  async writeHandoff(userId: string, content: string): Promise<void> {
    const root = this.rootFor(userId)
    ensureDir(root)
    await writeFile(handoffPath(root), content)
  }

  /**
   * 读 home 下的平台托管配置文件。
   * 名字走**白名单**（只允许固定文件名）⇒ 不可能拼出 `../` 之类的越界路径。
   */
  async readHomeFile(userId: string, name: HomeFileName): Promise<string | null> {
    if (!isHomeFileName(name)) throw new UserFsError('bad_path')
    try {
      return await readFile(join(homeRoot(this.rootFor(userId)), name), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /**
   * 写 home 下的平台托管配置文件：`0600` + chown 给 **home 属主**。
   * chown 不能省 —— 实例以 `dsh-<uid>` 身份读它（见 `home-files.ts` 头注释① ②）。
   */
  async writeHomeFile(userId: string, name: HomeFileName, text: string): Promise<void> {
    if (!isHomeFileName(name)) throw new UserFsError('bad_path')
    const home = homeRoot(this.rootFor(userId))
    ensureDir(home)
    const file = join(home, name)
    await writeFile(file, text, { mode: 0o600 })
    try {
      const st = await stat(home)
      await chown(file, st.uid, st.gid)
      await chmod(file, 0o600)
    } catch {
      /* chown 失败（非 root 运行等）不阻断 —— 与 home-files.ts 同款 */
    }
  }

  /** Resolve a workspace-relative path, self-healing the root the way the
   * pre-seam routes did (every one of them called `ensureWorkspaceRoot` first). */
  private resolve(userId: string, relPath: string): string {
    const ws = workspaceRoot(this.rootFor(userId))
    ensureDir(ws)
    try {
      return resolveWithinRoot(ws, relPath)
    } catch (err) {
      if (err instanceof PathEscapeError) throw new UserFsError('bad_path')
      throw err
    }
  }

  /** The lexical guard above is prefix-only and blind to links planted inside
   * the workspace, so every operation re-walks its final absolute path (the
   * write target for upload/createEntry) and rejects any symlink component —
   * `writeFile`/`mkdir` would otherwise follow it outside the root with this
   * process's privileges. Surfaces as the usual `bad_path` wire code. */
  private async assertNoLinks(userId: string, abs: string): Promise<void> {
    try {
      await rejectSymlinkEscape(workspaceRoot(this.rootFor(userId)), abs)
    } catch (err) {
      if (err instanceof PathEscapeError) throw new UserFsError('bad_path')
      throw err
    }
  }

  private sanitize(name: string): string {
    try {
      return safeFilename(name)
    } catch (err) {
      if (err instanceof PathEscapeError) throw new UserFsError('bad_name')
      throw err
    }
  }
}
