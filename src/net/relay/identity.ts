/**
 * 覆盖网络 **四层密钥模型 + 离线信任根**（一机一钥 / 入网即签名 / 本地校验 / 可单台吊销）。
 *
 * ## 它治的病（一句话）
 * `keys.ts` 的 HMAC 预共享密钥解决的是"**爆炸半径 = 那一台**"，但**没有解决"控制面自己被攻破"**：
 * 密钥表放在控制面（47）上，谁改得动那张表，谁就能塞进一台自己的节点 —— 而所有对端都会照单全收，
 * 因为对端**没有任何独立的判据**可以否决它。
 *
 * ⇒ 本模块引入一个控制面**看不到也改不了**的信任源（根 + 签名者），让"**能不能入网**"这件事
 * 由**节点自己在本地**判定（D2：校验位置 = 节点本地，relay 侧只做**辅助**准入）。
 *
 * ## 四层（形状照抄 Tailnet Lock，见 一份内部推演记录）
 *
 * | 层 | 放哪 | 用途 | 丢失后果 |
 * |---|---|---|---|
 * | **根（离线）** | 用户手里（本工作区 `0600` 文件 / 纸质恢复码 / 离线 U 盘） | **只**授权/撤销"签名者" | 最严重 ⇒ 全网重建 |
 * | **签名者（在线，多把）** | 管理员设备（现网 = <worker-a>，`/etc/dsh_ai1net/overlay-signer-key.pem`） | 签发节点入网凭据 | 换一把（根仍在） |
 * | **节点密钥（每机一把）** | 每台机器（`0600`，属主正确） | 设备身份；对接时证明"握有私钥" | 该设备重签 |
 * | **会话密钥（内存）** | 隧道 | 传输加密 | 无感 |
 *
 * ⚠️ **根密钥的用途边界（⛔ 别搞错）**：它**只用于授权 / 撤销"签名者"** ——
 * **不签发节点、不加密数据、不参与会话**。⇒ "根在线"**不带来任何性能问题**，唯一影响是**安全**
 * 与**恢复**（`设计文档 §4.3.1`）。
 *
 * ## 🔴 四条不可动摇的判据（改动前先读）
 * 1. **失败关闭**：任一校验未命中 ⇒ 返回**带具体原因**的 `ok:false`，⛔ 绝不静默回退到共享凭据、
 *    ⛔ 绝不回落默认机。原因必须**结构化**（`IdentityReason`），否则"配错了"会伪装成"网络不通"
 *    （本线反复复发的那类病，见 `设计文档 §12` 的 A1）。
 * 2. **不可验 = 不接受**：受信根 / 受信签名者为空 ⇒ **拒绝**（与 `directory.ts` 的 `no-trusted-keys` 同款）。
 * 3. **签名覆盖全部字段**：载荷用**规范拼接**（`*Payload()`），⛔ 不用 `JSON.stringify`
 *    （键序变化 ⇒ 载荷变 ⇒ 验签结果随 TS 版本漂移；`directory.ts` 已踩过这条）。
 * 4. **本模块只做身份，不做寻址**：不碰 `network.ts` 的地址规划、不碰 `directory.ts` 的地址下发。
 *    它回答的唯一问题是「**这台机器是不是被授权进入这张网**」。
 *
 * 纯函数（载荷 / 解析 / 签发 / 验签 / 指纹）与 IO（密钥文件读写）分开放 —— 与 `network.ts` /
 * `directory.ts` 同一风格，前者可单测、后者只做搬运。
 *
 * @module dsh_ai1net/net/relay/identity
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey as cryptoCreatePublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { publicKeyFrom } from './directory.js'
import { isHostId, isNetworkId } from './network.js'

/** 文档结构版本。未知版本 ⇒ 拒绝（而不是"尽力解析"）。 */
export const IDENTITY_VERSION = 1

/** 载荷标签：换格式时改这里 ⇒ 老节点**验签失败 ⇒ 失败关闭**（不会误读新格式）。 */
export const SIGNER_SET_TAG = 'dsh_ai1net-overlay-signerset/v1'
export const NODE_GRANT_TAG = 'dsh_ai1net-overlay-nodegrant/v1'
export const REVOCATION_TAG = 'dsh_ai1net-overlay-revocation/v1'

