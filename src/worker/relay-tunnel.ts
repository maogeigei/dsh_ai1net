/**
 * Worker 侧的**中继隧道**（覆盖网络 R4）—— `SshTunnel` 的同面替代品。
 *
 * ## 它替掉的是什么
 * 今天"Manager 连不到 Worker"靠的是 `ssh -R`：Worker 拨 Manager 的 sshd，把两边的
 * `127.0.0.1:<port>` 接起来。代价是**长期依赖 sshd + root 凭据 + 一条公网 SSH 口**。
 * 本类改用自研 relay：Worker 只拨一条 wss，relay 为每个注册端口在**它自己的回环**上开一条
 * 监听 ⇒ 对 Manager 而言"又有一个 `host:port` 可以拨"，形态与 sshd 版同形（S0 抽 `Reachability`
 * 的全部意义）。**Worker 依旧零入站口**。
 *
 * ## 与 `SshTunnel` 的**唯一实质差别**（改代码前务必知道）
 * | | 端口号 | 谁来翻译 |
 * |---|---|---|
 * | `SshTunnel` | **同号**（`-R p:127.0.0.1:p`）⇒ Manager 侧端口 = Worker 侧端口 | 不需要翻译 |
 * | `RelayTunnel` | relay **动态分配**（实测 42067）⇒ Manager 侧端口 ≠ Worker 侧端口 | **Manager 侧**按 `(hostId, port)` 查 relay `/status` 翻译 |
 *
 * ⇒ 所以本类**只负责"把这个口声明给 relay"**，绝不把 relay 的回环口号回传给 agent 去上报
 * （那会把"Manager 侧地址观"塞进 Worker，relay 换机部署时两头都要改）。
 * Manager 侧的翻译在 `web/server.ts` 的 relay 快照 + `RemoteSpawner` 的 endpoint 翻译器里。
 *
 * ## 动态端口（实例端口）
 * 实例端口是 `findFreePort()` 运行期分配的 ⇒ 用 `PORT_ADD` / `PORT_DEL`（对应 ssh 的
 * `-O forward` / `-O cancel`），**不是**开局声明一整段（那样 relay 要为段内每个口开监听）。
 * 断链后由 `RelayClient` 自动重放（见 `client.ts#replayDynamicPorts`）—— 这是"注册恢复"那一层。
 *
 * @module dsh_ai1net/worker/relay-tunnel
 */

import { RelayClient, waitUpOnStatus, type RelayClientOptions, type WebSocketCtor } from '../net/relay/client.js'
import { RelayFailoverSupervisor } from '../net/relay/switcher.js'
import type { RelayChannelHandle, RelayFailoverThresholds } from '../net/relay/switcher.js'
import type { WorkerTunnel } from './tunnel.js'

export interface RelayTunnelOptions {
  /** relay 的 WebSocket 地址：`wss://<base-domain>/dsh_ai1net-relay`（生产）或 `ws://127.0.0.1:<relay-port>/dsh_ai1net-relay`（本机验）。 */
  url: string
  /** 本机在 `dsh_hosts.id` 里的标识（`<host-a>` / `<host-b>`）。 */
  hostId: string
  /** 与 relay 的预共享密钥（hex）。**缺失必须吵** —— 静默回退到别的传输比报错危险得多。 */
  secret: string
  /**
   * **本机节点身份**（覆盖网络）：私钥 PEM + 入网凭据。
   *
   * 缺省 ⇒ `HELLO` 不带身份字段（过渡期形态，relay 未强制时照旧可用）；
   * 给了 ⇒ relay 侧可按**受信签名者**独立验证"这台机器被授权进入这张网"，
   * 而不再只依赖那张放在控制面上的密钥表。
   */
  identity?: RelayClientOptions['identity']
  /** 启动即声明的端口（agent 自身；还可带控制面 PG 等）。 */
  staticPorts?: number[]
  /** 首连等待上限（ms）。默认 12s：跨云一次 RTT 也就几十 ms，等这么久只可能是真连不上。 */
  upTimeoutMs?: number
  log?: (line: string) => void
  webSocketCtor?: WebSocketCtor
  /**
   * **中继失败切流**（C2 装配点）。给了才启用；不给 ⇒ 行为与改造前**逐字一致**
   * （启动解析一次、此后钉死 —— 这正是改造前 E9 后半不成立的原因）。
   *
   * ⛔ **候选链只来自"同一份引导链"**（{@link listOverlayRelayCandidates}）⇒ 只可能是
   * **已签名目录 / 内置种子**里的地址，⛔ 不接受任意 url（否则就是任意重定向 = 真 R5）。
   * ⚠️ 它**不改会合面**：起始地址仍由 `DSH_AI1NET_RENDEZVOUS_URL` 决定（见 §3.2），
   * 这里只补上"起始那台不健康时换到链里的下一条"。
   */
  failover?: {
    candidates: () => Promise<readonly string[]>
    thresholds?: Partial<RelayFailoverThresholds>
  }
}

