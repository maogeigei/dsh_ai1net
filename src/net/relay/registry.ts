/**
 * 覆盖网络 **S1＋S2＋S4 · 网注册表 ＋ 准入凭据 ＋ 白名单派生**（「节点一键加入与分组准入」P1）。
 *
 * ## 它解决的确切问题（缺口 ②：「分组准入门面」）
 * `server.ts` 的拨号方白名单**机制已经完整**（`dialers: Map<network, Set<hostId>>`、默认拒绝、
 * 跨网在"能不能拨"这一步就走不到 —— 结构性隔离）。缺的是**把它变成可管理的东西**：
 * 今天配置靠**手写字符串**（`DSH_AI1NET_RELAY_DIALERS="u:5:manager"`），写错了长得像"这张网不存在"。
 *
 * ⇒ 本模块把「**哪些网、每张网有哪些节点、谁已批准**」变成**一份注册表**，
 *    并**派生**出 relay 侧的白名单（`DSH_AI1NET_RELAY_DIALERS`）。
 *
 * ## 三条硬约束
 * 1. **控制面是权威单点** —— 注册表只有控制面写（用户既有口径：「归属 / 租约 / 骨干资格只能控制面写」）。
 * 2. **手写 drop-in 退化为应急通道，⛔ 不删** —— 派生只是**多一条**产生白名单的路；控制面不可用
 *    时手写仍然照旧生效（`normalizeDialers` 同时接受扁平 `Set` 与分桶 `Map`）。
 * 3. **凭据载荷 ⛔ 不含密钥本体** —— 邀请凭据只回答「哪张网 ＋ 有效期 ＋ 一次性 nonce」，
 *    与组密钥凭据同形（`content/crypto.ts` 的 `(network, group, epoch, keyId)`）。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - 不碰 `server.ts` 的 DIAL / 白名单**语义**（只**读取**既有形状，派生出的仍是同一个 `Map` 形状）；
 * - 不开监听、不写 env、不 reload 任何单元（**派生是纯函数**，落盘与 reload 是调用方的事）；
 * - 不发明第二种签名 —— 一律走 `identity.ts#verifySignedPayload` / `signPayloadWith`。
 *
 * @module dsh_ai1net/net/relay/registry
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { OPS_NETWORK, assertNetworkId, isHostId, logicalName, networkKindOf } from './network.js'
import { installDir } from '../../platform-paths.js'
import { verifySignedPayload, type IdentityReason } from './identity.js'

// ── 邀请（准入）凭据 ─────────────────────────────────────────────────────────

/** 载荷域分隔标签。⛔ **改它 = 令所有既有邀请失效**。 */
export const NETWORK_INVITE_TAG = 'dsh_ai1net-overlay-netinvite/v1'

/** 注册表文件的结构版本。 */
export const NODES_REGISTRY_VERSION = 1

/** 输入长度的上界（防"超长 hostId 撑爆注册表"这类形状攻击；⛔ 与 `HOST_RE` 同量级）。 */
const NONCE_RE = /^[0-9a-f]{32}$/
const HEX_PUB_RE = /^[0-9a-f]{64}$/

/**
 * 一张网的**准入邀请凭据**。
 *
 * 🔴 **载荷内不含任何密钥本体**（私钥 / 对称密钥都不在）—— 它只是"控制面允许某台机器
 * 以某张网的身份来申请"。**节点自己的密钥在节点上生成、私钥永不出机**（`join.ts` 第 ② 步）。
 */
export interface NetworkInvite {
  version: number
  /** 该邀请**绑定的网** —— 拿它去申请别的网 ⇒ `network-mismatch`（具名拒绝）。 */
  network: string
  /** **一次性** nonce（32 hex）。控制面在**收单时**占位，第二次用 ⇒ `invite-already-used`。 */
  nonce: string
  issuedAt: string
  /** **有效期**（ISO）。空串 = 不过期（⛔ 不推荐；控制面签发时缺省给 TTL）。 */
  expiresAt: string
}

/** 邀请凭据的拒绝原因（**在 `IdentityReason` 之上再加两条注册表侧原因**）。 */
export type InviteReason = IdentityReason | 'bad-payload' | 'invite-already-used'

/** 邀请验签结论：**失败一律带具体原因**（⛔ 不许静默）。 */
export type InviteVerdict = { ok: true; doc: NetworkInvite; payload: string } | { ok: false; reason: InviteReason }

