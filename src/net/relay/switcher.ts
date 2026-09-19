/**
 * 中继失败切流 · **唯一一份实现**（覆盖网络）
 *
 * ## 为什么只能是"唯一一份"
 * 本线已经吃过两次**同类**教训：`translateEndpoint` 漏赋值、`target()` 静默回退
 * —— 都是"同一件事在多处各写一遍，其中一处悄悄漏了"。所以切换逻辑**只写在这里**，
 * 三个装配点（Manager 拨号通道 / worker 实例面 / 独立 `relay --client`）复用同一个类。
 *
 * ## 它解决的是"候选集退化成单点"
 * 改造前 `RelayClient` 退避**永不放弃**地重试**同一个 url**，而取址层 `pickFromDoc`
 * **取到第一个候选就 `return`** ⇒ 重解析一百次拿回来的还是同一个字符串。
 * ⇒ 本模块负责"**发现当前这条不健康 ⇒ 换到链里的下一条**"。
 *
 * ## 判据全部复用现成的（D2：⛔ 不新造心跳 / 不新增探测帧）
 * - 不健康 = `state === 'backoff'` 且（`attempts ≥ MIN_ATTEMPTS` ∨ `unhealthyForMs ≥ GRACE`）；
 * - 候选链 = {@link listOverlayRelayCandidates}（**同一份引导链**，⛔ 不另写取址）；
 * - "先建新、成功再关旧" = 由调用方的 `open()` 保证（见 {@link RelayFailoverDeps.open}）。
 *
 * ## 硬纪律（每条都有对应验收）
 * - **D4**：新通道**建不起来 ⇒ 保持原通道**（把"本来能用"的通路打掉才是真事故）；
 * - **D5**：被换掉的 url 进**冷却表**，冷却期内不回跳（否则两台互相抢 = 抖动风暴）；
 * - **D6**：链里除已排除项外**没有候选 ⇒ 不切换**（原地退避）；⛔ 绝不切到空、**绝不静默回退默认机**；
 * - **D7**：**每次切换**输出一行 `[relay-switch] #N …` ＋ 累加计数 `switches`
 *   ⇒ `grep -c '^\[relay-switch\]'` 与 `switches` **必然相等**（判别器可断言）。
 *   ⚠️ 所以"**没切**"的行必须用**另一个前缀** `[relay-skip]` —— 否则计数对不上（E9 会红）。
 *
 * ## （2026-09-17）新增：**冷却语义的不对称拆分**（解决"候选池被自己耗干"）
 * - **D1**：**「当前通道已不可用」有权打破自己刚设下的冷却；「目录说该换回首位」没有**。
 *   ⇒ `replace()` 新增 `origin: 'health' | 'directory'`，闸门**只对 directory 收口**。
 * - **D2**：冷却键**仍是 url**；新增 `kind`（`switched-away` / `open-failed`）**只**决定豁免优先级。
 *   ⛔ 原因做键 ⇒ 同一 url 会同时存在多条 ⇒ 从头抖回来 = 净退化。
 * - **D4**：豁免**有界** —— 每 url **每冷却周期一次**（`exemptedAtMs`）；豁免后 `open()` 再失败
 *   ⇒ 重置该 url 冷却**且本周期不再豁免**（⛔ 否则每 2 s 试一次 = 重试风暴）。
 * - **D5**：豁免优先级 = `switched-away` 优先，同类按 `untilMs` 升序。
 * - **D3 护栏**：豁免**只在 D6 现场**启用；**有干净候选时行为逐字不变**（单测 F15 锁住）。
 * - **D6 开关**：`RELAY_FAILOVER_EXEMPT`（默认 `1`；置 `0` ⇒ 逐字回到行为）＝ 第二层回滚。
 */

/**
 * `jitter` 主序与"劣化即切"的**唯一实现**都在 `jitter.ts` ⇒ 本文件只做三件事：
 * ① 采样（把当前通道的 `rttMs` 喂进 tracker）② 判定（调 `pickJitterTarget`）③ 记数 + 告警。
 * ⛔ 不许在本文件里再写一份 p95/排序 —— 那正是"另一份实现 = 另一处静默失效"的复发点。
 */
import {
  orderByJitter,
  pickJitterTarget,
  sharedJitterTracker,
  type JitterTracker,
} from './jitter.js'

