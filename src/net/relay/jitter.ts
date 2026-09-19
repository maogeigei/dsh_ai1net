/**
 * 覆盖网络 · **链路抖动（jitter）采样 · 直方图 · 选路主序**（序 ㉖ · 骨干稳定选路与加密）。
 *
 * ## 为什么需要它（用户口径 → 机器判据）
 *
 * 用户 2026-09-17 20:2x 的口径是「**按照连接稳定高效的方式 数据安全可加密传输**」。翻译成
 * 可验证的工程质量判据就是 **"选路看 jitter、⛔ 不看 RTT"**：
 *
 * - 改造前：`directory.ts` 的候选序 = **签名目录发布序**（同源优先插首位），`switcher.ts` 的换址
 *   = **排除当前 + 排除冷却中的 ⇒ 取链里下一个** ⇒ 两处**都没有**"哪条更稳"这个维度。
 * - 后果：一条 RTT 低但**抖得厉害**的路径会长期霸占首位 —— 而"稳定"恰恰是交互式会话的第一诉求
 *   （RTT 高只是慢，jitter 高是**卡顿/超时/断连**）。
 *
 * ## 三条口径（⛔ 改这三条等于改判据，必须同步改参数表）
 *
 * 1. **量 = `|ΔRTT|` 的 p95**（相邻两次心跳往返之差的绝对值），与 `覆盖网络抖动探针`
 *    实测所用的**同一个量**（`p95AbsDelta`）⇒ 历史读数（`p95 = 3 ms`）与本模块**同口径可比**。
 * 2. **序 = jitter 升序**，且 **只对"已测出样本"的候选生效**；**无样本者保原序排在其后**
 *    （⛔ 不惩罚"还没测过的备用中继"，也不凭空给它排位 —— 见 {@link orderByJitter}）。
 * 3. **零样本 ⇒ 逐字返回原数组**（⛔ 这是零回归的机器判据 `D9`：观测器没喂过数，
 *    行为必须与改造前**逐字一致**）。
 *
 * ## 为什么只有这一份算法
 *
 * relay 侧（`server.ts` 的每会话 RTT）与平台侧（`switcher.ts` 的选路）**共用**本模块的
 * `absDeltas` / `percentile` / `histogram` —— 本线的教训是「**另一份实现 = 另一处静默失效**」
 * （取址链踩过两次）。⛔ 不许在 `scripts/**` 或别的模块里再写一份 p95/直方图。
 *
 * ## 阈值来源（⛔ 全部来自参数表，模块内零魔数）
 *
 * `JITTER_ENABLE` / `JITTER_SAMPLE_MAX` / `JITTER_MIN_SAMPLES` / **`JITTER_LIMIT_MS`** /
 * `JITTER_HIST_MAX_MS` / `JITTER_HIST_BUCKETS` / `JITTER_SAMPLE_GAP_MS`
 * （口径见 本线的参数表）。
 *
 * 🔴 **劣化阈值复用 `JITTER_LIMIT_MS`（⛔ 不新造 `JITTER_SWITCH_MS`）**：该键在就已登记
 * （值 `20 ms`，语义 = `p95(|ΔRTT|)` 的**达标限值**）—— "超标"与"劣化到该换路"是**同一件事**
 * ⇒ 新造一个同值键只会变成"同一事实两处写"（本线的知识碎片化教训）。
 *
 * @module src/net/relay/jitter
 */

