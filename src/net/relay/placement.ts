/**
 * 节点选点（placement）—— **"加入哪个节点"这件事的唯一判据来源**。
 *
 * ## 为什么要有独立一层
 * 「自动选择适合的节点」如果散在 client / Manager / 门户里各写一遍，就会出现三套不一致的
 * 判据（这类不一致在复盘里反复出现）。所以：**判据只有这一处，纯函数、无 IO、可单测**。
 *
 * ## 两条硬规则（先说结论）
 * 1. **手动选择永远优先**（`manual: true`）—— 显式指定就不该被算法偷偷改掉；
 *    手动指定的节点**满了** ⇒ 返回 `queued`（排队等待）或 `rejected`，**不会静默换一个**。
 * 2. **满载是唯一的硬门**（`capacity.free === 0` ⇒ 不可选）。其余（RTT 高、近期失败多）
 *    只**降权**，不排除 —— 因为"唯一可用但慢"的节点也远好过"没有节点"。
 *
 * ## 排序依据（用户要求的两条：速度 + 负载）
 * ```text
 *   speed  = 100 / (1 + rttMs / rttHalfMs)     // rtt 0→100 分；50ms→50 分；200ms→20 分
 *   load   = 100 × (1 − used / max)            // 容量未知 ⇒ 按 0.5 中性处理（不假装它空）
 *   score  = weight × (wSpeed·speed + wLoad·load) − failurePenalty × recentFailures
 * ```
 * 权重默认 `速度 0.55 / 负载 0.45`：实测里"能不能连上"由 RTT 决定，"连上之后卡不卡"由负载决定，
 * 而我们的第一瓶颈是 **presence（在线态）**，所以速度略重（传输方案 §12 的实测依据）。
 *
 * ## 与 relay 的关系
 * 本模块**不连网、不开端口**：它只把"可观测画像"变成"一次可解释的选择"。
 * relay 侧只负责把画像喂进来（`rttMs` 来自心跳 PONG，`capacity` 来自注册数）。
 *
 * @module dsh_ai1net/net/relay/placement
 */

/** 一个候选节点（relay 或 worker，判据同构）的**可观测**画像。 */
export interface NodeCandidate {
  id: string
  /** 往返时延（ms）。未知 ⇒ 不猜，按"最差但有值"处理（见 `assumedRttMs`）。 */
  rttMs?: number
  /** 容量。`max <= 0` 或缺省 ⇒ **不限**（视为有空位，负载按中性算）。 */
  capacity?: { max: number; used: number }
  /** 近期失败次数（连接失败 / 被拒）—— 用于降权，**不用于排除**。 */
  recentFailures?: number
  /** 手工指定的节点。**最高优先级**：只要它没满就一定选它。 */
  manual?: boolean
  /** 额外权重（例如"存量锚点"、"同机房"）；`1` = 中性。 */
  weight?: number
}

export interface PlacementWeights {
  /** 速度权重。默认 0.55。 */
  speed?: number
  /** 负载权重。默认 0.45。 */
  load?: number
  /** 每次近期失败的扣分。默认 15。 */
  failurePenalty?: number
  /** 速度评分的半衰 RTT（ms）。默认 50。 */
  rttHalfMs?: number
  /** RTT 未知时的代用值（ms）。默认 120（明显偏保守，避免"没测速"被当成"很快"）。 */
  assumedRttMs?: number
  /** 全部满载时的建议重试间隔（ms）。默认 5000。 */
  queueRetryAfterMs?: number
}

export interface PlacementScore {
  id: string
  /** 0–100（负分表示被降权到负）；`-Infinity` = 硬门拦住。 */
  score: number
  /** 硬门原因。只有 `full` 是硬门。 */
  blocked?: 'full'
  detail: {
    speed: number
    load: number
    penalty: number
    /** 剩余空位；容量未知时 `undefined`。 */
    freeSlots?: number
    /** 负载比例 0–1。 */
    loadRatio?: number
  }
}

export interface PlacementDecision {
  /** 选中的节点。全部满载 ⇒ `undefined`。 */
  chosen?: NodeCandidate
  /** 结论形态：选中 / 排队等待 / 直接拒绝（无任何可选且不适合排队）。 */
  outcome: 'chosen' | 'queued' | 'rejected'
  /** 排队时建议的等待时长（ms）。 */
  retryAfterMs?: number
  /** **可解释**的理由（这个字段就是本模块存在的意义：拒绝也要说清为什么）。 */
  reason: string
  /** 完整排名（含被拦的），便于前端展示与排障。 */
  ranking: PlacementScore[]
}

const DEFAULTS = {
  speed: 0.55,
  load: 0.45,
  failurePenalty: 15,
  rttHalfMs: 50,
  assumedRttMs: 120,
  queueRetryAfterMs: 5_000,
} as const

function clampScore(n: number): number {
  return Math.max(-100, Math.min(100, n))
}