/** 阈值（全部来自参数表 / env；脚本与实现**零数字字面量**）。 */
export interface RelayFailoverThresholds {
  /** 连续失败次数达到这个数即视为不健康。 */
  minAttempts: number
  /** 或：持续不健康时间达到这个数（ms）即视为不健康。 */
  graceMs: number
  /** 被换掉的 url 的冷却时长（ms）；冷却期内不参与候选。 */
  cooldownMs: number
  /** 从"判定不健康"到"切换完成"的允许上限（ms）——**验收判据**，实现只用它做日志。 */
  deadlineMs: number
  /** 巡检周期（ms）。 */
  checkMs: number
  /**
   * **换址时"新通道算不算建起来了"的等待上限（ms）**。
   *
   * ⚠️ 只作用于**换址**，⛔ **不作用于启动** —— 启动那条通道必须"不依赖网络"就走完
   * （P0-2 的设计前提：控制面自己也是客户端，启动那一刻自己的门户还没 listen）。
   * 不给这个上限，`open()` 就会把"口池绑好了"当成"通了" ⇒ 会切到一条**同样连不上**的中继上。
   */
  upTimeoutMs: number
  /**
   * **新增：一跳豁免总开关**（`RELAY_FAILOVER_EXEMPT`，默认开）。
   *
   * 语义 = "**当前这条已经挂了**"有权打破自己刚设下的冷却（见 {@link RelayFailoverSupervisor.pickExemptTarget}）。
   * 置 `0` ⇒ 逐字回到行为（D6 现场只写 `[relay-skip]`、不切换）⇒ **第二层回滚**。
   * ⚠️ 与 `minAttempts <= 0`（把整个监管器关掉）**不是同一层级**，⛔ 不许合并（D6 口径）。
   */
  exempt: boolean
}

/**
 * 从 env 读阈值（**值格必须纯数字**；非纯数字一律回退默认值并在日志里说清）。
 *
 * 键名与本线参数表的 `RELAY_FAILOVER_*` 一一对应。
 */
export function relayFailoverThresholds(
  env: Record<string, string | undefined> = process.env,
): RelayFailoverThresholds {
  const num = (key: string, dflt: number): number => {
    const raw = (env[key] ?? '').trim()
    if (raw === '') return dflt
    return /^\d+$/.test(raw) ? Number(raw) : dflt
  }
  return {
    minAttempts: num('RELAY_FAILOVER_MIN_ATTEMPTS', 3),
    graceMs: num('RELAY_FAILOVER_GRACE_MS', 15_000),
    cooldownMs: num('RELAY_FAILOVER_COOLDOWN_MS', 300_000),
    deadlineMs: num('RELAY_FAILOVER_DEADLINE_MS', 30_000),
    checkMs: num('RELAY_FAILOVER_CHECK_MS', 2_000),
    upTimeoutMs: num('RELAY_FAILOVER_UP_TIMEOUT_MS', 12_000),
    /**
     * 值格仍走 `num()`（`/^\d+$/`）⇒ ⛔ 参数表里的值格**必须纯数字**（写 `1` / `0`，
     * ⛔ 不许写成 `true` 或带夹注的 `1（默认）` —— 后者解析失败会**静默回退默认值**）。
     */
    exempt: num('RELAY_FAILOVER_EXEMPT', 1) !== 0,
  }
}

/** 一条 relay 通道（把"通道"和它的健康快照绑在一起，避免调用方各记一份）。 */
export interface RelayChannelHandle {
  /** 这条通道连的地址（`ws://` / `wss://`）。 */
  readonly url: string
  /** 该通道自己的健康快照（实现里通常就是 `RelayClient.status()` 的投影）。 */
  health(): { state: string; attempts: number; unhealthyForMs: number; rttMs?: number }
  /** 关掉这条通道。**幂等**、不抛。 */
  close(): void
}

export interface RelayFailoverDeps {
  /**
   * 建一条新通道，**成功才返回句柄**（失败返回 `undefined`）。
   *
   * ⛔ 顺序由本函数负责：**先把新通道建起来并确认可用，本模块之后才去关旧的**。
   * 反着做（先关后建）会在切换失败时把"本来能用"的通路打掉 ⇒ 违反 R11。
   */
  open: (url: string) => Promise<RelayChannelHandle | undefined>
  /** **候选链**（有序）。生产上就是 `listOverlayRelayCandidates()` 的投影。 */
  candidates: () => Promise<readonly string[]>
  log: (line: string) => void
  thresholds?: Partial<RelayFailoverThresholds>
  /** 注入点（单测用）；默认 `Date.now`。 */
  nowMs?: () => number
  /** 注入点（单测用）；默认 `setTimeout` 自链。 */
  setTimerImpl?: (fn: () => void, ms: number) => unknown
  clearTimerImpl?: (handle: unknown) => void
  /**
   * **抖动采样表**。
   *
   * - 缺省（`undefined`）⇒ 用**进程级共享 tracker**（{@link sharedJitterTracker}）——
   *   装配点（`src/web/server.ts` / `src/worker/relay-tunnel.ts` / `src/net/relay/main.ts`）
   *   都**不在原有的在册文件集**里，做成"必须注入"= 生产上永远不会被注入 = **静默失效**。
   * - 显式给 `null` ⇒ **本监管器不参与 jitter 排序与劣化切换**（逐字回到行为，夹具用）。
   * - 集成/单测可传自己的实例（⛔ 别用共享单例做断言 —— 会与别的用例串味）。
   */
  jitterTracker?: JitterTracker | null
}

