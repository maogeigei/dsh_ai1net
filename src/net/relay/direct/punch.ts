/**
 * 覆盖网络 **UDP 打洞探测**（序㊵ · P2 · S5）。
 *
 * ## 它做什么（照抄成熟做法的最小集，⛔ 不发明）
 * ① 本机绑一个 **UDP 口**（端口从**参数表区间**取：`PUNCH_PORT_BASE` ＋ `PUNCH_PORT_SPAN`）；
 * ② **双方同时**向对方候选地址发包（间隔 {@link PUNCH_PROBE_INTERVAL_MS}，持续到 deadline）；
 * ③ `PUNCH_DEADLINE_MS` 内**收到对方的包** ⇒ 该方向成立；
 * ④ 🔴 **双向都成立**才判直连可用；否则 ⇒ **判死**（`one-way` / `deadline`）；
 * ⑤ 判死后：**立即降级中继** ＋ 该候选进**冷却**（复用本线既有冷却纪律，⛔ 不自造一套）。
 *
 * ## 🔴 三条纪律
 * | # | 纪律 | 为什么 |
 * |---|---|---|
 * | ① | 只用 Node 内建 `dgram`，⛔ **不引入新依赖** | 本仓既有口径：`addr-override.ts` 头注「本项目**不引入 `undici` / `ws`**」 |
 * | ② | ⛔ **用户态**、⛔ 无内核驱动、⛔ 无虚拟网卡 | 参数表 §8-① 已把"虚拟网卡"收窄为**不做**；要打洞也只走用户态 UDP |
 * | ③ | 冷却**必须非零**（`ms <= 0` ⇒ 构造即抛） | `COOLDOWN=0` ⇒ "判死"退化成**重试风暴**；本线已把 `RELAY_FAILOVER_COOLDOWN_MS=0` 写成硬禁令 |
 *
 * ## 🧪 离线夹具（文件末段 · ⛔ 不进生产接线路径）
 * 打洞的**成功路径**需要"两台机器 + 两个会做 NAT 映射的网络"。云上那条真机腿被**云安全组**挡着
 * （见 `设计说明` §2-3），⇒ 本模块自带一个
 * **NAT 模拟器**（{@link SimulatedNat} ＋ {@link runPunchPair}）：它用**真的 `dgram` socket**
 * 跑**同一份打洞代码**，只是把"两跳 NAT"用回环上的四个 socket ＋ 两份映射表来表现。
 * ⇒ 机器断言证明的是"**这段打洞逻辑**在 NAT 穿透场景下成立"，⛔ **不是**"公网一定能打洞"。
 *
 * @module dsh_ai1net/net/relay/direct/punch
 */

import { createSocket, type Socket } from 'node:dgram'

import { isIpv6, type DirectAddress } from './candidate.js'

/** 打洞 socket 的**端口基址**（沿用序⑥ S4 观察器用过的 21100 段 ⇒ ⛔ 不新造魔数）。 */
export const PUNCH_PORT_BASE = 21100

/** 打洞端口区间跨度 ⇒ `[21100, 21116)`。⚠️ **UDP** 口，与 `LISTEN_ALLOWED_RANGES`（TCP）**不同族**。 */
export const PUNCH_PORT_SPAN = 16

/** 单次探测的**重发间隔**（双方同时发包，直到 deadline）。 */
export const PUNCH_PROBE_INTERVAL_MS = 150

/** 收包窗口缺省值（真值在参数表 `PUNCH_DEADLINE_MS`）。 */
export const DEFAULT_PUNCH_DEADLINE_MS = 3_000

/** 判死后的冷却缺省值（真值在参数表 `DIRECT_COOLDOWN_MS`）。🔴 **必须非零**。 */
export const DEFAULT_DIRECT_COOLDOWN_MS = 300_000

/** 探测结论（**具名**，⛔ 不收自由文本）。 */
export type PunchReason =
  /** 双向都成立 ⇒ 直连可用。 */
  | 'ok'
  /** 一个方向成立、另一个不成立 ⇒ **判死**（⛔ 单向不算直连）。 */
  | 'one-way'
  /** 窗内一个包都没收到 ⇒ **判死**。 */
  | 'deadline'
  /** 该对端在冷却里 ⇒ 本次**连 socket 都不开**。 */
  | 'cooldown'
  /** 没有可用候选地址（⛔ 不是"打洞失败"⇒ ⛔ 不进冷却）。 */
  | 'no-address'
  /** 绑定失败（具名带上原始错误）。 */
  | 'socket-error'