/**
 * Ed25519 会话证明（node proof）的**域分隔串**。
 *
 * 为什么要它：节点私钥**同时**用来签入网凭据的持有证明与握手的挑战签名 —— 两种签名若不带上
 * 各自的域标签，一个签名就可能被搬到另一个场景里重用（跨协议签名混淆）。带上标签后两者互不可用。
 */
export const PROOF_TAG = 'dsh_ai1net-overlay-node-proof/v1'

/** 节点密钥文件的默认落点（**0600**，属主 = 跑 dsh 的那个用户）。 */
export const DEFAULT_NODE_KEY_FILE = '/etc/dsh_ai1net/node.key'

// ── 类型 ────────────────────────────────────────────────────────────────────

/** **签名者集合**（由**根**签发）—— 回答"哪些签名者被授权签发节点"。 */
export interface SignerSet {
  version: number
  /** 该集合所属的网。**签名者只在它被授权的网里有效**（跨网签发 ⇒ 拒）。 */
  network: string
  /** 签发时间（ISO 8601）。 */
  issuedAt: string
  /** 受根授权的签名者公钥（PEM 或裸 32 字节 hex/base64）。 */
  signers: string[]
}

/** **节点入网凭据**（由**签名者**签发）—— 回答"这台机器被授权进入这张网"。 */
export interface NodeGrant {
  version: number
  network: string
  hostId: string
  /** 该节点的公钥（**裸 32 字节 hex 小写**）。 */
  nodeKey: string
  issuedAt: string
  /** 过期时间（ISO 8601）；**空串 = 不过期**（运维网的常驻机器适用，照 Tailnet 的 tagged 语义）。 */
  expiresAt: string
}

/**
 * **吊销清单**（由**签名者**签发）—— 撤销单台 ≈ 只动这一份清单，**不牵动全网换密钥**。
 *
 * ⚠️ 撤销**签名者**不走这里（那是"根签一份新的 SignerSet"的职责）；本清单只撤**节点**。
 */
export interface RevocationList {
  version: number
  network: string
  issuedAt: string
  /** 被撤销的 hostId（再签一份 grant 也不生效 —— 必须先把它从清单里移除）。 */
  hosts: string[]
  /** 被撤销的**节点公钥**（设备被盗场景：hostId 可能被复用，公钥不会）。 */
  nodeKeys: string[]
}

/** 拒绝原因（**结构化**，直接进日志/HELLO_ERR 的 `why`）。 */
export type IdentityReason =
  | 'bad-document'
  | 'no-signature'
  | 'bad-signature-length'
  | 'no-trusted-keys'
  | 'signature-mismatch'
  | 'network-mismatch'
  | 'host-mismatch'
  | 'key-mismatch'
  | 'expired'
  | 'not-yet-valid'
  | 'revoked-host'
  | 'revoked-node-key'

/** 通用验签结论：**失败一律带具体原因**。 */
export type IdentityVerdict<T> = { ok: true; doc: T; payload: string } | { ok: false; reason: IdentityReason }

// ── 纯函数：载荷（规范拼接，⛔ 不用 JSON.stringify）────────────────────────────

export function signerSetPayload(set: SignerSet): string {
  return [SIGNER_SET_TAG, String(set.version), set.network, set.issuedAt, set.signers.join(',')].join('\n')
}

export function nodeGrantPayload(grant: NodeGrant): string {
  return [
    NODE_GRANT_TAG,
    String(grant.version),
    grant.network,
    grant.hostId,
    grant.nodeKey,
    grant.issuedAt,
    grant.expiresAt,
  ].join('\n')
}

export function revocationPayload(list: RevocationList): string {
  return [REVOCATION_TAG, String(list.version), list.network, list.issuedAt, list.hosts.join(','), list.nodeKeys.join(',')].join('\n')
}

/**
 * 会话证明的载荷：`<PROOF_TAG>\n<challenge>`。
 *
 * `challenge` 由调用方决定（relay 握手用 `hostId|ts|nonce|portsCsv`，与本模块解耦）——
 * 本模块只保证"域分隔"与"签名/验签用的是同一个串"。
 */
