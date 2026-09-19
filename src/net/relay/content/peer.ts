/**
 * 同网段 peer 发现与取块 —— **分组隔离的 peer 视图**（覆盖网络线 内容分发）。
 *
 * ## 一句话说清它是什么
 * 维护一张"**谁在哪个组、持有哪些块**"的表，并回答两个问题：
 * - `candidates(id)` —— **同组**里谁有这块（⇒ 可以找它取）；
 * - `markDenied(name, id)` —— 这次请求**跨组**吗（⇒ 是就**显式拒绝并计数**）。
 *
 * ## 为什么必须"分组"（E5）
 * Delivery Optimization 的 group mode 对应物：**按（用户/团队网, 局域网）分组**共享。
 * ⛔ 不分组 = 一张巨网里"谁的块都能拿" ⇒ 一旦某台设备被控，它能**下毒到别的租户**
 * 而内容哈希只能保证"块没被改"，**保证不了"它本来就该拿到这块"**（可见性 ≠ 完整性）。
 * ⇒ 分组是本项目「权限只准收窄」这条硬性约束的落点。
 *
 * ## 三条纪律
 * 1. **跨组必须显式拒绝 + 计数**：返回空数组**不算拒绝**（调用方分不清"没有"与"不许"）
 *    ⇒ 本线反复踩的假绿正是这一类"静默返空"。
 * 2. **组键由 (network, group) 唯一决定**，⛔ 不许只看其一 —— 同名不同网 ⇒ 必须不同组。
 * 3. **peer 宣布的持有关系是被动信息**：`addPeer` 只登记"它说自己有"，
 *    ⛔ 与 `store.get` 的**读侧校验**是两回事（后者才是 E4 的真闸门）。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - 不做传输（取块走 `source.ts` 注入的 fetcher，底层复用既有 wss 通道，见设计文档 §7）；
 * - 不做广播 / mDNS（本阶段"发现"由 relay 的在册会话表喂进来；⛔ 不新开公网口＝R5）；
 * - 不做房间层（不在本项目范围）。
 *
 * @module dsh_ai1net/net/relay/content/peer
 */

/** 一个 peer 的声明（"我在这张网的这个组里，我有这些块"）。 */
export interface PeerDeclaration {
  /** 逻辑名（`<network>/<hostId>`，与 relay 侧同名口径）。 */
  name: string
  /** 该 peer 所属网（`ops` / `u:<id>`）。 */
  network: string
  /** 该 peer 所属**组**（局域网 / 团队维度）。 */
  group: string
  /** 它声明持有的块 id。 */
  holds: readonly string[]
  /**
   * 🆕 单 B：该 peer 的**组密钥 epoch**。
   * ⚠️ 与本节点不一致 ⇒ **不作为候选**（它的块 id 是另一代口径 ⇒ 取回来也拼不上）。
   */
  epoch?: number
}

/** peer 层的**可断言**判别器（OBS 会断言这些键都存在且是数字）。 */
export const PEER_COUNTER_KEYS = [
  'peerHits',
  'peerMisses',
  'crossGroupDenied',
  'declarations',
  'withdrawn',
  // 🆕 单 B：epoch 不一致被跳过的次数（⛔ 它**不是**跨组拒绝 —— 两者必须可区分）
  'epochMismatch',
] as const

export type PeerCounterKey = (typeof PEER_COUNTER_KEYS)[number]

export type PeerCounters = Record<PeerCounterKey, number>

/**
 * 组键：`<network>|<group>`。
 *
 * ⚠️ 分隔符用 `|` 而不是 `/` —— `/` 是 relay 逻辑名（`network/hostId`）的分隔符，
 * 复用会让"网名里带斜杠"这类输入产生歧义（本线已有 `NAME_SEP` 的先例可循）。
 */
export function groupKeyOf(network: string, group: string): string {
  return `${network}|${group}`
}

/** 判定两个 (网, 组) 是否同组（E5 的**唯一**判据处）。 */
export function sameGroup(
  networkA: string,
  groupA: string,
  networkB: string,
  groupB: string,
): boolean {
  return groupKeyOf(networkA, groupA) === groupKeyOf(networkB, groupB)
}

/** `ContentPeerGroup` 构造选项。 */
export interface ContentPeerGroupOptions {
  /** 本节点所属网。 */
  network: string
  /** 本节点所属组。 */
  group: string
  /** 🆕 本节点的组密钥 epoch（给了才做 epoch 一致性判定；缺省 ⇒ 与逐字一致）。 */
  epoch?: number
  /** 日志函数（观测辅助；⛔ 不替代计数）。 */
  log?: (line: string) => void
  /** 单块候选上限（防"一次返回上千个 peer"把控制面撑爆）。缺省 8。 */
  maxCandidates?: number
}

/** 一个已登记的 peer（含它的组键与持有集）。 */
interface RegisteredPeer {
  name: string
  network: string
  group: string
  key: string
  holds: Set<string>
  addedAt: number
  /** 🆕 声明里的 epoch（没声明 ⇒ `undefined`）。 */
  epoch: number | undefined
}

/**
 * 同组 peer 视图。
 *
 * 生命周期：`addPeer`（收到声明）→ `candidates`（查谁有）→ `markDenied`（判跨组）
 * → `withdraw`（peer 下线）。全部是**同步内存操作**（relay 侧已有在线态，本层不重复探测）。
 */