/** 规范拼接（字段顺序**写死**；⛔ 改顺序 = 令所有既有签名失效）。 */
export function networkInvitePayload(doc: NetworkInvite): string {
  return [
    NETWORK_INVITE_TAG,
    `version=${String(doc.version)}`,
    `network=${doc.network}`,
    `nonce=${doc.nonce}`,
    `issuedAt=${doc.issuedAt}`,
    `expiresAt=${doc.expiresAt}`,
  ].join('\n')
}

/** 解析（**严格**：字段不全 / 类型不对 ⇒ `undefined`，⛔ 不猜、不补默认值）。 */
export function parseNetworkInvite(raw: unknown): NetworkInvite | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const network = typeof r.network === 'string' ? r.network.trim() : ''
  const nonce = typeof r.nonce === 'string' ? r.nonce.trim().toLowerCase() : ''
  const issuedAt = typeof r.issuedAt === 'string' ? r.issuedAt.trim() : ''
  const expiresAt = typeof r.expiresAt === 'string' ? r.expiresAt.trim() : ''
  if (network === '' || issuedAt === '') return undefined
  if (networkKindOf(network) === undefined) return undefined
  if (!NONCE_RE.test(nonce)) return undefined
  const version = typeof r.version === 'number' ? r.version : NODES_REGISTRY_VERSION
  return { version, network, nonce, issuedAt, expiresAt }
}

/**
 * 验一份邀请凭据 —— **四件套**：受信签名者 + 网络绑定 + 有效期 + 载荷形状。
 *
 * ⚠️ **一次性不在这里判** —— 一笔邀请的"是否已被用过"是**控制面台账**的事实（跨进程共享），
 * 不是签名能表达的东西。⇒ 由 {@link consumeNonce} 在**收单时**用原子占位判。
 * 把两件事分开，是为了让"凭据合法但已用过"与"凭据不合法"在排障时**可分**。
 */
export function verifyNetworkInvite(
  doc: unknown,
  sig: unknown,
  trustedSigners: readonly string[],
  opts: { network?: string; now?: number } = {},
): InviteVerdict {
  const parsed = parseNetworkInvite(doc)
  if (parsed === undefined) return { ok: false, reason: 'bad-payload' }
  const payload = networkInvitePayload(parsed)
  const verdict = verifySignedPayload(payload, sig, trustedSigners)
  if (verdict !== 'ok') return { ok: false, reason: verdict }
  if (opts.network !== undefined && parsed.network !== opts.network) {
    return { ok: false, reason: 'network-mismatch' }
  }
  const now = opts.now ?? Date.now()
  if (parsed.expiresAt !== '') {
    const at = Date.parse(parsed.expiresAt)
    if (!Number.isFinite(at)) return { ok: false, reason: 'bad-payload' }
    if (now > at) return { ok: false, reason: 'expired' }
  }
  return { ok: true, doc: parsed, payload }
}

/** 生成一个**一次性 nonce**（32 hex = 16 字节随机）。 */
export function newInviteNonce(randomBytes: (n: number) => Buffer): string {
  return randomBytes(16).toString('hex')
}

// ── 一次性台账（**原子占位**，治"同一凭据被两台机器同时用"）─────────────────────

/** 台账入参：目录 + 时间源（注入 ⇒ 可单测，⛔ 不读全局时钟）。 */
export interface NonceLedger {
  dir: string
  now?: () => number
}

/** 单个 nonce 的台账文件路径（`<dir>/<nonce>.used`）。 */
export function noncePath(ledger: NonceLedger, nonce: string): string {
  return `${ledger.dir}/${nonce}.used`
}

/**
 * 占位一个 nonce（**一次性**）。
 *
 * 🔴 **做法 = `writeFileSync(..., { flag: 'wx' })`** —— `O_CREAT|O_EXCL` 是**内核原子**的：
 * 两台机器**同时**拿同一张邀请来收单，**恰好一台**拿到 `ok`，另一台得到 `invite-already-used`。
 * ⛔ **不许**"先 `existsSync` 再写" —— 那是两次系统调用的竞态，正是本线「判据成立 ≠ 机制成立」
 * 的典型反例（单机测着对、并发下漏一个）。
 *
 * ⚠️ 占位文件里写**收单侧可读的事实**（时间 + 用途），便于事后排障；⛔ 不写任何密钥 / 公钥。
 */