export function proofPayload(challenge: string): string {
  return `${PROOF_TAG}\n${challenge}`
}

// ── 纯函数：公钥 / 指纹 ───────────────────────────────────────────────────────

/** 裸 32 字节 Ed25519 公钥 → 小写 hex；解析不出来 ⇒ `undefined`。 */
export function normalizePublicKey(spec: string): string | undefined {
  const key = publicKeyFrom(spec)
  if (key === undefined) return undefined
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer
  // SPKI DER 前 12 字节是固定前缀，其后 32 字节即裸公钥（directory.ts 已用同一常量）。
  return der.subarray(der.length - 32).toString('hex')
}

/**
 * 公钥指纹：`sha256(裸 32 字节)` 的前 16 位 hex。
 *
 * **为什么不是直接显示公钥**：指纹是给人看的（日志 / 清点 / 演练报告），16 位 hex 足够唯一，
 * 且**不可反推**。判据里"两台机器指纹不同"要的正是这个。
 * ⚠️ 指纹**不是**校验依据（那是验签的职责）⇒ 永不参与任何准入判断。
 */
export function nodeKeyFingerprint(spec: string): string | undefined {
  const raw = normalizePublicKey(spec)
  if (raw === undefined) return undefined
  return createHash('sha256').update(Buffer.from(raw, 'hex')).digest('hex').slice(0, 16)
}

/**
 * 从**私钥 PEM** 推出对应的裸公钥 hex —— 免去"到处再存一份公钥"的错配风险。
 *
 * Node 的 `createPublicKey()` **直接吃私钥 `KeyObject`**（PKCS#8 里本就带着公钥），
 * 所以这里一行就够；写成函数是为了让"公钥从哪来"在调用方是**同一个**答案。
 */
export function publicKeyOfPrivate(privateKeyPem: string): string {
  const priv = createPrivateKey(privateKeyPem)
  if (priv.asymmetricKeyType !== 'ed25519') {
    throw new Error(`identity key must be ed25519 (got ${String(priv.asymmetricKeyType)})`)
  }
  const der = cryptoCreatePublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer
  return der.subarray(der.length - 32).toString('hex')
}

// ── 纯函数：解析（只校验形状与取值域，**不验签**）─────────────────────────────

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function isoString(v: unknown, maxLen = 40): string | undefined {
  if (typeof v !== 'string' || v.length > maxLen) return undefined
  if (Number.isNaN(Date.parse(v))) return undefined
  return v
}

function specList(v: unknown, max = 16): string[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || item.trim() === '') return undefined
    const norm = normalizePublicKey(item)
    if (norm === undefined) return undefined
    if (!out.includes(norm)) out.push(norm)
  }
  return out
}

/** 严格解析签名者集合。任一条不合规 ⇒ `undefined`（宁可不接受，也不要"半成品"）。 */
export function parseSignerSet(raw: unknown): SignerSet | undefined {
  const r = asRecord(raw)
  if (r === undefined) return undefined
  if (r.version !== IDENTITY_VERSION) return undefined
  const network = typeof r.network === 'string' ? r.network.trim() : ''
  if (!isNetworkId(network)) return undefined
  const issuedAt = isoString(r.issuedAt)
  if (issuedAt === undefined) return undefined
  const signers = specList(r.signers)
  // **空集合 = 无授权签名者** ⇒ 不合法：它会让"签名者全部被撤"与"配置忘了填"长得一样。
  if (signers === undefined || signers.length === 0) return undefined
  return { version: IDENTITY_VERSION, network, issuedAt, signers }
}

/** 严格解析节点凭据。 */
export function parseNodeGrant(raw: unknown): NodeGrant | undefined {
  const r = asRecord(raw)
  if (r === undefined) return undefined
  if (r.version !== IDENTITY_VERSION) return undefined
  const network = typeof r.network === 'string' ? r.network.trim() : ''
  if (!isNetworkId(network)) return undefined
  const hostId = typeof r.hostId === 'string' ? r.hostId.trim() : ''
  if (!isHostId(hostId)) return undefined
  const nodeKey = typeof r.nodeKey === 'string' ? normalizePublicKey(r.nodeKey) : undefined
  if (nodeKey === undefined) return undefined
  const issuedAt = isoString(r.issuedAt)
  if (issuedAt === undefined) return undefined
  // `expiresAt` 允许空串（= 不过期），非空则必须是合法 ISO。
  if (r.expiresAt !== '' && typeof r.expiresAt !== 'string') return undefined
  const expiresAt = r.expiresAt === '' ? '' : isoString(r.expiresAt)
  if (expiresAt === undefined) return undefined
  return { version: IDENTITY_VERSION, network, hostId, nodeKey, issuedAt, expiresAt }
}

