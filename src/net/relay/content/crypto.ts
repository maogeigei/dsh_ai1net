/**
 * 内容面**组密钥加密**（覆盖网络线 单 B）—— 让"中继看不到明文载荷"与
 * "按哈希共享块"**同时成立**。
 *
 * ## 一句话说清它是什么
 * 同一个「内容组」`(network, group)` 共享**一把对称密钥**（AES-256-GCM，与 `src/crypto.ts` 同源）；
 * 加密是**确定性**的 ⇒ **同组 + 同明文 ⇒ 密文逐字节相同**（`md5` 相等）
 * ⇒ 原有的"块 id = 内容哈希"照旧成立（**组内共享不退化**），而中继只拿到不透明字节。
 *
 * ## 为什么必须"确定性"（⛔ 不是随便挑的加密模式）
 * 普通 GCM 每次随机 `iv` ⇒ 同明文两次密文不同 ⇒ **块 id 每次都变** ⇒ 去重与 peer 命中**全废**
 * （这正是主判据 `E1` 从 1.00× 退回 4.00× 的路径）。所以：
 * - `iv = HMAC(key, "iv"‖明文) 前 12 字节` —— **由明文决定，不留随机数**；
 * - `k  = HMAC(key, "k"‖iv)` —— 与 `iv` 一一对应 ⇒ **解密侧能复算**（解密时只有密文，没有明文）；
 * - `AAD = "<network>|<group>|<epoch>"` —— 把组与 epoch **绑进认证** ⇒ 跨组 / 跨 epoch 的密文
 *   **在认证阶段就被拒**（⛔ 不靠"解出来是乱码"来判）。
 *
 * 🔑 **唯一的解密实现是本文件的 `decodeBlock`**。它有两个调用点、**同一批字节只过其中一处**：
 * ① `source.ts` 优先级链的统一返回点（**生产路径**：五档一律在这里解密 ⇒ ⛔ 不存在
 *    "local 档不解密、peer 档解密"那种双口径）；
 * ② `chunker.ts#reassemble` 的重组位（**夹具 / 工具路径**）。二者**不叠加**。
 *
 * ## 三条纪律（每条都对应本线踩过的病）
 * 1. **失败关闭且具名**：密钥文件缺失 / 权限不对 / 组名不配 / 密钥形状不对 / epoch 超窗口 ——
 *    五种情形各有**独立原因码**并落计数器。⛔ 绝不出现"以为加密了其实没加"。
 * 2. **计数即判据**：所有判别器都是可断言的数字（⛔ 不许只写日志 —— 探针 `OBS-23` 逐键断言）。
 * 3. **明文不出现**：`plainScans` / `plainLeaks` 是**字节级**自证 ——
 *    对自己刚加密出的字节扫明文标记，命中数必须 **0**；⛔ 记录 / 日志里也不许出现明文标记。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - 不做网络、不做 IO 传输（密钥**只从 `0600` 文件读**，⛔ 不经网络、不经 relay —— 见 §7.2）；
 * - 不引第二套算法栈（⛔ 无 ChaCha / 无 RSA 包裹）；
 * - 不新根、不新签名链：组密钥凭据由**既有签名者**签发，验签走**既有** `identity.ts` 实现。
 *
 * @module dsh_ai1net/net/relay/content/crypto
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { verifySignedPayload } from '../identity.js'
import type { IdentityReason } from '../identity.js'

/** 组密钥凭据的载荷标签（规范拼接用；⛔ 不用 `JSON.stringify`）。 */
export const GROUP_KEY_TAG = 'dsh_ai1net-overlay-groupkey/v1'

/** 组密钥文件的缺省落点（与节点密钥同处 `/etc/dsh_ai1net/`，同样 `0600`）。 */
export const DEFAULT_GROUP_KEY_FILE = '/etc/dsh_ai1net/content-group-key.json'

/** 加密格式版本（进 AAD ⇒ 换代即全量失效，⛔ 不该随手改）。 */
export const CONTENT_CIPHER_VERSION = 1

/** GCM 的 iv 长度（字节）。 */
export const IV_LEN = 12
/** GCM 认证标签长度（字节）。 */
export const TAG_LEN = 16
/** 密文块的最小长度（`iv|tag` 各一段，再加至少 0 字节明文）。 */
export const MIN_BLOB_LEN = IV_LEN + TAG_LEN
/** 密钥长度（AES-256 ⇒ 32 字节）。 */
export const KEY_LEN = 32