/** 内部：一条通道 + 它自己的 `RelayClient`。 */
type TunnelChannel = RelayChannelHandle & { client: RelayClient }

function healthOf(client: RelayClient): { state: string; attempts: number; unhealthyForMs: number } {
  const st = client.status()
  return { state: st.state, attempts: st.attempts, unhealthyForMs: st.unhealthyForMs }
}

/**
 * 候选链**只读观测**（覆盖网络）—— E3「**每连接候选数 ≥ 2**」的可机器断言面。
 *
 * ## 为什么需要它（立项依据）
 * §8.1-⑦ 登记的第 ④ 条 = 「**E3 未取得机器断言面**」：候选条数此前**只体现在日志文案里**
 * （`…（候选 3 条）`），脚本无法断言、只能靠人读日志；而"候选集退化成单点"正是本线反复吃亏的
 * 那类**静默失效** —— 上层看起来一切正常（连接照旧能建），只是**再也换不了址**。
 *
 * ## 它**不是**什么（三条边界，⛔ 改之前先读）
 * 1. **只读**：只统计**已经发生**的解析结果 ⇒ ⛔ 不参与选路 / ⛔ 不写冷却 / ⛔ 不改解析入参；
 * 2. **不新增暴露面**：只写一行日志 ＋ 一个进程内快照 ⇒ ⛔ 无监听口 / ⛔ 无 HTTP 路由 / ⛔ 无文件；
 * 3. **不制造网络 I/O**：周期重发只重发**上次快照**（⛔ 不重新解析 —— 观测面**不许**变成网络 I/O 源）。
 *
 * ## 判据锚点 = {@link CAND_OBS_PREFIX} 那一行的**固定 key 序**
 * `[overlay-candidates] scope=<s> resolves=<n> count=<n> hosts=<n> source=<s> detail=<s> urls=<u|u>`
 * - `count` = 候选**条数**（= E3 的**字面**判据 `count ≥ CAND_MIN`）；
 * - `hosts` = **主机名**个数（按 `URL#host` 去重）—— ⛔ **只作信息输出、不作判据**：
 *   🔴 **它不是"独立物理路径数"** —— 本观测**不解析 DNS**（零网络），而生产上前两条候选
 *   `wss://<base-domain>/dsh_ai1net-relay` 与 `wss://relay-direct.<base-domain>/dsh_ai1net-relay` **摘名不同、
 *   落在同一台 47**（`switcher.ts` 已实证）⇒ 真机读数 `count=3` 时 `hosts` 也报 **3**，
 *   而**机器级**独立路径只有 2（47 ＋ 106）。⇒ 这个数只用来**提示**"条数够不等于冗余够"，
 *   "冗余建成"必须由人按机器归属判（⛔ 别拿它当独立路径数用）；
 * - `resolves = 0` ＋ `source=unresolved` ⇒ **从未解析过** ⛔ 必须与"解析出 0 条"**可区分**
 *   （本线两处静默失效都是"分不清没装与没采到" ⇒ 判据必须能自证活性）。
 */
export const CAND_OBS_PREFIX = '[overlay-candidates]'

/**
 * 观测行重发周期（ms）。**`0` ⇒ 不周期重发**（只在实际解析时写一行）。
 *
 * 为什么要周期重发：`failover.candidates()` **只在需要换址时**才被调用（worker 侧可能数小时不调），
 * 而探针是**事后**读 ⇒ 没有周期重发就会读到一个"很久以前"的行、甚至**读不到行**
 * （判据就分不清"没装"与"装了但从不解析"）。
 */
export function candidateObsMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.RELAY_CAND_OBS_MS ?? '').trim()
  if (raw === '') return 300_000
  return /^\d+$/.test(raw) ? Number(raw) : 300_000
}

