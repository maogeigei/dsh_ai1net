/**
 * `UserFs` 的**远端实现**（T08 S5）。
 *
 * 为什么需要它：门户的「我的文件」(`/api/desktop/tree`、`/api/fs/*`) 只依赖 `UserFs` seam；
 * 多机后用户卷在 **worker** 上，Manager 的本地读会落空。做法不是重新实现一套路径语义，
 * 而是把 worker 上**同一个 `LocalUserFs`** 经 agent 的 `/fs/*` 暴露出来 —— 路径安全
 * （`resolveWithinRoot` / `safeFilename` / `PathEscapeError`）**继续复用同一份代码**，
 * 所以"本地能过的路径，远端行为一致"是结构性保证，不是靠测试碰运气。
 *
 * `resolvePath` 是**纯路径数学**（同步接口），按 **worker 的 dataRoot** 计算 ——
 * 这正是"实例眼里的路径"。因此多机部署有一条**基线约定**：
 * **所有 worker 的 dataRoot 必须是同一个绝对路径**（同镜像即可满足，见设计 §14.3 机器基线）。
 * 不一致时 `buildServer` 会在启动时把差异**报出来**（见 `server.ts` 的 probe）。
 *
 * @module dsh_ai1net/fs/remote-user-fs
 */
import { AGENT_TOKEN_HEADER } from '../worker/agent.js'
import { PathEscapeError, resolveWithinRoot } from '../web/middleware/fs-guard.js'
import type { PluginInfo } from './plugins.js'
import { UserFsError, isUserFsErrorCode, type HomeFileName, type UserFs } from './user-fs.js'
import type { FsEntry } from './workspace.js'
import { userRoot, workspaceRoot } from './workspace.js'

