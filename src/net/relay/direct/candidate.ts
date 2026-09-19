/**
 * 覆盖网络 **直连候选交换**（序㊵ · P2 · S5）—— 候选地址的**收发与校验**。
 *
 * ## 它解决的确切问题
 * 打洞前双方必须知道**对方的公网 UDP 落点**。这份模块定义"这条消息长什么样"以及
 * "**什么样的对端才有资格发它**"，其余（怎么打洞）在 `punch.ts`。
 *
 * ## 🔴 三条不可退让的设计（每一条都对应本线吃过的一次亏）
 *
 * | # | 纪律 | 为什么 |
 * |---|---|---|
 * | ① | **走既有 relay 通道**，⛔ 零新口、⛔ 零新协议 | 候选交换**不是**数据面：它只需要"已被鉴权的那条连接"。新增监听口 = 命中 R5 |
 * | ② | 准入**复用** `network.ts#isAllowedDialer`（= `server.ts` DIAL 白名单那一条策略） | 本线老病根「同一事实两处写」：另写一份 ⇒ 两处迟早分叉，而 `server.ts` 那两处是**冻结的只读面** |
 * | ③ | 拒绝**必须显式 ＋ 计数**，⛔ **不许静默返空** | "配置错长得像网络不通"是本线反复踩的假绿面：静默返空 = 判据全绿而功能全废 |
 *
 * ## ⛔ 载荷里不许有什么
 * 只准 `{kind, hostId, network, addrs[], ts}`。**任何**含密钥 / 签名 / 凭据字样的字段名
 * ⇒ `secret-field` 直接拒（判定见 {@link findSecretField}）。理由：候选是**对端**给的、
 * 会被写进日志与观测面；它一旦能携带身份材料，就等于给"密钥本体不经网络"这条纪律开了一个洞。
 *
 * @module dsh_ai1net/net/relay/direct/candidate
 */

import { isAllowedDialer, isHostId, isNetworkId, logicalName } from '../network.js'

/** 候选消息的类型标签（走既有 relay 通道时的 JSON 信封）。⛔ 别改名 —— 探针与单测按它取值。 */
export const DIRECT_MESSAGE_KIND = 'DIRECT_CANDIDATE'

/** 单条消息里候选地址的上限（缺省）。⚠️ 权威值在参数表 `DIRECT_CAND_MAX_ADDRS`。 */
export const DIRECT_CAND_MAX_ADDRS = 4

/** 候选的**新鲜期**（ms）：超期 ⇒ `stale`。理由 = NAT 映射有寿命，过期的落点打不通还会浪费一次探测。 */
export const DIRECT_CAND_TTL_MS = 60_000

/** 打洞用的候选地址（**IPv4 / IPv6 字面量**，⛔ 不收主机名 —— 打洞不能依赖 DNS）。 */
export interface DirectAddress {
  host: string
  port: number
}

/** 候选消息本体。 */
export interface DirectCandidateMessage {
  kind: typeof DIRECT_MESSAGE_KIND
  /** 申报者自己在**这张网**里的逻辑名（= 发送方自己的 hostId）。 */
  hostId: string
  network: string
  addrs: DirectAddress[]
  /** 产生时刻（epoch ms）；`0` = 未标注（不判新鲜期）。 */
  ts: number
}

/**
 * 拒绝原因（**枚举**，⛔ 不收自由文本）—— 目的：让"哪一类被拒"可被机器判、可被计数。
 *
 * ⚠️ `'cross-network'` 与 `'not-self-candidate'` 是**安全判据**（跨网 / 冒名申报第三人地址），
 * ⛔ 不是"配置错了"。
 */
export type CandidateReason =
  /** 载荷形状不合法（缺字段 / 类型不对 / `kind` 不是本类型）。 */
  | 'bad-shape'
  /** 载荷里出现了疑似密钥 / 凭据字段。 */
  | 'secret-field'
  /** 申报的网与会话所属的网不一致（跨网）。 */
  | 'cross-network'
  /** 申报的 `hostId` **不是发送方自己**（= 替第三人申报地址）。 */
  | 'not-self-candidate'
  /** 发送方不在该网白名单里（⛔ 默认拒绝）。 */
  | 'not-a-dialer'
  /** 本机不在该网白名单里 ⇒ 连"能拨"都不成立，没必要建立直连。 */
  | 'self-not-a-dialer'
  /** 地址不是合法字面量（主机名 / 端口越界 / 非法 IP）。 */
  | 'bad-address'
  /** 地址条数超上限。 */
  | 'too-many-addrs'
  /** 超过新鲜期。 */
  | 'stale'

