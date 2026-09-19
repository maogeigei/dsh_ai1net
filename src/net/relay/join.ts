/**
 * 覆盖网络 **S3 · join 编排**（序㊱ · 「节点一键加入与分组准入」P1）。
 *
 * ## 它解决的确切问题（缺口 ①：「一键加入」）
 * 今天把一台机器加进覆盖网要**手工做四件事**：
 * ① 装 relay / worker 单元 → ② 配节点密钥 → ③ drop-in 写 `DSH_AI1NET_RELAY_DIALERS` → ④ DB 登记。
 * 全仓**无 join 类入口**（`grep` 实证）。⇒ 本模块把它编成**一条命令的四步**：
 *
 * | 步 | 做什么 | 失败后果（**必须具名**） |
 * |---|---|---|
 * | ① `verify-invite` | 校验邀请凭据（签名 ＋ 网络绑定 ＋ 有效期） | `invite-*` 五条具名原因 |
 * | ② `node-key` | **本机**生成 / 复用节点密钥（**私钥不出机**，`0600`） | `node-key-unwritable` |
 * | ③ `local-config` | 落地本机配置（`0600`） | `local-config-unwritable` |
 * | ④ `register` | 向控制面提交申请（HTTP 或**落盘申请单**） | `register-*` 三条具名原因 |
 *
 * ## 🔴 一条不可退让的纪律：**⛔ 不许静默拒绝**
 * 本线的病根反复是"配置错**长得像**网络不通"。⇒ 本模块**没有** `catch {}` 兜底：
 * 每一步的失败都返回 `{ ok:false, step, reason, detail }`，`detail` 里带**原始**信息
 * （路径 / 原因码 / HTTP 码），调用方（CLI）负责把它**原样打到 stderr** 并 `exit 1`。
 * 判据：源码里**零**空 `catch` 块（`OBS-25` 的机器判据之一）。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - ⛔ 不装服务单元、不写 drop-in、不 reload（那是控制面派生 ＋ 运维动作，不是节点侧的事）；
 * - ⛔ 不落任何**密钥本体**到 stdout / 申请单（申请单里只有**公钥**）；
 * - ⛔ 不自己判"一次性" —— 一笔邀请是否已用过是**控制面台账**的事实（见 `registry.ts#consumeNonce`）。
 *
 * @module dsh_ai1net/net/relay/join
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { assertNetworkId, isHostId } from './network.js'
import { verifyNetworkInvite, type InviteReason } from './registry.js'
import { DEFAULT_DIRECT_ENABLED } from './direct/index.js'

/** 四步（顺序即执行顺序；⛔ 改这个数组 = 改判据口径，`OBS-25` 会读到它）。 */
export const JOIN_STEPS = ['verify-invite', 'node-key', 'local-config', 'register'] as const

export type JoinStep = (typeof JOIN_STEPS)[number]

/**
 * 失败原因（**枚举**，⛔ 不收自由文本）—— 目的：让"哪一步的哪种错"可被机器判。
 *
 * ⚠️ `invite-*` 五条与 `registry.ts#InviteReason` **一一对应**（不是另造一套口径）：
 * 映射表见 {@link joinReasonOfInvite}。
 */
export type JoinReason =
  | 'invite-missing'
  | 'invite-bad-payload'
  | 'invite-no-trusted-signer'
  | 'invite-signature-mismatch'
  | 'invite-expired'
  | 'invite-network-mismatch'
  | 'node-key-unwritable'
  | 'local-config-unwritable'
  | 'register-unreachable'
  | 'register-rejected'
  | 'register-malformed'

/** 邀请验签原因 → join 原因（**唯一映射点**；⛔ 别在别处再写一遍）。 */
export function joinReasonOfInvite(reason: InviteReason): JoinReason {
  switch (reason) {
    case 'bad-payload':
      return 'invite-bad-payload'
    case 'no-trusted-keys':
      return 'invite-no-trusted-signer'
    case 'network-mismatch':
      return 'invite-network-mismatch'
    case 'expired':
      return 'invite-expired'
    case 'not-yet-valid':
      return 'invite-expired'
    default:
      return 'invite-signature-mismatch'
  }
}