/** 本模块的阈值（**全部**来自参数表；见模块头）。 */
export interface JitterThresholds {
  /** 总开关（`JITTER_ENABLE`，默认 `1`）。置 `0` ⇒ 采样与排序**全部失效**回到改造前行为。 */
  enabled: boolean
  /** 每个 url 保留的 RTT 样本上限（环状，老的丢弃）。 */
  sampleMax: number
  /** 参与排序 / 劣化判定所需的**最小 |ΔRTT| 样本数**（不足 ⇒ 该 url 视为"未知"）。 */
  minSamples: number
  /**
   * **劣化阈值**：`p95(|ΔRTT|) ≥ 它` ⇒ 这条路径被判"不稳"，允许换到更稳的候选。
   *
   * ⚠️ 来源 = 参数表的 **`JITTER_LIMIT_MS`**（就有的"达标限值"；⛔ 不是新键）。
   */
  switchMs: number
  /** 直方图上界（`≥ 它` 的样本落进末桶）。 */
  histMaxMs: number
  /** 直方图桶数（**固定值**；探针拿它校验"口径一致"，⛔ 不是实现细节）。 */
  histBuckets: number
  /**
   * **同一份缓存读数的最小采样间隔（ms）**。
   *
   * 🔴 为什么必须有这个键：`RelayClient.status().rttMs` 是**上一次心跳的结果**，而心跳周期
   * （`HB_SEC = 15 s`）远大于巡检周期（`checkMs = 2 s`）⇒ 不做门限的话**同一个 RTT 值会被
   * 反复记录** ⇒ 差分恒为 0 ⇒ **jitter 被系统性低估到 0**（判据假绿）。
   * ⇒ 门限必须 **> 心跳周期**：同一份缓存值最多只贡献一个样本。
   *
   * ⚠️ relay 侧（`server.ts`）**不用**这个键 —— 它在 `PONG` 到达那一刻采样，本来就是新测量。
   */
  sampleGapMs: number
}

/**
 * 从 env 读阈值（**值格必须纯数字**；非纯数字一律回退默认值）。
 *
 * ⚠️ 与 `relayFailoverThresholds` 同款纪律：参数表里写 `1` / `0`，⛔ **不许**写 `true` 或
 * 带夹注的 `1（默认）` —— 后者解析失败会**静默回退默认值**（本线已踩过一次）。
 */
export function jitterThresholds(env: Record<string, string | undefined> = process.env): JitterThresholds {
  const num = (key: string, dflt: number): number => {
    const raw = (env[key] ?? '').trim()
    if (raw === '') return dflt
    return /^\d+$/.test(raw) ? Number(raw) : dflt
  }
  return {
    enabled: num('JITTER_ENABLE', 1) !== 0,
    sampleMax: num('JITTER_SAMPLE_MAX', 32),
    minSamples: num('JITTER_MIN_SAMPLES', 3),
    switchMs: num('JITTER_LIMIT_MS', 20),
    histMaxMs: num('JITTER_HIST_MAX_MS', 200),
    histBuckets: num('JITTER_HIST_BUCKETS', 8),
    sampleGapMs: num('JITTER_SAMPLE_GAP_MS', 20_000),
  }
}

/**
 * 相邻样本的一阶差分绝对值 = **抖动量**（⛔ 不是标准差）。
 *
 * 🔴 为什么不用标准差：标准差会把"单调漂移"（排队时延缓慢变化）算成抖动，而交互式会话真正
 * 怕的是**相邻两拍之间的突变**（卡一下）。原有的实测口径同样是相邻差分 ⇒ 保持一致。
 */
export function absDeltas(samples: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const d = Math.abs(samples[i]! - samples[i - 1]!)
    if (Number.isFinite(d)) out.push(d)
  }
  return out
}

/**
 * 百分位（**与 `覆盖网络抖动探针` 逐字同口径**：`sorted[min(len-1, floor(len·p))]`）。
 *
 * ⚠️ 口径必须与运维点测一致，否则"实时选路看到的 p95"与"运维点测的 p95"会给出**两个数**。
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!
}

/** 直方图（等宽桶；`≥ histMaxMs` 落末桶）。返回值长度**恒等于** `buckets`。 */
export function histogram(deltas: readonly number[], histMaxMs: number, buckets: number): number[] {
  const out = new Array<number>(Math.max(1, buckets)).fill(0)
  if (histMaxMs <= 0) return out
  const n = out.length
  for (const d of deltas) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((d / histMaxMs) * n)))
    out[idx] = (out[idx] ?? 0) + 1
  }
  return out
}

/** 一组样本的抖动画像。 */
export interface JitterStats {
  /** 已采到的 RTT 样本数。 */
  samples: number
  /** `|ΔRTT|` 样本数（= `samples - 1`，样本不足 2 时为 0）。 */
  deltas: number
  p95AbsDeltaMs: number
  meanAbsDeltaMs: number
  maxAbsDeltaMs: number
  /** 直方图（长度 = `histBuckets`）。 */
  hist: number[]
}