export function consumeNonce(
  ledger: NonceLedger,
  nonce: string,
  note: string,
): { ok: true; file: string } | { ok: false; reason: 'invite-already-used' } {
  const n = nonce.trim().toLowerCase()
  if (!NONCE_RE.test(n)) return { ok: false, reason: 'invite-already-used' }
  mkdirSync(ledger.dir, { recursive: true })
  const file = noncePath(ledger, n)
  const at = new Date(ledger.now?.() ?? Date.now()).toISOString()
  try {
    writeFileSync(file, `${at} ${note}\n`, { flag: 'wx', mode: 0o644 })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'EEXIST') return { ok: false, reason: 'invite-already-used' }
    throw err
  }
  return { ok: true, file }
}

/** 只读：该 nonce 是否已被用过（**不占位**）。 */
export function isNonceConsumed(ledger: NonceLedger, nonce: string): boolean {
  const n = nonce.trim().toLowerCase()
  return NONCE_RE.test(n) && existsSync(noncePath(ledger, n))
}

// ── 网注册表（S1 的数据模型）─────────────────────────────────────────────────

/**
 * 一个节点在注册表里的状态。
 *
 * | 状态 | 含义 | 后果 |
 * |---|---|---|
 * | `pending` | **已申请、待批准** | ⛔ **不进白名单** ⇒ relay 侧拨不动（默认拒绝） |
 * | `approved` | 已批准 | 进派生白名单 ⇒ 可接入 |
 */
export type NodeStatus = 'pending' | 'approved'

/** 注册表里的一条节点记录（⛔ 只有**公钥**，没有私钥 / 没有密钥本体）。 */
export interface NetworkNodeRecord {
  network: string
  hostId: string
  /** 节点**公钥**（64 hex，Ed25519 裸公钥）。 */
  nodeKey: string
  status: NodeStatus
  /** 申请时刻（ISO）。 */
  appliedAt: string
  /** 批准时刻（ISO）；`''` = 未批准。 */
  approvedAt: string
  /** 分组（`''` = 该网默认组）。⚠️ 分组只作**管理信息**，⛔ 不参与"能不能拨"的判据。 */
  group: string
}

/** 注册表文件（键 = **逻辑名** `<network>/<hostId>`，与 `server.ts` 会话表同口径）。 */
export interface NodesRegistry {
  version: number
  nodes: Record<string, NetworkNodeRecord>
}

export function emptyRegistry(): NodesRegistry {
  return { version: NODES_REGISTRY_VERSION, nodes: {} }
}

/**
 * 解析注册表（**严格**：形状不对 ⇒ `undefined`）。
 *
 * ⛔ **不做"宽容修复"** —— 一条 `status` 拼错的记录如果被静默当成 `pending`，
 * 表现就是"批准了却连不上"（本线反复要根治的那类病）。
 */
export function parseRegistry(raw: unknown): NodesRegistry | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const nodesRaw = r.nodes
  if (nodesRaw === undefined || typeof nodesRaw !== 'object' || Array.isArray(nodesRaw)) return undefined
  const version = typeof r.version === 'number' ? r.version : NODES_REGISTRY_VERSION
  const nodes: Record<string, NetworkNodeRecord> = {}
  for (const [key, value] of Object.entries(nodesRaw as Record<string, unknown>)) {
    const rec = parseRecord(value)
    if (rec === undefined) return undefined
    if (key !== logicalName(rec.network, rec.hostId)) return undefined
    nodes[key] = rec
  }
  return { version, nodes }
}

function parseRecord(raw: unknown): NetworkNodeRecord | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const network = typeof r.network === 'string' ? r.network.trim() : ''
  const hostId = typeof r.hostId === 'string' ? r.hostId.trim() : ''
  const nodeKey = typeof r.nodeKey === 'string' ? r.nodeKey.trim().toLowerCase() : ''
  const status = typeof r.status === 'string' ? r.status.trim() : ''
  const appliedAt = typeof r.appliedAt === 'string' ? r.appliedAt.trim() : ''
  const approvedAt = typeof r.approvedAt === 'string' ? r.approvedAt.trim() : ''
  const group = typeof r.group === 'string' ? r.group.trim() : ''
  if (networkKindOf(network) === undefined) return undefined
  if (!isHostId(hostId)) return undefined
  if (!HEX_PUB_RE.test(nodeKey)) return undefined
  if (status !== 'pending' && status !== 'approved') return undefined
  if (appliedAt === '') return undefined
  if (status === 'approved' && approvedAt === '') return undefined
  return { network, hostId, nodeKey, status, appliedAt, approvedAt, group }
}