export class ContentPeerGroup {
  private readonly self: { network: string; group: string; key: string }
  /** 🆕 本节点 epoch（`undefined` = 不做 epoch 判定，保持行为）。 */
  private readonly selfEpoch: number | undefined
  private readonly peers = new Map<string, RegisteredPeer>()
  private readonly maxCandidates: number
  private readonly log: (line: string) => void
  private readonly c: PeerCounters = {
    peerHits: 0,
    peerMisses: 0,
    crossGroupDenied: 0,
    declarations: 0,
    withdrawn: 0,
    epochMismatch: 0,
  }

  constructor(opts: ContentPeerGroupOptions) {
    this.self = { network: opts.network, group: opts.group, key: groupKeyOf(opts.network, opts.group) }
    this.selfEpoch = opts.epoch
    this.log = opts.log ?? (() => {})
    const mc = opts.maxCandidates ?? 8
    if (!Number.isInteger(mc) || mc <= 0) {
      throw new Error(`content-peer: maxCandidates 必须是正整数，收到 ${String(opts.maxCandidates)}`)
    }
    this.maxCandidates = mc
  }

  /** 本节点所属组键。 */
  get groupKey(): string {
    return this.self.key
  }

  /** 判别器快照（**拷贝**）。 */
  counters(): PeerCounters {
    return { ...this.c }
  }

  /** 当前登记的 peer 数（含其它组的 —— 它们存在但**不可选**）。 */
  get size(): number {
    return this.peers.size
  }

  /** 登记 / 覆盖一个 peer 的声明。 */
  addPeer(decl: PeerDeclaration): void {
    const key = groupKeyOf(decl.network, decl.group)
    this.peers.set(decl.name, {
      name: decl.name,
      network: decl.network,
      group: decl.group,
      key,
      holds: new Set(decl.holds),
      addedAt: Date.now(),
      epoch: decl.epoch,
    })
    this.c.declarations += 1
  }

  /** peer 下线 ⇒ 从视图移除（其持有的块不再可选）。 */
  withdraw(name: string): boolean {
    const had = this.peers.delete(name)
    if (had) {
      this.c.withdrawn += 1
      this.log(`[content-peer] withdraw ${name}`)
    }
    return had
  }

  /**
   * 查"**同组**内谁持有这些块"。
   *
   * 🆕 单 B：**epoch 不一致的同组 peer 不作候选**（它的块 id 是另一代口径 ⇒ 取回来也拼不上），
   * 且这一次跳过**单独计数** `epochMismatch`（⛔ 不许混进 `crossGroupDenied` ——
   * "换了代"与"跨了组"是**两件事**，混在一起会让 `E5` 的判据失去分辨力）。
   *
   * @returns 同 (网, 组) 且 **epoch 一致** 的 peer 名列表（按登记序，最多 `maxCandidates`）
   */
  candidates(id: string): { name: string; network: string; group: string }[] {
    const out: { name: string; network: string; group: string }[] = []
    for (const p of this.peers.values()) {
      // ── E5 的**唯一**闸门：组键必须与本节点一致 ─────────────────────
      if (p.key !== this.self.key) continue
      // ── 🆕 单 B：epoch 闸门（只在本节点声明了 epoch、且对端也声明了时才判）──
      if (this.selfEpoch !== undefined && p.epoch !== undefined && p.epoch !== this.selfEpoch) {
        this.c.epochMismatch += 1
        this.log(`[content-peer] 跳过 ${p.name}：epoch=${p.epoch} ≠ 本节点 ${this.selfEpoch}（换代会全量换 id）`)
        continue
      }
      if (!p.holds.has(id)) continue
      out.push({ name: p.name, network: p.network, group: p.group })
      if (out.length >= this.maxCandidates) break
    }
    if (out.length > 0) this.c.peerHits += 1
    else this.c.peerMisses += 1
    return out
  }

  /**
   * 判定一次请求是否**跨组**；是 ⇒ 记数并返回 `true`（调用方据此**显式拒绝**）。
   *
   * ⚠️ 这是 E5 判据的落点：跨组拒绝必须有**独立计数**，
   * 否则"不许"与"没有"在脚本里同形（本线的假绿来源）。
   */
  markDenied(name: string, id: string): boolean {
    const p = this.peers.get(name)
    if (p === undefined) {
      // 未知 peer ⇒ 不是"跨组"，是"不认识"（调用方按未命中处理）
      return false
    }
    if (p.key === this.self.key) return false
    this.c.crossGroupDenied += 1
    this.log(`[content-peer] 跨组拒绝 ${name}（${p.key} ≠ ${this.self.key}）请求块 ${id}`)
    return true
  }

  /** 同组 peer 数（E5 的可读视图）。 */
  sameGroupPeers(): string[] {
    const out: string[] = []
    for (const p of this.peers.values()) {
      if (p.key === this.self.key) out.push(p.name)
    }
    return out
  }

  /** 跨组 peer 数（应当 **> 0** 才能证明"隔离真的在起作用"，而不是"根本没有别人"）。 */
  crossGroupPeers(): string[] {
    const out: string[] = []
    for (const p of this.peers.values()) {
      if (p.key !== this.self.key) out.push(p.name)
    }
    return out
  }
}