/** 严格解析吊销清单。 */
export function parseRevocationList(raw: unknown): RevocationList | undefined {
  const r = asRecord(raw)
  if (r === undefined) return undefined
  if (r.version !== IDENTITY_VERSION) return undefined
  const network = typeof r.network === 'string' ? r.network.trim() : ''
  if (!isNetworkId(network)) return undefined
  const issuedAt = isoString(r.issuedAt)
  if (issuedAt === undefined) return undefined
  const hosts = stringList(r.hosts, 256, (s) => isHostId(s))
  if (hosts === undefined) return undefined
  const nodeKeys = stringList(r.nodeKeys, 256, (s) => normalizePublicKey(s) !== undefined)
  if (nodeKeys === undefined) return undefined
  return {
    version: IDENTITY_VERSION,
    network,
    issuedAt,
    hosts,
    nodeKeys: nodeKeys.map((s) => normalizePublicKey(s) as string),
  }
}

function stringList(v: unknown, max: number, ok: (s: string) => boolean): string[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') return undefined
    const s = item.trim()
    if (s === '' || !ok(s)) return undefined
    if (!out.includes(s)) out.push(s)
  }
  return out
}

// ── 纯函数：签发 / 验签 ───────────────────────────────────────────────────────

/** 通用验签：`sig` 为 base64；`keys` 为受信公钥 spec 列表（PEM 或裸 32 字节）。 */
function verifySigned(payload: string, sig: unknown, keys: readonly string[]): IdentityReason | 'ok' {
  if (typeof sig !== 'string' || sig.trim() === '') return 'no-signature'
  const sigBuf = Buffer.from(sig.trim(), 'base64')
  if (sigBuf.length !== 64) return 'bad-signature-length'
  // **受信公钥为空 ⇒ 拒绝**（不可验 = 不接受）——与 directory.ts 同一条判据。
  if (keys.length === 0) return 'no-trusted-keys'
  const data = Buffer.from(payload, 'utf8')
  for (const spec of keys) {
    const key = publicKeyFrom(spec)
    if (key === undefined) continue
    if (cryptoVerify(null, data, key, sigBuf)) return 'ok'
  }
  return 'signature-mismatch'
}

function signPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`identity key must be ed25519 (got ${String(key.asymmetricKeyType)})`)
  }
  return cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('base64')
}

/**
 * **既有验签实现的唯一出口**（单 B **纯扩展**）。
 *
 * 为什么要有它：内容面的「组密钥凭据」`(network, group, epoch, keyId)` 必须走**同一条**
 * 信任链（同一批受信签名者、同一套"不可验 = 不接受"判据）。⛔ 不允许在 `content/crypto.ts`
 * 里再写一份 `crypto.verify` —— 那会造出**两套验签实现**，日后必然分叉。
 *
 * ⚠️ 本地函数**语义一行未改**（只是把既有 `verifySigned` 暴露出去）：返回值仍是
 * `'ok'` 或**具名** `IdentityReason`（⛔ 不吞错、⛔ 不合并原因）。
 */
export function verifySignedPayload(
  payload: string,
  sig: unknown,
  trustedKeys: readonly string[],
): IdentityReason | 'ok' {
  return verifySigned(payload, sig, trustedKeys)
}

/**
 * **既有签发实现的唯一出口**（与上面的 `verifySignedPayload` 成对；单 B **纯扩展**）。
 *
 * 用途：组密钥凭据的**签发**要走同一把签名者钥匙、同一套规范载荷（`*Payload()`）——
 * ⛔ 不许在 CLI 里另写一份 `crypto.sign`。⚠️ 仍然**强制 `ed25519`**（`signPayload` 内校验）。
 */