/** 一次探测的完整读数（**成功与失败都出这一份** ⇒ 观测面不用猜）。 */
export interface PunchAttempt {
  /** 对端逻辑名（`<network>/<hostId>`，冷却按它做键）。 */
  peer: string
  ok: boolean
  reason: PunchReason
  /** 本机收到的包数（**本方向**是否成立）。 */
  recvLocal: number
  /** 对端是否收到我们的包（真机经 relay 通道回报；离线夹具由 NAT 模拟给出）。 */
  peerSeen: boolean
  /** 🔴 双向都成立（`recvLocal > 0 && peerSeen`）—— **只有它为真才算直连可用**。 */
  bidirectional: boolean
  sent: number
  elapsedMs: number
  at: number
  /** 回包来源（`ip:port`，升序）—— **"谁回的"必须看得见**（真机腿靠它区分"对端回的"与"别的什么东西回的"）。 */
  sources: string[]
  /** 失败时的人读原因（⛔ 不许只回 `false`）。 */
  detail: string
}

/**
 * 候选地址的**冷却表**（判死后才写入）。
 *
 * 🔴 `ms` **必须 > 0**：`0` 会让"判死"退化成"每次重试都真打一遍" = 重试风暴
 * （本线把 `RELAY_FAILOVER_COOLDOWN_MS=0` 列为硬禁令，同一条纪律在这里落地为**构造期断言**）。
 */
export class DirectCooldown {
  readonly ms: number
  private until = new Map<string, number>()
  private blockedCount = 0

  constructor(ms: number = DEFAULT_DIRECT_COOLDOWN_MS) {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(
        `直连冷却时长必须 > 0，收到 ${JSON.stringify(ms)}（🔴 0 ⇒ 判死退化成重试风暴，本线硬禁令）`,
      )
    }
    this.ms = Math.floor(ms)
  }

  /** 该对端是否还在冷却里（**命中即计数** —— 观测面上要看得见"被挡了几次"）。 */
  blocked(peer: string, now: number = Date.now()): boolean {
    const until = this.until.get(peer)
    if (until === undefined) return false
    if (until <= now) {
      this.until.delete(peer)
      return false
    }
    this.blockedCount += 1
    return true
  }

  /** 记一次判死 ⇒ 进入冷却。 */
  noteDead(peer: string, now: number = Date.now()): void {
    this.until.set(peer, now + this.ms)
  }

  /** 成功 ⇒ 撤销冷却（**只有成功才撤**，⛔ 别拿"尝试过"当成功）。 */
  clear(peer: string): void {
    this.until.delete(peer)
  }

  snapshot(now: number = Date.now()): { ms: number; blocked: number; cooling: string[] } {
    const cooling: string[] = []
    for (const [peer, until] of this.until) if (until > now) cooling.push(peer)
    return { ms: this.ms, blocked: this.blockedCount, cooling: cooling.sort() }
  }
}

/** 一个**已绑定的** UDP 探测口（收发包 ＋ 计数）。⛔ 只做收发，判定在上层。 */
export class PunchSocket {
  private sock?: Socket
  private packets = 0
  private readonly senders = new Set<string>()
  private lastError = ''

  /** 已成功绑定的端口（`0` = 尚未绑定）。 */
  port = 0

  constructor(private readonly host = '0.0.0.0') {}

