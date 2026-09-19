/**
 * 覆盖网络 P0-2：**首次入网引导的三级链**（内置种子 → 签名目录 → 离线降级）。
 *
 * ## 为什么要有这个模块
 *
 * ① 的终态里，客户端（Manager / worker / 未来的用户设备）**只能**从 env 拿到中继地址。
 * 一旦域名或机器要换，`env` 只存在于**我们自己的部署脚本**里 —— 用户设备上的那个值
 * 改不到 ⇒ `§A2` 点名的灾难：**所有客户端必须升级重装**。
 * 引导链把"地址"从**编译期常量**变成**可在线轮换的下发物**：
 *
 * | 级 | 来源 | 作用 |
 * |---|---|---|
 * | ① | **env 显式** | 运维最后手段，**压制一切**（调试 / 应急，不查目录、不联网） |
 * | ② | **缓存目录**（未过期） | 日常路径：省一次网络往返，也保证"控制面挂掉不影响已入网节点" |
 * | ③ | **内置种子** | 冷启动：拿种子 origin 去取**签名目录**，拿到 `relays[]` 才连 |
 * | ④ | 离线降级 | 目录不可达 ⇒ 用**过期但签名有效**的缓存（只影响**新节点加入**） |
 * | ⑤ | 种子兜底 | 连目录都取不到 ⇒ 直接用种子地址本身当入口（种子 = 中继入口，**同源**） |
 *
 * ## 🔴 三条不可动摇的判据
 *
 * 1. **签名不对 ⇒ 失败关闭**：目录只有在**受信公钥验签通过**时才被采用，
 *    **既不写缓存、也不拿它的地址去连**（`§A2`）。受信公钥为空 ⇒ 同样拒绝（**不可验 = 不接受**）。
 * 2. **`bootstrap[]` 是轮换的唯一抓手**：取目录的 origin **优先取缓存里的 `bootstrap[]`**，
 *    而不是编译进来的种子 ⇒ 目录里把 `bootstrap[]` 改成新地址，**下一次刷新就跟着走**，
 *    **不重装、不升级**（`§A2` 的关键设计要求）。
 * 3. **本模块只处理地址，不碰身份**：目录里**没有** hostId / 密钥 / 用户数据 / 内网地址；
 *    连上之后能不能拨、能拨谁，仍由 relay 侧「网维度 + 白名单」（P0-1）决定。
 *
 * 纯函数（payload / 解析 / 验签 / 取址决策）与 IO（缓存读写、取目录）分开放，
 * 前者可单测、后者只做搬运 —— 与 `network.ts` 同一风格。
 * @module dsh_ai1net/net/relay/directory
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
/**
 * 候选链的**排序输入**（jitter 主序）。
 *
 * ⚠️ 这三个名字是**本序新增**的唯一跨模块依赖方向：`directory` → `jitter`（⛔ 反向不许有，
 * 否则 `jitter` 里就会长出一份取址 —— 本线"另一份实现 = 另一处静默失效"的教训）。
 */
import { orderByJitter, sharedJitterTracker, type JitterTracker } from './jitter.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
// （443/TCP 兜底 · L1）：**取目录这一腿也要走地址覆盖**（另一处注入点在 `client.ts` 的建连点）。
import { ensureOverlayAddrOverrides } from './addr-override.js'

/** 目录端点的**固定路径**（服务端注册、客户端派生都用它，⛔ 不要在调用方各写一份）。 */
export const DIRECTORY_PATH = '/dsh_ai1net-overlay/bootstrap'

/** 签名载荷的**版本标签**：换载荷格式时改这里 ⇒ 老客户端**验签失败 ⇒ 失败关闭**（不会误读新格式）。 */
export const DIRECTORY_PAYLOAD_TAG = 'dsh_ai1net-overlay-directory/v1'

/** 目录文档结构版本。未知版本 ⇒ 拒绝（而不是"尽力解析"）。 */
export const DIRECTORY_VERSION = 1

/** 刷新周期的安全区间（防止目录里写"缓存十年"把轮换能力锁死）。 */
export const MIN_REFRESH_SECONDS = 30
export const MAX_REFRESH_SECONDS = 86400

/** 默认刷新周期（秒）：服务端签发时用、客户端拿不到目录时的兜底节奏也用。 */
export const DEFAULT_DIRECTORY_REFRESH_SECONDS = 300

/** 一份目录里地址条目的上限（防放大 / 防误配）。 */
const MAX_ENTRIES = 8
const MAX_ENTRY_LEN = 512

