/**
 * Backend abstraction for per-user DSH lifecycle (manual/architecture.md).
 *
 * `LocalSpawner` spawns child processes (setuid/iptables). The route layer
 * depends only on this interface. Shared instance/status types live here so
 * no backend owns them.
 * @module dsh_ai1net/supervisor/spawner
 */

export type InstanceStatus = 'starting' | 'running' | 'crashed' | 'stopped' | 'failed'
export type InstanceRole = 'main' | 'watchdog'

/** A tracked DSH instance (main or watchdog). `port`/`pid` are local-only. */
export interface Instance {
  id: string
  userId: string
  role: InstanceRole
  folder: string
  port?: number
  status: InstanceStatus
  pid?: number
  exitCode?: number
  lastError?: string
  /** Rendered cordis patch **content**, not a path — see {@link Spawner.launch}. */
  patch?: string
  /** dsh web 一次性 launch token（本地模式从子进程 stdout 解析），用于拼装可直达的打开 URL。 */
  launchToken?: string
  /** systemd scope 名（bwrap 沙箱隔离时），stop 时用 systemctl stop 正确终止整个 scope。 */
  unit?: string
  /** 崩溃自动重启次数（观测面，随实例重建归零）。 */
  restarts?: number
  /** 最近一次崩溃时间（ms epoch）。 */
  lastCrashedAt?: number
}

/** Thrown when a user already has a running main DSH. */
export class AlreadyRunningError extends Error {
  constructor(userId: string) {
    super(`user ${userId} already has a running DSH`)
    this.name = 'AlreadyRunningError'
  }
}

/**
 * 该用户的实例刚因崩溃循环被熔断，冷却期内拒绝启动。
 *
 * 为什么需要它：`circuit-open` 之后若允许立刻重来，崩溃循环可无限重复
 * （用户 F5 / 注入脚本自愈 / 脚本直铺都可能触发），且平台只留一行 stderr。
 * 冷却过后只给一次干净预算。
 */
export class CrashBreakerOpenError extends Error {
  readonly userId: string
  /** 冷却结束时刻（ms epoch）。 */
  readonly retryAt: number
  /** 累计熔断次数。 */
  readonly opens: number

  constructor(userId: string, retryAt: number, opens: number) {
    const waitSec = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
    super(`user ${userId} instance crash-breaker open (opens=${opens}, retry in ${waitSec}s)`)
    this.name = 'CrashBreakerOpenError'
    this.userId = userId
    this.retryAt = retryAt
    this.opens = opens
  }

  /** 距可重试还剩多少毫秒。 */
  get retryAfterMs(): number {
    return Math.max(0, this.retryAt - Date.now())
  }
}

/** A user's main + watchdog pair. */
export interface UserStatus {
  main?: Instance
  watchdog?: Instance
}

/** The host:port the proxy forwards a user's DSH traffic to. */
export interface Endpoint {
  host: string
  port: number
}

/**
 * The lifecycle seam the route layer delegates to.
 *
 * `endpointFor` is spawner-specific: `127.0.0.1:<port>` for the local backend
 * (manual/architecture.md).
 *
 * `launch` takes the rendered cordis patch as **content**, not a path;
 * `LocalSpawner` materializes it to a file inside the user's own volume.
 */
export interface Spawner {
  /**
   * 拉起实例。
   *
   * `opts.epoch`（T08 S4）：**集群模式下 epoch 是 launch 契约的一部分** —— Manager 先抢占
   * 归属拿到 epoch，再把它随 launch 下发，worker 记下来用于 **self-fencing**
   * （收到更高 epoch 就停掉自己那个实例）。本地模式忽略该字段。
   *
   * `opts.hostId`（T08 S6）：**多 worker 时指定落到哪台** —— 由上层选好机、并已用它认领租约，
   * 因此这里必须与租约的 `host_id` 一致（否则归属与实例分离）。单机/1a 忽略。
   */
  launch(
    userId: string,
    folder: string,
    patch?: string,
    opts?: { force?: boolean; epoch?: number; hostId?: string },
  ): Promise<Instance>
  restartMain(userId: string): Promise<Instance | undefined>
  /**
   * 熔断观测面（可选）。
   * 返回 null = 该用户未被熔断冷却；非 null = 正在冷却（含累计熔断次数与解冻时刻）。
   */
  breakerInfo?(userId: string): { opens: number; openedAt: number; cooldownUntil: number } | null

  /**
   * 实例内存配额观测面（可选 —— 「配额随插件集合推导」是**本地模式**概念）。
   * 返回 `instanceMemMb()` / `heapMbFor()` 的**同源结果**，供实例内的「功能管理」
   * 直接显示真值，而不是各自维护一份必然会漂的估算表。
   */
  quotaInfo?(userId: string): { baseMb: number; memMb: number; heapMb: number } | null

  /** Restart every running main so a swapped global API key takes effect (env is a spawn-time snapshot). */
  restartAllMains(): Promise<void>
  spawnWatchdog(userId: string): Promise<Instance | undefined>
  status(userId: string): Promise<UserStatus>
  endpointFor(userId: string): Promise<Endpoint | undefined>
  stop(userId: string, hostId?: string): Promise<void>
  teardown(): Promise<void>
  /** 等待该用户 main 实例打印 launch token（本地模式 = 启动完成的信号）。无实例 /
   * 已崩溃 / 已停 → 立即返回。供 enter 复用分支在返回
   * 打开 URL 前等待，避免把浏览器导向「HTTP 已监听但路由未就绪 → 404」的启动窗口。 */
  waitForLaunchTokenForUser(userId: string, timeoutMs?: number): Promise<void>

  /**
   * 重启该用户实例并**探活**——功能插件启用后判定实例是否还起得来。
   * `ok:false` 时调用方必须回滚/隔离该插件（否则会把实例拖进崩溃循环，教训）。
   */
  restartAndProbe(userId: string, settleMs?: number): Promise<{ ok: boolean; reason: string }>
  /** Record user activity (proxied traffic / entering the workspace) so idle
   * reaping keeps warm instances that are genuinely in use. Local mode tracks
   * this in memory. */
  touch(userId: string): void
  /** Ensure the user's file layer is ready before the route layer uses it. */
  ensureFileService(userId: string): Promise<void>
}
