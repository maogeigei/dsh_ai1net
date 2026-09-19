/**
 * 给任意 `Spawner` 套上**归属租约**（T08 S4；设计 §1.2/§3.2/§11.5）。
 *
 * 它补上集群模式下 Manager 侧最关键的一环：**"能不能拉起"必须先问过归属**。
 * 本地模式靠"进程内 Map + 单机"天然保证单写者；多机后这个保证只能落在 DB 的原子 CAS 上
 * —— 两个 Manager 各持一把租约、抢同一个用户，就是**双写同一个 home** = 数据损坏。
 *
 * 三个动作：
 *  1. `launch` 前 **claim**：拿不到就抛 `LeaseBusyError`（**退让**，不是接管 —— 见 R9）；
 *  2. 心跳里 **renewAll**：续租；同时把"我已失权"的实例用 **`/fence`** 通知 worker 停掉
 *     （self-fencing 的 Manager 侧对齐，设计 §11.5）；
 *  3. `stop` 时 **release**：归属交还，别人立刻可以接管（不用等 TTL）。
 *
 * ⚠️ 归属只由 Manager 写（设计 §1.3 数据分层的判据 1）。worker 侧只被通知。
 *
 * @module dsh_ai1net/supervisor/leased-spawner
 */
import { AGENT_TOKEN_HEADER } from '../worker/agent.js'
import type { DbAdapter } from '../db/adapter.js'
import type { Endpoint, Instance, Spawner, UserStatus } from './spawner.js'
import { InstanceLease, type LeaseOptions } from './lease.js'

/** 归属被别人持有时抛出 —— 调用方应**退让**（等待/报告），**不得接管**（R9）。 */
export class LeaseBusyError extends Error {
  readonly userId: string
  readonly holder: string | null
  readonly leaseUntil: number
  constructor(userId: string, holder: string | null, leaseUntil: number) {
    super(`instance ${userId} is held by ${holder ?? 'someone'} until ${new Date(leaseUntil).toISOString()}`)
    this.name = 'LeaseBusyError'
    this.userId = userId
    this.holder = holder
    this.leaseUntil = leaseUntil
  }
}

export interface LeasedSpawnerOptions extends LeaseOptions {
  /** 本机（= 它所属的 worker）在 `dsh_hosts.id` 里的标识。 */
  hostId: string
  /** worker agent 基址。 */
  agentUrl: string
  /** 与 agent 约定的共享密钥。 */
  agentToken: string
  /** 心跳间隔（ms）。默认 = 续租间隔。 */
  heartbeatMs?: number
  /** 该 worker 的内存预算（MB）；**0 = 不承载实例**（只做门户/控制，设计 §15.3）。 */
  capacityMb?: number
  /**
   * **选机**（T08 S6）：返回这次要把实例放到的 `hostId`。
   *
   * ⚠️ 实现必须**先粘性、再容量**（2026-09-15 生产切换时补的设计缺口）：
   * 用户的工作区是**跟机器走的**（本地盘）⇒ 把"已有历史数据在某台"的用户调度到另一台，
   * 他打开实例会看到**空工作区**。所以：有历史归属且那台还 `up` ⇒ **留在原地**；
   * 只有"从没有过归属"（新用户）才按容量挑最空的。
   * 传入 `userId` 就是为了让实现能做这件事。
   */
  selectHost?: (userId?: string) => Promise<string | undefined>
  /** **hostId → agent 地址/密钥**（多机时 fence 要发给"实例所在的那台"）。 */
  agentFor?: (hostId: string) => { agentUrl: string; token: string } | undefined
  /**
   * 启动时把自己注册进 `dsh_hosts`（幂等）。
   *
   * ⚠️ **一个 agent 只应有一条 host 记录**：`registerSelf` 只在"本 Manager 与 worker 同机"
   * （1a 形态）时该开。**专用 Manager 部署必须关掉**（`DSH_AI1NET_CLUSTER_REGISTER_SELF=0`），
   * 否则会多出一条指向同一 agent 的 host 记录 ⇒ 同一个用户可能被两个 hostId 各自认领。
   */
  registerSelf?: boolean
  /** 关闭心跳（测试里手动 tick 用）。 */
  manual?: boolean
}

/** 心跳里上报给 `dsh_hosts` 的本机观测值。 */
export interface HostObservation {
  ok: boolean
  instances: number
  lastError?: string
}