/** Ed25519 裸 32 字节公钥的 **SPKI DER 前缀**（`302a300506032b6570032100`）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * **内置种子的常量位**。
 * ⛔ 刻意留空 —— 种子是**具体部署的入口地址**，属部署相关值，
 * 一律由 `DSH_AI1NET_OVERLAY_BOOTSTRAP_SEEDS` 提供（见 `config/platform.env`）。
 * 代码内不留真实域名 / IP；未配置 ⇒ 引导链为空、不自动取址。
 * ⚠️ `config.ts` 属**基础层**、不许 import 本模块 ⇒ 那边另有一份同语义常量，
 * **改动必须两处同改**（与 `db/types.ts` 的 `DEFAULT_HOST_NETWORK` 同一纪律）。
 */
export const DEFAULT_OVERLAY_SEED = ''

/** 从环境变量取种子；**没配** ⇒ 用内置常量位（空 ⇒ 返回空列表）。 */
export function overlayEnvSeeds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DSH_AI1NET_OVERLAY_BOOTSTRAP_SEEDS
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_OVERLAY_SEED === '' ? [] : [DEFAULT_OVERLAY_SEED]
  }
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
}

/**
 * 从环境变量取受信目录公钥。**没配 ⇒ 空数组 ⇒ 目录一律不接受**（不可验 = 不接受），
 * 于是引导链退化成"env / 种子兜底"两级 —— 行为等价于 P0-2 之前，不会更危险。
 */
export function overlayEnvTrustedKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DSH_AI1NET_OVERLAY_DIR_PUBKEYS
  if (raw === undefined) return []
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
}

/** 引导目录文档（**签名覆盖全部字段**，顺序由 {@link directoryPayload} 固定）。 */export interface OverlayDirectory {
  /** 结构版本，必须 === {@link DIRECTORY_VERSION}。 */
  version: number
  /** 签发时间（ISO 8601）。 */
  issuedAt: string
  /** 客户端缓存多久后重新取目录（秒）。 */
  refreshAfterSeconds: number
  /** 该目录所属的网（P0-1 的 `network_id`，运维网 = `ops`）。 */
  network: string
  /** 当前可用的**中继端点**（连接用；`https://` 会被归一化成 `wss://`）。 */
  relays: string[]
  /** **可轮换的引导地址清单**（下一轮取目录的 origin；也是最终兜底入口）。 */
  bootstrap: string[]
}

/** 验签结论。失败一律带**具体原因** —— 静默拒绝会让"目录写错"看起来像"网络不通"。 */
export type DirectoryVerdict =
  | { ok: true; doc: OverlayDirectory; payload: string; keyIndex: number }
  | { ok: false; reason: string }

/** 取址来源（写日志用；也是验收判据要断言的东西）。 */
export type OverlayAddressSource =
  | 'env'
  | 'cache'
  | 'seed-directory'
  | 'stale-cache'
  | 'seed-fallback'
  | 'none'

/** 一次取址的结论。 */
export interface OverlayRelayResolution {
  /** 归一化后的中继地址（`ws://` / `wss://`）；空 = 取不到（行为等同"未配 relay"）。 */
  url: string
  source: OverlayAddressSource
  /** 供日志 / 取证：具体用了哪个 origin、哪条拒绝原因。 */
  detail: string
  /** 本次结论的**保鲜期**（秒）：调用方据此决定下一次刷新的节奏。 */
  refreshAfterSeconds: number
}

// ── 纯函数：载荷 / 解析 / 验签 ─────────────────────────────────────────────

/**
 * **签名载荷的规范形式**。服务端签发与客户端验签都必须走这个函数 ——
 * 用 `JSON.stringify` 会踩"键序不同 ⇒ payload 不同"的坑（换一个 TS 版本就可能变）。
 */
export function directoryPayload(doc: OverlayDirectory): string {
  return [
    DIRECTORY_PAYLOAD_TAG,
    String(doc.version),
    doc.issuedAt,
    String(doc.refreshAfterSeconds),
    doc.network,
    doc.relays.join(','),
    doc.bootstrap.join(','),
  ].join('\n')
}

/** 把 hex / base64 / base64url 解成字节；都不是 ⇒ `undefined`。 */
function decodeRawKey(spec: string): Buffer | undefined {
  if (/^[0-9a-fA-F]{64}$/.test(spec)) return Buffer.from(spec, 'hex')
  if (/^[A-Za-z0-9+/=_-]+$/.test(spec)) {
    const b64 = spec.replace(/-/g, '+').replace(/_/g, '/')
    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 32) return buf
  }
  return undefined
}

/**
 * 解析一个受信公钥：接受 **PEM（SPKI）** 或 **裸 32 字节（hex / base64 / base64url）**。
 * 解析不出来 ⇒ `undefined`（调用方**跳过**这一把，而不是让整条链断掉）。
 */
export function publicKeyFrom(spec: string): KeyObject | undefined {
  const s = spec.trim()
  if (s === '') return undefined
  if (s.includes('BEGIN')) {
    try {
      const k = createPublicKey(s)
      return k.asymmetricKeyType === 'ed25519' ? k : undefined
    } catch {
      return undefined
    }
  }
  const raw = decodeRawKey(s)
  if (raw === undefined) return undefined
  try {
    const k = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    })
    return k.asymmetricKeyType === 'ed25519' ? k : undefined
  } catch {
    return undefined
  }
}