/** 一次准入判定的结果（成功与失败都带 `detail`，⛔ 不许只回 `false`）。 */
export type CandidateVerdict =
  | { ok: true; message: DirectCandidateMessage }
  | { ok: false; reason: CandidateReason; detail: string }

/**
 * 疑似密钥 / 凭据的字段名（**子串匹配，大小写不敏感**）。
 *
 * ⚠️ 这份清单**故意从宽**：漏掉一个词 = 给"密钥本体不经网络"开洞；
 * 误伤一个正常的字段名 = 改个字段名就行（代价不对称 ⇒ 从严）。
 */
const SECRET_FIELD_TOKENS = [
  'key',
  'secret',
  'token',
  'pem',
  'priv',
  'sign',
  'sig',
  'cert',
  'pass',
  'cred',
  'hmac',
  'bearer',
] as const

/**
 * 递归找一个"像密钥 / 凭据"的字段名（**任意深度**）。
 *
 * ⛔ 不看**值**（那要靠猜测）：只看**字段名** —— 判据必须可复现、不靠人看。
 */
export function findSecretField(value: unknown, path = '$'): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretField(value[i], `${path}[${i}]`)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const low = k.toLowerCase()
    if (SECRET_FIELD_TOKENS.some((t) => low.includes(t))) return `${path}.${k}`
    const hit = findSecretField(v, `${path}.${k}`)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** IPv4 字面量（**逐段 0–255**；⛔ 不收 `1.2.3`、⛔ 不收前导零）。 */
export function isIpv4(raw: string): boolean {
  const parts = raw.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)
}

/**
 * IPv6 字面量（**宽松但排除了主机名字符**）。
 *
 * 口径：只允许 `[0-9a-fA-F:]` 且冒号数量 ≥ 2（⇒ 单冒号形态如 `host:80` 不可能通过）。
 * ⛔ 刻意**不**做完整 RFC 解析：打洞只要求"能直接喂给 `dgram.send`"，而形状错的地址
 * 会在 `dgram` 那里立刻报错 ⇒ 这里只负责拦掉"看着像主机名"的那一类。
 */
export function isIpv6(raw: string): boolean {
  if (!/^[0-9a-fA-F:]+$/.test(raw)) return false
  const colons = (raw.match(/:/g) ?? []).length
  return colons >= 2 && colons <= 7
}

/** 地址校验（只判**形状**；端口 1–65535）。 */
export function isValidAddress(a: DirectAddress): boolean {
  if (typeof a.host !== 'string' || a.host === '') return false
  if (!isIpv4(a.host) && !isIpv6(a.host)) return false
  return Number.isInteger(a.port) && a.port > 0 && a.port <= 65535
}

/**
 * 严格解析一条候选消息。
 *
 * ⛔ **不宽容**：任何形状问题都返回 `undefined`（调用方转成 `bad-shape` **并计数**），
 * ⛔ 不补默认值、⛔ 不做类型强转（`"80"` 不是 `80`）。
 */
export function parseDirectMessage(raw: string): DirectCandidateMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return normalizeDirectMessage(parsed)
}

/** 与 {@link parseDirectMessage} 同一口径，但收**已解析**的对象（信封解出来之后的入口）。 */
export function normalizeDirectMessage(parsed: unknown): DirectCandidateMessage | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const r = parsed as Record<string, unknown>
  if (r.kind !== DIRECT_MESSAGE_KIND) return undefined
  const hostId = typeof r.hostId === 'string' ? r.hostId : ''
  const network = typeof r.network === 'string' ? r.network : ''
  if (!isHostId(hostId) || !isNetworkId(network)) return undefined
  if (!Array.isArray(r.addrs) || r.addrs.length === 0) return undefined
  const addrs: DirectAddress[] = []
  for (const item of r.addrs) {
    if (item === null || typeof item !== 'object') return undefined
    const a = item as Record<string, unknown>
    if (typeof a.host !== 'string' || typeof a.port !== 'number') return undefined
    addrs.push({ host: a.host, port: a.port })
  }
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0
  return { kind: DIRECT_MESSAGE_KIND, hostId, network, addrs, ts }
}

/**
 * 编码一条候选消息（**唯一构造点**）。
 *
 * ⛔ 先过一遍 {@link findSecretField}：构造侧就不许把身份材料塞进来（失败早于上线）。
 */
