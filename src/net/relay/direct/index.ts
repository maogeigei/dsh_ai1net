/**
 * 覆盖网络 **直连（打洞）总装配**（P2 · S5）—— 开关 ＋ 默认值 ＋ 提示 ＋ 降级编排。
 *
 * ## 用户口径（原话，⛔ 别改写成技术题）
 * ```
 * 1 用户可设置，默认开启提示用户  2 乙
 * ```
 * ⇒ 本模块是那三件事的**唯一落点**：
 *
 * | # | 口径 | 落在这里的什么 |
 * |---|---|---|
 * | ① | **用户可设置** | {@link resolveDirectSwitch}：env（运维强制）＞ 节点本地配置（用户设置）＞ **缺省**；{@link writeNodeConfigDirect} 是"用户改"的写入口 |
 * | ② | **默认开启** | {@link DEFAULT_DIRECT_ENABLED} = `true`（⛔ 不是"缺省关、用户主动开"） |
 * | ③ | **提示用户** | {@link DIRECT_HINT_PARTS}（三段：**谁会连进来 / 怎么关 / 关掉不影响什么**） |
 *
 * ## 🔴 开关的三种状态，⛔ 没有第四种
 * `enabled: true` ｜ `enabled: false` ｜ `enabled: null`（**取值非法** —— ⛔ **不许**静默当开、
 * ⛔ 也不许静默当关；调用方必须**具名报错**）。本线所有"配置错长得像网络不通"的事故，
 * 第一步都是"给个缺省值糊过去"。
 *
 * ## 降级编排（关闭 / 打洞失败 ⇒ 全部回落中继）
 * ⛔ **关闭不是功能降级**：P1 已交付的「一键加入 ＋ 分组准入」照旧完整可用，只是跨机流量走中继。
 * 回落必须是**具名**的（`disabled` / `cooldown` / `no-address` / `one-way` / `deadline`），
 * ⛔ 不许出现"没有原因地走了中继"。
 *
 * @module dsh_ai1net/net/relay/direct
 */

import {
  CandidateLedger,
  DIRECT_CAND_MAX_ADDRS,
  DIRECT_CAND_TTL_MS,
  type CandidateContext,
  type CandidateLedgerSnapshot,
  type CandidateReason,
  type CandidateVerdict,
  type DirectAddress,
} from './candidate.js'
import {
  DEFAULT_DIRECT_COOLDOWN_MS,
  DEFAULT_PUNCH_DEADLINE_MS,
  DirectCooldown,
  PUNCH_PORT_BASE,
  PUNCH_PORT_SPAN,
  pickPunchPort,
  runPunchAttempt,
  type PunchAttempt,
  type PunchReason,
} from './punch.js'

/** 总开关的 env 键名（用户口径①）。⚠️ **缺省即可用**（缺省 = 开）⇒ 不写进任何 drop-in 也生效。 */
export const DIRECT_ENV_KEY = 'DSH_AI1NET_OVERLAY_DIRECT'

/** 用户口径②：**默认开启**。⛔ 改它 = 改用户拍过的口径。 */
export const DEFAULT_DIRECT_ENABLED = true

/** 显式**开**的取值（大小写不敏感）。 */
export const DIRECT_ON_VALUES = ['1', 'true', 'on', 'yes'] as const

/** 显式**关**的取值（大小写不敏感）。 */
export const DIRECT_OFF_VALUES = ['0', 'false', 'off', 'no'] as const

/** 节点本地配置的缺省落点（与 `join.ts` 的 `--config` 缺省一致；⛔ 两处必须是同一个值）。 */
export const NODE_CONFIG_FILE_DEFAULT = '/etc/dsh_ai1net/overlay-node.json'

/** 开关解析结果。 */
export interface DirectSwitchState {
  /** 键名（便于日志与观测面**原样**说出"是哪个键在起作用"）。 */
  envKey: string
  /** env 原文（未设 ⇒ `null`）。 */
  raw: string | null
  /** 生效来源 —— ⛔ 三态必须能分开（否则"为什么它是开的"永远说不清）。 */
  source: 'env' | 'node-config' | 'default'
  /** `null` = **取值非法**（⛔ 不许当开也不许当关）。 */
  enabled: boolean | null
  /** 非法时的人读原因（`enabled !== null` 时为空串）。 */
  invalid: string
  /** 缺省值（便于观测面自证"缺省 = 开"）。 */
  defaultEnabled: boolean
}