/** 单个地址条目：必须是非空、≤512 字符、`http(s)` / `ws(s)` 的绝对 URL。 */
function parseEntry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (s === '' || s.length > MAX_ENTRY_LEN) return undefined
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') {
    return undefined
  }
  return s
}

/** 地址清单：数组、≤{@link MAX_ENTRIES} 条、条条合法、去重后返回。 */
function parseEntryList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return undefined
  const out: string[] = []
  for (const item of value) {
    const entry = parseEntry(item)
    if (entry === undefined) return undefined
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/**
 * 严格解析（**只做形状与取值域校验，不验签**）。任何一条不合规 ⇒ `undefined`：
 * 对齐"默认拒绝" —— 目录是**下发物**，宁可不接受，也不要"尽力解析出一个半成品"。
 */
export function parseDirectory(raw: unknown): OverlayDirectory | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (r.version !== DIRECTORY_VERSION) return undefined
  if (typeof r.issuedAt !== 'string' || r.issuedAt.length > 40) return undefined
  if (Number.isNaN(Date.parse(r.issuedAt))) return undefined
  if (typeof r.refreshAfterSeconds !== 'number' || !Number.isFinite(r.refreshAfterSeconds)) return undefined
  if (r.refreshAfterSeconds < MIN_REFRESH_SECONDS || r.refreshAfterSeconds > MAX_REFRESH_SECONDS) {
    return undefined
  }
  if (typeof r.network !== 'string' || r.network === '' || r.network.length > 64) return undefined
  const relays = parseEntryList(r.relays)
  if (relays === undefined) return undefined
  const bootstrap = parseEntryList(r.bootstrap)
  if (bootstrap === undefined) return undefined
  if (relays.length === 0 && bootstrap.length === 0) return undefined
  return {
    version: DIRECTORY_VERSION,
    issuedAt: r.issuedAt,
    refreshAfterSeconds: r.refreshAfterSeconds,
    network: r.network,
    relays,
    bootstrap,
  }
}

/**
 * 验签。**受信公钥为空 ⇒ 拒绝**（不可验 = 不接受）—— 这条是 `§A2` 的失败关闭语义，
 * ⛔ 不要"配不上密钥就先用着"，那等于把引导链的信任根交给 MITM（TLS 之外的那一层防线就没了）。
 */
export function verifyDirectory(
  rawDoc: unknown,
  sig: unknown,
  keys: readonly string[],
): DirectoryVerdict {
  const doc = parseDirectory(rawDoc)
  if (doc === undefined) return { ok: false, reason: 'bad-document' }
  if (typeof sig !== 'string' || sig.trim() === '') return { ok: false, reason: 'no-signature' }
  const sigBuf = Buffer.from(sig.trim(), 'base64')
  if (sigBuf.length !== 64) return { ok: false, reason: 'bad-signature-length' }
  if (keys.length === 0) return { ok: false, reason: 'no-trusted-keys' }
  const payload = directoryPayload(doc)
  for (let i = 0; i < keys.length; i += 1) {
    const key = publicKeyFrom(keys[i] ?? '')
    if (key === undefined) continue
    if (cryptoVerify(null, Buffer.from(payload, 'utf8'), key, sigBuf)) {
      return { ok: true, doc, payload, keyIndex: i }
    }
  }
  return { ok: false, reason: 'signature-mismatch' }
}

/** 签发（**只跑在控制面**）。私钥只从内存里的 PEM 字符串进来，⛔ 本模块不读任何密钥文件。 */
export function signDirectory(doc: OverlayDirectory, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`overlay directory key must be ed25519 (got ${String(key.asymmetricKeyType)})`)
  }
  return cryptoSign(null, Buffer.from(directoryPayload(doc), 'utf8'), key).toString('base64')
}

/** 组装一份**已经清洗过**的目录文档（服务端与单测共用，保证两边载荷完全一致）。 */
export function buildDirectoryDocument(input: {
  relays: readonly string[]
  bootstrap: readonly string[]
  network: string
  now: number
  refreshAfterSeconds?: number
}): OverlayDirectory {
  const relays = parseEntryList(input.relays.slice(0, MAX_ENTRIES)) ?? []
  const bootstrap = parseEntryList(input.bootstrap.slice(0, MAX_ENTRIES)) ?? []
  if (relays.length === 0 && bootstrap.length === 0) {
    throw new Error('overlay directory needs at least one relay or bootstrap address')
  }
  const refresh = input.refreshAfterSeconds ?? 300
  if (!Number.isFinite(refresh) || refresh < MIN_REFRESH_SECONDS || refresh > MAX_REFRESH_SECONDS) {
    throw new Error(`invalid refreshAfterSeconds ${String(refresh)}`)
  }
  return {
    version: DIRECTORY_VERSION,
    issuedAt: new Date(input.now).toISOString(),
    refreshAfterSeconds: Math.floor(refresh),
    network: input.network,
    relays,
    bootstrap,
  }
}