export function encodeDirectMessage(msg: {
  hostId: string
  network: string
  addrs: DirectAddress[]
  ts?: number
}): string {
  const out: DirectCandidateMessage = {
    kind: DIRECT_MESSAGE_KIND,
    hostId: msg.hostId,
    network: msg.network,
    addrs: msg.addrs.map((a) => ({ host: a.host, port: a.port })),
    ts: msg.ts ?? Date.now(),
  }
  const secret = findSecretField(out)
  if (secret !== undefined) throw new Error(`候选载荷里出现疑似凭据字段 ${secret}（⛔ 候选只含地址与端口）`)
  const back = normalizeDirectMessage(out)
  if (back === undefined) throw new Error('候选消息形状非法（⛔ 不许把坏形状编出去）')
  return JSON.stringify(out)
}

/** 一条候选的完整上下文（判定所需的一切**都是显式传入的** ⇒ 单测无需 mock 判据）。 */
export interface CandidateContext {
  /** 归一化后的拨号方白名单（`network → hostId 集合`）—— 与 `server.ts` 的 `dialers` **同型同源**。 */
  dialers: ReadonlyMap<string, ReadonlySet<string>>
  /** 收到这条消息的会话所属的网 ＋ 对端 hostId（由 relay 侧鉴权后的会话表给出，⛔ 不信载荷）。 */
  from: { network: string; hostId: string }
  /** 本机在这张网里的 hostId。 */
  selfHostId: string
  /** 地址条数上限（缺省 {@link DIRECT_CAND_MAX_ADDRS}，权威值在参数表）。 */
  maxAddrs?: number
  /** 新鲜期（缺省 {@link DIRECT_CAND_TTL_MS}）。 */
  ttlMs?: number
  now?: number
}

/**
 * **准入判定**（判据 `D1`）。
 *
 * 顺序刻意如此（**先安全后形状**会掩盖错配："跨网"的证据在 `from.network` 与载荷的对比里）：
 * ① 形状（`bad-shape` / `secret-field`）
 * ② 网一致（`cross-network`）—— 🔴 安全：⛔ 绝不让一张网里的会话申报另一张网的落点
 * ③ **只准申报自己**（`not-self-candidate`）—— 🔴 安全：⛔ 不许替第三人申报地址
 * ④ 双向白名单（`not-a-dialer` / `self-not-a-dialer`）—— **复用** `isAllowedDialer`
 * ⑤ 地址形状与条数（`bad-address` / `too-many-addrs`）
 * ⑥ 新鲜期（`stale`）
 */