  /** 绑定（`port = 0` ⇒ 由内核分配；真机路径给参数表区间里的口）。 */
  open(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const family = isIpv6(this.host) ? 'udp6' : 'udp4'
      const sock = createSocket({ type: family, reuseAddr: false })
      const fail = (err: Error): void => {
        this.lastError = err.message
        try {
          sock.close()
        } catch {
          // 已经关掉了 ⇒ 无事可做（⛔ 但**不吞**：原始错误在 `lastError` 里）
        }
        reject(err)
      }
      sock.once('error', fail)
      sock.on('message', (_msg, rinfo) => {
        this.packets += 1
        this.senders.add(`${rinfo.address}:${rinfo.port}`)
      })
      sock.bind({ port, address: this.host }, () => {
        sock.off('error', fail)
        // 绑定之后的错误（如 ICMP 端口不可达）只记账，⛔ 不让它把进程炸掉
        sock.on('error', (err) => {
          this.lastError = err.message
        })
        const addr = sock.address()
        this.port = typeof addr === 'object' && addr !== null ? addr.port : 0
        this.sock = sock
        resolve()
      })
    })
  }

  /** 向若干候选地址各发一包。返回**实际发出**的包数。 */
  send(targets: readonly DirectAddress[], payload = 'dsh_ai1net-punch'): number {
    const sock = this.sock
    if (sock === undefined) return 0
    let sent = 0
    for (const t of targets) {
      try {
        sock.send(Buffer.from(payload, 'utf8'), t.port, t.host)
        sent += 1
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return sent
  }

  /** 本机收到的包数（截至此刻）。 */
  received(): number {
    return this.packets
  }

  /** 收到过包的对端来源（`ip:port`，升序）。 */
  sources(): string[] {
    return [...this.senders].sort()
  }

  errorText(): string {
    return this.lastError
  }

  close(): void {
    const sock = this.sock
    this.sock = undefined
    if (sock === undefined) return
    try {
      sock.close()
    } catch {
      // 关两次 ⇒ 忽略；本类是**唯一**关闭点，正常路径不会走到这
    }
  }
}

/** 探测入参。⛔ 所有阈值**都是显式传入的**（真值在参数表，模块里只有缺省）。 */
export interface PunchOptions {
  /** 对端逻辑名（冷却键）。 */
  peer: string
  /** 本机要绑的 UDP 口（来自 {@link pickPunchPort}；`0` = 内核分配，夹具用）。 */
  selfPort: number
  /** 对端候选地址（**打洞的目标**）。 */
  targets: readonly DirectAddress[]
  deadlineMs?: number
  probeIntervalMs?: number
  /** 冷却表（**必传** —— 冷却纪律是判死的一部分，⛔ 不许可选）。 */
  cooldown: DirectCooldown
  /**
   * 对端是否收到我们的包（真机 = 经 relay 通道回报；离线夹具 = NAT 模拟器给出）。
   * ⛔ 缺省 = `() => false`（= 只看见自己的方向 ⇒ 判 `one-way`）。**刻意不给"乐观缺省"**：
   * 拿不到对端证据时**判不上直连**，而不是"先当成功"。
   */
  peerSeen?: () => boolean
  /** 本机绑定地址（缺省 `0.0.0.0`；离线夹具用 `127.0.0.1`）。 */
  bindHost?: string
  now?: number
  /** 观测钩子：每绑一次 UDP socket 调一次（探针的"关闭 ⇒ 零 socket"靠它计数）。 */
  onSocketOpen?: () => void
  /** 测试钩子：拿到刚绑好的 socket（离线夹具用它读**对端**的实时收包数）。 */
  onSocket?: (sock: PunchSocket) => void
}

/**
 * 跑一次打洞探测（**唯一执行点**）。
 *
 * 顺序：冷却闸门 → 候选闸门 → 绑口 → 重发到 deadline（**每轮都重判双向**）→ 判定 → 判死／撤冷却
 * → **必定关口**。⛔ 提前返回的两条路径（冷却 / 无候选）**一个 socket 都不开**。
 */
export async function runPunchAttempt(
  opts: PunchOptions,
  io: { sleep: (ms: number) => Promise<void> },
): Promise<PunchAttempt> {
  const now = opts.now ?? Date.now()
  const deadlineMs = opts.deadlineMs ?? DEFAULT_PUNCH_DEADLINE_MS
  const interval = opts.probeIntervalMs ?? PUNCH_PROBE_INTERVAL_MS
  const base: Omit<PunchAttempt, 'ok' | 'reason' | 'detail'> = {
    peer: opts.peer,
    recvLocal: 0,
    peerSeen: false,
    bidirectional: false,
    sent: 0,
    elapsedMs: 0,
    at: now,
    sources: [],
  }

  // ① 冷却闸门（⛔ 连 socket 都不开）
  if (opts.cooldown.blocked(opts.peer, now)) {
    return { ...base, ok: false, reason: 'cooldown', detail: `在冷却中（${opts.cooldown.ms} ms）⇒ 本次不打，沿用中继` }
  }
  // ② 候选闸门（⛔ 不是"打洞失败" ⇒ 不进冷却）
  if (opts.targets.length === 0) {
    return { ...base, ok: false, reason: 'no-address', detail: '没有可用候选地址 ⇒ 不打洞（⛔ 不进冷却）' }
  }

  const sock = new PunchSocket(opts.bindHost ?? '0.0.0.0')
  const started = Date.now()
  try {
    await sock.open(opts.selfPort)
    opts.onSocketOpen?.()
    opts.onSocket?.(sock)
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: 'socket-error',
      detail: `绑定 UDP ${opts.selfPort} 失败：${err instanceof Error ? err.message : String(err)}`,
      elapsedMs: Date.now() - started,
    }
  }

  const peerSeenOf = opts.peerSeen ?? ((): boolean => false)
  try {
    // ③ 双方同时发包：按 interval 重发，每轮**重判双向**（任一方向一旦成立就可以停了）
    let sent = 0
    const deadlineAt = started + deadlineMs
    let recvLocal = 0
    let peerSeen = false
    for (;;) {
      sent += sock.send(opts.targets)
      recvLocal = sock.received()
      peerSeen = peerSeenOf()
      if (recvLocal > 0 && peerSeen) break
      const remain = deadlineAt - Date.now()
      if (remain <= 0) break
      await io.sleep(Math.min(interval, remain))
    }
    recvLocal = sock.received()
    peerSeen = peerSeenOf()
    const bidirectional = recvLocal > 0 && peerSeen
    const elapsedMs = Date.now() - started
    if (bidirectional) {
      opts.cooldown.clear(opts.peer)
      return {
        ...base,
        ok: true,
        reason: 'ok',
        recvLocal,
        peerSeen,
        bidirectional: true,
        sent,
        elapsedMs,
        sources: sock.sources(),
        detail: `直连成立：本方向收 ${recvLocal} 包 ＋ 对端确认收到 ⇒ 双向 ✅（耗时 ${elapsedMs} ms，发 ${sent} 包）`,
      }
    }
    const reason: PunchReason = recvLocal === 0 && !peerSeen ? 'deadline' : 'one-way'
    opts.cooldown.noteDead(opts.peer, started)
    return {
      ...base,
      ok: false,
      reason,
      recvLocal,
      peerSeen,
      bidirectional: false,
      sent,
      elapsedMs,
      sources: sock.sources(),
      detail:
        reason === 'one-way'
          ? `单向（本方向收 ${recvLocal} 包 / 对端确认=${peerSeen}）⇒ 判死 ＋ 进冷却 ${opts.cooldown.ms} ms`
          : `窗内零收包（deadline ${deadlineMs} ms，实耗 ${elapsedMs} ms，发 ${sent} 包）⇒ 判死 ＋ 进冷却 ${opts.cooldown.ms} ms`,
    }
  } finally {
    sock.close()
  }
}