/**
 * **冷却原因**（/ D2）：⛔ **不作冷却表的键**，只决定**豁免优先级**（D5）。
 *
 * - `switched-away` —— "**我们主动离开了它**"，它**曾可用**（{@link RelayFailoverSupervisor.replace} 换址成功那条）⇒ 优先豁免。
 * - `open-failed` —— "**刚证明它建不起来**"（`open()` 失败那条）⇒ 次选。
 *
 * 🔴 **为什么原因不能做键**（本线已有同类教训：`translateEndpoint` 漏赋值）：同一 url 会**先后**因不同
 * 原因进冷却 ⇒ 原因做键会让同一 url 同时存在多条条目 ⇒ 它会通过"另一条原因键"被再次尝试 ⇒
 * 抖动抑制失效 = **净退化**。
 */
export type RelayCooldownKind = 'switched-away' | 'open-failed'

/** 冷却表条目（/ D2 + D4）。 */
export interface RelayCooldownEntry {
  /** 解除时刻（epoch ms）。 */
  untilMs: number
  /** **本冷却周期的起点**（epoch ms）—— 判定"本周期的豁免是否已用掉"的锚点（D4）。 */
  sinceMs: number
  /** 进冷却的原因；只喂给豁免优先级（D5）。 */
  kind: RelayCooldownKind
  /**
   * **本周期内上一次用掉豁免**的时刻（D4 的有界性）。
   * 判据 = `exemptedAtMs >= sinceMs` ⇒ 本周期不再豁免它（否则每 2 s 巡检都试一次 = **重试风暴**）。
   */
  exemptedAtMs?: number
}

/** 切换统计（D7：**可读计数**，与日志行数必须一致）。 */
export interface RelayFailoverStats {
  /** 成功切换次数（= `[relay-switch]` 日志行数）。 */
  switches: number
  /** 巡检次数。 */
  checks: number
  /** "判定不健康但无候选可切"的次数（D6 的现场证据）。 */
  noCandidateChecks: number
  /** "新通道建不起来 ⇒ 保持原通道"的次数（D4 的现场证据）。 */
  openFailed: number
  /** **新增**：走"一跳豁免"完成的切换次数（⊆ `switches`；这些行都带 `｜豁免`）。 */
  exemptSwitches: number
  /**
   * **新增**：因 **jitter 劣化**触发的换址次数（⊆ `switches`；这些行都带 `｜jitter`）。
   *
   * 🔑 为什么必须有这个数：本序的判据是"**超阈值自动切路径并告警**"——如果只写日志不留计数，
   * 脚本就无法断言"它到底切过没有"（本线已有两次同类教训：只写日志的实现让判据形同虚设）。
   */
  jitterSwitches: number
  /** **新增**：成功记入 tracker 的 RTT 采样次数（= 0 ⇒ 采样链断了，必须能看出来）。 */
  jitterSamples: number
  /** **新增**：当前通道抖动量超标（`p95|ΔRTT| ≥ JITTER_LIMIT_MS`）的巡检次数。 */
  jitterAlerts: number
  /** 最近一次成功切换的时刻（epoch ms）。 */
  lastSwitchAtMs?: number
  /** 冷却表中的地址与解除时刻（⚠️ 保持 `{url, untilMs}` 外形；`kind` 为追加的只读字段）。 */
  cooldown: { url: string; untilMs: number; kind: RelayCooldownKind }[]
}

export class RelayFailoverSupervisor {
  private readonly deps: RelayFailoverDeps
  private readonly th: RelayFailoverThresholds
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  /** 抖动采样表（`undefined` = 本序能力关闭 ⇒ 一切逐字回到行为）。 */
  private readonly jitter: JitterTracker | undefined