export function admitCandidate(raw: string, ctx: CandidateContext): CandidateVerdict {
  const maxAddrs = ctx.maxAddrs ?? DIRECT_CAND_MAX_ADDRS
  const ttlMs = ctx.ttlMs ?? DIRECT_CAND_TTL_MS
  const now = ctx.now ?? Date.now()

  // ① 形状（含凭据字段扫描 —— 扫描在**归一之前**，坏形状也不能夹带）
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { ok: false, reason: 'bad-shape', detail: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const secret = findSecretField(json)
  if (secret !== undefined) {
    return { ok: false, reason: 'secret-field', detail: `载荷含疑似凭据字段 ${secret}（⛔ 候选只准含地址与端口）` }
  }
  const msg = normalizeDirectMessage(json)
  if (msg === undefined) {
    return { ok: false, reason: 'bad-shape', detail: `不是 ${DIRECT_MESSAGE_KIND} 形态（须含 hostId / network / addrs[非空]{host,port}）` }
  }

  // ② 网一致（跨网 ⇒ 结构性拒绝）
  if (msg.network !== ctx.from.network) {
    return {
      ok: false,
      reason: 'cross-network',
      detail: `载荷申报的网 "${msg.network}" ≠ 会话所属的网 "${ctx.from.network}"`,
    }
  }

  // ③ 只准申报自己（⛔ 替第三人申报 = 冒名，会变成"借别人的手把流量引到目标"）
  if (msg.hostId !== ctx.from.hostId) {
    return {
      ok: false,
      reason: 'not-self-candidate',
      detail: `载荷申报 ${logicalName(msg.network, msg.hostId)}，而会话持有的身份是 ${logicalName(ctx.from.network, ctx.from.hostId)}（⛔ 只准申报自己）`,
    }
  }

  // ④ 双向白名单（**复用** network.ts#isAllowedDialer —— ⛔ 不另写一份）
  if (!isAllowedDialer(ctx.dialers, ctx.from.network, ctx.from.hostId)) {
    return {
      ok: false,
      reason: 'not-a-dialer',
      detail: `对端 ${logicalName(ctx.from.network, ctx.from.hostId)} 不在网 "${ctx.from.network}" 的拨号方白名单里（默认拒绝）`,
    }
  }
  if (!isAllowedDialer(ctx.dialers, ctx.from.network, ctx.selfHostId)) {
    return {
      ok: false,
      reason: 'self-not-a-dialer',
      detail: `本机 ${logicalName(ctx.from.network, ctx.selfHostId)} 不在网 "${ctx.from.network}" 的拨号方白名单里 ⇒ 建不成直连`,
    }
  }

  // ⑤ 地址形状与条数
  if (msg.addrs.length > maxAddrs) {
    return { ok: false, reason: 'too-many-addrs', detail: `候选地址 ${msg.addrs.length} 条 > 上限 ${maxAddrs}` }
  }
  for (const a of msg.addrs) {
    if (!isValidAddress(a)) {
      return { ok: false, reason: 'bad-address', detail: `非法候选地址 ${JSON.stringify(a)}（须 IPv4/IPv6 字面量 ＋ 端口 1–65535）` }
    }
  }

  // ⑥ 新鲜期（`ts = 0` ⇒ 未标注 ⇒ 不判 —— ⛔ 但也不当"新鲜"混过去：detail 里写明）
  if (msg.ts > 0 && ttlMs > 0 && now - msg.ts > ttlMs) {
    return { ok: false, reason: 'stale', detail: `候选已过期 ${now - msg.ts} ms > 新鲜期 ${ttlMs} ms` }
  }

  return { ok: true, message: msg }
}

/** 计数的快照（观测面与探针都取这一份）。 */
export interface CandidateLedgerSnapshot {
  /** 收到的消息总数（**进过判定**的）。 */
  received: number
  accepted: number
  rejected: { reason: CandidateReason; detail: string }[]
  /**
   * 🔴 **静默拒绝数**（本线老病根的可断言面）。
   *
   * 恒等式 = `received - accepted - rejected.length`；**按构造它必须是 0** —— 它不是"统计"，
   * 而是一道**不变量守卫**：将来谁加了一条 `return {ok:false}` 却忘了记账，它立刻非零。
   * ⛔ 探针见到非零 ⇒ **FAIL 并点名**（静默返空 = 判据全绿而功能全废）。
   */
  silentRejections: number
  /** 拒绝原因的分布（`reason → 条数`，便于一眼看出"全是同一类"）。 */
  byReason: Record<string, number>
}

/**
 * 候选收发的记账器。
 *
 * ⚠️ **每条进路都必须记账**：`receive()` 先记"收到"，之后要么 `accept()` 要么 `reject()`。
 * 判据看 {@link CandidateLedgerSnapshot.silentRejections} 是否为零。
 */
export class CandidateLedger {
  private received = 0
  private accepted = 0
  private rejected: { reason: CandidateReason; detail: string }[] = []

  /** 收到一条（**必须在判定之前**调用）。 */
  receive(): void {
    this.received += 1
  }

  /** 接受一条。 */
  accept(): void {
    this.accepted += 1
  }

  /** 拒绝一条（**必须带原因**，⛔ 不许只计数不写原因）。 */
  reject(reason: CandidateReason, detail: string): void {
    this.rejected.push({ reason, detail })
  }

  /**
   * 判定 ＋ 记账的**唯一入口**（调用方不需要记得先 `receive()`）。
   *
   * ⇒ "忘了记账"这件事在**接口层**就已经不可能 —— 这是比"靠自觉"更强的形态。
   */
  judge(raw: string, ctx: CandidateContext): CandidateVerdict {
    this.receive()
    const verdict = admitCandidate(raw, ctx)
    if (verdict.ok) this.accept()
    else this.reject(verdict.reason, verdict.detail)
    return verdict
  }

  snapshot(): CandidateLedgerSnapshot {
    const byReason: Record<string, number> = {}
    for (const r of this.rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
    return {
      received: this.received,
      accepted: this.accepted,
      rejected: this.rejected.map((r) => ({ ...r })),
      silentRejections: this.received - this.accepted - this.rejected.length,
      byReason,
    }
  }
}