export interface RemoteUserFsOptions {
  /** **默认/回退** worker agent 基址（未提供 hostIdFor 或查不到归属时用它）。 */
  agentUrl: string
  /** 与默认 agent 约定的共享密钥。 */
  token: string
  /**
   * **按用户归属路由**（2026-09-15 生产切换暴露的缺口）。
   *
   * 为什么必须有：用户工作区在**那台 worker 的本地盘**上；文件面若固定打一台 agent，
   * 就会出现「实例跑在 A、而 mkdir/上传写到 B」⇒ 实例看不到自己的文件、甚至 cwd 不存在而崩。
   * 传 `hostIdFor`（查 `dsh_instances.host_id`）即可让每次文件操作落到**该用户所在的机器**。
   */
  hostIdFor?: (userId: string) => Promise<string | undefined>
  /** hostId → 接入信息（与 RemoteSpawner 用**同一份**目录，避免两套漂移）。 */
  agentFor?: (hostId: string) => { agentUrl: string; token: string } | undefined
  /**
   * `agentFor` **未命中**时的按需补齐钩子（2026-09-16 加，覆盖网络线缺陷 A1）。
   *
   * 为什么需要：`agentFor` 是同步查表，而那张表（`server.ts` 的 `hostDirectory`）是**惰性**的
   * —— 唯一写入者是 `hostsProvider()`，此前只有 `RemoteSpawner.ensureHosts()` 会调它。
   * ⇒ Manager 重启后若用户先碰**文件面**，表里只有"本机"，别的机的用户就会取不到地址。
   * 传了这个钩子，取不到时会先补一次表再判，而不是直接掉进下面的失败关闭。
   */
  ensureHost?: (hostId: string) => Promise<void>
  /** **worker 上**的 dataRoot（必须与该 worker 一致，用于 `resolvePath` 的路径数学）。 */
  workerDataRoot: string
  /** 单次请求超时（ms）。文件可能较大，默认 30 s。 */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class RemoteUserFs implements UserFs {
  private readonly base: string
  private readonly token: string
  /** **worker 上**的 dataRoot —— 公开只读，供 `server.ts` 启动时做基线一致性探测。 */
  readonly workerDataRoot: string
  private readonly timeoutMs: number
  private readonly doFetch: typeof fetch
  private readonly hostIdFor?: (userId: string) => Promise<string | undefined>
  private readonly agentFor?: (hostId: string) => { agentUrl: string; token: string } | undefined
  private readonly ensureHost?: (hostId: string) => Promise<void>

  constructor(options: RemoteUserFsOptions) {
    this.base = options.agentUrl.replace(/\/$/, '')
    this.token = options.token
    this.hostIdFor = options.hostIdFor
    this.agentFor = options.agentFor
    this.ensureHost = options.ensureHost
    this.workerDataRoot = options.workerDataRoot
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.doFetch = options.fetchImpl ?? fetch
  }

  /**
   * 解析该用户文件操作应打的那台 agent。
   *
   * ## 归属已知却取不到地址 ⇒ **抛错，绝不回退默认机**（覆盖网络线缺陷 A1，2026-09-16 修）
   *
   * 旧行为是三种失败（查库抛错 / 没给 `agentFor` / `agentFor` 查不到）**一律静默回退默认机**。
   * 为什么这是缺陷：默认机 = Manager 所在那台，它对**别的机**的用户只会给出两种答案 ——
   * ① 那台 agent 上没有这个用户 ⇒ `{error:"not_found"}`，与"**文件夹不存在**"**完全同形**
   *    （用户读成"我的文件丢了"，而真因是"请求根本没出这台机"）；
   * ② 若本地恰好有同名目录 ⇒ 直接把文件写进**一份没人在看的副本**（更糟的静默写坏）。
   * 实测现场：Manager 重启后 `hostDirectory` 尚未被 `hostsProvider()` 填充，<host-b> 用户点启动
   * 连发 3 次 **全 404，且 relay 零 `DIAL`、拨号池零落点** ⇒ 请求根本没出去。
   * **判别器 = 看 relay 有没有 `DIAL`**（本机单测打在 `fetch` 上，断言"没打默认机"）。
   *
   * 只有**"确实还没有归属"**（`hostIdFor` 正常返回 `undefined`）才用默认 agent ——
   * 那是设计内的单机 / 首次触达路径（见 `hostIdForFile` 的粘性说明），不是错误。
   */
  private async target(userId: string): Promise<{ base: string; token: string }> {
    if (this.hostIdFor === undefined) return { base: this.base, token: this.token }
    let hostId: string | undefined
    try {
      hostId = (await this.hostIdFor(userId)) ?? undefined
    } catch {
      // 归属都查不出来 ⇒ 无法判断该打哪台 ⇒ 失败关闭（旧行为在这里静默打默认机）
      throw new UserFsError('host_unresolved')
    }
    if (hostId === undefined || hostId === '') return { base: this.base, token: this.token }
    let hit = this.agentFor?.(hostId)
    if (hit === undefined && this.agentFor !== undefined && this.ensureHost !== undefined) {
      // 未命中往往只是"表还没被填"（重启窗口期）⇒ 先按需补齐一次再判。
      // 这一步让下面的失败关闭**不波及正常的冷启动请求**（否则只是把"假 404"换成"真 503"）。
      try {
        await this.ensureHost(hostId)
      } catch {
        /* 补齐失败 ⇒ 交给下面的失败关闭：带 hostId 的明确错误，好过静默打错机 */
      }
      hit = this.agentFor(hostId)
    }
    if (hit === undefined) throw new UserFsError('host_unresolved')
    return { base: hit.agentUrl.replace(/\/$/, ''), token: hit.token }
  }

  /** 统一的 POST：把 agent 的 `{error: code}` 还原成 `UserFsError`（路由按 code 回前端）。 */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const userId = typeof body.userId === 'string' ? body.userId : ''
    const t = await this.target(userId)
    const res = await this.doFetch(`${t.base}${path}`, {
      method: 'POST',
      headers: { [AGENT_TOKEN_HEADER]: t.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    if (res.ok) return (text === '' ? undefined : JSON.parse(text)) as T
    let code: unknown
    try {
      code = (JSON.parse(text) as { error?: unknown }).error
    } catch {
      code = undefined
    }
    if (typeof code === 'string' && isUserFsErrorCode(code)) throw new UserFsError(code)
    throw new Error(`agent POST ${path} → ${res.status}: ${text.slice(0, 200)}`)
  }

  async initUserRoot(userId: string, uid?: number): Promise<void> {
    // 注意：uid 也要带过去 —— 本地实现会 chown 用户根，远端由 worker 执行同一动作。
    await this.post('/fs/init', uid === undefined ? { userId } : { userId, uid })
  }

  /**
   * **纯路径数学**，按 worker 的 dataRoot 算（= 实例眼里的绝对路径）。
   * 刻意**不**像本地实现那样 `ensureDir` —— Manager 不该在**自己**的盘上造目录。
   */
  resolvePath(userId: string, relPath: string): string {
    const ws = workspaceRoot(userRoot(this.workerDataRoot, userId))
    try {
      return resolveWithinRoot(ws, relPath)
    } catch (err) {
      if (err instanceof PathEscapeError) throw new UserFsError('bad_path')
      throw err
    }
  }

  async listDir(userId: string, relPath: string): Promise<FsEntry[]> {
    return this.post<FsEntry[]>('/fs/list', { userId, relPath })
  }

  async mkdir(userId: string, relPath: string): Promise<void> {
    await this.post('/fs/mkdir', { userId, relPath })
  }

  async createEntry(userId: string, relPath: string, name: string, type: 'file' | 'dir'): Promise<string> {
    const out = await this.post<{ name: string }>('/fs/create', { userId, relPath, name, type })
    return out.name
  }

  async upload(userId: string, relPath: string, name: string, data: Buffer): Promise<string> {
    const out = await this.post<{ name: string }>('/fs/upload', {
      userId,
      relPath,
      name,
      dataBase64: data.toString('base64'),
    })
    return out.name
  }

  async isDirectory(userId: string, relPath: string): Promise<boolean> {
    const out = await this.post<{ isDirectory: boolean }>('/fs/isdir', { userId, relPath })
    return out.isDirectory
  }

  async readFile(userId: string, relPath: string, maxBytes?: number): Promise<{ name: string; data: Buffer }> {
    const out = await this.post<{ name: string; dataBase64: string }>(
      '/fs/read',
      maxBytes === undefined ? { userId, relPath } : { userId, relPath, maxBytes },
    )
    return { name: out.name, data: Buffer.from(out.dataBase64, 'base64') }
  }

  async listInstalledPlugins(userId: string): Promise<PluginInfo[]> {
    return this.post<PluginInfo[]>('/fs/plugins', { userId })
  }

  async writeHandoff(userId: string, content: string): Promise<void> {
    await this.post('/fs/handoff', { userId, content })
  }

  /**
   * 读用户 home 下的平台托管配置文件—— 走 agent 的 `/fs/home-read`，
   * 目标是 `hostIdFor(userId)` 钉住的那台机（与实例同机，见 `user-fs.ts#readHomeFile` 注释）。
   * 文件不存在 ⇒ `null`。
   */
  async readHomeFile(userId: string, name: HomeFileName): Promise<string | null> {
    const out = await this.post<{ text: string | null }>('/fs/home-read', { userId, name })
    return out.text
  }

  async writeHomeFile(userId: string, name: HomeFileName, text: string): Promise<void> {
    await this.post('/fs/home-write', { userId, name, text })
  }

  /** 探测 worker 的 dataRoot（用于启动时的基线一致性检查，见 `server.ts`）。 */
  async probeWorkerRoot(): Promise<string | undefined> {
    try {
      const res = await this.doFetch(`${this.base}/fs/root`, {
        headers: { [AGENT_TOKEN_HEADER]: this.token },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { dataRoot?: string }
      return body.dataRoot
    } catch {
      return undefined
    }
  }
}