/** 单步的执行记录（**成功与失败都记** —— 报告里要能看到"走到哪一步了"）。 */
export interface StepReport {
  step: JoinStep
  ok: boolean
  /** 人读的一行；⛔ 不含任何密钥本体。 */
  detail: string
}

export type JoinOutcome =
  | {
      ok: true
      network: string
      hostId: string
      /** 节点**公钥**（hex）。 */
      nodeKey: string
      /** 申请单落盘路径（`--out` 通道）；HTTP 通道下为 `''`。 */
      applicationFile: string
      /** 控制面返回（HTTP 通道）或 `''`。 */
      ack: string
      steps: StepReport[]
    }
  | { ok: false; step: JoinStep; reason: JoinReason; detail: string; steps: StepReport[] }

/** 外部世界的边界（**全部注入** ⇒ 单测可在临时目录里真跑，⛔ 不 mock 判据）。 */
export interface JoinIo {
  exists(path: string): boolean
  read(path: string): string
  /** 写文件；`mode` 由调用方给（密钥类 `0600`，公开类 `0644`）。 */
  write(path: string, text: string, mode: number): void
  generateNodeKey(): { privateKeyPem: string; publicKey: string }
  publicKeyOfPrivate(privateKeyPem: string): string
  hostname(): string
  /** 提交申请（HTTP 通道）。 */
  post(
    url: string,
    body: string,
  ): Promise<{ status: number; body: string }>
}

export interface JoinOptions {
  /** 要加入的网（`ops` / `u:<租户>` / 显式命名 —— 合法形状由 `network.ts` 判）。 */
  network: string
  hostId: string
  /** 邀请凭据（`{doc, sig}` 的原始 JSON 值；解析与验签都在 `registry.ts`）。 */
  invite: { doc: unknown; sig: unknown }
  /** 受信签名者公钥（hex）。**空 ⇒ 直接失败**（不可验 = 不接受）。 */
  trustedSigners: readonly string[]
  /** 节点私钥落点（缺省 `/etc/dsh_ai1net/node.key`）。 */
  nodeKeyFile: string
  /** 本机配置落点（缺省 `/etc/dsh_ai1net/overlay-node.json`）。 */
  localConfigFile: string
  /** 申请单落盘路径（**离线通道**；与 `portalUrl` 二选一）。 */
  outFile?: string
  /** 控制面入口（**HTTP 通道**；使用它需要控制面已开放接收入口）。 */
  portalUrl?: string
  /**
   * 🆕 序㊵（P2/S5）：本机的**直连（打洞）开关**是否开启。
   *
   * 缺省 = {@link DEFAULT_DIRECT_ENABLED}（**开** —— 用户 2026-09-18 12:22 原话「默认开启提示用户」）。
   * ⚠️ 它只写进**本机配置**（`direct` 字段）—— ⛔ 不写任何 drop-in / env：
   * 节点的直连开关属于"跟着用户走"的那类数据（放实例 / 节点自己的配置），不属于控制面共享值。
   */
  direct?: boolean
  now?: number
}

/** 从主机名派一个合法 `hostId`（非法字符替换为 `-`；⛔ 不猜、不静默回落到 `localhost`）。 */
export function defaultHostId(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 63)
  return v === '' ? '' : v
}

/**
 * 跑完整 join 编排（四步）。
 *
 * ⚠️ **顺序不可颠倒**：先验凭据（否则会为一张无效邀请生成无用的密钥），再生成密钥，
 * 再落地本机配置，最后才向控制面提交（前一步失败 ⇒ **不产生下一步的副作用**）。
 */