  private current: RelayChannelHandle | undefined
  /** 冷却表：**键 = url**（单一事实：冷却期内该地址不可用）；值是 {@link RelayCooldownEntry}（结构化）。 */
  private readonly cooling = new Map<string, RelayCooldownEntry>()
  private switches = 0
  private checks = 0
  private noCandidateChecks = 0
  private openFailed = 0
  private exemptSwitches = 0
  private jitterSwitches = 0
  private jitterSamples = 0
  private jitterAlerts = 0
  private lastJitterLogAtMs: number | undefined
  private lastSwitchAtMs: number | undefined
  private lastSkipLogAtMs: number | undefined
  /** 上一次记入 tracker 的样本（用于"同一份缓存读数只记一次"的门限）。 */
  private lastJitterSample: { url: string; rttMs: number; atMs: number } | undefined
  private timer: unknown
  private running = false
  private ticking = false

  constructor(deps: RelayFailoverDeps) {
    this.deps = deps
    this.log = deps.log
    this.now = deps.nowMs ?? ((): number => Date.now())
    this.setTimer =
      deps.setTimerImpl ??
      ((fn, ms): unknown => {
        /**
         * **默认 unref**：巡检是**后台**活动，⛔ 不许因为它把进程钉在事件循环上
         * （`relay --client` / worker 这类进程本来就可能随时退出；一个 pending timer
         * 会让"该退出的进程退不掉"—— 那是净退化）。
         */
        const h = setTimeout(fn, ms)
        ;(h as { unref?: () => void }).unref?.()
        return h
      })
    this.clearTimer = deps.clearTimerImpl ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.th = { ...relayFailoverThresholds({}), ...(deps.thresholds ?? {}) }
    /**
     * `null` ⇒ 关闭（逐字回到原行为）；`undefined` ⇒ 共享单例（默认，装配点零改动）。
     * ⚠️ `?? ` 会把 `null` 也当成"没给"，所以必须**先显式判 `null`** —— 这是本行唯一的坑。
     */
    this.jitter = deps.jitterTracker === null ? undefined : deps.jitterTracker ?? sharedJitterTracker()
  }

  /** 当前通道（启动时由装配点灌入第一条）。 */
  get channel(): RelayChannelHandle | undefined {
    return this.current
  }

  get thresholds(): RelayFailoverThresholds {
    return { ...this.th }
  }

  /** 灌入起始通道（启动那条，**不计数、不写 `[relay-switch]`** —— 它不是"切换"）。 */
  seed(handle: RelayChannelHandle | undefined): void {
    this.current = handle
  }

  stats(): RelayFailoverStats {
    const now = this.now()
    return {
      switches: this.switches,
      checks: this.checks,
      noCandidateChecks: this.noCandidateChecks,
      openFailed: this.openFailed,
      exemptSwitches: this.exemptSwitches,
      jitterSwitches: this.jitterSwitches,
      jitterSamples: this.jitterSamples,
      jitterAlerts: this.jitterAlerts,
      lastSwitchAtMs: this.lastSwitchAtMs,
      cooldown: [...this.cooling.entries()]
        .filter(([, e]) => e.untilMs > now)
        .map(([url, e]) => ({ url, untilMs: e.untilMs, kind: e.kind }))
        .sort((a, b) => a.untilMs - b.untilMs),
    }
  }

  /** 是否满足"不健康"判据（**口径**：只有 `backoff` 累计才算；`handshaking` 不算）。 */
  private unhealthy(h: { state: string; attempts: number; unhealthyForMs: number }): boolean {
    /**
     * 🔑 **`RELAY_FAILOVER_MIN_ATTEMPTS=0` = 总开关关闭**（§7 回滚第 1 层）。
     * 语义必须这样定：置 0 后监管器**永不触发** ⇒ 不改代码就能回到"原地退避重试"的现状。
     * ⛔ 不能理解成"`attempts >= 0` 恒真"—— 那会变成"一进 backoff 就切"，是**反向**效果。
     */
    if (this.th.minAttempts <= 0) return false
    if (h.state !== 'backoff') return false
    return h.attempts >= this.th.minAttempts || h.unhealthyForMs >= this.th.graceMs
  }