/** 组密钥的**可断言**判别器（探针 `OBS-23` 逐键断言 "存在且是 number"）。 */
export const CONTENT_CRYPTO_COUNTER_KEYS = [
  'encrypts',
  'decrypts',
  'decryptRejected',
  'epochs',
  'epoch',
  'epochExpired',
  'detChecks',
  'detMismatches',
  'plainScans',
  'plainLeaks',
] as const

export type ContentCryptoCounterKey = (typeof CONTENT_CRYPTO_COUNTER_KEYS)[number]

export type ContentCryptoCounters = Record<ContentCryptoCounterKey, number>

/** 装载密钥文件失败的原因（**具名** —— ⛔ 不许合并成一句"不可用"）。 */
export type GroupKeyLoadReason =
  | 'no-file'
  | 'bad-perms'
  | 'parse-error'
  | 'group-mismatch'
  | 'bad-key'
  | 'bad-epoch'

/** 装载结果：要么拿到密钥，要么拿到**具名原因**。 */
export type GroupKeyLoadResult =
  | { ok: true; group: string; epoch: number; epochs: number; keyId: string; permsChecked: boolean }
  | { ok: false; reason: GroupKeyLoadReason; detail: string }

/** 组密钥文件里的一条 epoch 记录。 */
export interface GroupKeyEpochEntry {
  epoch: number
  /** base64（32 字节）。 */
  key: string
  /** 该 epoch 的**停止服役时刻**（ISO）。给了才参与"过渡窗口上界"判定。 */
  retiredAt?: string
}

/**
 * 组密钥文件形状（`0600`）。
 *
 * ```json
 * { "version": 1, "group": "relay", "epoch": 2, "key": "<base64 32B>",
 *   "previous": [{ "epoch": 1, "key": "<base64 32B>", "retiredAt": "2026-09-18T00:00:00.000Z" }] }
 * ```
 *
 * ⚠️ `previous` 只**解不写**（S5 的双 epoch 过渡态）；`epoch` = 当前**写入**用 epoch。
 */
export interface GroupKeyFile {
  version?: number
  /** **组名**（与运行时的 `group` 逐字比对）。 */
  group: string
  /** 可选的网名：给了就必须与运行时一致（防"同名不同网"）。 */
  network?: string
  /** 当前写入 epoch。 */
  epoch: number
  /** 当前写入密钥（base64）。 */
  key: string
  /** 仅解不写的历史 epoch。 */
  previous?: GroupKeyEpochEntry[]
}

/** 组密钥凭据（签名者签发；**载荷内不含密钥本体**）。 */
export interface GroupKeyCredential {
  version?: number
  network: string
  group: string
  epoch: number
  /** 密钥指纹 = `sha256(key)` 前 16 hex（⛔ 不是密钥本身）。 */
  keyId: string
  issuedAt: string
}

/** 密钥指纹（可公开）—— 组密钥文件与凭据用它对齐"是不是同一把"。 */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

// ── 凭据：规范载荷 + 解析 + 验签（**复用既有验签实现**，⛔ 不新写第二份） ──────────

/** 规范拼接（字段顺序**写死**；⛔ 改顺序 = 令所有既有签名失效）。 */
export function groupKeyCredentialPayload(doc: GroupKeyCredential): string {
  return [
    GROUP_KEY_TAG,
    `version=${String(doc.version ?? CONTENT_CIPHER_VERSION)}`,
    `network=${doc.network}`,
    `group=${doc.group}`,
    `epoch=${String(doc.epoch)}`,
    `keyId=${doc.keyId}`,
    `issuedAt=${doc.issuedAt}`,
  ].join('\n')
}

/** 解析（**严格**：字段不全 / 类型不对 ⇒ `undefined`，⛔ 不猜、不补默认值）。 */
export function parseGroupKeyCredential(raw: unknown): GroupKeyCredential | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const network = typeof r.network === 'string' ? r.network.trim() : ''
  const group = typeof r.group === 'string' ? r.group.trim() : ''
  const keyId = typeof r.keyId === 'string' ? r.keyId.trim() : ''
  const issuedAt = typeof r.issuedAt === 'string' ? r.issuedAt.trim() : ''
  const epoch = typeof r.epoch === 'number' ? r.epoch : NaN
  if (network === '' || group === '' || keyId === '' || issuedAt === '') return undefined
  if (!Number.isInteger(epoch) || epoch <= 0) return undefined
  const version = typeof r.version === 'number' ? r.version : CONTENT_CIPHER_VERSION
  return { version, network, group, epoch, keyId, issuedAt }
}