// ── 纯函数：地址派生 / 归一化 ───────────────────────────────────────────────

/**
 * 引导地址 → **取目录的 URL**：同 origin、路径固定为 {@link DIRECTORY_PATH}。
 *
 * 约定："**引导地址 = 中继入口同源**"（D3：种子就是 `https://<base-domain>/dsh_ai1net-relay`，
 * 已持证书、不新增域名）⇒ 目录端点只是同一台机器上的另一个路径。
 * 已经是目录地址（path 相同）⇒ 原样返回，便于"目录里直接写目录 URL"。
 */
export function directoryUrlFor(entry: string): string | undefined {
  const raw = parseEntry(entry)
  if (raw === undefined) return undefined
  const u = new URL(raw)
  if (u.pathname !== DIRECTORY_PATH) {
    u.pathname = DIRECTORY_PATH
    u.search = ''
    u.hash = ''
  }
  if (u.protocol === 'wss:') u.protocol = 'https:'
  if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.toString()
}

/**
 * 中继地址归一化：`https→wss` / `http→ws`（`RelayClient` 只吃 ws 方言）。
 * ⛔ 不改路径 —— `/dsh_ai1net-relay` 这个 path 是 nginx 的 location 判据（R2 定的）。
 */
export function toRelayUrl(entry: string): string | undefined {
  const raw = parseEntry(entry)
  if (raw === undefined) return undefined
  const u = new URL(raw)
  if (u.protocol === 'https:') u.protocol = 'wss:'
  else if (u.protocol === 'http:') u.protocol = 'ws:'
  return u.toString()
}

/**
 * 从一份目录里列出**全部候选中继地址**（有序）。
 *
 * 顺序 = `relays[]` → `bootstrap[]`（控制面下发的**有序**清单，⛔ 不重排）；
 * 按 `host` 去重（同一台机器在多条清单里各写一遍只算一个候选）；非法项跳过。
 *
 * ## 为什么需要"全部"而不是"第一个"（本函数存在的理由）
 * 改造前 `pickFromDoc` **取到第一个可用项就 `return`** ⇒ 候选集退化成**单点**：
 * 目录里排第二的那台中继**永远选不中**（除非首位此刻不可用）。后果是"换址"这条路径形同虚设
 * —— 重解析一百次，拿回来的还是同一个字符串 ⇒ 上层按"地址没变"直接 `return`。
 * ⇒ **根因是"候选集退化成单点"，不是"没写重解析"**（对§8.8-1 的证据级细化）。
 */
function listCandidatesFromDoc(doc: OverlayDirectory): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of [...doc.relays, ...doc.bootstrap]) {
    const url = toRelayUrl(candidate)
    if (url === undefined) continue
    const key = hostKeyOf(url)
    if (key === undefined) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
  }
  return out
}

/**
 * 主机键 = `host[:port]`（丢掉 scheme 与 path/query/hash）；不是绝对 URL ⇒ `undefined`。
 *
 * ⚠️ **不能连 scheme 一起比**：目录 origin 是 `https://…`（HTTP 取目录），而清单里的是
 * `wss://…`（中继入口）—— 同一个 host 在两条链路上 scheme 本来就不同。`URL#host` 会把默认端口
 * （80/443/ws 80/wss 443）一并省掉 ⇒ 既"同 host 即同源"，又不会被非默认端口误判成同源。
 */
function hostKeyOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * **同源优先**（443/TCP 兜底）：目录是**哪个 origin 答出来的**，就优先用它的同源中继入口。
 *
 * ## 为什么必须有这一条
 * `relays[]` 是控制面下发的**有序**清单，而 `pickFromDoc` 取的是**首位**（= 主入口）。
 * 于是"主入口不可达、兜底 origin 却能答出目录"这种降级场景里，客户端仍会去连**首位那条**
 * ⇒ 兜底入口**永远轮不到** ——「多一条入口」落不成「CF / 门户 conf 不可用时还能连」，
 * 整个兜底就只剩装饰性（端点能 101，但没有任何客户端会去连它）。
 *
 * ## 它不是新概念
 * 它就是既有约定「**引导地址 = 中继入口同源**」在**选择时刻**的落地
 * （见 `config.ts#overlayBootstrapSeeds` 与 {@link DIRECTORY_PATH} 的注释）。
 *
 * ## 什么时候**不动**
 * - origin 不在文档的 `relays[]` / `bootstrap[]` 里（那它就不是一个中继入口）⇒ 返回 `undefined`，
 *   调用方退回 `pickFromDoc`（**与今天逐字一致**）；
 * - 命中的就是首位 ⇒ 替换是空操作（调用方按字符串比对后不进日志）。
 *
 * ⚠️ 只作用于"**目录被某个 origin 取到手**"这一支；缓存两条路径（② 新鲜缓存 / ④ 过期缓存）没有
 * "答出者"信息 ⇒ 保持原样（代价：CF 打挂后，最多等一个刷新周期 `refreshAfterSeconds` 才切过去）。
 */