  /**
   * **唯一的"换址"动作**（三处触发路径共用：健康巡检 / 健康巡检的**一跳豁免** / 目录地址变了）。
   *
   * 成功 → 关旧、记冷却、`switches += 1`、写一行 `[relay-switch]`；失败 → 原通道**原样保留**。
   *
   * ## `origin` = 「这条换址**有没有**打破冷却的权力」（D1）
   * - `'directory'` ⇒ ⛔ **没有**。它的触发条件（"目录里的地址变了"）与"旧通道是否可用"**无关**；
   *   给它豁免权 ⇒ "当前站在 106、目录首位是 47"的每一轮巡检都想把刚冷却的 47 换回来 ⇒
   *   **两位互相抢 = D5 想防的那个抖动风暴**（真机 11:43:26 已实测踩到）。
   * - `'health'` ⇒ 有。`tick()` 稳态只用它传**已过滤掉冷却**的候选；唯一会传"冷却中目标"的场合是
   *   **D6 现场的一跳豁免**（见 {@link tick}）—— ⚠️ 豁免**挑谁**由 `tick()` 单点判定（D4/D5），
   *   本函数只做一件与豁免有关的事：**认领**它（写 `exemptedAtMs`）＋ 按 D4 处理"豁免也失败"。
   */
  async replace(
    targetUrl: string,
    reason: string,
    origin: 'health' | 'directory',
  ): Promise<boolean> {
    const old = this.current
    if (old !== undefined && old.url === targetUrl) {
      this.log(`[relay-skip] 目标地址与当前通道相同（${targetUrl}）⇒ 不动`)
      return false
    }
    /**
     * 🔴 **冷却闸门放在这里（不是只放在 `tick()` 里）** —— 真机实测逼出来的修正：
     *
     * 两条触发路径共用本函数：**健康巡检**（`tick()` 已按冷却过滤候选）与
     * **「目录地址变了」**（`refreshOverlay` 直接调 `replace`，**它不看冷却**）。
     * 首轮真机实测（11:43:26）：`wss://106… -> wss://<base-domain>…` —— 而 `<base-domain>` 十几分钟前
     * **刚被冷却**，只是 `refreshOverlay` 的周期到了、按"地址变了"又把它换回来
     * ⇒ **抖动抑制形同不存在**（D5 的意图被另一条路径绕开）。
     * ⇒ 统一在这一处把关：**directory 路径**上，冷却期内的目标**一律不换**。
     *
     * （D1）：闸门**只对 `'directory'` 收口** —— `'health'` 传进来的"冷却中目标"就是一跳豁免本身。
     */
    const now = this.now()
    const entry = this.cooling.get(targetUrl)
    const inCooling = entry !== undefined && entry.untilMs > now
    if (inCooling && origin === 'directory') {
      this.log(
        `[relay-skip] 目标 ${targetUrl} 仍在冷却（剩 ${entry.untilMs - now}ms / 共 ${this.th.cooldownMs}ms）` +
          `⇒ 不换（D5 防抖动；目录路径**无豁免权** D1）；原因本为：${reason}`,
      )
      return false
    }
    const opened = await this.deps.open(targetUrl)
    if (opened === undefined) {
      this.openFailed += 1
      const failAt = this.now()
      /**
       * 🔴 **失败的候选也必须进冷却** —— 这是真机上想清楚才补上的一条（不是理论洁癖）：
       *
       * 生产目录的 `relays[]` = `[<base-domain>(47), relay-direct.<base-domain>(47), 106]`
       * ——**前两条落在同一台机器上**。杀 47 时，若只排除"当前 url"、不排除"刚试失败的候选"，
       * 那么每次巡检都会**卡在候选②上反复失败**，**永远推进不到候选③（106）** ⇒
       * 链虽然"不再退化成单点"，却依然**换不过去**。
       * ⇒ 语义 = 「排除 **当前** + 排除 **试过且失败的** ⇒ 取下一个」，失败项冷却 `cooldownMs` 后自动回归。
       */
      if (inCooling) {
        /**
         * **D4 后半句**：豁免尝试也失败 ⇒ ① **重置该 url 冷却** ② **本周期不再豁免它**。
         * 实现 = `exemptedAtMs = sinceMs = failAt` ⇒ `exemptedAtMs >= sinceMs` 恒真 ⇒ 本周期额度用尽。
         * ⛔ 不这样写就是"每 2 s 豁免一次、每次都失败" = **重试风暴**（比不切更糟，R11）。
         */
        this.cooling.set(targetUrl, {
          untilMs: failAt + this.th.cooldownMs,
          sinceMs: failAt,
          kind: 'open-failed',
          exemptedAtMs: failAt,
        })
        this.log(
          `[relay-skip] ⛔ 豁免尝试也起不来（${targetUrl}）⇒ **保持原通道**；` +
            `重置该候选冷却 ${this.th.cooldownMs}ms 且**本周期不再豁免**（D4 防重试风暴）`,
        )
        return false
      }
      this.cooling.set(targetUrl, {
        untilMs: failAt + this.th.cooldownMs,
        sinceMs: failAt,
        kind: 'open-failed',
      })
      this.log(
        `[relay-skip] ⛔ 新通道起不来（${targetUrl}）⇒ **保持原通道**（不做半途替换）；` +
          `该候选进冷却 ${this.th.cooldownMs}ms（否则它会把链堵死）`,
      )
      return false
    }
    this.current = opened
    if (old !== undefined) {
      try {
        old.close()
      } catch {
        /* 已关 */
      }
      /**
       * D5：**被换掉的那条进冷却**。不冷却的话，它一恢复就会被立刻换回来，
       * 两台互相抢 = 抖动风暴（"A 挂 → 切 B → A 恢复 → 切回 A → 再挂…"）。
       */
      const awayAt = this.now()
      this.cooling.set(old.url, {
        untilMs: awayAt + this.th.cooldownMs,
        sinceMs: awayAt,
        kind: 'switched-away',
      })
    }
    /** 认领本次豁免（D4）：本周期内**不再**把它当豁免对象。 */
    const wasExempt = inCooling && entry !== undefined
    if (wasExempt) {
      this.cooling.set(targetUrl, { ...entry, exemptedAtMs: this.now() })
      this.exemptSwitches += 1
    }
    this.switches += 1
    this.lastSwitchAtMs = this.now()
    this.log(
      `[relay-switch] #${this.switches} ${old === undefined ? '(无)' : old.url} -> ${opened.url}` +
        `（原因：${reason}；冷却 ${old === undefined ? '-' : old.url} 至 +${this.th.cooldownMs}ms）` +
        (wasExempt ? `｜豁免 kind=${entry.kind} 剩 ${entry.untilMs - now}ms` : ''),
    )
    return true
  }