/**
 * 用**既有受信签名者**验一份组密钥凭据。
 *
 * ⚠️ 与 `identity.ts` 的四条判据同源：**不可验 = 不接受**（受信签名者为空 ⇒ 拒绝）。
 */
export function verifyGroupKeyCredential(
  doc: unknown,
  sig: unknown,
  trustedSigners: readonly string[],
): { ok: true; doc: GroupKeyCredential } | { ok: false; reason: IdentityReason | 'bad-payload' } {
  const parsed = parseGroupKeyCredential(doc)
  if (parsed === undefined) return { ok: false, reason: 'bad-payload' }
  const verdict = verifySignedPayload(groupKeyCredentialPayload(parsed), sig, trustedSigners)
  if (verdict !== 'ok') return { ok: false, reason: verdict }
  return { ok: true, doc: parsed }
}

// ── 密钥文件装载 ──────────────────────────────────────────────────────────────

/** base64 → 32 字节（形状不对 ⇒ `undefined`）。 */
function decodeKey(b64: unknown): Buffer | undefined {
  if (typeof b64 !== 'string' || b64.trim() === '') return undefined
  let buf: Buffer
  try {
    buf = Buffer.from(b64.trim(), 'base64')
  } catch {
    return undefined
  }
  return buf.length === KEY_LEN ? buf : undefined
}

/** 装载选项。 */
export interface LoadGroupKeyOptions {
  /** 密钥文件路径。 */
  file: string
  /** 运行时组名（必须与文件里的 `group` 一致）。 */
  group: string
  /** 运行时网名（文件里给了 `network` 时必须一致）。 */
  network?: string
  /**
   * 是否强制 `0600` 判定。缺省 = **`process.platform !== 'win32'`**。
   *
   * 🔴 **为什么必须按平台分**（本地实测）：Windows **没有 POSIX 权限位** ——
   * `writeFileSync(p, x, {mode: 0o600})` 之后 `statSync(p).mode & 0o777` 恒为 `666`
   * ⇒ 无条件判会**把每个文件都判成 `bad-perms`**、加密**永远开不起来**。
   * 而生产环境是 Linux ⇒ 判据在那里**必须**成立。
   * ⚠️ 本选项同时是"判据有牙"的证明位（单测用它在本机复现 `bad-perms`）。
   */
  enforcePerms?: boolean
}

/**
 * 从 `0600` 文件装载组密钥。**任一不符 ⇒ 具名失败**（⛔ 静默降级成明文）。
 *
 * 顺序刻意如此：**先看文件在不在 → 再看权限 → 再解析 → 再比对组 / 网 → 再验密钥形状**。
 * 这样"没装"与"装了但配错"在日志里是**两种**原因（本线反复要求的可区分性）。
 */