function sameOriginRelayUrl(doc: OverlayDirectory, dirUrl: string): string | undefined {
  const target = hostKeyOf(dirUrl)
  if (target === undefined) return undefined
  for (const candidate of [...doc.relays, ...doc.bootstrap]) {
    const url = toRelayUrl(candidate)
    if (url === undefined) continue
    if (hostKeyOf(url) === target) return url
  }
  return undefined
}

/** 单标签主机名 / 回环 / 私网 / 链路本地 / CGNAT / IPv6 ⇒ **不是**可对外公布的地址。 */
function isPublicHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === '') return false
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return false
  }
  if (h.includes(':')) return false // IPv6 一律不公布（避免 `::1` / ULA 漏进目录）
  if (!h.includes('.')) return false // 单标签 = 内网主机名
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m === null) return true // 域名 ⇒ 公布
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0 || a === 127 || a === 10) return false
  if (a === 192 && b === 168) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 169 && b === 254) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT（D1 点名的段）
  return true
}

/**
 * 地址的**语义身份**：同一台机器、同一个口、同一个路径 ⇒ 同一个身份。
 * `https`/`wss` 同属 443、`http`/`ws` 同属 80 ⇒ 按"是否 TLS + 主机 + 有效口 + 路径"归一。
 * 为什么需要它：配置里 `wss://host/dsh_ai1net-relay` 与种子 `https://host/dsh_ai1net-relay` 是**同一个端点**，
 * 不去重就会在目录里出现两条同义项（客户端无碍，但读目录的人会误以为有两个中继）。
 */
function entryIdentity(u: URL): string {
  const secure = u.protocol === 'https:' || u.protocol === 'wss:'
  const port = u.port !== '' ? u.port : secure ? '443' : '80'
  return `${secure ? 'tls' : 'plain'}|${u.hostname.toLowerCase()}:${port}${u.pathname}`
}

/**
 * 选出**可以对外公布**的中继 / 引导地址。
 *
 * ⛔ 回环与私网一律剔除：目录是**公网可读**的 —— 公布 `127.0.0.1:<relay-port>` 对客户端毫无用处，
 * 还白送一份内网拓扑。对齐红线「**权限只准收窄**」（这里收窄的是**暴露面**）。
 * 同一语义身份只保留**首次出现**的那条（⇒ `wss://` 写法优先于同源的 `https://` 写法）。
 */
export function publicRelayEntries(entries: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const raw = parseEntry(entry)
    if (raw === undefined) continue
    const u = new URL(raw)
    if (!isPublicHost(u.hostname)) continue
    const id = entryIdentity(u)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(raw)
  }
  return out
}

// ── IO：缓存读写 ──────────────────────────────────────────────────────────

/** 磁盘上的缓存条目。 */
export interface CachedDirectory {
  doc: OverlayDirectory
  sig: string
  /** 写入时刻（ms）。 */
  fetchedAt: number
}

/**
 * 读缓存。**读也要验签**：缓存文件是本地普通文件，被改坏/被换掉时
 * 必须与"从网上取到脏目录"同等待遇（拒绝），⛔ 不要因为"是本机文件"就免检。
 */
export function readCachedDirectory(
  file: string,
  keys: readonly string[],
  now: number,
): { entry: CachedDirectory; fresh: boolean } | undefined {
  if (file === '') return undefined
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const o = parsed as Record<string, unknown>
  const fetchedAt = typeof o.fetchedAt === 'number' && Number.isFinite(o.fetchedAt) ? o.fetchedAt : Number.NaN
  if (Number.isNaN(fetchedAt)) return undefined
  const verdict = verifyDirectory(o.doc, o.sig, keys)
  if (!verdict.ok) return undefined
  const age = Math.max(0, now - fetchedAt)
  return {
    entry: { doc: verdict.doc, sig: String(o.sig), fetchedAt },
    fresh: age <= verdict.doc.refreshAfterSeconds * 1000,
  }
}

/** 写缓存（同目录临时文件 + `rename`，避免读到写了一半的 JSON）。 */
export function writeCachedDirectory(
  file: string,
  doc: OverlayDirectory,
  sig: string,
  fetchedAt: number,
): void {
  if (file === '') return
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ doc, sig, fetchedAt }, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

// ── 取目录 ────────────────────────────────────────────────────────────────

const DEFAULT_FETCH_TIMEOUT_MS = 5000