/** 给一个候选打分（纯函数；导出便于单测与前端复用同一套判据）。 */
export function scoreCandidate(c: NodeCandidate, w: PlacementWeights = {}): PlacementScore {
  const W = { ...DEFAULTS, ...w }
  const rtt = typeof c.rttMs === 'number' && c.rttMs >= 0 ? c.rttMs : W.assumedRttMs
  const speed = clampScore((100 / (1 + rtt / W.rttHalfMs)) | 0)

  const max = c.capacity !== undefined ? c.capacity.max : 0
  const used = c.capacity !== undefined ? c.capacity.used : 0
  const limited = max > 0
  const freeSlots = limited ? Math.max(0, max - used) : undefined
  // 容量未知 ⇒ 按 0.5 中性：既不当成空、也不当成满（不猜）。
  const loadRatio = limited ? Math.min(1, used / max) : 0.5
  const load = clampScore(Math.round(100 * (1 - loadRatio)))

  const penalty = Math.round((c.recentFailures ?? 0) * W.failurePenalty)
  const weight = typeof c.weight === 'number' && c.weight > 0 ? c.weight : 1
  const raw = weight * (W.speed * speed + W.load * load) - penalty

  const base = {
    id: c.id,
    detail: {
      speed,
      load,
      penalty,
      ...(freeSlots === undefined ? {} : { freeSlots }),
      ...(limited ? { loadRatio } : {}),
    },
  }
  // **唯一的硬门**：容量已满。满了就是不能加入 —— 只能排队或换节点。
  if (freeSlots === 0) return { ...base, score: Number.NEGATIVE_INFINITY, blocked: 'full' }
  return { ...base, score: Math.round(raw * 100) / 100 }
}

/** 全量排名（降序；`-Infinity` 排在最后）。 */
export function rankCandidates(candidates: readonly NodeCandidate[], w: PlacementWeights = {}): PlacementScore[] {
  return candidates.map((c) => scoreCandidate(c, w)).sort((a, b) => b.score - a.score)
}

export interface ChooseOptions extends PlacementWeights {
  /**
   * 手动指定的 id。给了它 ⇒ **只考虑它**（不静默改选别的）。
   * 这也是"手动选择"与"自动推荐"之间唯一的接口。
   */
  manualId?: string
  /** 允许排队等待（默认 `true`）。设 `false` ⇒ 满载直接 `rejected`（"不能加入"）。 */
  allowQueue?: boolean
}

/**
 * 选一个节点 —— **自动 / 手动 / 排队**三种出口都有明确语义：
 * | 情况 | outcome | 说明 |
 * |---|---|---|
 * | 手动指定且未满 | `chosen` | 尊重显式选择 |
 * | 手动指定但已满 | `queued` / `rejected` | **不会**偷偷换节点 |
 * | 自动且有空位 | `chosen` | 按速度 + 负载打分 |
 * | 自动但全满 | `queued` / `rejected` | 排队等位，或（`allowQueue:false`）拒绝加入 |
 * | 候选为空 | `rejected` | 明确"没有可选节点"，不抛异常给上层去猜 |
 */
export function chooseNode(candidates: readonly NodeCandidate[], opts: ChooseOptions = {}): PlacementDecision {
  const allowQueue = opts.allowQueue !== false
  const retryAfterMs = opts.queueRetryAfterMs ?? DEFAULTS.queueRetryAfterMs
  const ranking = rankCandidates(candidates, opts)

  if (ranking.length === 0) {
    return { outcome: 'rejected', reason: '没有可用候选节点（候选列表为空）', ranking }
  }

  const manualId = opts.manualId
  if (manualId !== undefined && manualId !== '') {
    const hit = ranking.find((r) => r.id === manualId)
    if (hit === undefined) {
      return { outcome: 'rejected', reason: `手动指定的节点 "${manualId}" 不在候选列表里（不静默改选别的节点）`, ranking }
    }
    if (hit.blocked === 'full') {
      return allowQueue
        ? { outcome: 'queued', retryAfterMs, reason: `手动指定的节点 "${manualId}" 已满载（容量已用尽）⇒ 排队等待`, ranking }
        : { outcome: 'rejected', reason: `手动指定的节点 "${manualId}" 已满载 ⇒ 拒绝加入（未开启排队）`, ranking }
    }
    return { chosen: candidates.find((c) => c.id === manualId), outcome: 'chosen', reason: `按手动指定选择 "${manualId}"`, ranking }
  }

  const best = ranking[0]
  if (best.blocked !== 'full') {
    const c = candidates.find((x) => x.id === best.id)
    return {
      chosen: c,
      outcome: 'chosen',
      reason:
        `自动选择 "${best.id}"（速度 ${best.detail.speed} 分 / 负载 ${best.detail.load} 分` +
        `${best.detail.freeSlots === undefined ? '' : ` / 空位 ${best.detail.freeSlots}`}` +
        `${best.detail.penalty > 0 ? ` / 近期失败扣 ${best.detail.penalty}` : ''}）`,
      ranking,
    }
  }

  const fullCount = ranking.filter((r) => r.blocked === 'full').length
  return allowQueue
    ? { outcome: 'queued', retryAfterMs, reason: `全部 ${fullCount} 个候选节点都已满载 ⇒ 排队等待（${retryAfterMs}ms 后重试）`, ranking }
    : { outcome: 'rejected', reason: `全部 ${fullCount} 个候选节点都已满载 ⇒ 拒绝加入（未开启排队）`, ranking }
}

/** 供日志/UI 一行展示（**同一条信息只说一次**，避免各处自定义格式）。 */
export function describeDecision(d: PlacementDecision): string {
  const head = `placement=${d.outcome}${d.chosen === undefined ? '' : ` node=${d.chosen.id}`}`
  const retry = d.retryAfterMs === undefined ? '' : ` retryAfter=${d.retryAfterMs}ms`
  return `${head}${retry} reason="${d.reason}"`
}
