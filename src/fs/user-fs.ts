/**
 * The per-user filesystem seam (manual/architecture.md).
 *
 * The control plane owns the users volume and touches it in-process
 * ({@link LocalUserFs}); routes depend only on this interface.
 *
 * All paths crossing this interface are **workspace-relative**; the
 * implementation resolves them against its own root via `resolveWithinRoot`.
 * @module dsh_ai1net/fs/user-fs
 */

import type { PluginInfo } from './plugins.js'
import type { FsEntry } from './workspace.js'

/** Wire-level failure codes. These are the exact `{error}` values the desktop
 * UI already switches on. */
export type UserFsErrorCode =
  | 'bad_path'
  | 'bad_name'
  | 'not_found'
  | 'exists'
  | 'parent_missing'
  | 'not_a_folder'
  // 下载/查看文件
  | 'not_a_file'
  | 'too_large'
  | 'unsupported'
  // 覆盖网络线缺陷 A1（2026-09-16）：**归属的机器已知，却取不到它的接入信息**（或归属本身
  // 查不出来）⇒ 503。刻意与 `not_found` 分开：`not_found` 会被读成"文件夹不存在"（数据丢了），
  // 而这里的事实是"这次连该打哪台都没定下来"，属于**可重试**的服务侧状态。
  | 'host_unresolved'

/** HTTP status each code maps to (unchanged from the pre-seam routes). */
const STATUS: Record<UserFsErrorCode, number> = {
  bad_path: 400,
  bad_name: 400,
  not_found: 404,
  exists: 409,
  parent_missing: 404,
  not_a_folder: 400,
  not_a_file: 400,
  too_large: 413,
  unsupported: 501,
  host_unresolved: 503,
}

/**
 * A filesystem failure already reduced to its wire form. Routes rethrow it as
 * `reply.code(err.status).send({ error: err.code })` without inspecting errno,
 * which is what lets a thin implementation rebuild it from a wire response.
 */
export class UserFsError extends Error {
  readonly status: number

  constructor(readonly code: UserFsErrorCode) {
    super(code)
    this.name = 'UserFsError'
    this.status = STATUS[code]
  }
}

/** True when `code` is one this seam knows how to represent. */
export function isUserFsErrorCode(code: string): code is UserFsErrorCode {
  return code in STATUS
}

/** Per-user filesystem operations, as the route layer needs them. */
export interface UserFs {
  /** Create the user's home/workspace roots (`0700`). Idempotent.
   * `uid` (when provided) makes local mode chown the roots to the user's Linux
   * uid — the DSH child runs as that uid and would otherwise hit EACCES writing
   * `home/` (directories are created by the root control plane). */
  initUserRoot(userId: string, uid?: number): Promise<void>
  /** Absolute path of `relPath` **as the user's DSH process sees it** (pure path
   * math — the path as the user's own DSH process sees it). */
  resolvePath(userId: string, relPath: string): string
  listDir(userId: string, relPath: string): Promise<FsEntry[]>
  mkdir(userId: string, relPath: string): Promise<void>
  /** Create a file or directory under `relPath`; returns the sanitized name. */
  createEntry(userId: string, relPath: string, name: string, type: 'file' | 'dir'): Promise<string>
  /** Write `data` as `name` under `relPath`; returns the sanitized name. */
  upload(userId: string, relPath: string, name: string, data: Buffer): Promise<string>
  /** Whether `relPath` is a directory; throws `not_found` when absent. */
  isDirectory(userId: string, relPath: string): Promise<boolean>
  /** Read a workspace-relative **file** (供门户/实例页「我的文件」下载)。
   * 目录 → `not_a_file`；超过 `maxBytes` → `too_large`。
   * 注：部分实现可能抛 `unsupported`（尚无对应端点时）。 */
  readFile(userId: string, relPath: string, maxBytes?: number): Promise<{ name: string; data: Buffer }>
  listInstalledPlugins(userId: string): Promise<PluginInfo[]>
  /** Write the post-restart command handoff the watchdog reads. */
  writeHandoff(userId: string, content: string): Promise<void>
  /**
   * 读用户 **home**（`$DSH_HOME`）下的**平台托管配置文件**。
   *
   * 为什么必须走本 seam 而不是直接 `fs.readFile(home_dir)`：**用户卷跟着实例走**
   * —— 实例在 worker 上时，`home/` 就在那台机器上。平台侧直接 `readFile` 只会读到
   * 自己盘上一个**不存在的路径**（返回空串、不报错）⇒ 落地层静默变成空操作
   * （2026-09-19 实测：托管清单被清空、目标文件一个字节没动）。
   * 归属的钉法与本 seam 的其它方法**完全一致**（`hostIdFor` 的粘性选机，见 `server.ts`
   * 「文件写到 A、实例起在 B」那段注释）⇒ 落地与实例必然同机。
   *
   * `name` 只接受 {@link HOME_FILE_NAMES} 里的**固定文件名**（⛔ 不收路径）：
   * 这几个是平台自己写的配置，用户的其它文件不归平台碰。
   * 文件不存在 ⇒ `null`（**不是**抛错：首次落地就该从"没有文件"开始）。
   */
  readHomeFile(userId: string, name: HomeFileName): Promise<string | null>
  /**
   * 写用户 home 下的平台托管配置文件。
   * ⚠️ 与 `writeHomeFile`（本地版）同一组约束：`0600` + **chown 给 home 属主**
   * —— 实例以 `dsh-<uid>` 身份跑，root 写的 0600 文件它**读不了**（/ R10 同族）。
   */
  writeHomeFile(userId: string, name: HomeFileName, text: string): Promise<void>
}

/**
 * 平台托管的 home 配置文件名白名单（⛔ 只许这些**裸文件名**，不许带路径）。
 *
 * - `settings.yaml` —— dsh 自己的设置（平台只写 `llm-pi-ai.providers.*` 与 `locale.*`）；
 * - `.credentials.yaml` —— dsh 的凭据 refs（平台只写自己 refs 段）。
 */
export const HOME_FILE_NAMES = ['settings.yaml', '.credentials.yaml'] as const
export type HomeFileName = (typeof HOME_FILE_NAMES)[number]

/** 白名单校验（两端都调一次：agent 侧拦住非法入参，本地实现拦住越界调用）。 */
export function isHomeFileName(name: unknown): name is HomeFileName {
  return typeof name === 'string' && (HOME_FILE_NAMES as readonly string[]).includes(name)
}