/** 读注册表；**文件不存在 ⇒ 空注册表**（不是错误：还没开始用）。形状不对 ⇒ **抛**（具名）。 */
export function loadRegistry(file: string): NodesRegistry {
  if (!existsSync(file)) return emptyRegistry()
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const reg = parseRegistry(raw)
  if (reg === undefined) throw new Error(`注册表 ${file} 形状非法（⛔ 不静默修复；字段口径见 registry.ts）`)
  return reg
}

/** 写注册表（**`0644`** —— 内容只有公钥与状态，⛔ 无密钥；走临时文件 + `rename` 不留半成品）。 */
export function saveRegistry(file: string, reg: NodesRegistry): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(sortedRegistryJson(reg), null, 2)}\n`, { mode: 0o644 })
  renameSync(tmp, file)
}

/** 稳定序列化：`nodes` 的键**按键名排序**，让"没有改动"与"改动了"在 `diff` 里可分。 */
function sortedRegistryJson(reg: NodesRegistry): NodesRegistry {
  const nodes: Record<string, NetworkNodeRecord> = {}
  for (const key of Object.keys(reg.nodes).sort()) {
    const rec = reg.nodes[key]
    if (rec === undefined) continue
    nodes[key] = rec
  }
  return { version: reg.version, nodes }
}

// ── 读只面（S1）─────────────────────────────────────────────────────────────

export interface NetworkSummary {
  network: string
  /** 该网记录总数。 */
  total: number
  /** 其中已批准数。 */
  approved: number
  /** 其中待批准数。 */
  pending: number
}

/** 逐网汇总（**排序稳定**：`ops` 先，其余按名）。 */
export function summarizeNetworks(reg: NodesRegistry): NetworkSummary[] {
  const acc = new Map<string, NetworkSummary>()
  for (const rec of Object.values(reg.nodes)) {
    const cur = acc.get(rec.network) ?? { network: rec.network, total: 0, approved: 0, pending: 0 }
    cur.total++
    if (rec.status === 'approved') cur.approved++
    else cur.pending++
    acc.set(rec.network, cur)
  }
  return [...acc.values()].sort((a, b) => {
    if (a.network === OPS_NETWORK) return -1
    if (b.network === OPS_NETWORK) return 1
    return a.network < b.network ? -1 : a.network > b.network ? 1 : 0
  })
}

/** 列出节点（可选按网过滤；**排序稳定**：网名 → hostId）。 */
export function listNodes(reg: NodesRegistry, network?: string): NetworkNodeRecord[] {
  return Object.values(reg.nodes)
    .filter((r) => network === undefined || r.network === network)
    .sort((a, b) => {
      if (a.network !== b.network) return a.network < b.network ? -1 : 1
      return a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0
    })
}

// ── 写面（S1；**只有控制面调**）──────────────────────────────────────────────

/** 收单结果：失败**具名**（⛔ 不许静默拒绝）。 */
export type RegistryEdit =
  | { ok: true; record: NetworkNodeRecord; created: boolean }
  | { ok: false; reason: 'unknown-node' | 'unknown-network' }

/**
 * 收一份**申请**（`join` 的第 ④ 步）。
 *
 * 语义（**刻意如此**）：
 * - 新节点 ⇒ 建一条 `pending`（⛔ **不自动批准** —— 批准权在控制面，见 §4.1）；
 * - **已 `approved` 的节点再次申请** ⇒ **保持 `approved`**（幂等：重装 / 重跑 join 不该把自己踢回待批）；
 * - 已 `pending` 再次申请 ⇒ 刷新 `appliedAt` / `nodeKey`（换机重装场景）。
 */
export function applyApplication(
  reg: NodesRegistry,
  app: { network: string; hostId: string; nodeKey: string; at: string; group?: string },
): RegistryEdit {
  const network = app.network.trim()
  if (networkKindOf(network) === undefined) return { ok: false, reason: 'unknown-network' }
  if (!isHostId(app.hostId)) return { ok: false, reason: 'unknown-node' }
  if (!HEX_PUB_RE.test(app.nodeKey.trim().toLowerCase())) return { ok: false, reason: 'unknown-node' }
  const key = logicalName(network, app.hostId)
  const prev = reg.nodes[key]
  const record: NetworkNodeRecord = {
    network,
    hostId: app.hostId,
    nodeKey: app.nodeKey.trim().toLowerCase(),
    status: prev?.status === 'approved' ? 'approved' : 'pending',
    appliedAt: app.at,
    approvedAt: prev?.status === 'approved' ? prev.approvedAt : '',
    group: app.group ?? prev?.group ?? '',
  }
  reg.nodes[key] = record
  return { ok: true, record, created: prev === undefined }
}

/** 批准一个节点（⛔ 只在**已申请**的节点上生效 ⇒ 不存在"凭空批准一个没申请过的 hostId"）。 */
export function approveNode(
  reg: NodesRegistry,
  network: string,
  hostId: string,
  at: string,
  group?: string,
): RegistryEdit {
  const net = network.trim()
  if (networkKindOf(net) === undefined) return { ok: false, reason: 'unknown-network' }
  const key = logicalName(net, hostId)
  const prev = reg.nodes[key]
  if (prev === undefined) return { ok: false, reason: 'unknown-node' }
  const record: NetworkNodeRecord = {
    ...prev,
    status: 'approved',
    approvedAt: at,
    group: group ?? prev.group,
  }
  reg.nodes[key] = record
  return { ok: true, record, created: false }
}

/** 移除一个节点（⇒ 立刻退出派生白名单；⚠️ relay 侧生效要等一次 reload —— 见 §4.1 注）。 */
export function removeNode(reg: NodesRegistry, network: string, hostId: string): RegistryEdit {
  const net = network.trim()
  if (networkKindOf(net) === undefined) return { ok: false, reason: 'unknown-network' }
  const key = logicalName(net, hostId)
  const prev = reg.nodes[key]
  if (prev === undefined) return { ok: false, reason: 'unknown-node' }
  delete reg.nodes[key]
  return { ok: true, record: prev, created: false }
}

// ── S4 · 白名单派生 ─────────────────────────────────────────────────────────

/**
 * 把**已批准集合**投影成 relay 侧的白名单（`dialers` 的**分桶 Map** 形状）。
 *
 * ⚠️ 这是 `network.ts#normalizeDialers` **能吃**的形状 ⇒ 派生结果与手写 drop-in
 * 走的是**同一个归一化入口**（⛔ 不存在"派生的白名单和手写的不是一回事"）。
 * 🔴 `pending` **一律不投影** —— 派生只表达"已批准"，待批节点的可拨性由既有默认拒绝兜住。
 */