/** 由**已在别处算好的差分序列**构造画像（relay 侧多会话合并时用；⛔ 不重复实现统计）。 */
export function statsFromDeltas(deltas: readonly number[], th: JitterThresholds): JitterStats {
  const sum = deltas.reduce((a, b) => a + b, 0)
  return {
    samples: deltas.length + 1,
    deltas: deltas.length,
    p95AbsDeltaMs: round2(percentile(deltas, 0.95)),
    meanAbsDeltaMs: deltas.length === 0 ? 0 : round2(sum / deltas.length),
    maxAbsDeltaMs: deltas.length === 0 ? 0 : round2(Math.max(...deltas)),
    hist: histogram(deltas, th.histMaxMs, th.histBuckets),
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * **每个 url 一份的 RTT 样本环 + 抖动画像**（进程内单例，见 {@link sharedJitterTracker}）。
 *
 * ⛔ 它**不做 I/O**、不定时、不联网 —— 采样由调用方喂（relay 侧 = PONG 回来的那一刻；
 * 平台侧 = 当前通道的 `status().rttMs`）。这样本模块可以在单测里被**逐项断言**。
 */
export class JitterTracker {
  private readonly th: JitterThresholds
  private readonly rings = new Map<string, number[]>()

  constructor(th: Partial<JitterThresholds> = {}) {
    this.th = { ...jitterThresholds(), ...th }
  }

  /** 阈值快照（调用方据此做判定，⛔ 不许各自再读一遍 env）。 */
  thresholds(): JitterThresholds {
    return this.th
  }

  /** 是否开启（`JITTER_ENABLE=0` ⇒ 采样与排序全部失效）。 */
  get enabled(): boolean {
    return this.th.enabled
  }

  /**
   * 记一次 RTT 样本。
   *
   * 非法输入（非有限数 / 负数）**静默丢弃并返回 `false`** —— 这里故意不抛：
   * 采样点在生产路径上（每 15 s 一次心跳），抛异常会把**选路**带崩，
   * 而"少一个样本"只影响排序精度。⛔ 但**不静默吞掉"整条通道读不到 RTT"**：那是
   * `switcher.ts` 的 `jitterAlerts` / 探针 `OBS-19` 负责点名的分工。
   */
  record(url: string, rttMs: number): boolean {
    if (!this.th.enabled) return false
    if (url === '' || !Number.isFinite(rttMs) || rttMs < 0) return false
    const ring = this.rings.get(url) ?? []
    ring.push(rttMs)
    const max = Math.max(2, this.th.sampleMax)
    if (ring.length > max) ring.splice(0, ring.length - max)
    this.rings.set(url, ring)
    return true
  }

  /** 该 url 的画像；**样本不足 `minSamples` 个差分 ⇒ `undefined`（= 未知，⛔ 不当 0 用）**。 */
  stats(url: string): JitterStats | undefined {
    const ring = this.rings.get(url)
    if (ring === undefined || ring.length < 2) return undefined
    const st = statsFromDeltas(absDeltas(ring), this.th)
    if (st.deltas < this.th.minSamples) return undefined
    return st
  }

  /** 该 url 的 jitter（`undefined` = 未知）。 */
  jitterMs(url: string): number | undefined {
    return this.stats(url)?.p95AbsDeltaMs
  }

  /** 已采过样的 url（信息输出 / 观测用）。 */
  urls(): string[] {
    return [...this.rings.keys()].sort()
  }

  /** 全量快照（**只读**副本；给 `/status` 与探针用）。 */
  snapshot(): { url: string; samples: number; jitterMs?: number }[] {
    return this.urls().map((url) => {
      const st = this.stats(url)
      return {
        url,
        samples: this.rings.get(url)?.length ?? 0,
        ...(st === undefined ? {} : { jitterMs: st.p95AbsDeltaMs }),
      }
    })
  }

  /** 清空（测试与"配置热更"用；⛔ 生产路径不调它）。 */
  reset(): void {
    this.rings.clear()
  }
}

/**
 * **候选排序：jitter 为主序**（`E1` 的实现本体）。
 *
 * 语义（⛔ 三条都要照做，改一条就等于改判据）：
 * 1. **已测出样本**（差分 ≥ `minSamples`）的候选按 `jitter` **升序**在前 —— 并列时**保原相对序**；
 * 2. **未测出样本**的候选按**原相对序**排在其后 —— ⛔ 不把"没测过"当成"很差"（那会让**备用中继
 *    永远排最后 ⇒ 永远不被使用 ⇒ 永远测不出来**，形成死角），也⛔ 不把它当成"很好"（那会让
 *    推荐序失去意义）；
 * 3. **一个都没测出来 ⇒ 返回原数组本身**（`D9`：零回归的机器判据）。
 *
 * ⚠️ 排序必须 **stable**（同 key 保原序）—— 否则同源优先、目录发布序这些**已有语义**会被
 * 一次抖动采样随机洗牌 ⇒ 那是净退化（R11）。
 */
export function orderByJitter(
  urls: readonly string[],
  tracker: JitterTracker | undefined,
  minSamples?: number,
): readonly string[] {
  if (tracker === undefined || !tracker.enabled || urls.length < 2) return urls
  const th = tracker.thresholds()
  const need = minSamples ?? th.minSamples
  const known: { url: string; jitterMs: number; idx: number }[] = []
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!
    const st = tracker.stats(url)
    if (st === undefined || st.deltas < need) continue
    known.push({ url, jitterMs: st.p95AbsDeltaMs, idx: i })
  }
  /** ③ 零已知 ⇒ 原数组（⛔ 连新数组都不建：`D9` 要的是"逐字一致"）。 */
  if (known.length === 0) return urls
  known.sort((a, b) => (a.jitterMs === b.jitterMs ? a.idx - b.idx : a.jitterMs - b.jitterMs))
  const pinned = new Set(known.map((k) => k.url))
  return [...known.map((k) => k.url), ...urls.filter((u) => !pinned.has(u))]
}

/**
 * **"jitter 劣化即切"的挑人单点判据**（`E2` 的实现本体）。
 *
 * 规则（⛔ 只有这一处实现；`switcher.ts` 只负责调用 + 记数 + 告警）：
 * - 当前通道 jitter `< switchMs` ⇒ `undefined`（**没劣化，一步都不许动**）；
 * - 否则在候选里找 **① 不是当前 ② 不在 `blocked` 里**（`blocked` = 当前 + 冷却中的，
 *   ⛔ **jitter 换址没有打破冷却的权力** —— 豁免权只属于"当前这条已经挂了"这条语义，见 `switcher.ts`）
 *   且 **jitter 已知且严格更小** 的最小者；
 * - 找不到 ⇒ `undefined`（**原地不动**，⛔ 不切空、⛔ 不静默回退默认机）。
 */
export function pickJitterTarget(opts: {
  urls: readonly string[]
  tracker: JitterTracker | undefined
  curUrl: string
  curJitterMs: number
  switchMs: number
  minSamples?: number
  blocked?: ReadonlySet<string>
}): { url: string; jitterMs: number } | undefined {
  const { urls, tracker, curUrl, curJitterMs, switchMs, blocked } = opts
  if (tracker === undefined || !tracker.enabled) return undefined
  if (!Number.isFinite(curJitterMs) || curJitterMs < switchMs) return undefined
  const need = opts.minSamples ?? tracker.thresholds().minSamples
  let best: { url: string; jitterMs: number } | undefined
  for (const url of urls) {
    if (url === curUrl) continue
    if (blocked !== undefined && blocked.has(url)) continue
    const st = tracker.stats(url)
    if (st === undefined || st.deltas < need) continue
    const j = st.p95AbsDeltaMs
    if (j >= curJitterMs) continue
    if (best === undefined || j < best.jitterMs) best = { url, jitterMs: j }
  }
  return best
}

/**
 * **进程级共享 tracker**（`switcher.ts` 采样 / `directory.ts` 排序 / relay `/status` 观测
 * 都用它 ⇒ 装配点**零改动**）。
 *
 * 🔴 为什么必须是单例：装配点（`src/web/server.ts` / `src/worker/relay-tunnel.ts` /
 * `src/net/relay/main.ts`）**不在原有的在册文件集**内 ⇒ 若把 tracker 做成"构造时注入"，
 * 生产上**永远不会被注入** ⇒ 本序所有判据都变成**静默失效**（装了但一次都没生效）。
 * 单例把"接线"这件事**从装配点挪进模块内部**，代价是"测试要能换掉它" ⇒ 见
 * {@link setSharedJitterTracker}。
 */
let shared: JitterTracker | undefined

export function sharedJitterTracker(): JitterTracker {
  if (shared === undefined) shared = new JitterTracker()
  return shared
}

/** 注入/清空共享 tracker（**只有单测用**）。 */
export function setSharedJitterTracker(t: JitterTracker | undefined): void {
  shared = t
}