/**
 * 解析总开关（**唯一解析点**）。
 *
 * 优先级：env（显式设了就以它为准）＞ 节点本地配置的 `direct` ＞ **缺省 = 开**。
 * ⚠️ 为什么 env 优先：它是**运维通道**（"这台机器强制不直连"必须能压过用户设置）；
 * 用户改的是**本地配置**（{@link writeNodeConfigDirect}）—— 两条路各自有明确的主人。
 */
export function resolveDirectSwitch(
  env: Readonly<Record<string, string | undefined>>,
  opts: { localDirect?: boolean; envKey?: string } = {},
): DirectSwitchState {
  const envKey = opts.envKey ?? DIRECT_ENV_KEY
  const defaultEnabled = DEFAULT_DIRECT_ENABLED
  const raw = env[envKey]
  const base = { envKey, defaultEnabled }
  if (raw !== undefined && raw.trim() !== '') {
    const v = raw.trim().toLowerCase()
    if ((DIRECT_ON_VALUES as readonly string[]).includes(v)) {
      return { ...base, raw: raw.trim(), source: 'env', enabled: true, invalid: '' }
    }
    if ((DIRECT_OFF_VALUES as readonly string[]).includes(v)) {
      return { ...base, raw: raw.trim(), source: 'env', enabled: false, invalid: '' }
    }
    return {
      ...base,
      raw: raw.trim(),
      source: 'env',
      enabled: null,
      invalid: `${envKey}=${JSON.stringify(raw.trim())} 既不在开集 ${DIRECT_ON_VALUES.join('/')} 也不在关集 ${DIRECT_OFF_VALUES.join('/')} ⇒ ⛔ 不静默取缺省`,
    }
  }
  if (typeof opts.localDirect === 'boolean') {
    return { ...base, raw: null, source: 'node-config', enabled: opts.localDirect, invalid: '' }
  }
  return { ...base, raw: null, source: 'default', enabled: defaultEnabled, invalid: '' }
}

/** 提示文案的三段（**顺序即语义**，⛔ 别合并成一段 —— 探针按段数判）。 */
export const DIRECT_HINT_PARTS = [
  `① 开启后，**谁**可能直连到这台机器：只有**同一张覆盖网里、且双向都在拨号白名单**里的节点；⛔ 公网任意源、⛔ 跨网节点都连不进来。`,
  `② 怎么关：给本机设 ${DIRECT_ENV_KEY}=0（或 false/off/no）后重启节点服务；也可以在管理面把本机配置里的 direct 改成 false。关闭后**不再绑定任何 UDP 端口**、也**不再发送直连候选**。`,
  `③ 关掉会影响什么：⛔ 不影响接入与准入 —— 一键加入、分组白名单、跨机取块**照旧可用**，跨机流量改走中继；代价只是"多一跳中继"（延迟与中继带宽略升）。`,
] as const

/** 三段提示（数组形态，便于管理面渲染）。 */
export function directHintLines(): string[] {
  return [...DIRECT_HINT_PARTS]
}

/** 三段提示（一行文本形态，供 CLI `stdout` 打印）。 */
export function directHintText(): string {
  return DIRECT_HINT_PARTS.join('\n')
}

/** 降级／拒绝原因的**统一口径**（⛔ 不许出现"没有原因地走了中继"）。 */
export type DirectRefusal = 'disabled' | 'invalid-switch' | PunchReason | CandidateReason

/** 直连总装（**只读观测面 ＋ 编排**；⛔ 它不做传输、不做接线 —— 那是 S6）。 */
export class DirectPath {
  readonly ledger = new CandidateLedger()
  readonly cooldown: DirectCooldown
  private readonly switchState: DirectSwitchState
  private readonly portBase: number
  private readonly portSpan: number
  private readonly deadlineMs: number
  private readonly maxAddrs: number
  private readonly ttlMs: number
  private udpSocketsOpened = 0
  private candidatesEmitted = 0
  private punchOk = 0
  private punchDead = 0
  private last?: PunchAttempt