export function loadGroupKeyFile(opts: LoadGroupKeyOptions): GroupKeyLoadResult {
  let st
  try {
    st = statSync(opts.file)
  } catch {
    return { ok: false, reason: 'no-file', detail: `${opts.file} 不存在或读不到` }
  }
  // 0600 口径：只要 group/other 有任一权限位 ⇒ 判权限错（⛔ 不"自动 chmod"——那会掩盖部署缺陷）
  // ⚠️ POSIX-only：Windows 的 mode 恒 666（无权限位语义）⇒ 默认在那里跳过判定（`permsChecked=false`）
  const enforcePerms = opts.enforcePerms ?? process.platform !== 'win32'
  if (enforcePerms && (st.mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: 'bad-perms',
      detail: `${opts.file} 权限 ${(st.mode & 0o777).toString(8)}（必须 0600）`,
    }
  }
  let parsed: GroupKeyFile
  try {
    parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as GroupKeyFile
  } catch (err) {
    return { ok: false, reason: 'parse-error', detail: String(err) }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'parse-error', detail: '顶层不是对象' }
  }
  if (parsed.group !== opts.group) {
    return {
      ok: false,
      reason: 'group-mismatch',
      detail: `文件 group=${String(parsed.group)} ≠ 运行时 group=${opts.group}`,
    }
  }
  if (parsed.network !== undefined && opts.network !== undefined && parsed.network !== opts.network) {
    return {
      ok: false,
      reason: 'group-mismatch',
      detail: `文件 network=${String(parsed.network)} ≠ 运行时 network=${opts.network}`,
    }
  }
  const write = decodeKey(parsed.key)
  if (write === undefined) {
    return { ok: false, reason: 'bad-key', detail: 'key 不是 base64 的 32 字节' }
  }
  if (!Number.isInteger(parsed.epoch) || parsed.epoch <= 0) {
    return { ok: false, reason: 'bad-epoch', detail: `epoch=${String(parsed.epoch)}（必须是正整数）` }
  }
  let extra = 0
  for (const p of parsed.previous ?? []) {
    if (decodeKey(p?.key) === undefined) {
      return { ok: false, reason: 'bad-key', detail: `previous epoch=${String(p?.epoch)} 的 key 形状不对` }
    }
    if (!Number.isInteger(p.epoch) || p.epoch <= 0) {
      return { ok: false, reason: 'bad-epoch', detail: `previous epoch=${String(p?.epoch)} 必须是正整数` }
    }
    extra += 1
  }
  return {
    ok: true,
    group: parsed.group,
    epoch: parsed.epoch,
    epochs: 1 + extra,
    keyId: keyIdOf(write),
    permsChecked: enforcePerms,
  }
}

/** 装载后的可读回确认（供装配点打一行**不含密钥**的判别器日志）。 */
export function describeGroupKey(file: string, r: GroupKeyLoadResult): string {
  return r.ok
    ? `[content-crypto] 组密钥已装载 file=${file} group=${r.group} epoch=${r.epoch} epochs=${r.epochs} keyId=${r.keyId}` +
        (r.permsChecked ? ' perms=0600 ✓' : ' perms=未判定（Windows 无 POSIX 权限位）')
    : `[content-crypto] ⛔ 不启用加密：${r.reason} —— ${r.detail}`
}

// ── 🆕 C（域分离）：块 id 的 per-network 域密钥 ──────────────────────────────

/**
 * 块 id 域密钥的**派生标签**。
 *
 * 🔴 **改这个字面量 = 全部块 id 换代**（缓存全清、去重率归零重算）⇒ ⛔ 只在换代时动，
 * 且必须与 `E1` 基线重置**同时做**（`04-133 §3.3`）。
 */
export const BLOCK_ID_DOMAIN_TAG = 'dsh_ai1net-overlay-block-id/v1'

/**
 * 🆕 C（域分离）：从**组密钥本体**按 **network 维度**派生块 id 的域密钥。
 *
 * ## 为什么复用组密钥链路（⛔ 不新增密钥文件 / ⛔ 不新增 env）
 * 块 id 的可观测面只有一件：**同一个 id 是否在两个 network 里同时出现**（跨租户相关性）。
 * 要挡住它，只需要**每网一把互不相同的派生钥**；而组密钥已经**按 `(network, group)` 分发到位、
 * `0600` 落盘、可随 epoch 轮换** ⇒ 直接派生即可，无需任何新的运维对象。
 *
 * ## 三条口径（写死）
 * - ✅ **确定性**：同钥同网 ⇒ 同派生钥（否则块 id 次次不同，去重全废）；
 * - ✅ **单向**：只有持组密钥者能算出某个 network 的派生钥 ⇒ **无钥者算不出另一个网的块 id**
 *   （= 跨网 COF / LRI 被切断的那一半）；
 * - ⚠️ **轮换组密钥 ⇒ 派生钥变 ⇒ 块 id 换代**。⚠️ 这与"轮换后密文全变 ⇒ 块 id 全变"**同向**，
 *   ⇒ **不引入额外代价**（密文口径本来就是 `sha256(密文)`）。
 *
 * @param groupKeyMaterial 组密钥本体（32 字节 AES key，**来自 `0600` 文件**）
 * @param network 本节点所属网络标识（`network.ts#OPS_NETWORK` 一类）
 */
export function deriveBlockIdKey(groupKeyMaterial: Buffer, network: string): Buffer {
  return createHmac('sha256', groupKeyMaterial).update(BLOCK_ID_DOMAIN_TAG).update(network, 'utf8').digest()
}