export function signPayloadWith(privateKeyPem: string, payload: string): string {
  return signPayload(payload, privateKeyPem)
}

/** 验一份签名者集合（是否被**根**授权）。 */
export function verifySignerSet(raw: unknown, sig: unknown, trustedRootKeys: readonly string[]): IdentityVerdict<SignerSet> {
  const doc = parseSignerSet(raw)
  if (doc === undefined) return { ok: false, reason: 'bad-document' }
  const payload = signerSetPayload(doc)
  const verdict = verifySigned(payload, sig, trustedRootKeys)
  if (verdict !== 'ok') return { ok: false, reason: verdict }
  return { ok: true, doc, payload }
}

/** 验一份节点凭据（是否由**受信签名者**签发）。 */
export function verifyNodeGrant(
  raw: unknown,
  sig: unknown,
  trustedSignerKeys: readonly string[],
): IdentityVerdict<NodeGrant> {
  const doc = parseNodeGrant(raw)
  if (doc === undefined) return { ok: false, reason: 'bad-document' }
  const payload = nodeGrantPayload(doc)
  const verdict = verifySigned(payload, sig, trustedSignerKeys)
  if (verdict !== 'ok') return { ok: false, reason: verdict }
  return { ok: true, doc, payload }
}

/** 验一份吊销清单（是否由**受信签名者**签发）。 */
export function verifyRevocations(
  raw: unknown,
  sig: unknown,
  trustedSignerKeys: readonly string[],
): IdentityVerdict<RevocationList> {
  const doc = parseRevocationList(raw)
  if (doc === undefined) return { ok: false, reason: 'bad-document' }
  const payload = revocationPayload(doc)
  const verdict = verifySigned(payload, sig, trustedSignerKeys)
  if (verdict !== 'ok') return { ok: false, reason: verdict }
  return { ok: true, doc, payload }
}

/** 签发签名者集合（**只跑在离线的根密钥持有者那一侧**）。 */
export function signSignerSet(set: SignerSet, rootPrivateKeyPem: string): string {
  return signPayload(signerSetPayload(set), rootPrivateKeyPem)
}

/** 签发节点凭据（跑在**在线签名者**那一侧，现网 = <worker-a>）。 */
export function signNodeGrant(grant: NodeGrant, signerPrivateKeyPem: string): string {
  return signPayload(nodeGrantPayload(grant), signerPrivateKeyPem)
}

/** 签发吊销清单（跑在**在线签名者**那一侧）。 */
export function signRevocations(list: RevocationList, signerPrivateKeyPem: string): string {
  return signPayload(revocationPayload(list), signerPrivateKeyPem)
}

/** 会话证明：用**节点私钥**对挑战签名（证明"握有私钥"，光有凭据不够）。 */
export function signProof(nodePrivateKeyPem: string, challenge: string): string {
  return signPayload(proofPayload(challenge), nodePrivateKeyPem)
}

/** 验会话证明。**公钥解析不出来 ⇒ 拒**（不静默当作"这张网没有身份要求"）。 */
export function verifyProof(nodeKeySpec: string, challenge: string, sig: unknown): boolean {
  const key = publicKeyFrom(nodeKeySpec)
  if (key === undefined) return false
  if (typeof sig !== 'string' || sig.trim() === '') return false
  const sigBuf = Buffer.from(sig.trim(), 'base64')
  if (sigBuf.length !== 64) return false
  return cryptoVerify(null, Buffer.from(proofPayload(challenge), 'utf8'), key, sigBuf)
}

// ── 本地校验的单一入口（**节点自己判**，D2）──────────────────────────────────

/** {@link verifyPeerGrant} 的上下文。 */
export interface PeerVerifyContext {
  /** 受根授权的签名者公钥（**直接**受信；要么来自 env，要么来自一份已验签的 SignerSet）。 */
  trustedSignerKeys: readonly string[]
  /** 期望的网。给 ⇒ 必须一致（跨网签发 ⇒ `network-mismatch`）。 */
  network?: string
  /** 期望的 hostId。给 ⇒ 必须一致（凭据被搬到别的 hostId 上 ⇒ `host-mismatch`）。 */
  hostId?: string
  /** 期望的节点公钥（**裸 32 字节 hex**）。给 ⇒ 必须一致（私钥被换过 ⇒ `key-mismatch`）。 */
  nodeKey?: string
  /** 当前有效的吊销清单（已验签；未配 ⇒ 只警告不拒 —— 见 `loadRevocations`）。 */
  revocations?: RevocationList
  /** 注入点：默认 `Date.now()`。 */
  nowMs?: number
}