  constructor(opts: {
    /** 开关解析结果（**必传** —— 避免"忘了解析就用上真值"）。 */
    switchState: DirectSwitchState
    cooldownMs?: number
    portBase?: number
    portSpan?: number
    deadlineMs?: number
    maxAddrs?: number
    ttlMs?: number
  }) {
    this.switchState = opts.switchState
    this.cooldown = new DirectCooldown(opts.cooldownMs ?? DEFAULT_DIRECT_COOLDOWN_MS)
    this.portBase = opts.portBase ?? PUNCH_PORT_BASE
    this.portSpan = opts.portSpan ?? PUNCH_PORT_SPAN
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_PUNCH_DEADLINE_MS
    this.maxAddrs = opts.maxAddrs ?? DIRECT_CAND_MAX_ADDRS
    this.ttlMs = opts.ttlMs ?? DIRECT_CAND_TTL_MS
  }

  /** 生效值：`true` / `false` / `null`（非法）。⛔ 调用方**必须**处理 `null`。 */
  get enabled(): boolean | null {
    return this.switchState.enabled
  }

  /** 候选准入（**关闭 ⇒ 一条都不判、一条都不发**）。 */
  offerCandidate(raw: string, ctx: Omit<CandidateContext, 'maxAddrs' | 'ttlMs'>): CandidateVerdict | { ok: false; reason: DirectRefusal; detail: string } {
    if (this.switchState.enabled !== true) {
      return {
        ok: false,
        reason: this.switchState.enabled === false ? 'disabled' : 'invalid-switch',
        detail:
          this.switchState.enabled === false
            ? `${DIRECT_ENV_KEY} 关闭（来源 ${this.switchState.source}）⇒ ⛔ 不发候选、⛔ 不开 UDP 口`
            : this.switchState.invalid,
      }
    }
    this.candidatesEmitted += 1
    return this.ledger.judge(raw, { ...ctx, maxAddrs: this.maxAddrs, ttlMs: this.ttlMs })
  }

  /**
   * 尝试建立直连（**关闭 ⇒ 零 socket**）。
   *
   * ⛔ 这里**只做探测**：成功与否都不改变"能不能用中继"这件事（回落是无条件的）。
   */
  async attempt(
    peer: string,
    targets: readonly DirectAddress[],
    io: { sleep: (ms: number) => Promise<void> },
    offset = 0,
  ): Promise<PunchAttempt | { ok: false; reason: DirectRefusal; detail: string }> {
    if (this.switchState.enabled !== true) {
      return {
        ok: false,
        reason: this.switchState.enabled === false ? 'disabled' : 'invalid-switch',
        detail:
          this.switchState.enabled === false
            ? `${DIRECT_ENV_KEY} 关闭（来源 ${this.switchState.source}）⇒ ⛔ 不打洞、⛔ 零 UDP socket，直接用中继`
            : this.switchState.invalid,
      }
    }
    const r = await runPunchAttempt(
      {
        peer,
        selfPort: pickPunchPort(this.portBase, this.portSpan, offset),
        targets,
        deadlineMs: this.deadlineMs,
        cooldown: this.cooldown,
        onSocketOpen: () => {
          this.udpSocketsOpened += 1
        },
      },
      io,
    )
    this.last = r
    if (r.ok) this.punchOk += 1
    else if (r.reason !== 'cooldown' && r.reason !== 'no-address') this.punchDead += 1
    return r
  }