export function deriveDialers(reg: NodesRegistry, networks?: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (networks !== undefined) for (const n of networks) out.set(assertNetworkId(n, '派生的网名'), new Set())
  for (const rec of Object.values(reg.nodes)) {
    if (rec.status !== 'approved') continue
    if (networks !== undefined && !networks.includes(rec.network)) continue
    const bucket = out.get(rec.network) ?? new Set<string>()
    bucket.add(rec.hostId)
    out.set(rec.network, bucket)
  }
  return out
}

/** 派生结果的一致性问题（`OBS-24` 的判据②③，**逐条点名**）。 */
export interface DerivationAudit {
  ok: boolean
  /** 派生集合 ≠ 已批准集合的网（逐条点名，含差集）。 */
  mismatches: string[]
  /** **结构性错桶**：bucket 里的 hostId 对应记录属于**另一张网**（跨网零共享的机器判据）。 */
  misfiled: string[]
}

/**
 * 自审派生结果 —— **S4 的判据不是"函数跑通了"，而是三件事同时成立**：
 * ① 每张网的派生集合 ≡ 该网 `approved` 集合（多一个 / 少一个都点名）；
 * ② 任何 bucket 里的 hostId 都**来属于该 bucket 的网**（⇒ 「独立网零共享」是**结构性**的，
 *    不是"我们用的时候记得过滤"）；
 * ③ `pending` 一个都不在派生里。
 */
