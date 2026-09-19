/**
 * relay 密钥装载 —— **每 worker 一密钥**（不是共享 token），**且每条密钥带「属于哪张网」**。
 *
 * ## 为什么不是共享 token
 * 共享 token 的问题是**爆炸半径 = 全部 worker**：任何一台 worker 被读走配置文件，攻击者就能
 * 冒充**任意** worker 注册（方案 §10.1 判据①，`chisel` / `frp` 正是在这里垫底）。
 * 每 worker 一密钥把爆炸半径收回到那一台。
 *
 * ## 为什么带「网」，以及为什么键是**逻辑名**
 * 只按 `hostId` 索引时，**这张表回答不了「它属于哪张网」** ⇒ relay 只能相信 HELLO 里的 `network`
 * 声明。于是任何持有任意一条有效密钥的节点，**声称任意合法网名就能在那张网里注册** ——
 * 而「网内别的节点」与「这张网自己」都无从否决（`设计说明 §待办②` 的确切缺口）。
 *
 * ⇒ 本模块让**密钥表本身**成为成员资格的唯一判据（配置是既成事实，声明只是待校验的输入）。
 *    表的**键 = 逻辑名 `<network>/<hostId>`**（`network.ts` 的「唯一入口」口径），因为：
 *
 * 1. **同一台机器名可以出现在两张网里**（`u:5/pc-1` 与 `u:9/pc-1`）—— 用户设备名是客户端取的，
 *    跨用户撞名是常态；拿 `hostId` 当键会让第二张网**注册不进来**（一个维度净变差）。
 * 2. 与 `server.ts` 的会话表 / 端点表**同一个口径**（都是逻辑名）⇒ 不再有「这张表按 hostId、
 *    那张表按逻辑名」两套写法（本线反复复发的那类病）。
 *
 * ## 格式（**向后兼容，旧配置一字不改照旧可用**）
 * ```json
 * {
 *   "<host-a>": "fc6c…7d01",                    // 旧写法：裸 hostId ⇒ 运维网 ops
 *   "manager": { "secret": "515d…3b6ea" },  // 新写法：显式给出 secret
 *   "u:5/pc-1": "aa11…77aa",                // 带网：与 u:9/pc-1 互不干扰（网络取自**键**）
 *   "u:9/pc-1": { "secret": "bb22…88bb" }
 * }
 * ```
 * 内联形式（便于 env 传入，**不建议**用于生产，因为 env 会进 `ps`/journald）：
 * `<host-a>:<64hex>,ops/manager:<64hex>,u:5/pc-1:<64hex>`
 *
 * ⚠️ 名字段一律走 `network.ts#parseLogicalName`（**唯一入口**）—— 它同时接受
 * `网/hostId`、`网:hostId` 与旧形态裸 `hostId`，且**网络 id 非法就抛**。
 * 抛而**不静默回落 `ops`**：静默回落会让「网配错了」表现成「网络不通」，那是最难查的一类。
 *
 * @module dsh_ai1net/net/relay/keys
 */

import { readFileSync } from 'node:fs'

import { OPS_NETWORK, assertNetworkId, logicalName, parseLogicalName } from './network.js'

const HEX64 = /^[0-9a-f]{64}$/

/**
 * 一条 relay 密钥。
 *
 * - `secret`：64 位 hex（= 32 字节，HMAC-SHA256 的推荐长度）；
 * - `network`：该 hostId **属于哪张网** —— 成员资格的唯一判据（序③）；
 *   ⚠️ 它**是准入判据，不是注释**：relay 拿它与 HELLO 的声明比对，不一致即拒。
 */
export interface RelayKeyEntry {
  network: string
  secret: string
}

/** `逻辑名 <network>/<hostId> → 密钥条目`。 */
export type RelayKeyMap = Map<string, RelayKeyEntry>

/** 校验一条密钥：**必须 64 位 hex**。短密钥直接拒，不静默接受。 */
export function assertKey(hostId: string, secret: string): string {
  const s = secret.trim().toLowerCase()
  if (!HEX64.test(s)) throw new Error(`relay key for "${hostId}" must be 64 hex chars (got ${s.length} chars)`)
  return s
}

/** 键里**显式写了网络**没有（`u:5/pc-1` / `ops/manager` ⇒ 有；`pc-1` ⇒ 没有）。 */
function isQualifiedName(raw: string): boolean {
  return raw.includes('/') || raw.includes(':')
}

/**
 * 把一条登记项归一化成 `{name, entry}`。
 *
 * 网络来源有**两个可能的位置**（键 / 值），规则刻意简单：
 * - 键是**限定名**（`u:5/pc-1`）⇒ 网络**只认键**；值里若也写了且不一致 ⇒ **抛**
 *   （两处写不一致 = 埋雷，与 `normalizeDialers` 的「写了就必须一致」同一条纪律）；
 * - 键是**裸 hostId** ⇒ 网络取自值里的 `network`，缺省 `ops`（= R5 旧配置的事实）。
 */