  /** **只读观测面**（探针 / 管理面 / 日志共用这一份 —— ⛔ 别各写一套）。 */
  status(): {
    envKey: string
    enabled: boolean | null
    defaultEnabled: boolean
    source: DirectSwitchState['source']
    raw: string | null
    invalid: string
    hint: string[]
    portBase: number
    portSpan: number
    deadlineMs: number
    maxAddrs: number
    cooldownMs: number
    counters: {
      udpSocketsOpened: number
      candidatesEmitted: number
      punchOk: number
      punchDead: number
      cooldownBlocked: number
      candidateSilentRejections: number
    }
    ledger: CandidateLedgerSnapshot
    last: PunchAttempt | null
  } {
    const snap = this.cooldown.snapshot()
    const led = this.ledger.snapshot()
    return {
      envKey: this.switchState.envKey,
      enabled: this.switchState.enabled,
      defaultEnabled: this.switchState.defaultEnabled,
      source: this.switchState.source,
      raw: this.switchState.raw,
      invalid: this.switchState.invalid,
      hint: directHintLines(),
      portBase: this.portBase,
      portSpan: this.portSpan,
      deadlineMs: this.deadlineMs,
      maxAddrs: this.maxAddrs,
      cooldownMs: snap.ms,
      counters: {
        udpSocketsOpened: this.udpSocketsOpened,
        candidatesEmitted: this.candidatesEmitted,
        punchOk: this.punchOk,
        punchDead: this.punchDead,
        cooldownBlocked: snap.blocked,
        candidateSilentRejections: led.silentRejections,
      },
      ledger: led,
      last: this.last ?? null,
    }
  }
}

/** 从节点本地配置里读 `direct`（`undefined` = 没写这一项 ⇒ 走缺省）。 */
export function directFromNodeConfig(raw: unknown): boolean | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const v = (raw as Record<string, unknown>).direct
  return typeof v === 'boolean' ? v : undefined
}

/** 读一读节点本地配置（**形状不对 ⇒ 抛**；文件不存在 ⇒ `undefined`）。 */
export function readNodeConfig(file: string, io: { exists: (p: string) => boolean; read: (p: string) => string }): Record<string, unknown> | undefined {
  if (!io.exists(file)) return undefined
  const parsed: unknown = JSON.parse(io.read(file))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} 不是 JSON 对象（⛔ 不当作"没配置"静默放过）`)
  }
  return parsed as Record<string, unknown>
}

/** 写回结果（**失败必须具名** —— 与 `join.ts` 同一条纪律）。 */
export type NodeConfigWriteOutcome =
  | { ok: true; file: string; direct: boolean }
  | { ok: false; reason: 'node-config-missing' | 'node-config-bad' | 'node-config-unwritable'; detail: string }

/**
 * 把 `direct` 写进节点本地配置（**用户口径①「用户可设置」的写入口**）。
 *
 * 🔴 三条纪律：
 * ① **只改 `direct` 一个字段**（其余字段原样保留 —— ⛔ 不做"顺手规范化"）；
 * ② **文件不存在 ⇒ 具名失败**（`node-config-missing`）—— ⛔ 不静默创建：本地配置的存在本身就意味着
 *    "这台机器跑过 join"，凭空造一个会让节点看起来"加入过"；
 * ③ **原子写 ＋ `0600`**（先写 `<file>.tmp` 再 `rename`）—— 半截文件会让节点**起不来**。
 */
export function writeNodeConfigDirect(
  file: string,
  enabled: boolean,
  io: {
    exists: (p: string) => boolean
    read: (p: string) => string
    write: (p: string, text: string, mode: number) => void
    rename: (from: string, to: string) => void
  },
): NodeConfigWriteOutcome {
  let current: Record<string, unknown> | undefined
  try {
    current = readNodeConfig(file, io)
  } catch (err) {
    return { ok: false, reason: 'node-config-bad', detail: `${file}：${err instanceof Error ? err.message : String(err)}` }
  }
  if (current === undefined) {
    return {
      ok: false,
      reason: 'node-config-missing',
      detail: `${file} 不存在 ⇒ ⛔ 不凭空创建（本机还没跑过 join）`,
    }
  }
  const next = { ...current, direct: enabled }
  const tmp = `${file}.tmp`
  try {
    io.write(tmp, `${JSON.stringify(next, null, 2)}\n`, 0o600)
    io.rename(tmp, file)
  } catch (err) {
    return {
      ok: false,
      reason: 'node-config-unwritable',
      detail: `${file}：${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return { ok: true, file, direct: enabled }
}