export class LeasedSpawner implements Spawner {
  private readonly lease: InstanceLease
  private timer: NodeJS.Timeout | undefined
  private lastObservation: HostObservation | undefined
  private readonly heartbeatMs: number

  constructor(
    private readonly inner: Spawner,
    private readonly db: DbAdapter,
    private readonly options: LeasedSpawnerOptions,
  ) {
    this.lease = new InstanceLease(db, options.hostId, options)
    this.heartbeatMs = options.heartbeatMs ?? this.lease.renewMs
  }

  get hostId(): string {
    return this.options.hostId
  }

  /** 最近一次心跳观测（管理面/诊断用）。 */
  observation(): HostObservation | undefined {
    return this.lastObservation
  }

  /** 本 Manager 当前持有的实例（userId → {epoch, hostId}）。 */
  holdings(): ReadonlyMap<string, { epoch: number; hostId: string }> {
    return this.lease.holdings()
  }

  /** 注册本机 + 起心跳。窗口未开时先注册一次（否则管理面看不到这台 worker）。 */
  async start(): Promise<void> {
    if (this.options.registerSelf !== false) {
      await this.db.upsertDshHost({
        id: this.options.hostId,
        endpoint: this.options.agentUrl,
        agentToken: this.options.agentToken,
        capacityMb: this.options.capacityMb ?? 0,
      })
    }
    await this.tick() // 立即一次，管理面马上能看到心跳
    if (this.options.manual === true) return
    this.timer = setInterval(() => void this.tick(), this.heartbeatMs)
    this.timer.unref?.()
  }