/**
 * 候选里的**主机名**个数（非法 URL 不计）。⛔ 丢 scheme ⇒ `wss://h/a` 与 `https://h/b` 算同一台。
 *
 * 🔴 **不解析 DNS**（观测器零网络）⇒ **摘名不同但同机的候选会被算成两个** ⇒
 * 本数**不是独立物理路径数**（真机实证：`<base-domain>` 与 `relay-direct.<base-domain>` 都在 47，
 * 但 `count=3` 时 `hosts` 也报 3）。
 */
function candHostsOf(urls: readonly string[]): number {
  const set = new Set<string>()
  for (const u of urls) {
    try {
      set.add(new URL(u).host.toLowerCase())
    } catch {
      /* 非法项不计（不影响 count —— count 取的是解析结果长度，⛔ 不在这里再做一次过滤） */
    }
  }
  return set.size
}

/** 一次解析的快照（只读返回，调用方改不动内部状态）。 */
export interface RelayCandidateSnapshot {
  scope: string
  /** 解析次数（只增；`0` = 从未解析过）。 */
  resolves: number
  /** 候选条数。 */
  count: number
  /** **主机名**个数（信息面；⛔ 不是独立物理路径数 —— 见 {@link candHostsOf}）。 */
  hosts: number
  urls: readonly string[]
  /** 来源档位（`env` / `cache` / `seed-directory` / `stale-cache` / `seed-fallback` / `none` / `unresolved`；worker 侧只看得到候选链 ⇒ `chain` / `startup`）。 */
  source: string
  detail: string
  atMs: number
  /** 从未解析过 ⇒ `true`。⛔ 必须与"解析出 0 条"（`count===0 && !unresolved`）可区分。 */
  unresolved: boolean
}

/** 候选链观测器（进程内单份；两个装配点各持一个自己的 `scope`）。 */
export class RelayCandidateObservation {
  private readonly scope: string
  private readonly log: (line: string) => void
  private readonly obsMs: number
  private resolves = 0
  private timer: unknown
  /** 上一次**写出去**的判据形状 —— 用来做"变化才写"（巡检可能每 2 s 解析一次）。 */
  private lastShape = ''
  private snap: RelayCandidateSnapshot

  constructor(scope: string, log: (line: string) => void, obsMs: number = candidateObsMs()) {
    this.scope = scope
    this.log = log
    this.obsMs = obsMs
    this.snap = {
      scope,
      resolves: 0,
      count: 0,
      hosts: 0,
      urls: [],
      source: 'unresolved',
      detail: '',
      atMs: 0,
      unresolved: true,
    }
  }

  /** 记账一次**真实**解析（由装配点在解析成功之后调用；⛔ 失败路径不记账 —— 那会让 `count` 说谎）。 */
  record(urls: readonly string[], source: string, detail: string): RelayCandidateSnapshot {
    this.resolves += 1
    this.snap = {
      scope: this.scope,
      resolves: this.resolves,
      count: urls.length,
      hosts: candHostsOf(urls),
      urls: [...urls],
      source: source === '' ? 'chain' : source,
      detail,
      atMs: Date.now(),
      unresolved: false,
    }
    /** ⚠️ **变化才写**：`RELAY_FAILOVER_CHECK_MS` 是 2 s，稳态下同一形状会被反复解析 ⇒ 不设这道门就是刷屏。 */
    const shape = `${this.snap.count}|${this.snap.hosts}|${this.snap.source}|${this.snap.urls.join(',')}`
    if (shape !== this.lastShape) {
      this.lastShape = shape
      this.log(this.line())
    }
    return this.snapshot()
  }

  snapshot(): RelayCandidateSnapshot {
    return { ...this.snap, urls: [...this.snap.urls] }
  }