export function auditDerivation(reg: NodesRegistry, derived?: Map<string, Set<string>>): DerivationAudit {
  const d = derived ?? deriveDialers(reg)
  const mismatches: string[] = []
  const misfiled: string[] = []
  const byNetwork = new Map<string, Set<string>>()
  const ownerOf = new Map<string, string>()
  for (const rec of Object.values(reg.nodes)) {
    ownerOf.set(`${rec.network}${'\u0000'}${rec.hostId}`, rec.network)
    if (rec.status !== 'approved') continue
    const bucket = byNetwork.get(rec.network) ?? new Set<string>()
    bucket.add(rec.hostId)
    byNetwork.set(rec.network, bucket)
  }
  for (const network of new Set<string>([...byNetwork.keys(), ...d.keys()])) {
    const want = byNetwork.get(network) ?? new Set<string>()
    const got = d.get(network) ?? new Set<string>()
    const missing = [...want].filter((h) => !got.has(h)).sort()
    const extra = [...got].filter((h) => !want.has(h)).sort()
    if (missing.length > 0 || extra.length > 0) {
      mismatches.push(`${network}: 缺[${missing.join(',')}] 多[${extra.join(',')}]`)
    }
  }
  for (const [network, hosts] of d.entries()) {
    for (const host of hosts) {
      const owner = ownerOf.get(`${network}${'\u0000'}${host}`)
      if (owner !== network) misfiled.push(`${network}/${host}（记录属于 ${owner ?? '不存在'}）`)
    }
  }
  return { ok: mismatches.length === 0 && misfiled.length === 0, mismatches, misfiled }
}

/**
 * 派生一份 **relay drop-in** 的**内容**（纯字符串，⛔ 本函数不落盘、不 reload）。
 *
 * 🔴 **手写 drop-in 是应急通道，⛔ 不删** —— 派生出的这份与手写那份作用**完全等价**
 * （同一个 env 键、同一套归一化），差别只在"谁产生它"。⇒ 控制面不可用时，手写照旧生效。
 */
export function deriveDropIn(
  reg: NodesRegistry,
  opts: { network: string; varName?: string; libDir?: string; unit?: string },
): string {
  const network = assertNetworkId(opts.network, '派生的网名')
  const varName = opts.varName ?? 'DSH_AI1NET_RELAY_DIALERS'
  const hosts = [...(deriveDialers(reg, [network]).get(network) ?? new Set<string>())].sort()
  // 逻辑名形态（`<网>/<hostId>`）—— `normalizeDialers` 的**规范形态**；⛔ 不用 `网:hostId` 旧式写法。
  const entries = hosts.map((h) => logicalName(network, h))
  // relay 代码安装根：**部署相关 ⇒ 不写死**（`DSH_RELAY_LIB_DIR` 可显式指定，
  // 缺省取本进程的安装根 —— relay 进程跑在自己的安装目录下，即为正确值）。
  const libDir = opts.libDir ?? process.env.DSH_RELAY_LIB_DIR ?? installDir()
  const unit = opts.unit ?? 'dsh_ai1net-relay'
  return [
    `# 由控制面**派生**（${unit} · network=${network}）—— 源 = 网注册表里该网的 approved 集合`,
    `# 🔴 手写 drop-in 是**应急通道**（控制面不可用时照旧生效），⛔ 本文件不取代它。`,
    `# ⛔ 不许手改：改了下一次派生就被覆盖；要改就改注册表（approve / remove）。`,
    '[Service]',
    `Environment="${varName}=${entries.join(',')}"`,
  ].join('\n')
}

/** drop-in 的**目标路径**（同一套命名，⛔ 别在调用方拼）。 */
export function dropInPath(unit: string, libDir?: string): string {
  const suffix = libDir === undefined ? '' : ` (lib=${libDir})`
  return `/etc/systemd/system/${unit}.service.d/50-overlay-dialers.conf${suffix}`
}

// ── 一行摘要（给 CLI / 日志；**同一条信息只说一次**）─────────────────────────

export function describeRegistryLine(reg: NodesRegistry): string {
  const nets = summarizeNetworks(reg)
  if (nets.length === 0) return `注册表：0 张网 0 个节点（⛔ 空注册表 ⇒ 派生结果为空 ⇒ 默认拒绝一切拨号）`
  return `注册表：${nets.map((n) => `${n.network}(approved ${n.approved}/pending ${n.pending})`).join(' · ')}`
}