  /**
   * 从**当前通道**读一次 RTT 样本并记入 tracker（返回当前通道的 jitter，未知 ⇒ `undefined`）。
   *
   * 两级取值：
   * ① `health().rttMs` —— 接口位（实现方愿意投影就投影）；
   * ② **鸭子类型兜底** `(handle).client.status().rttMs` —— 真实装配点（`src/web/server.ts` 的
   *    `toHandle` 与 `src/worker/relay-tunnel.ts` 的 `healthOf`）**只投影了三个字段**，而它们
   *    **不在原有的在册文件集**里 ⇒ 兜底读 `client.status()` 是**唯一**能让真机采到样本的路径。
   *    ⚠️ 代价：耦合"句柄身上挂着 client"这个装配事实 ⇒ 用**全可选 + 拿不到就返回 `undefined`**
   *    兜住：拿不到只是"没样本"，⛔ **不抛、不影响换址**。
   *
   * 🔴 **缓存门限**：`status().rttMs` 是上次心跳的结果（周期 15 s），而巡检是 2 s 一次 ⇒
   * 不设门限同一个值会被反复记录、差分恒 0 ⇒ jitter 假绿。门限见 `JITTER_SAMPLE_GAP_MS`。
   */
  private sampleCurrent(cur: RelayChannelHandle): number | undefined {
    const j = this.jitter
    if (j === undefined || !j.enabled) return undefined
    let rtt = cur.health().rttMs
    if (typeof rtt !== 'number' || !Number.isFinite(rtt)) {
      const duck = (cur as { client?: { status?: () => { rttMs?: number } } }).client
      const st = typeof duck?.status === 'function' ? duck.status() : undefined
      rtt = st?.rttMs
    }
    if (typeof rtt !== 'number' || !Number.isFinite(rtt)) return j.jitterMs(cur.url)
    const now = this.now()
    const last = this.lastJitterSample
    const fresh =
      last === undefined ||
      last.url !== cur.url ||
      last.rttMs !== rtt ||
      now - last.atMs >= j.thresholds().sampleGapMs
    if (fresh) {
      if (j.record(cur.url, rtt)) {
        this.jitterSamples += 1
        this.lastJitterSample = { url: cur.url, rttMs: rtt, atMs: now }
      }
    }
    return j.jitterMs(cur.url)
  }