// ── 加解密 ────────────────────────────────────────────────────────────────────

/** `ContentCipher` 构造选项。 */
export interface ContentCipherOptions {
  /** 组键（`` `${network}|${group}` ``）—— 进 AAD，⛔ 不许跨组复用同一把钥。 */
  groupKey: string
  /** 当前**写入** epoch 与它的密钥。 */
  epoch: number
  key: Buffer
  /** 仅解不写的历史 epoch（S5 双 epoch 过渡态）。 */
  previous?: readonly { epoch: number; key: Buffer; retiredAt?: string }[]
  /**
   * 过渡窗口上界（毫秒）。`retiredAt + graceMs < now` ⇒ 该历史 epoch **不再解**
   * （⛔ `decryptRejected` + `epochExpired` 各 +1，并**点名** epoch）。
   * 缺省 **24 h**（`CONTENT_EPOCH_GRACE_MS`）。
   */
  graceMs?: number
  /** 日志函数（⛔ 不许把明文塞进来）。 */
  log?: (line: string) => void
  /** 时钟注入（单测用）。 */
  now?: () => number
}

/** 缺省过渡窗口：24 h（参数表 `CONTENT_EPOCH_GRACE_MS`）。 */
export const DEFAULT_EPOCH_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * 组密钥加解密器。
 *
 * ⚠️ 生命周期：无 IO、无网络、无监听 —— 构造与使用都只碰内存 ⇒ 不触 R5。
 */
export class ContentCipher {
  /** 组键（含网名 —— "同名不同网"必须不同组）。 */
  readonly groupKey: string
  /** 当前写入 epoch。 */
  readonly epoch: number

  private readonly key: Buffer
  private readonly previous: { epoch: number; key: Buffer; retiredAt?: string }[]
  private readonly graceMs: number
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly c: ContentCryptoCounters = {
    encrypts: 0,
    decrypts: 0,
    decryptRejected: 0,
    epochs: 0,
    epoch: 0,
    epochExpired: 0,
    detChecks: 0,
    detMismatches: 0,
    plainScans: 0,
    plainLeaks: 0,
  }

  constructor(opts: ContentCipherOptions) {
    if (opts.key.length !== KEY_LEN) {
      throw new Error(`content-crypto: 密钥必须是 ${KEY_LEN} 字节，收到 ${opts.key.length}`)
    }
    this.key = Buffer.from(opts.key)
    this.epoch = opts.epoch
    this.groupKey = opts.groupKey
    this.previous = (opts.previous ?? []).map((p) => ({
      epoch: p.epoch,
      key: Buffer.from(p.key),
      ...(p.retiredAt === undefined ? {} : { retiredAt: p.retiredAt }),
    }))
    this.graceMs = opts.graceMs ?? DEFAULT_EPOCH_GRACE_MS
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? (() => Date.now())
    this.c.epochs = 1 + this.previous.length
    this.c.epoch = opts.epoch
    // 双 epoch ⇒ 明确留一行（轮换是有代价的动作，⛔ 不许静默发生）
    if (this.previous.length > 0) {
      this.log(
        `[content-crypto] 过渡态：写入 epoch=${this.epoch}，仅解 epoch=[${this.previous.map((p) => p.epoch).join(',')}]` +
          `（窗口 ${this.graceMs} ms）`,
      )
    }
  }

  /** 判别器快照（**拷贝**）。 */
  counters(): ContentCryptoCounters {
    return { ...this.c }
  }

  /** 当前可解的 epoch 列表（写入在前）。 */
  epochs(): number[] {
    return [this.epoch, ...this.previous.map((p) => p.epoch)]
  }

  /** 组密钥指纹（可公开比对；⛔ 不是密钥）。 */
  keyId(): string {
    return keyIdOf(this.key)
  }

  /**
   * 🆕 C（域分离）：**本网**的块 id 域密钥（由当前**写入**密钥派生）。
   *
   * ⚠️ 返回的是**派生钥**（32 B），⛔ **不是密钥本体** —— 但它仍是密钥材料 ⇒
   * 调用方**不许打印、不许进日志、不许进 `/status`**（`/status` 只放 `keyIdOf()` 指纹）。
   */
  blockIdKeyOf(network: string): Buffer {
    return deriveBlockIdKey(this.key, network)
  }