  /**
   * 启动**周期重发**（幂等）。🔴 只重发上次快照 ⇒ ⛔ 零网络 I/O。
   * `unref()`：观测是**后台**活动，⛔ 不许因为它把进程钉在事件循环上（本仓既有纪律）。
   */
  start(): void {
    if (this.timer !== undefined || this.obsMs <= 0) return
    const h = setInterval(() => this.log(this.line()), this.obsMs)
    ;(h as { unref?: () => void }).unref?.()
    this.timer = h
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer as ReturnType<typeof setInterval>)
    this.timer = undefined
  }

  /** 固定 key 序的观测行；值里的空白一律换成 `_` ⇒ **每行都可被 `key=value` 直接切分**。 */
  private line(): string {
    const s = this.snap
    const safe = (v: string): string => {
      const t = String(v).replace(/\s+/g, '_')
      return t === '' ? '-' : t
    }
    return (
      `${CAND_OBS_PREFIX} scope=${safe(this.scope)} resolves=${s.resolves} count=${s.count}` +
      ` hosts=${s.hosts} source=${safe(s.source)} detail=${safe(s.detail)}` +
      ` urls=${s.urls.length === 0 ? '-' : s.urls.map(safe).join('|')}`
    )
  }
}

export class RelayTunnel implements WorkerTunnel {
  private readonly opts: RelayTunnelOptions
  private readonly forwarded = new Set<number>()
  private readonly log: (line: string) => void
  private readonly failover: RelayFailoverSupervisor | undefined
  /** 起始通道（监管器不在场时它就是唯一通道）。 */
  private readonly initialChannel: TunnelChannel
  /** 候选链只读观测（`failover` 没配 ⇒ `undefined` ⇒ 不产任何观测行）。 */
  private readonly candidateObs: RelayCandidateObservation | undefined
  /** 启动观测只做一次（自愈会重复调 `ensureMaster()`，重复解析无意义）。 */
  private observedOnce = false

  constructor(options: RelayTunnelOptions) {
    this.opts = options
    this.log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
    this.initialChannel = this.channelFor(this.buildClient(options.url), options.url)
    const fc = options.failover
    if (fc === undefined) {
      this.failover = undefined
      this.candidateObs = undefined
      return
    }
    /**
     * 候选链观测（E3 的可断言面）。**包在解析器外面** ⇒ 解析结果原样透传给监管器，
     * ⛔ 不改条数 / ⛔ 不改顺序 / ⛔ 不改失败语义（抛错照旧抛给监管器，观测只在成功时记账）。
     *
     * ⚠️ `scope` 固定写 `worker`：本类在生产上**唯一**的装配点是 worker agent（C2），
     * 而 Manager 侧（C1）的观测在 `src/web/server.ts` 里自带 `scope=manager`。
     */
    const obs = new RelayCandidateObservation('worker', this.log)
    obs.start()
    this.candidateObs = obs
    const sup = new RelayFailoverSupervisor({
      /**
       * **先建新、成功再关旧**：新客户端必须先真的到 `up`，本函数才返回句柄；
       * 到不了 ⇒ 返回 `undefined` ⇒ 监管器**保持原通道**（D4）。
       * 新客户端**一次就把已声明的端口全带上**（`staticPorts` + 运行期 `forwarded`），
       * 否则切换完成后"实例面端口没了"—— 那是比不切更糟的结果。
       */
      open: async (url) => {
        const next = this.buildClient(url)
        next.start()
        const ok = await this.waitUpOn(next, this.opts.upTimeoutMs ?? 12_000)
        if (!ok) {
          next.stop()
          return undefined
        }
        return this.channelFor(next, url)
      },
      candidates: async () => {
        const urls = await fc.candidates()
        obs.record(urls, 'chain', '')
        return urls
      },
      log: this.log,
      thresholds: fc.thresholds,
    })
    sup.seed(this.initialChannel)
    sup.start()
    this.failover = sup
  }

  /** 当前通道（监管器在场时以它为准 —— "当前是谁"只有**一个**权威来源）。 */
  private get channel(): TunnelChannel {
    return (this.failover?.channel as TunnelChannel | undefined) ?? this.initialChannel
  }

  private channelFor(client: RelayClient, url: string): TunnelChannel {
    return {
      url,
      client,
      health: () => healthOf(client),
      close: () => client.stop(),
    }
  }

  private buildClient(url: string): RelayClient {
    return new RelayClient({
      url,
      hostId: this.opts.hostId,
      secret: this.opts.secret,
      ports: [...new Set([...(this.opts.staticPorts ?? []), ...this.forwarded])].sort((a, b) => a - b),
      identity: this.opts.identity,
      log: this.log,
      webSocketCtor: this.opts.webSocketCtor,
    })
  }

  private get client(): RelayClient {
    return this.channel.client
  }

  /** 当前"已声明给 relay"的端口（静态 + 运行期），诊断用。 */
  get ports(): number[] {
    return [...new Set([...(this.opts.staticPorts ?? []), ...this.forwarded])].sort((a, b) => a - b)
  }