export function normalizeKeyRecord(rawKey: string, rawValue: unknown): { name: string; entry: RelayKeyEntry } {
  const parsed = parseLogicalName(rawKey)
  const qualified = isQualifiedName(rawKey)
  let network = parsed.network
  let secretRaw: unknown = rawValue
  if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    const o = rawValue as Record<string, unknown>
    if (typeof o.network === 'string' && o.network.trim() !== '') {
      const declared = assertNetworkId(o.network, `relay key "${rawKey}" 的网络段`)
      if (qualified && declared !== parsed.network) {
        throw new Error(`relay key "${rawKey}" 自相矛盾：键说 "${parsed.network}"，值里的 network 说 "${declared}"`)
      }
      network = declared
    }
    secretRaw = o.secret
  }
  if (typeof secretRaw !== 'string') {
    throw new Error(`relay key for "${rawKey}" must be a 64-hex string or {secret[, network]}`)
  }
  const secret = assertKey(parsed.hostId, secretRaw)
  return { name: logicalName(network, parsed.hostId), entry: { network, secret } }
}

/**
 * 宽容读取：把「旧调用方手里的 `Map<hostId, string>`」与「新的 `Map<逻辑名, RelayKeyEntry>`」
 * 都读成 {@link RelayKeyEntry}。
 *
 * 存在的理由：`server.ts` 的 `keys` 选项在若干地方被构造（`main.ts` / `web/server.ts` / 单测），
 * 逐个改成新形态会带来「漏改一处 ⇒ 运行期 `entry.secret` 是 `undefined` ⇒ 全部拒绝」的风险 ——
 * 那个失效形态**看起来像网络不通**。收在一个函数里，读的地方只有一种写法。
 *
 * ⚠️ 本函数**只在没有网络信息可依据时**才把网络当 `ops`。若键本身是限定名（已表达网络），
 * 调用方应当用 {@link lookupKey}（它会从键里取网络），否则会把 `u:5/pc-1` 误判成 `ops`。
 */
export function keyEntryOf(raw: string | RelayKeyEntry | undefined): RelayKeyEntry | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string') return { network: OPS_NETWORK, secret: raw }
  return raw
}

/**
 * 查一条密钥 —— **唯一的查表入口**（`server.ts` / `main.ts` 都走它，⛔ 不各自 `keys.get`）。
 *
 * 两步：① 按**逻辑名**查（新形态，能区分同名不同网）；② 回落到**裸 hostId**（R5 旧形态：
 * `Map<hostId, hex>` 与「键是裸 hostId 的 JSON 项」）。
 *
 * ⚠️ **网络归属从哪来**（这条搞错就会「配对了却仍被拒」）：
 * - 命中**逻辑名**键 ⇒ 值若是裸 hex 串，网络**取自键**（键是限定名，它已经说了是哪张网）；
 *   值若是对象，则用对象里那把（`normalizeKeyRecord` 保证两者一致；手写的 `Map` 若不一致，
 *   由调用方的 `entry.network !== 声明网` 兜住 ⇒ 仍是失败关闭）。
 * - 命中**裸 hostId** ⇒ 值的网络缺省 `ops`（R5 旧配置的**事实**，不是猜测）。
 *
 * ⛔ 第二步**不做网络过滤** —— 网络一致性的判据只有一处（调用方拿 `entry.network !== 声明网`
 * 判）：这样「裸条目 + 声明别张网」会得到**明确的 `network-mismatch`**，而不是含混的
 * `unknown-host`（后者会让「配错网」看起来像「这台机器从没登记过」）。
 */
export function lookupKey(
  keys: ReadonlyMap<string, string | RelayKeyEntry>,
  network: string,
  hostId: string,
): RelayKeyEntry | undefined {
  const direct = keys.get(logicalName(network, hostId))
  if (direct !== undefined) {
    if (typeof direct === 'string') return { network, secret: direct }
    return direct
  }
  return keyEntryOf(keys.get(hostId))
}

/**
 * 解析 `hostId:secret` / `network/hostId:secret` / `network:hostId:secret`。
 *
 * **切点 = 最后一个 `:`**（不是第一个）：网络 id 自己就可能含 `:`（`u:5`），
 * 而 secret 是纯 hex **不含** `:` ⇒ 最后一个 `:` 必然是分隔符。
 * ⛔ 用第一个 `:` 会把 `u:5/pc-1:<hex>` 切成网络段 `u`，于是「配置写错」长得像「这张网不存在」。
 */
export function parseKeysInline(text: string): RelayKeyMap {
  const out: RelayKeyMap = new Map()
  for (const pair of text.split(',')) {
    const item = pair.trim()
    if (item === '') continue
    const idx = item.lastIndexOf(':')
    if (idx <= 0 || idx === item.length - 1) throw new Error(`malformed relay key entry: ${item.slice(0, 12)}…`)
    const name = item.slice(0, idx).trim()
    const { name: key, entry } = normalizeKeyRecord(name, item.slice(idx + 1).trim())
    out.set(key, entry)
  }
  return out
}

/** 读 JSON 密钥文件（生产用；权限应为 `600`，仅能跑 relay 的用户可读）。 */
export function loadKeysFile(path: string): RelayKeyMap {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `relay keys file ${path} must be a JSON object of { "<net>/<hostId>": "<64hex>" | {secret[, network]} }`,
    )
  }
  const out: RelayKeyMap = new Map()
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const { name, entry } = normalizeKeyRecord(rawKey, rawValue)
    if (out.has(name)) throw new Error(`relay keys file ${path} 里 "${name}" 出现了两次`)
    out.set(name, entry)
  }
  return out
}

/** 一行摘要（给启动日志 / `/status` 用，**同一条信息只说一次**）。 */
export function describeKeyEntry(hostId: string, entry: RelayKeyEntry): string {
  // `ops` 下的条目**省略网络前缀** —— 与 R5 时代的日志写法一致，读起来不变。
  return entry.network === OPS_NETWORK ? hostId : `${entry.network}/${hostId}`
}