/**
 * **本地校验一份对端凭据** —— 本模块唯一的高层入口（relay 与各节点都调它）。
 *
 * 校验顺序（**先结构、再签名、再语义、最后吊销**）：任何一个不过 ⇒ 立即带原因返回。
 * ⛔ 绝不"跳过某一步继续"：那种"尽力而为"的校验正是"看起来验过了"的来源。
 */
export function verifyPeerGrant(
  raw: unknown,
  sig: unknown,
  ctx: PeerVerifyContext,
): IdentityVerdict<NodeGrant> {
  const verdict = verifyNodeGrant(raw, sig, ctx.trustedSignerKeys)
  if (!verdict.ok) return verdict
  const g = verdict.doc
  if (ctx.network !== undefined && g.network !== ctx.network) return { ok: false, reason: 'network-mismatch' }
  if (ctx.hostId !== undefined && g.hostId !== ctx.hostId) return { ok: false, reason: 'host-mismatch' }
  if (ctx.nodeKey !== undefined && g.nodeKey !== normalizePublicKey(ctx.nodeKey)) {
    return { ok: false, reason: 'key-mismatch' }
  }
  const now = ctx.nowMs ?? Date.now()
  const issued = Date.parse(g.issuedAt)
  // 允许 5 分钟的签发时刻容差（签发机与校验机的时钟不可能逐毫秒对齐）。
  if (Number.isFinite(issued) && issued > now + 5 * 60_000) return { ok: false, reason: 'not-yet-valid' }
  if (g.expiresAt !== '') {
    const exp = Date.parse(g.expiresAt)
    if (Number.isFinite(exp) && exp <= now) return { ok: false, reason: 'expired' }
  }
  const rev = ctx.revocations
  if (rev !== undefined) {
    // 吊销清单与凭据必须**同网**；不同网 ⇒ 清单不适用（凭据本身已通过 network 校验）。
    if (rev.network === g.network) {
      if (rev.hosts.includes(g.hostId)) return { ok: false, reason: 'revoked-host' }
      if (rev.nodeKeys.includes(g.nodeKey)) return { ok: false, reason: 'revoked-node-key' }
    }
  }
  return verdict
}

// ── 环境变量（relay 独立进程与 dsh 进程共用同一套口径）──────────────────────

function envList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]
  if (raw === undefined) return []
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
}

/**
 * 受信**根**公钥（用于验 `SignerSet`）。
 *
 * ⚠️ 与 `directory.ts` 的 `DSH_AI1NET_OVERLAY_DIR_PUBKEYS` 是**两把不同的密钥、两个不同的用途**：
 * 那把签"地址目录"（可轮换的下发物），这把签"签名者名单"（身份根）。⛔ 不要合并成一个变量 ——
 * 合并等于让"能换地址的人"顺带能加签名者。
 */
export function identityEnvTrustedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return envList(env, 'DSH_AI1NET_OVERLAY_ROOT_PUBKEYS')
}

/** 受信**签名者**公钥（快速通道：直接信任某把签名者，不必先摆一份 SignerSet）。 */
export function identityEnvTrustedSigners(env: NodeJS.ProcessEnv = process.env): string[] {
  return envList(env, 'DSH_AI1NET_OVERLAY_SIGNER_PUBKEYS')
}