/**
 * 从参数表区间里挑一个口（**取模上扫**；真机路径用它给 `selfPort`）。
 *
 * ⛔ 不写死单个端口：两台 worker 可能各自打洞，踩同一口会互相干扰；
 * 区间由 `PUNCH_PORT_BASE` / `PUNCH_PORT_SPAN` 给出。
 */
export function pickPunchPort(base: number = PUNCH_PORT_BASE, span: number = PUNCH_PORT_SPAN, offset = 0): number {
  const n = Math.max(1, Math.floor(span))
  return base + (Math.abs(Math.floor(offset)) % n)
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * 🧪 离线夹具（⛔ **不进生产接线路径**）
 *
 * 打洞的**成功路径**在云上被安全组挡着，所以这一段的用途只有一个：
 * **用真的 `dgram` socket 跑同一份打洞代码**，把"两跳 NAT ＋ 双方同时发包 ⇒ 打穿"这件事
 * 变成机器可断言的读数。⛔ 它**不改**打洞逻辑（`runPunchAttempt` 一字未动），只替换"网络长什么样"。
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** NAT 模拟器的形态开关（每个开关对应一条真实的失败模式）。 */
export interface SimulatedNatOptions {
  /**
   * `true` ⇒ 即使有映射也**丢弃入向包**（模拟"对称 NAT / 单向不可达" ⇒ 只能出、不能进）。
   * 用于产出 `one-way` 这条负腿。
   */
  dropInbound?: boolean
}

/** NAT 模拟器的计数（观测面用 —— ⛔ 只读）。 */
export interface SimNatCounters {
  fromNode: number
  fromPeer: number
  forwardedIn: number
  droppedNoMapping: number
  droppedByPolicy: number
}

/**
 * 一台**模拟 NAT**（= 两个回环 UDP socket ＋ 一份"出过向才放行入向"的映射表）。
 *
 * 语义（真 NAT 的**最小充分**语义）：
 * - 节点把包发给 {@link gateway}（内侧门牌 = `innerSocket` 的口）；
 * - NAT 见**内侧来的包** ⇒ 记映射（{@link isMapped} 变真）＋ 从 `outerSocket`（外侧门牌）转给对端 NAT；
 * - NAT 收**对端 NAT 来的包** ⇒ **只有已建映射才**从内侧门牌交回节点（无映射 ⇒ **丢**，并计数）。
 *
 * 🔴 `dropInbound` 只影响第三条（= 单向不可达）。
 */
export class SimulatedNat {
  private innerSock?: Socket
  private outerSock?: Socket
  private nodePort = 0
  private mapped = false
  private readonly dropInbound: boolean

  readonly counters: SimNatCounters = {
    fromNode: 0,
    fromPeer: 0,
    forwardedIn: 0,
    droppedNoMapping: 0,
    droppedByPolicy: 0,
  }

  /** 对端 NAT 的**外侧门牌**（两侧都建好之后回填；真网里靠候选交换得到）。 */
  peerAddress?: DirectAddress

  constructor(opts: SimulatedNatOptions = {}) {
    this.dropInbound = opts.dropInbound === true
  }

  /** 绑定两个门牌并开始转发（返回后 {@link gateway} / {@link natAddress} 才是真值）。 */
  async open(): Promise<void> {
    this.outerSock = await this.bind()
    this.innerSock = await this.bind()
    this.outerSock.on('message', (msg, rinfo) => this.onOuter(msg, rinfo))
    this.innerSock.on('message', (msg, rinfo) => this.onInner(msg, rinfo))
  }

  private bind(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const sock = createSocket({ type: 'udp4', reuseAddr: false })
      sock.once('error', reject)
      sock.bind({ port: 0, address: '127.0.0.1' }, () => {
        sock.off('error', reject)
        sock.on('error', () => {
          // 发送目标已关 ⇒ 夹具里的正常竞态，忽略
        })
        resolve(sock)
      })
    })
  }

  private portOf(sock: Socket): number {
    const addr = sock.address()
    return typeof addr === 'object' && addr !== null ? addr.port : 0
  }

  /** 内侧来的包（= 节点要出去）⇒ 建映射 ＋ 转给对端 NAT。 */
  private onInner(msg: Buffer, rinfo: { address: string; port: number }): void {
    this.counters.fromNode += 1
    this.nodePort = rinfo.port
    this.mapped = true
    const peer = this.peerAddress
    if (peer === undefined || this.outerSock === undefined) return
    try {
      this.outerSock.send(msg, peer.port, peer.host)
    } catch {
      // 对端已关 ⇒ 忽略
    }
  }

  /** 外侧来的包（= 对端打过来的）⇒ 只有已建映射才放行入向。 */
  private onOuter(msg: Buffer, rinfo: { address: string; port: number }): void {
    const peer = this.peerAddress
    if (peer === undefined || rinfo.port !== peer.port) return
    this.counters.fromPeer += 1
    if (!this.mapped) {
      this.counters.droppedNoMapping += 1
      return
    }
    if (this.dropInbound) {
      this.counters.droppedByPolicy += 1
      return
    }
    if (this.nodePort === 0 || this.innerSock === undefined) return
    try {
      this.innerSock.send(msg, this.nodePort, '127.0.0.1')
      this.counters.forwardedIn += 1
    } catch {
      // 节点已关 ⇒ 忽略
    }
  }

  /** 节点侧要发往的地址（**内侧门牌** = 我的网关）。 */
  get gateway(): DirectAddress {
    return { host: '127.0.0.1', port: this.innerSock === undefined ? 0 : this.portOf(this.innerSock) }
  }

  /** 对外门牌（= **对端要打的目标**，也是本机"公网地址"的替身）。 */
  get natAddress(): DirectAddress {
    return { host: '127.0.0.1', port: this.outerSock === undefined ? 0 : this.portOf(this.outerSock) }
  }

  get isMapped(): boolean {
    return this.mapped
  }

  close(): void {
    for (const sock of [this.innerSock, this.outerSock]) {
      try {
        sock?.close()
      } catch {
        // 已关 ⇒ 忽略
      }
    }
    this.innerSock = undefined
    this.outerSock = undefined
  }
}