  /**
   * **"jitter 劣化即切"**（`E2`）—— 通道**健康但抖得厉害**时，换到更稳的候选。
   *
   * ⛔ 三条边界（都是本线已有判据，⛔ 不许动）：
   * 1. **不碰冷却语义**：候选池仍要过 `blocked`（当前 + 冷却中的）⇒ jitter 换址**没有**打破
   *    冷却的权力（豁免权只属于"当前这条已经挂了"那条语义）。
   * 2. **没有更稳的候选 ⇒ 原地不动**（不切空、不静默回退默认机）。
   * 3. 换址**仍走唯一的 {@link replace}** ⇒ `[relay-switch]` 行数与 `switches` 的相等关系
   *    （D7 判别器）不受影响。
   */
  private async considerJitterSwitch(cur: RelayChannelHandle, curJitterMs: number | undefined): Promise<void> {
    const j = this.jitter
    if (j === undefined || curJitterMs === undefined) return
    const jth = j.thresholds()
    if (curJitterMs < jth.switchMs) return
    this.jitterAlerts += 1
    const now = this.now()
    /** 告警按 `graceMs` 节流（否则每次巡检一行 = 日志被刷满，本线吃过这个亏）。 */
    if (this.lastJitterLogAtMs === undefined || now - this.lastJitterLogAtMs >= this.th.graceMs) {
      this.lastJitterLogAtMs = now
      this.log(
        `[relay-jitter] ⚠ 当前通道抖动量超标（p95|ΔRTT|=${curJitterMs}ms ≥ 阈值 ${jth.switchMs}ms，` +
          `样本 ${this.jitterSamples} 个）⇒ 尝试换到更稳的候选（url=${cur.url}）`,
      )
    }
    let urls: readonly string[]
    try {
      urls = await this.deps.candidates()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`[relay-jitter] ⚠ 候选链解析失败（${msg}）⇒ 本次不换址（原地不动）`)
      return
    }
    const blocked = new Set<string>([cur.url])
    for (const [url, e] of this.cooling) if (e.untilMs > now) blocked.add(url)
    const best = pickJitterTarget({
      urls,
      tracker: j,
      curUrl: cur.url,
      curJitterMs,
      switchMs: jth.switchMs,
      blocked,
    })
    if (best === undefined) {
      this.log(
        `[relay-jitter] ⤵ 无更稳的候选（候选 ${urls.length} 条，可用 ${urls.filter((u) => !blocked.has(u)).length} 条）⇒ 保持当前通道`,
      )
      return
    }
    const ok = await this.replace(
      best.url,
      `当前通道抖动量超标（p95|ΔRTT|=${curJitterMs}ms ≥ 阈值 ${jth.switchMs}ms）且 ${best.url} 更稳（${best.jitterMs}ms）`,
      'health',
    )
    if (ok) this.jitterSwitches += 1
  }

  /**
   * 一次巡检：**当前通道不健康 ⇒ 换到链里的下一条**（排除当前 + 冷却中的）。
   *
   * ⛔ 不健康但无候选 ⇒ 之前是**什么都不做**（D6：原地退避，⛔ 不切到空 / 不静默回退默认机）；
   * 起：**先试一次"一跳豁免"**（D1/D4/D5），拿不到豁免对象才回到原地退避。
   *
   * **每次巡检都先采一个 RTT 样本**（不论健康与否 —— 直方图没数据就判不出"劣化"），
   * 健康时额外判一次"**抖动劣化即切**"（{@link considerJitterSwitch}）。
   */
  async tick(): Promise<void> {
    this.checks += 1
    const cur = this.current
    if (cur === undefined) return
    const h = cur.health()
    const curJitterMs = this.sampleCurrent(cur)
    if (!this.unhealthy(h)) {
      await this.considerJitterSwitch(cur, curJitterMs)
      return
    }

    const now = this.now()
    let urls: readonly string[]
    try {
      urls = await this.deps.candidates()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`[relay-skip] ⚠ 候选链解析失败（${msg}）⇒ 本次不换址（保持原地退避）`)
      return
    }
    const blocked = new Set<string>([cur.url])
    for (const [url, e] of this.cooling) if (e.untilMs > now) blocked.add(url)
    /**
     * ⚠️ **这段文案是 D3 的护栏本身**：稳态（有干净候选）路径上必须**逐字不变** ——
     * 否则原有的 E1–E11 结论会被本项目"自己推翻自己"。
     */
    const reason =
      `当前通道不健康（state=${h.state} attempts=${h.attempts} unhealthyForMs=${h.unhealthyForMs}` +
      ` ≥ 阈值 minAttempts=${this.th.minAttempts}/graceMs=${this.th.graceMs}）`
    /**
     * **候选顺序 = jitter 为主序**（`E1`）。⚠️ tracker 无样本时 `orderByJitter` 返回
     * **原数组本身** ⇒ 与改造前逐字一致（`D3` 的护栏因此仍然成立）。
     */
    const target = orderByJitter(urls, this.jitter).find((u) => !blocked.has(u))
    if (target !== undefined) {
      await this.replace(target, reason, 'health')
      return
    }
    /**
     * ═══ **D6 现场**：链里除"当前 + 冷却中的"之外**没有候选** ═══
     *
     * 原有的立项依据正是这里：生产目录 3 条候选里有 **2 条同机**，一次 47 故障就把它们
     * **同时**耗进冷却 ⇒ 杀另一台时"唯一可能的出路"被自己设的冷却挡住 ⇒
     * 真机读数 `仍在冷却（剩 59201ms / 共 300000ms）` ⇒ **最长 ~300 s 不切流**。
     *
     * ⇒ 语义拆分（D1）：**"当前这条已经挂了"有权打破自己刚设下的冷却**（一跳豁免），
     *   而"目录说该换回首位"没有这个权力（见 {@link replace} 的 `origin`）。
     */
    const exempt = this.pickExemptTarget(urls, cur.url, now)
    if (exempt !== undefined) {
      await this.replace(
        exempt,
        `${reason}；D6 现场：**候选池已被冷却耗干** ⇒ 动用一跳豁免（每 url 每冷却周期一次，D4）`,
        'health',
      )
      return
    }
    this.noCandidateChecks += 1
    /**
     * D6 现场证据。⚠️ 这句话**必然**会被反复写（每次巡检一次）⇒ 按 grace 节流，
     * 否则日志被它刷满（本线的日志纪律：`attempts` 那种每秒一行的噪音已经吃过一次）。
     */
    if (this.lastSkipLogAtMs === undefined || now - this.lastSkipLogAtMs >= this.th.graceMs) {
      this.lastSkipLogAtMs = now
      this.log(
        `[relay-skip] ⚠ 当前通道不健康（state=${h.state} attempts=${h.attempts} ` +
          `unhealthyForMs=${h.unhealthyForMs}）但**链里无其他候选**（候选 ${urls.length} 条，` +
          `排除 ${blocked.size} 条）⇒ 保持原地退避（⛔ 不切到空、不静默回退默认机）`,
      )
    }
  }

  /**
   * **一跳豁免的"挑人"单点判据**（D1 / D4 / D5）。
   *
   * ⛔ **只有 D6 现场才允许调用它**（D3）—— 有干净候选时**根本不该走到这里**。
   * 这条护栏由单测 **F15** 锁住：豁免一旦泄漏进正常路径，就会变成"每轮巡检都想回跳"（新抖动源）。
   *
   * 候选池 = `urls`（**链里真正存在**，即已签名目录给出的候选）∩ 冷却中 － 当前 url － 本周期已豁免过的。
   * ⚠️ 池子**严格限定在候选链内** ⇒ ⛔ 绝不放宽成"任意 url"（那是 R5：扩大信任面 = 任意重定向）。
   *
   * 排序（D5）：`switched-away` 优先（"我们主动离开了一件**曾可用**的东西"），
   * 同类按 `untilMs` **升序**（越早解除 ⇒ 越可能已经恢复）。
   */
  private pickExemptTarget(
    urls: readonly string[],
    curUrl: string,
    now: number,
  ): string | undefined {
    if (!this.th.exempt) return undefined
    const pool: { url: string; entry: RelayCooldownEntry }[] = []
    for (const u of urls) {
      if (u === curUrl) continue
      const entry = this.cooling.get(u)
      if (entry === undefined || entry.untilMs <= now) continue
      /** D4：本周期已用掉豁免 ⇒ 不再挑它（否则每 2 s 一次 = 重试风暴）。 */
      if (entry.exemptedAtMs !== undefined && entry.exemptedAtMs >= entry.sinceMs) continue
      pool.push({ url: u, entry })
    }
    if (pool.length === 0) return undefined
    pool.sort((a, b) => {
      const ka = a.entry.kind === 'switched-away' ? 0 : 1
      const kb = b.entry.kind === 'switched-away' ? 0 : 1
      if (ka !== kb) return ka - kb
      return a.entry.untilMs - b.entry.untilMs
    })
    return pool[0].url
  }

  /** 启动巡检（**幂等**）。周期 = `checkMs`；自链自推，不依赖调用方的定时器。 */
  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      void this.runOnce().finally(() => {
        if (!this.running) return
        this.timer = this.setTimer(loop, this.th.checkMs)
      })
    }
    this.timer = this.setTimer(loop, this.th.checkMs)
  }

  /** 停巡检（**幂等**）。⛔ 不关通道 —— 通道归装配点管。 */
  stop(): void {
    this.running = false
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  /** 单次巡检的重入保护（`tick()` 里会 await 网络 ⇒ 两次巡检可能交叠）。 */
  private async runOnce(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`[relay-skip] ⚠ 巡检异常（${msg}）⇒ 忽略本轮（下轮继续）`)
    } finally {
      this.ticking = false
    }
  }
}