  /** AAD = `<groupKey>|<epoch>` —— 把"组"与"代"绑进认证。 */
  private aadOf(epoch: number): Buffer {
    return Buffer.from(`${this.groupKey}|${epoch}`, 'utf8')
  }

  /** `iv = HMAC(key,"iv"‖plain)` 前 12 字节（**确定性**：同明文同 iv）。 */
  private ivOf(key: Buffer, plain: Buffer): Buffer {
    return createHmac('sha256', key).update('iv').update(plain).digest().subarray(0, IV_LEN)
  }

  /** `k = HMAC(key,"k"‖iv)` —— 解密侧只有 iv，故 k **必须**只由 iv 决定。 */
  private keyOf(key: Buffer, iv: Buffer): Buffer {
    return createHmac('sha256', key).update('k').update(iv).digest()
  }

  /**
   * **确定性**加密一个块。形状 = `iv ‖ tag ‖ 密文`。
   *
   * 三条不变量（单测锁住）：
   * 1. 同组 + 同明文 **两次** ⇒ 返回**逐字节相同**（⇒ 块 id 稳定 ⇒ 共享不退化）；
   * 2. 换 epoch ⇒ 密文**不同**（AAD 与密钥双变）；
   * 3. 换组密钥 ⇒ 密文**不同**。
   */
  encryptBlock(plain: Buffer): Buffer {
    const iv = this.ivOf(this.key, plain)
    const k = this.keyOf(this.key, iv)
    const c = createCipheriv('aes-256-gcm', k, iv)
    c.setAAD(this.aadOf(this.epoch))
    const ct = Buffer.concat([c.update(plain), c.final()])
    const tag = c.getAuthTag()
    this.c.encrypts += 1
    return Buffer.concat([iv, tag, ct])
  }

  /**
   * 解密一个块。**唯一的解密实现**（调用点见文件头）。
   *
   * 判定顺序（每一步失败都有**独立**线索，⛔ 不合并）：
   * ① 形状（太短 ⇒ `too-short`）；② 逐 epoch 试认证（写 epoch 优先）；
   * ③ 解出来的明文**复算 iv 必须等于原 iv**（确定性口径自证 + 非规范输入拦截）。
   *
   * @returns 明文；失败 ⇒ `undefined`（并 `decryptRejected` +1，原因落日志）
   */
  decodeBlock(blob: Buffer): Buffer | undefined {
    if (blob.length < MIN_BLOB_LEN) {
      this.reject('too-short', `长度 ${blob.length} < ${MIN_BLOB_LEN}`)
      return undefined
    }
    const iv = blob.subarray(0, IV_LEN)
    const tag = blob.subarray(IV_LEN, MIN_BLOB_LEN)
    const ct = blob.subarray(MIN_BLOB_LEN)
    const tried: number[] = []
    for (const cand of this.candidates()) {
      tried.push(cand.epoch)
      let plain: Buffer
      try {
        const d = createDecipheriv('aes-256-gcm', this.keyOf(cand.key, iv), iv)
        d.setAAD(this.aadOf(cand.epoch))
        d.setAuthTag(tag)
        plain = Buffer.concat([d.update(ct), d.final()])
      } catch {
        continue // 认证失败（也可能是 epoch 不对）⇒ 试下一个
      }
      const again = this.ivOf(cand.key, plain)
      if (!timingSafeEqual(again, iv)) {
        this.reject('non-canonical', `epoch=${cand.epoch} 复算 iv 不符（非本实现产出？）`)
        return undefined
      }
      this.c.decrypts += 1
      return plain
    }
    this.reject('auth-failed', `认证失败（试过 epoch=[${tried.join(',')}]）`)
    return undefined
  }

  /** 按"过期窗口"过筛后的候选（写入 epoch 恒在；历史 epoch 超窗口即剔除并计数）。 */
  private candidates(): { epoch: number; key: Buffer }[] {
    const out: { epoch: number; key: Buffer }[] = [{ epoch: this.epoch, key: this.key }]
    const now = this.now()
    for (const p of this.previous) {
      if (p.retiredAt !== undefined) {
        const retired = Date.parse(p.retiredAt)
        if (Number.isFinite(retired) && retired + this.graceMs < now) {
          this.c.epochExpired += 1
          this.log(
            `[content-crypto] ⛔ epoch=${p.epoch} 超出过渡窗口（retiredAt=${p.retiredAt} + ${this.graceMs} ms < now）⇒ 不再解`,
          )
          continue
        }
      }
      out.push({ epoch: p.epoch, key: p.key })
    }
    return out
  }