export async function runJoin(opts: JoinOptions, io: JoinIo): Promise<JoinOutcome> {
  const steps: StepReport[] = []
  const fail = (step: JoinStep, reason: JoinReason, detail: string): JoinOutcome => {
    steps.push({ step, ok: false, detail: `${reason}：${detail}` })
    return { ok: false, step, reason, detail, steps }
  }

  // ── 形状先判：网络 id / hostId 非法 ⇒ 立即具名失败（⛔ 不"兜个默认网"）───────
  try {
    assertNetworkId(opts.network, 'join 的目标网')
  } catch (err) {
    return fail('verify-invite', 'invite-network-mismatch', err instanceof Error ? err.message : String(err))
  }
  if (!isHostId(opts.hostId)) {
    return fail('verify-invite', 'invite-bad-payload', `hostId 非法：${JSON.stringify(opts.hostId)}`)
  }

  // ── 步 ①：校验邀请凭据 ───────────────────────────────────────────────────
  if (opts.trustedSigners.length === 0) {
    return fail('verify-invite', 'invite-no-trusted-signer', '未配置受信签名者（不可验 = 不接受，⛔ 不降级放行）')
  }
  if (opts.invite === undefined || opts.invite === null) {
    return fail('verify-invite', 'invite-missing', '未提供邀请凭据（--invite）')
  }
  const verdict = verifyNetworkInvite(opts.invite.doc, opts.invite.sig, opts.trustedSigners, {
    network: opts.network,
    now: opts.now,
  })
  if (!verdict.ok) {
    return fail('verify-invite', joinReasonOfInvite(verdict.reason), `invite 验签失败：${verdict.reason}`)
  }
  steps.push({
    step: 'verify-invite',
    ok: true,
    detail: `network=${verdict.doc.network} nonce=${verdict.doc.nonce.slice(0, 8)}… 有效期至 ${verdict.doc.expiresAt || '（未设）'}`,
  })

  // ── 步 ②：节点密钥（**私钥不出机**；已存在 ⇒ 复用，重跑 join 不换钥匙）─────
  let publicKey = ''
  let firstTime = false
  try {
    if (io.exists(opts.nodeKeyFile)) {
      publicKey = io.publicKeyOfPrivate(io.read(opts.nodeKeyFile))
    } else {
      const key = io.generateNodeKey()
      io.write(opts.nodeKeyFile, key.privateKeyPem, 0o600)
      publicKey = key.publicKey
      firstTime = true
    }
  } catch (err) {
    return fail('node-key', 'node-key-unwritable', `${opts.nodeKeyFile}：${err instanceof Error ? err.message : String(err)}`)
  }
  if (publicKey === '') {
    return fail('node-key', 'node-key-unwritable', `${opts.nodeKeyFile} 里推不出公钥（形状非法）`)
  }
  steps.push({
    step: 'node-key',
    ok: true,
    detail: `${firstTime ? '新生成' : '复用既有'}节点密钥 ${opts.nodeKeyFile}（0600）｜公钥指纹 ${publicKey.slice(0, 16)}…`,
  })

  // ── 步 ③：本机配置（`0600`；⛔ 不含私钥本体，只记"私钥在哪"）───────────────
  //   🆕 序㊵（P2/S5）：多记一个 `direct` —— 本机**直连开关**（用户口径「默认开启提示用户」的落点）。
  const directEnabled = opts.direct ?? DEFAULT_DIRECT_ENABLED
  const localConfig = {
    version: 1,
    network: verdict.doc.network,
    hostId: opts.hostId,
    nodeKeyFile: opts.nodeKeyFile,
    nodeKey: publicKey,
    invitedBy: verdict.doc.nonce,
    joinedAt: new Date(opts.now ?? Date.now()).toISOString(),
    /** 🆕 直连（打洞）开关 —— **用户可改**（管理面 / 手改本文件均可）。 */
    direct: directEnabled,
  }
  try {
    io.write(opts.localConfigFile, `${JSON.stringify(localConfig, null, 2)}\n`, 0o600)
  } catch (err) {
    return fail(
      'local-config',
      'local-config-unwritable',
      `${opts.localConfigFile}：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  steps.push({
    step: 'local-config',
    ok: true,
    detail: `已落地 ${opts.localConfigFile}（0600）｜直连(打洞)=${directEnabled ? '开（缺省）' : '关'}`,
  })

  // ── 步 ④：向控制面提交申请 ──────────────────────────────────────────────
  // 🔴 **唯一的申请单构造点** —— 控制面 `apply` 用 `parseApplication` 读它（⛔ 别在这两处各写一份形状）。
  const application = buildApplication({
    hostId: opts.hostId,
    network: verdict.doc.network,
    // 只有公钥 —— 私钥永不出机、永不进这份申请单。
    nodeKey: publicKey,
    appliedAt: new Date(opts.now ?? Date.now()).toISOString(),
    invite: { doc: opts.invite.doc, sig: opts.invite.sig },
  })
  const payload = `${JSON.stringify(application, null, 2)}\n`

  if (typeof opts.portalUrl === 'string' && opts.portalUrl.trim() !== '') {
    let res: { status: number; body: string }
    try {
      res = await io.post(opts.portalUrl.trim(), payload)
    } catch (err) {
      return fail(
        'register',
        'register-unreachable',
        `${opts.portalUrl}：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (res.status < 200 || res.status >= 300) {
      // ⚠️ 控制面拒绝时必须把**它对外的原因码**带回来 —— ⛔ 不许把 4xx 说成"网络不通"。
      return fail('register', 'register-rejected', `HTTP ${res.status}：${res.body.slice(0, 200)}`)
    }
    steps.push({ step: 'register', ok: true, detail: `控制面已受理（HTTP ${res.status}）` })
    return {
      ok: true,
      network: verdict.doc.network,
      hostId: opts.hostId,
      nodeKey: publicKey,
      applicationFile: '',
      ack: res.body.slice(0, 500),
      steps,
    }
  }

  const outFile = opts.outFile ?? ''
  if (outFile === '') {
    return fail(
      'register',
      'register-malformed',
      '既未给 --portal（HTTP 通道）也未给 --out（离线申请单通道）⇒ ⛔ 不静默成功',
    )
  }
  try {
    mkdirSync(dirname(outFile), { recursive: true })
    // `0644`：申请单里只有**公钥**与签名，本就是给控制面看的公开物。
    writeFileSync(outFile, payload, { mode: 0o644 })
  } catch (err) {
    return fail('register', 'register-malformed', `${outFile}：${err instanceof Error ? err.message : String(err)}`)
  }
  steps.push({ step: 'register', ok: true, detail: `申请单已落盘 ${outFile}（0644，只有公钥）` })
  return {
    ok: true,
    network: verdict.doc.network,
    hostId: opts.hostId,
    nodeKey: publicKey,
    applicationFile: outFile,
    ack: '',
    steps,
  }
}

/** **Node 侧**的实现（真的读写文件系统、真的发 HTTP）。⛔ 判据不在这里。 */
export function nodeJoinIo(deps: {
  fss: {
    existsSync: (p: string) => boolean
    readFileSync: (p: string, enc: 'utf8') => string
    writeFileSync: (p: string, data: string, o: { mode: number }) => void
    mkdirSync: (p: string, o: { recursive: boolean }) => void
  }
  crypto: { generateNodeKey: () => { privateKeyPem: string; publicKey: string }; publicKeyOfPrivate: (pem: string) => string }
  os: { hostname: () => string }
  fetchImpl: (url: string, body: string) => Promise<{ status: number; body: string }>
}): JoinIo {
  return {
    exists: (p) => deps.fss.existsSync(p),
    read: (p) => deps.fss.readFileSync(p, 'utf8'),
    write: (p, text, mode) => {
      deps.fss.mkdirSync(dirname(p), { recursive: true })
      deps.fss.writeFileSync(p, text, { mode })
    },
    generateNodeKey: () => deps.crypto.generateNodeKey(),
    publicKeyOfPrivate: (pem) => deps.crypto.publicKeyOfPrivate(pem),
    hostname: () => deps.os.hostname(),
    post: (url, body) => deps.fetchImpl(url, body),
  }
}

/** 读一份邀请 / 申请单文件（`{doc, sig}` 形态；⛔ 形状不对 ⇒ **抛**，不返回 `undefined`）。 */
export function readSignedJson(file: string): { doc: unknown; sig: unknown } {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (raw === null || typeof raw !== 'object') throw new Error(`${file} 不是 {doc, sig} 形态的 JSON`)
  const r = raw as Record<string, unknown>
  if (r.doc === undefined || r.sig === undefined) throw new Error(`${file} 缺 doc / sig 字段`)
  return { doc: r.doc, sig: r.sig }
}

/**
 * **join 申请单**（`register` 步产出的那份东西）。
 *
 * 🔴 **存在的理由（真机首轮实测踩到）**：`join` 写出的是**申请单**（`hostId` / `network` / `nodeKey`
 * / 内嵌的 `invite:{doc,sig}`），而控制面 `apply` 一开始按"裸 `{doc, sig}`"去读 ⇒ **读不出来**
 * （`✗ … 缺 doc / sig 字段`）。两个形状**必须由同一处定义**、并由同一个解析函数读 ——
 * 否则 S3 的产物与 S2 的输入会各自演进、在真机上才暴露（本线"同一事实两处写"的又一例）。
 *
 * ⛔ **载荷内只有公钥** —— 私钥永不出机、永不进这份申请单。
 */
export interface NodeApplication {
  version: number
  hostId: string
  network: string
  /** 节点**公钥**（hex）。 */
  nodeKey: string
  appliedAt: string
  /** 内嵌的邀请凭据（**验签与一次性都由控制面判**）。 */
  invite: { doc: unknown; sig: unknown }
}

/** 构造一份申请单（**唯一构造点** —— `runJoin` 与夹具都走它）。 */
export function buildApplication(a: {
  hostId: string
  network: string
  nodeKey: string
  appliedAt: string
  invite: { doc: unknown; sig: unknown }
}): NodeApplication {
  return {
    version: 1,
    hostId: a.hostId,
    network: a.network,
    nodeKey: a.nodeKey,
    appliedAt: a.appliedAt,
    invite: { doc: a.invite.doc, sig: a.invite.sig },
  }
}

/** 解析申请单（**严格**：字段不全 / 类型不对 ⇒ `undefined`，⛔ 不猜、不补默认值）。 */
export function parseApplication(raw: unknown): NodeApplication | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const hostId = typeof r.hostId === 'string' ? r.hostId.trim() : ''
  const network = typeof r.network === 'string' ? r.network.trim() : ''
  const nodeKey = typeof r.nodeKey === 'string' ? r.nodeKey.trim().toLowerCase() : ''
  const appliedAt = typeof r.appliedAt === 'string' ? r.appliedAt.trim() : ''
  if (!isHostId(hostId) || network === '' || !/^[0-9a-f]{64}$/.test(nodeKey) || appliedAt === '') return undefined
  const inv = r.invite
  if (inv === null || typeof inv !== 'object') return undefined
  const i = inv as Record<string, unknown>
  if (i.doc === undefined || i.sig === undefined) return undefined
  const version = typeof r.version === 'number' ? r.version : 1
  return { version, hostId, network, nodeKey, appliedAt, invite: { doc: i.doc, sig: i.sig } }
}

/** 读一份申请单文件；形状不对 ⇒ **抛**（调用方负责转成具名失败，⛔ 不静默回落）。 */
export function readApplicationFile(file: string): NodeApplication {
  const parsed = parseApplication(JSON.parse(readFileSync(file, 'utf8')))
  if (parsed === undefined) {
    throw new Error(`${file} 不是合法的**申请单**（须含 hostId / network / nodeKey(64hex) / appliedAt / invite.doc / invite.sig）`)
  }
  return parsed
}

/** 一行摘要（给 CLI 收尾打印）。 */
export function describeJoin(outcome: JoinOutcome): string {
  if (outcome.ok) {
    return `✓ join 成功：${outcome.network}/${outcome.hostId}｜公钥 ${outcome.nodeKey.slice(0, 16)}…｜四步 ${outcome.steps.length}/4`
  }
  return `✗ join 失败于「${outcome.step}」：${outcome.reason} — ${outcome.detail}`
}

/** 供 CLI 判断"这个路径能不能写"（⛔ 不真写，避免试错产生半成品）。 */
export function canWrite(file: string): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 兜底：确无该文件时返回 `undefined`（**只用于可选输入**，⛔ 不用于密钥）。 */
export function maybeRead(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}