type FetchResult =
  | { ok: true; doc: OverlayDirectory; sig: string }
  | { ok: false; reason: string }

/** 取一份目录并当场验签。**验签不过的目录绝不外泄给调用方**（返回的 `ok:false` 不带地址）。 */
async function fetchDirectory(
  url: string,
  keys: readonly string[],
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<FetchResult> {
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }
    const body = (await res.json()) as unknown
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: 'bad-body' }
    }
    const o = body as Record<string, unknown>
    const sig = o.sig
    const doc: Record<string, unknown> = { ...o }
    delete doc.sig
    const verdict = verifyDirectory(doc, sig, keys)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    return { ok: true, doc: verdict.doc, sig: String(sig) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `unreachable: ${msg.slice(0, 80)}` }
  }
}

/** {@link resolveOverlayRelay} 的入参。 */
export interface ResolveOverlayRelayOptions {
  /** env 显式地址（`DSH_AI1NET_RELAY_URL`）；非空 ⇒ **压制一切**，不查目录。 */
  envUrl?: string
  /** 内置种子（D3 的常量位；② 第二地域留空 ⇒ 只填第一条）。 */
  seeds: readonly string[]
  /** 受信目录签名公钥（PEM 或裸 32 字节）。**空 ⇒ 目录一律不接受**。 */
  trustedKeys: readonly string[]
  /** 缓存文件绝对路径；空 ⇒ 不缓存（每次取目录）。 */
  cacheFile?: string
  log?: (line: string) => void
  /** 注入点（单测用）；默认全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /** 注入点（单测用）；默认 `Date.now`。 */
  nowMs?: number
  timeoutMs?: number
  /**
   * **要排除的地址**（中继失败切流）：通常 = "刚刚不健康的那一台"。
   *
   * 语义 = "在这份候选链里**跳过**这些地址，取第一个没被排除的"。作用范围**只在选择这一步**
   * —— ⛔ 它**不会**让任何候选凭空出现：被排除后若没有别的候选，返回 `url: ''`
   * （调用方按"无候选可切"处理 ⇒ **保持原地退避**，见 D6）。
   *
   * 缺省 / 空数组 ⇒ **行为与改造前逐字一致**（D9：存量调用点零影响）。
   */
  exclude?: readonly string[]
  /**
   * **抖动采样表**（骨干稳定选路的输入）。
   *
   * - 缺省（`undefined`）⇒ 用进程级共享 tracker（{@link sharedJitterTracker}）—— **装配点零改动**
   *   就能让"候选链按 jitter 排序"生效（⛔ 不做成"必须注入"：装配点在别的文件里，
   *   注不进去 = 静默失效）。
   * - 显式给 `null` ⇒ **本函数不排序**（夹具/对照实验用）。
   * - 🔴 **零样本 ⇒ 逐字返回原数组**（`D9`）⇒ 改造前后**逐字一致**，本序的零回归就靠这条。
   */
  jitterTracker?: JitterTracker | null
}

/**
 * 引导链算出的**有序候选集**（新增）。
 *
 * 与 {@link OverlayRelayResolution} 的区别：后者只有 `url`（首位），这里给**整条链**，
 * 供"首位不健康时换下一个"使用。`source` / `detail` / `refreshAfterSeconds` 语义不变。
 */
export interface OverlayRelayCandidates {
  /** 有序候选地址（首位 = 改造前的"本次该连的地址"）；空数组 = 取不到任何候选。 */
  urls: readonly string[]
  source: OverlayAddressSource
  detail: string
  refreshAfterSeconds: number
}

/**
 * **引导三级链的单一入口**：给出**整条有序候选链**（起）。
 *
 * 任何情况下都不抛异常（最坏返回 `urls: []`）—— 调用方按"未配 relay"处理即可。
 * ⛔ **取址代码只有这一份**：{@link resolveOverlayRelay} 与 {@link listOverlayRelayCandidates}
 * 都是它的薄包装（另一份取址 = 另一处静默失效，本线已有两次同类教训）。
 */