/** 是否**强制**要求节点凭据（`1` / `true` / `yes` ⇒ 开）。缺省关（存量节点平滑过渡，见 §8）。 */
export function identityEnvRequire(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DSH_AI1NET_OVERLAY_REQUIRE_IDENTITY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

// ── IO：密钥与凭据文件（只做搬运，判据全在上面）─────────────────────────────

/** 生成一把 Ed25519 节点密钥。返回**私钥 PEM** 与**裸公钥 hex**。 */
export function generateNodeKey(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  return { privateKeyPem, publicKey: der.subarray(der.length - 32).toString('hex') }
}

/** 生成一把 Ed25519 根 / 签名者密钥（同形，分开只为读起来不漏"这把是干什么用的"）。 */
export const generateAuthorityKey = generateNodeKey

function writeFile0600(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
  // `mode` 在**已存在**的文件上不生效（rename 覆盖时权限随 tmp）⇒ 显式再 chmod 一次，
  // 保证"恢复演练 / 重签"之后权限仍然收窄（否则一次 rename 就能把 0600 悄悄放宽）。
  chmodSync(file, 0o600)
}

/**
 * **读或生成**节点密钥（`0600`）。
 *
 * ⛔ 不"生成一把临时的顶上去"：身份是**长期**的，静默生成新身份 = 让"这台机器被吊销过"
 * 这件事在下一次重启后自动失效（吊销形同虚设）。
 */
export function loadOrCreateNodeKey(
  file: string,
  log: (line: string) => void = (): void => undefined,
): { privateKeyPem: string; publicKey: string; created: boolean } {
  if (file === '') throw new Error('node key file path is empty')
  if (existsSync(file)) {
    const privateKeyPem = readFileSync(file, 'utf8')
    const publicKey = publicKeyOfPrivate(privateKeyPem)
    // 权限收窄是**幂等**的：每次装载都确认一遍（被人 `chmod 644` 过也能自愈）。
    chmodSync(file, 0o600)
    return { privateKeyPem, publicKey, created: false }
  }
  const key = generateNodeKey()
  writeFile0600(file, key.privateKeyPem)
  log(`[identity] 生成新节点密钥：${file}（0600）指纹=${nodeKeyFingerprint(key.publicKey) ?? '-'}`)
  return { ...key, created: true }
}

/** 读一份 `{doc, sig}` 形式的签名文件；文件不存在 ⇒ `undefined`（**不抛**，便于"未配"分支）。 */
export function readSignedFile(file: string): { doc: unknown; sig: unknown } | undefined {
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
  const r = asRecord(parsed)
  if (r === undefined) return undefined
  return { doc: r.doc, sig: r.sig }
}

/** 写一份 `{doc, sig}` 形式的签名文件（同目录临时文件 + `rename`，**0600**）。 */
export function writeSignedFile(file: string, doc: unknown, sig: string): void {
  if (file === '') throw new Error('signed file path is empty')
  writeFile0600(file, `${JSON.stringify({ doc, sig }, null, 2)}\n`)
}

/**
 * 装载**受信签名者**：`SignerSet`（经根验签）+ env 里直接列的签名者。
 *
 * ## 失败关闭在这个函数里的确切形态
 * - 没配根、也没配签名者 ⇒ 返回 `{ keys: [] }`（调用方据此判定"不可验 = 不接受"）；
 * - **配了根、但 SignerSet 读不到 / 验不过** ⇒ 返回 `{ keys: [], error }` —— ⛔ **不回落**到
 *   "那先用 env 里那几个吧"：那种回落会让"签名者名单被换掉"表现成"一切正常"。
 *
 * ⚠️ 返回的签名者**还要过一道网校验**（`set.network` 必须等于本机所在网）—— 由调用方传入
 * `network` 完成（这里不猜本机在哪张网）。
 */
export function loadTrustedSigners(opts: {
  roots: readonly string[]
  directSigners: readonly string[]
  signerSetFile?: string
  network?: string
  log?: (line: string) => void
}): { keys: string[]; error?: string; signerSet?: SignerSet } {
  const log = opts.log ?? ((): void => undefined)
  const keys: string[] = [...opts.directSigners]
  let signerSet: SignerSet | undefined

  const file = opts.signerSetFile ?? ''
  if (file === '') {
    // 无签名者集合文件：只剩"直接受信签名者"这一条路（开发期形态）。
    return { keys }
  }
  const loaded = readSignedFile(file)
  if (loaded === undefined) {
    return { keys: [], error: `signer-set-unreadable: ${file}` }
  }
  const verdict = verifySignerSet(loaded.doc, loaded.sig, opts.roots)
  if (!verdict.ok) {
    return { keys: [], error: `signer-set-rejected: ${verdict.reason}` }
  }
  signerSet = verdict.doc
  if (opts.network !== undefined && signerSet.network !== opts.network) {
    return { keys: [], error: `signer-set-network-mismatch: ${signerSet.network} != ${opts.network}` }
  }
  for (const k of signerSet.signers) if (!keys.includes(k)) keys.push(k)
  log(`[identity] 受信签名者 ${keys.length} 把（来自 ${file}，net=${signerSet.network}，经根验签通过）`)
  return { keys, signerSet }
}

/**
 * 装载**吊销清单**（经签名者验签）。
 *
 * ⚠️ 与签名者集合**不同的一条**：清单**没配** ⇒ 返回 `undefined` 但**不报错**
 * （`keys.ts` 的 HMAC 已经把"未登记的 hostId"挡住了，吊销清单是"已登记但被撤"的这一层）；
 * 清单**配了却验不过** ⇒ 返回 `{ error }`，调用方必须**拒**（清单被改坏 ⇒ 撤销失效 ⇒ 不能当没事）。
 */
export function loadRevocations(opts: {
  file?: string
  trustedSignerKeys: readonly string[]
  log?: (line: string) => void
}): { list?: RevocationList; error?: string } {
  const file = opts.file ?? ''
  if (file === '') return {}
  const loaded = readSignedFile(file)
  if (loaded === undefined) return { error: `revocations-unreadable: ${file}` }
  const verdict = verifyRevocations(loaded.doc, loaded.sig, opts.trustedSignerKeys)
  if (!verdict.ok) return { error: `revocations-rejected: ${verdict.reason}` }
  opts.log?.(`[identity] 吊销清单：net=${verdict.doc.network} hosts=[${verdict.doc.hosts.join(',')}] nodeKeys=${verdict.doc.nodeKeys.length}`)
  return { list: verdict.doc }
}

/** 装载本机的 `{grant, sig}`；未配 ⇒ `undefined`（调用方按"本机还没入网凭据"处理）。 */
export function loadNodeGrant(file: string): { grant: NodeGrant; sig: string } | undefined {
  const loaded = readSignedFile(file)
  if (loaded === undefined) return undefined
  const grant = parseNodeGrant(loaded.doc)
  if (grant === undefined || typeof loaded.sig !== 'string') return undefined
  return { grant, sig: loaded.sig }
}

/**
 * **本机节点身份**（relay 客户端侧的唯一装配入口）—— `main.ts` / worker / Manager 都走它。
 *
 * 返回 `undefined` 的确切语义是「**本机没有身份可用**」，而不是「身份校验通过」：
 * - 密钥文件或凭据文件**任一没配** ⇒ `undefined`（过渡期形态：只做 HMAC）；
 * - 配了却**读不出来 / 凭据不合法** ⇒ **抛**（⛔ 不静默退化成"没身份" ——
 *   那会让"凭据坏了"表现成"relay 没要求身份时一切正常"，等 relay 一开强制就整台失联，
 *   而排障时看到的是"配置明明写了"）。
 *
 * ⚠️ 这里**不校验凭据签名**（那是 relay 与本机对端的事）：本机只是"把我的证书带上"。
 * 本机对**自己**的凭据也不做本地校验 —— 它若无效，relay 会明确拒（`identity-*` 原因码），
 * 那条日志才是可诊断的那一条。
 */
export function loadClientIdentity(opts: {
  keyFile: string
  grantFile: string
  log?: (line: string) => void
}): { privateKeyPem: string; grant: NodeGrant; grantSig: string } | undefined {
  const keyFile = (opts.keyFile ?? '').trim()
  const grantFile = (opts.grantFile ?? '').trim()
  if (keyFile === '' || grantFile === '') return undefined
  const node = loadOrCreateNodeKey(keyFile, opts.log)
  const loaded = loadNodeGrant(grantFile)
  if (loaded === undefined) {
    throw new Error(`node grant file ${grantFile} is missing or malformed (need {"doc":{...},"sig":"<base64>"})`)
  }
  opts.log?.(
    `[identity] 本机节点 ${loaded.grant.network}/${loaded.grant.hostId} 指纹=${nodeKeyFingerprint(node.publicKey) ?? '-'}`,
  )
  return { privateKeyPem: node.privateKeyPem, grant: loaded.grant, grantSig: loaded.sig }
}