  /** **幂等**：已启动就只等它到 `up`（断链后 agent 的自愈走的正是这条路径）。 */
  async ensureMaster(): Promise<void> {
    this.client.start()
    /**
     * **非阻塞**采一次候选链观测（E3 的可断言面）。
     *
     * 🔴 ⛔ **不许 `await`** —— P0-2 的硬前提是"**启动不依赖网络**"（控制面自己也是客户端，
     * 启动那一刻自己的门户还没 `listen`）⇒ 观测只许**搭车**，⛔ 不许把网络 I/O 塞进启动关键路径。
     * ⚠️ 为什么在这里补这一枪：`failover.candidates()` 平时**只在需要换址时**才被调用
     * （实测 47 的 worker 自 22:50 起 `[overlay-dir]` **0 行**）⇒ 光靠监管器的话，进程可能
     * 很久都不解析一次，探针就会读到"从没解析过"。本枪保证**每次启动**必有一条观测行。
     */
    if (!this.observedOnce) {
      this.observedOnce = true
      void this.observeCandidatesOnce()
    }
    await this.waitUp(this.opts.upTimeoutMs ?? 12_000)
  }

  /** 一次性观测。⛔ 失败**只吞掉** —— 观测面不许变成故障源。 */
  private async observeCandidatesOnce(): Promise<void> {
    const obs = this.candidateObs
    const fc = this.opts.failover
    if (obs === undefined || fc === undefined) return
    try {
      obs.record(await fc.candidates(), 'startup', '')
    } catch {
      /* 观测失败不影响任何通道行为 */
    }
  }

  async isMasterAlive(): Promise<boolean> {
    return this.client.status().state === 'up'
  }

  /** 加一个转发（实例起来时）。失败**不抛**：实例在本机照样可用，只是跨机代理这一跳不可用。 */
  async forward(port: number): Promise<boolean> {
    if (this.forwarded.has(port)) return true
    const ok = await this.client.addPort(port)
    if (ok) this.forwarded.add(port)
    return ok
  }

  /** 撤销一条转发（实例停止时）。 */
  async cancel(port: number): Promise<void> {
    if (!this.forwarded.has(port)) return
    if (await this.client.removePort(port)) this.forwarded.delete(port)
  }

  async close(): Promise<void> {
    this.failover?.stop()
    this.candidateObs?.stop()
    this.client.stop()
    this.forwarded.clear()
  }

  /**
   * 换址时用的**非抛版**等待：`open()` 要的是"能不能起来"这个布尔，
   * 而不是异常 —— 起不来就返回 `false`，由监管器决定"保持原通道"（D4）。
   *
   * 🔴 **RC-1（C2 装配点）**：实现已抽到 {@link waitUpOnStatus}（三个装配点共用一份，D7）；
   * 相对改造前的唯一差别 = **终态失败（死候选）立即 `false`**，⛔ 不再白等满 `upTimeoutMs`。
   */
  private async waitUpOn(client: RelayClient, timeoutMs: number): Promise<boolean> {
    return waitUpOnStatus(client, timeoutMs, {
      onDead: (st) =>
        this.log(
          `[relay-failover] ⛔ 新通道终态失败（state=${st.state} attempts=${st.attempts} ` +
            `burst=${st.inGracefulBurstWindow} lastError="${st.lastError ?? ''}"）⇒ 提前放弃，不等满 ${timeoutMs}ms`,
        ),
    })
  }

  /** 轮询等 `up`（`RelayClient` 没有 up 事件；重连由它自己退避驱动，这里只负责等）。 */
  private async waitUp(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.client.status().state === 'up') return
      if (Date.now() >= deadline) {
        const st = this.client.status()
        throw new Error(`relay 未在 ${timeoutMs}ms 内就绪（state=${st.state} lastError=${st.lastError ?? '-'}）`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/**
 * 这个会合地址是不是"走 relay"（覆盖网络 R4）。
 *
 * 判据只看 scheme：`ws://` / `wss://` = relay；`ssh://` / 裸 `user@host:port` = 旧隧道。
 * 于是一个环境变量就能在两种传输之间来回切（**删掉 relay 那行即回滚**，不需要回滚代码）。
 */
export function isRelayUrl(raw: string): boolean {
  return /^wss?:\/\//i.test(raw.trim())
}