async function resolveOverlayRelayChain(
  opts: ResolveOverlayRelayOptions,
): Promise<OverlayRelayCandidates> {
  const log = opts.log ?? ((): void => undefined)
  /**
   * （443/TCP 兜底 · L1）：**取目录这一腿也必须走地址覆盖**。
   *
   * 为什么少这一处 L1 就不成立：CF 不可用时，若目录还按 DNS 去取，则第 ③ 步（取目录）会
   * **全 origin 失败**，链只能走到第 ⑤ 步 —— 而 ⑤ 回落的是 `seeds[0]`（主入口 = 同样走 CF）
   * ⇒ 兜底入口永远轮不到。装上覆盖后，兜底 origin 的这一腿直连 47，目录取得回来。
   * ⛔ 未配 `DSH_AI1NET_OVERLAY_ADDR_OVERRIDES` ⇒ 零动作。
   */
  ensureOverlayAddrOverrides(undefined, log)
  const now = opts.nowMs ?? Date.now()
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const seeds = opts.seeds.map((s) => s.trim()).filter((s) => s !== '')
  /**
   * ── **候选排序 = jitter 为主序**（用户口径「连接稳定高效」的落点）──
   *
   * - `opts.jitterTracker === null` ⇒ 不排序（对照实验 / 夹具）；
   * - 缺省 ⇒ 进程级共享 tracker（{@link sharedJitterTracker}）⇒ 装配点**零改动**即生效；
   * - 🔴 **零样本 ⇒ `orderByJitter` 原样返回同一个数组** ⇒ 输出与改造前**逐字一致**
   *   （`D9`；本序的零回归判据就是它 —— `the regression suite` 的 176 条里没有任何一条喂过 jitter 样本）。
   */
  const jitter = opts.jitterTracker === null ? undefined : opts.jitterTracker ?? sharedJitterTracker()
  const jitterOrder = (urls: readonly string[]): readonly string[] => {
    const ordered = orderByJitter(urls, jitter)
    if (ordered !== urls) {
      log(
        `[overlay-dir] ↪ jitter 主序：候选重排（已测样本者按 p95|ΔRTT| 升序在前，未测者保原序在后）` +
          `｜新序 = ${ordered.join(' > ')}｜原序 = ${urls.join(' > ')}`,
      )
    }
    return ordered
  }

  // ① env 显式：运维最后手段。**支持空串=未配**，但配错了（非 http/ws 地址）要明确报一行。
  const envUrl = (opts.envUrl ?? '').trim()
  if (envUrl !== '') {
    const url = toRelayUrl(envUrl)
    if (url !== undefined) {
      log(`[overlay-dir] 取址 = env 显式（压制引导链）：${url}`)
      return { urls: [url], source: 'env', detail: 'env', refreshAfterSeconds: DEFAULT_DIRECTORY_REFRESH_SECONDS }
    }
    log(`[overlay-dir] ⛔ env 里的地址不是 http(s)/ws(s) 绝对 URL ⇒ 忽略它，继续走引导链`)
  }

  const cacheFile = opts.cacheFile ?? ''
  const cached = readCachedDirectory(cacheFile, opts.trustedKeys, now)

  // ② 缓存未过期：直接用（省一次往返；控制面抖动不影响已入网节点）。
  if (cached !== undefined && cached.fresh) {
    const urls = listCandidatesFromDoc(cached.entry.doc)
    if (urls.length > 0) {
      log(`[overlay-dir] 取址 = 缓存目录（未过期，net=${cached.entry.doc.network}）：${urls[0]}（候选 ${urls.length} 条）`)
      return {
        urls: jitterOrder(urls),
        source: 'cache',
        detail: cacheFile,
        refreshAfterSeconds: cached.entry.doc.refreshAfterSeconds,
      }
    }
  }

  // ③ 取目录。**origin 优先取缓存里的 `bootstrap[]`** —— 这就是"引导地址可在线轮换"的落点：
  //    控制面把 bootstrap[] 改成新地址 ⇒ 下一次刷新就去新地址，**不重装**。
  const origins: string[] = []
  for (const candidate of [...(cached?.entry.doc.bootstrap ?? []), ...seeds]) {
    if (!origins.includes(candidate)) origins.push(candidate)
  }
  for (const origin of origins) {
    const dirUrl = directoryUrlFor(origin)
    if (dirUrl === undefined) continue
    const got = await fetchDirectory(dirUrl, opts.trustedKeys, doFetch, timeoutMs)
    if (!got.ok) {
      log(`[overlay-dir] ⚠ 拒绝 ${dirUrl}（${got.reason}）—— 未签名 / 签名不符的目录**不写缓存、不采用**`)
      continue
    }
    writeCachedDirectory(cacheFile, got.doc, got.sig, now)
    /**
     * **同源优先**：谁答出的目录，就先认它的同源中继入口 —— 否则主入口一挂，
     * 客户端会一直去连 `relays[]` 的首位（= 主入口），兜底入口形同不存在。见 {@link sameOriginRelayUrl}。
     *
     * ⚠️ 同源优先必须作用在**整条链**上（"同源那条排第一，原首位排其后"），
     * ⛔ 不是"只看首位" —— 否则候选集又会退化成单点。见 {@link listCandidatesFromDoc}。
     */
    const list = listCandidatesFromDoc(got.doc)
    const base = list[0]
    const sameOrigin = sameOriginRelayUrl(got.doc, dirUrl)
    const urls =
      sameOrigin === undefined ? list : [sameOrigin, ...list.filter((u) => u !== sameOrigin)]
    if (sameOrigin !== undefined && base !== undefined && sameOrigin !== base) {
      log(
        `[overlay-dir] ↪ 同源优先：目录由 ${dirUrl} 答出 ⇒ 采用其同源中继入口 ${sameOrigin}` +
          `（不在 relays[] 首位；首位 ${base} 本次未被采用）`,
      )
    }
    if (urls.length === 0) {
      log(`[overlay-dir] ⚠ ${dirUrl} 的目录里没有可用中继地址 ⇒ 换下一个引导地址`)
      continue
    }
    log(
      `[overlay-dir] 取址 = 签名目录（来自 ${dirUrl}，version=${got.doc.version}，` +
        `net=${got.doc.network}，relays=${got.doc.relays.length}，bootstrap=${got.doc.bootstrap.length}）：${urls[0]}（候选 ${urls.length} 条）`,
    )
    return {
      urls: jitterOrder(urls),
      source: 'seed-directory',
      detail: dirUrl,
      refreshAfterSeconds: got.doc.refreshAfterSeconds,
    }
  }

  // ④ 离线降级：目录全都取不到 / 全被拒 ⇒ 用**过期但签名有效**的缓存（D3 ③）。
  if (cached !== undefined) {
    const urls = listCandidatesFromDoc(cached.entry.doc)
    if (urls.length > 0) {
      log('[overlay-dir] ⚠ 目录不可达 ⇒ 离线降级：用**过期缓存**里的地址（已建连接不受影响）')
      return {
        urls: jitterOrder(urls),
        source: 'stale-cache',
        detail: cacheFile,
        refreshAfterSeconds: cached.entry.doc.refreshAfterSeconds,
      }
    }
  }

  // ⑤ 种子兜底：种子地址本身就是中继入口（同源约定）⇒ 连目录端点挂了也还能起来。
  const first = seeds[0]
  if (first !== undefined) {
    const url = toRelayUrl(first)
    if (url !== undefined) {
      log(`[overlay-dir] ⚠ 取目录全部失败 ⇒ 回落到内置种子地址本身：${url}`)
      return { urls: [url], source: 'seed-fallback', detail: first, refreshAfterSeconds: DEFAULT_DIRECTORY_REFRESH_SECONDS }
    }
  }

  log('[overlay-dir] ⛔ 引导链全部失败且无内置种子 ⇒ 本次不接中继（等同"未配 relay"）')
  return { urls: [], source: 'none', detail: 'none', refreshAfterSeconds: DEFAULT_DIRECTORY_REFRESH_SECONDS }
}