  /** 只停**心跳定时器**（不改实例）—— 注意别和 `Spawner.stop(userId)` 混淆，故另起名。 */
  stopHeartbeat(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 一次心跳：续租 → 失权则 fence → 上报本机状态。 */
  async tick(): Promise<void> {
    // ① 续租；失权的 userId 会被清出本地记录
    const lost = await this.lease.renewAll()
    for (const userId of lost) {
      // ② 我已失权 ⇒ 让 worker 停掉那个实例（下发的 epoch 取 DB 当前值 +1，确保高于它的记录）
      await this.fenceOnAgent(userId)
    }
    await this.reportHost()
  }

  private async fenceOnAgent(userId: string): Promise<void> {
    try {
      const inst = await this.db.findUserInstance(userId, 'main')
      // 多机（T08 S6）：必须发给**实例所在的那台** —— 发错 host 等于没拦（旧持有者继续写）
      const target = inst?.hostId === null || inst?.hostId === undefined
        ? { agentUrl: this.options.agentUrl, token: this.options.agentToken }
        : (this.options.agentFor?.(inst.hostId) ?? { agentUrl: this.options.agentUrl, token: this.options.agentToken })
      await this.post(`/fence`, { userId, epoch: (inst?.epoch ?? 0) + 1 }, target)
    } catch {
      // 通知失败不抛：下一轮心跳会重试；即便一直失败，租约已过期 ⇒ 新持有者会重建实例
    }
  }

  private async reportHost(): Promise<void> {
    const base = this.options.agentUrl.replace(/\/$/, '')
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(this.heartbeatMs) })
      const body = (await res.json()) as { ok?: boolean; instances?: number }
      this.lastObservation = { ok: body.ok === true, instances: body.instances ?? 0 }
      await this.db.setDshHostStatus(
        this.options.hostId,
        this.lastObservation.ok ? 'up' : 'down',
        undefined,
        Date.now(),
      )
    } catch (err) {
      this.lastObservation = { ok: false, instances: 0, lastError: err instanceof Error ? err.message : String(err) }
      await this.db.setDshHostStatus(this.options.hostId, 'down', undefined, Date.now())
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    target?: { agentUrl: string; token: string },
  ): Promise<unknown> {
    const use = target ?? { agentUrl: this.options.agentUrl, token: this.options.agentToken }
    const base = use.agentUrl.replace(/\/$/, '')
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { [AGENT_TOKEN_HEADER]: use.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`agent POST ${path} → ${res.status}`)
    return res.json()
  }

  // ── Spawner 实现 ────────────────────────────────────────────────────────

  async launch(
    userId: string,
    folder: string,
    patch?: string,
    opts?: { force?: boolean; epoch?: number; hostId?: string },
  ): Promise<Instance> {
    // **先选机、再认领**（T08 S6）：租约的 host_id 必须与"实例真正落在哪台"一致，
    // 否则续租/释放会指向错误的对象（多机下就是静默的脑裂入口）。
    // 显式 `opts.hostId`（迁移的目标机）优先于自动选机。
    const hostId = opts?.hostId ?? (await this.options.selectHost?.(userId)) ?? this.options.hostId
    const claim = await this.lease.acquire(userId, hostId, { folder, patch })
    if (!claim.ok) throw new LeaseBusyError(userId, claim.holder, claim.leaseUntil)
    try {
      return await this.inner.launch(userId, folder, patch, { ...opts, epoch: claim.epoch, hostId })
    } catch (err) {
      // 拉起失败就**立刻交还归属** —— 否则要白等一个 TTL 才能重试（用户侧表现为"卡住"）
      await this.lease.release(userId)
      throw err
    }
  }

  async restartMain(userId: string): Promise<Instance | undefined> {
    const current = await this.inner.status(userId)
    if (current.main === undefined) return undefined
    const { folder, patch } = current.main
    await this.stop(userId)
    return this.launch(userId, folder, patch)
  }

  /** 只重启**本 Manager 持有**的实例 —— 别人的归属不该被我重启（会与其持有者抢同一个 home）。 */
  async restartAllMains(): Promise<void> {
    for (const userId of [...this.lease.holdings().keys()]) {
      try {
        await this.restartMain(userId)
      } catch {
        // 单个失败不打断其余
      }
    }
  }

  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    return this.inner.spawnWatchdog(userId)
  }

  async status(userId: string): Promise<UserStatus> {
    return this.inner.status(userId)
  }

  async endpointFor(userId: string): Promise<Endpoint | undefined> {
    return this.inner.endpointFor(userId)
  }

  async stop(userId: string, hostId?: string): Promise<void> {
    // 显式 host 优先；否则用**我认领时那台**（认领记录里有）—— 别让 stop 落到别的 worker 上
    const target = hostId ?? this.lease.holdings().get(userId)?.hostId
    await this.inner.stop(userId, target)
    await this.lease.release(userId)
  }

  /**
   * 覆盖网络线 序 ㉘ → 单 A（候选 `B`）：**把"停心跳"与"停实例"两件事拆开**。
   *
   * ① `stopHeartbeat()` **保留** —— 进程要走了就不该再续租；租约按 `DSH_AI1NET_CLUSTER_LEASE_TTL_MS`
   *    （47 实测 30000 ms）自然过期，这是「进程不在就别再续租」的正确语义。
   * ② `inner.teardown()` **保留** —— 它只是转发，`inner` = `RemoteSpawner` ⇒ 已是 no-op。
   *
   * ⛔ **严禁**在本函数里对 worker 下发停止（今天没有，将来也不许）；停止实例的正路是
   * `Spawner.stop(userId)`（路由层在用户**显式**停实例时调用），⛔ 不是退出路径。
   * ⚠️ 副作用（如实记账）：心跳停 ⇒ 租约过期 ⇒ **归属记录会与"仍在跑的实例"不一致**；
   * 这是候选 `B` 的真实新增风险，靠 `cleanStaleScopes(uid)` ＋ 认领探活兜住（本单 §7.4 lease 行）。
   */
  async teardown(): Promise<void> {
    // ⛔ 退出不停实例（guard: teardown-must-not-stop-instances）—— 只停心跳，实例留给下一个进程
    this.stopHeartbeat()
    await this.inner.teardown()
  }

  async waitForLaunchTokenForUser(userId: string, timeoutMs?: number): Promise<void> {
    return this.inner.waitForLaunchTokenForUser(userId, timeoutMs)
  }

  async restartAndProbe(userId: string, settleMs?: number): Promise<{ ok: boolean; reason: string }> {
    return this.inner.restartAndProbe(userId, settleMs)
  }

  touch(userId: string): void {
    this.inner.touch(userId)
  }

  async ensureFileService(userId: string): Promise<void> {
    return this.inner.ensureFileService(userId)
  }

  /**
   * 透传可选观测面。`Spawner` 里这两个是**可选**方法 ⇒ 这里做条件委托：
   * 内层有就转发（熔断/配额是 worker 本地自管的概念，设计 §1.2），没有就回 null。
   */
  breakerInfo(userId: string): { opens: number; openedAt: number; cooldownUntil: number } | null {
    return this.inner.breakerInfo?.(userId) ?? null
  }

  quotaInfo(userId: string): { baseMb: number; memMb: number; heapMb: number } | null {
    return this.inner.quotaInfo?.(userId) ?? null
  }
}