/** 一对打洞的读数（`bidirectional` = **两侧都成立** ⇒ 直连可用）。 */
export interface PunchPairResult {
  a: PunchAttempt
  b: PunchAttempt
  bidirectional: boolean
  nat: { a: SimNatCounters; b: SimNatCounters }
}

/**
 * 跑一对打洞探测（**两侧并发**，各自走真实 {@link runPunchAttempt}）。
 *
 * - `aNat` / `bNat` 的 `dropInbound` 决定这是"能打穿"还是"单向不可达"；
 * - 节点把包发给**自己的 NAT 网关**，目标是**对端 NAT 的外侧门牌**（= 真网里的"打公网门牌"）；
 * - `peerSeen` = **对端 socket 的实时收包数 > 0**（= "对端确认收到了我的包"这一事实的进程内等价物）。
 */
export async function runPunchPair(
  pair: {
    aPeer: string
    bPeer: string
    deadlineMs?: number
    cooldown?: number
    /** 让哪一侧"只能出不能进"（`'a'` / `'b'` / `'both'` / `'none'`；缺省 `'none'`）。 */
    oneWay?: 'a' | 'b' | 'both' | 'none'
  },
  io: { sleep: (ms: number) => Promise<void> },
): Promise<PunchPairResult> {
  const oneWay = pair.oneWay ?? 'none'
  const natA = new SimulatedNat({ dropInbound: oneWay === 'a' || oneWay === 'both' })
  const natB = new SimulatedNat({ dropInbound: oneWay === 'b' || oneWay === 'both' })
  await natA.open()
  await natB.open()
  natA.peerAddress = natB.natAddress
  natB.peerAddress = natA.natAddress

  const cooldownMs = pair.cooldown ?? DEFAULT_DIRECT_COOLDOWN_MS
  const cdA = new DirectCooldown(cooldownMs)
  const cdB = new DirectCooldown(cooldownMs)
  const handles: { a?: PunchSocket; b?: PunchSocket } = {}

  const mk = (
    peer: string,
    own: SimulatedNat,
    other: 'a' | 'b',
    self: 'a' | 'b',
    cd: DirectCooldown,
  ): Promise<PunchAttempt> =>
    runPunchAttempt(
      {
        peer,
        selfPort: 0,
        // ⚠️ 目标 = **本机自己的 NAT 网关**（= 真网里"经我这条 NAT 把包发到对端公网门牌"）
        //    夹具里 NAT 知道对端是谁（`peerAddress`），所以目标写成网关即可；
        //    ⛔ 不能直接写对端 NAT 的口 —— 那样**绕过自己的 NAT** ⇒ 映射建不起来（第一版就这么错）
        targets: [own.gateway],
        deadlineMs: pair.deadlineMs,
        cooldown: cd,
        bindHost: '127.0.0.1',
        peerSeen: () => (handles[other]?.received() ?? 0) > 0,
        onSocket: (s) => {
          handles[self] = s
        },
      },
      io,
    )

  const [a, b] = await Promise.all([mk(pair.aPeer, natA, 'b', 'a', cdA), mk(pair.bPeer, natB, 'a', 'b', cdB)])
  const out: PunchPairResult = {
    a,
    b,
    bidirectional: a.bidirectional && b.bidirectional,
    nat: { a: natA.counters, b: natB.counters },
  }
  natA.close()
  natB.close()
  return out
}