/**
 * **引导链的有序候选集**：把整条链交给调用方，供"当前中继不健康 ⇒ 换下一个"使用。
 *
 * ⛔ 只是 {@link resolveOverlayRelayChain} 的转发 —— **不另写一份取址**。
 * 与 {@link resolveOverlayRelay} 的关系：本函数**不套用 `exclude`**（它要的是"候选全集"）。
 */
export async function listOverlayRelayCandidates(
  opts: ResolveOverlayRelayOptions,
): Promise<OverlayRelayCandidates> {
  return resolveOverlayRelayChain(opts)
}

/**
 * **引导三级链的单一入口**：给出"这次该连哪个中继地址"（= 候选链首位）。
 * 任何情况下都不抛异常（最坏返回 `url: ''`）—— 调用方按"未配 relay"处理即可。
 *
 * 起它是 {@link resolveOverlayRelayChain} 的**薄包装**：链 → 剔除 `exclude` → 取第一个。
 * **`exclude` 缺省时与改造前逐字一致**（D9）。
 */
export async function resolveOverlayRelay(
  opts: ResolveOverlayRelayOptions,
): Promise<OverlayRelayResolution> {
  const chain = await resolveOverlayRelayChain(opts)
  const log = opts.log ?? ((): void => undefined)
  const excluded = opts.exclude ?? []
  if (excluded.length === 0) {
    return {
      url: chain.urls[0] ?? '',
      source: chain.source,
      detail: chain.detail,
      refreshAfterSeconds: chain.refreshAfterSeconds,
    }
  }
  const skip = new Set(excluded)
  const url = chain.urls.find((u) => !skip.has(u))
  if (url === undefined) {
    /**
     * D6：被排除后**没有别的候选** ⇒ 返回空串让调用方"保持原地退避"。
     * ⛔ 绝不静默回退默认机、绝不把候选集外的地址当作兜底（那才是真的 R5）。
     */
    log(
      `[overlay-dir] ⚠ 候选链里除已排除项外无可用地址（候选 ${chain.urls.length} 条，` +
        `排除 ${excluded.length} 条）⇒ 本次不换址（保持原地退避）`,
    )
    return {
      url: '',
      source: chain.source,
      detail: `${chain.detail}|exhausted`,
      refreshAfterSeconds: chain.refreshAfterSeconds,
    }
  }
  return {
    url,
    source: chain.source,
    detail: chain.detail,
    refreshAfterSeconds: chain.refreshAfterSeconds,
  }
}