  private reject(reason: string, detail: string): void {
    this.c.decryptRejected += 1
    this.log(`[content-crypto] ⛔ 解密被拒：${reason} —— ${detail}`)
  }

  /**
   * **字节级明文外泄自证**（`OBS-23` 判据③的落点）。
   *
   * 对给定的"已落地字节"扫一段**已知明文标记**：命中数必须为 **0**。
   * ⛔ 本函数**只报计数、不打印字节**（打印就等于把明文写进日志 —— 自证变自毁）。
   */
  scanForPlaintext(bytes: Buffer, marker: string): boolean {
    this.c.plainScans += 1
    if (marker === '') return false
    const hit = bytes.includes(Buffer.from(marker, 'utf8'))
    if (hit) {
      this.c.plainLeaks += 1
      this.log('[content-crypto] ⛔ 明文标记出现在已落地字节里（长度 ' + String(bytes.length) + ' B）')
    }
    return hit
  }
  /**
   * **启动自证**（防"装了但一次都没走过"）：
   * ① 同一明文加密两次 ⇒ 比 `md5`（`detChecks` / `detMismatches`）；
   * ② 加密 → 落存储 → 取回 → 解密 ⇒ 与明文逐字节相同（`decrypts` 兜底）；
   * ③ 对密文做明文标记扫描（`plainScans` / `plainLeaks`）。
   *
   * ⚠️ 判据全落**计数器**（探针读得到）；返回值只给调用方决定要不要打一行日志。
   */
  selfProbe(marker: string, sink: { put: (blob: Buffer) => void; get: () => Buffer | undefined }): boolean {
    const plain = Buffer.from(marker, 'utf8')
    const a = this.encryptBlock(plain)
    const b = this.encryptBlock(plain)
    this.c.detChecks += 1
    const same = a.equals(b)
    if (!same) this.c.detMismatches += 1
    this.scanForPlaintext(a, marker)
    sink.put(a)
    const back = sink.get()
    const roundtrip = back !== undefined && this.decodeBlock(back)?.equals(plain) === true
    if (!same) this.log('[content-crypto] ⛔ 确定性自证失败：同明文两次密文不同（共享会退化）')
    if (!roundtrip) this.log('[content-crypto] ⛔ 取回-解密自证失败（存储或解密链路有问题）')
    return same && roundtrip
  }
}

/**
 * 一步到位：读文件 → 造 cipher（供装配点用）。
 *
 * ⚠️ 刻意**不吞**具名原因：调用方拿到 `{ cipher: undefined, reason }` 后**必须**打一行
 * 判别器日志（⛔ 静默"不启用"= 用户以为加密了）。
 */
export function openContentCipher(opts: {
  file: string
  group: string
  network: string
  graceMs?: number
  log?: (line: string) => void
  now?: () => number
  previous?: readonly { epoch: number; key: Buffer; retiredAt?: string }[]
}): { cipher?: ContentCipher; load: GroupKeyLoadResult } {
  const load = loadGroupKeyFile({ file: opts.file, group: opts.group, network: opts.network })
  if (!load.ok) {
    opts.log?.(describeGroupKey(opts.file, load))
    return { load }
  }
  // 密钥本体**只从文件读**（⛔ 不经网络）：这里重新读一次以拿到 base64 → Buffer。
  const parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as GroupKeyFile
  const key = decodeKey(parsed.key)
  if (key === undefined) {
    const bad: GroupKeyLoadResult = { ok: false, reason: 'bad-key', detail: 'key 形状不对（二次读取）' }
    opts.log?.(describeGroupKey(opts.file, bad))
    return { load: bad }
  }
  const previous = (parsed.previous ?? []).map((p) => ({
    epoch: p.epoch,
    key: decodeKey(p.key) as Buffer,
    ...(p.retiredAt === undefined ? {} : { retiredAt: p.retiredAt }),
  }))
  const cipher = new ContentCipher({
    groupKey: `${opts.network}|${opts.group}`,
    epoch: load.epoch,
    key,
    previous,
    ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
    ...(opts.log === undefined ? {} : { log: opts.log }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  opts.log?.(describeGroupKey(opts.file, load))
  return { cipher, load }
}
