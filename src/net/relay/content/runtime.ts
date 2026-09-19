/**
 * 内容面**运行时装配**（覆盖网络线 内容分发）—— 把三个零件装成一个"能报数"的整体。
 *
 * ## 为什么要有这个文件
 * `chunker` / `store` / `source` / `peer` 四个模块都是**纯零件**：它们各自算账，
 * 但**没人把它们装起来**。而 relay 是**独立进程**，它的 `/status` 里没有 `content` 块
 * ⇒ `OBS-17` 在真机模式天生读不到判别器（首轮实测：`FAIL OBS-17 ❌ 缺 content 块缺失`）。
 *
 * ⛔ **不合成的后果**（本线的老毛病）：要么靠 `--content-fixture` 假夹具凑绿（假绿），
 * 要么让 `OBS-17` 永远红（判据形同不存在）。两条都不是"解决问题"。
 *
 * ## 本模块的三条纪律
 * 1. **计数即真相**：`snapshot()` 直读四个零件的 `counters()`，⛔ 不做二次加工、
 *    ⛔ 不补零、⛔ 不"看起来有就行"。缺一档就缺一档 —— 探针会逐键点名。
 * 2. **键名与探针同构**：`source` 五档 / `peer` 五键 / `store` 七键的键名**必须**和
 *    `source.ts` `PEER_COUNTER_KEYS` `ContentStoreCounters` 完全一致
 *    （探针 `OBS-17` 是逐键 `typeof === 'number'` 断言的，改名 = 静默失效）。
 * 3. **纯新增、可选、缺省可用**：relay 侧没装内容面时，`snapshot()` 返回 `undefined`
 *    ⇒ `/status` 不含 `content` 键 ⇒ 与之前的字节级兼容（⛔ 不改任何既有字段）。
 *
 * ## 🆕 S6：`peer` 档**接线**（优先直连 → 回落 wss）
 * 原有的 `peer` 档是**诚实回"没有"**的空壳（取回通道未接线）。S6 把它接上**两条通道**：
 *
 * | 顺序 | 通道 | 是什么 |
 * |---|---|---|
 * | ① | `direct` | S5 的直连（打洞）通道 —— **同时复用 S5 的准入判定**（`candidate.ts#admitCandidate`，其后端是 `network.ts#isAllowedDialer`） |
 * | ② | `wss` | 既有 wss 取回通道（**注入位**；relay 协议侧暂无内容取回 op ⇒ 缺省 = 具名 `not-wired`） |
 *
 * 🔴 **D7 闸门（本模块最要紧的一行逻辑）**：取回的**落库字节**必须**复算**出与请求相同的块 id
 * （`chunker#blockIdOf`）。不复算的接线会把"零回源"直接做成假绿 —— 块 id 口径一动，
 * "命中 peer" 仍然全绿，而内容已经拼不上。
 *
 * ## ⛔ 本模块**不做**的事
 * - 不做网络取块（peer 的真实取回通道在真机验证阶段由上层接线）；
 * - **不做准入判定**：直连候选只从 {@link ContentRuntime.noteDirectCandidate} 进来，
 *   而它只收 S5 `CandidateLedger#judge` 判过 `ok:true` 的结果 ⇒ ⛔ 本模块**不另写一份白名单**；
 * - 不做直连**数据面**（打洞成功后的块交换需要 UDP 应答端 = 新暴露面 ⇒ 独立后续项，
 *   现状按具名 `data-plane-pending` 回落到 wss，⛔ 不静默当"没有"）；
 * - 不读 `src/config.ts`（relay 是独立单元，见 `main.ts` 头部说明）；
 * - 不写日志（日志在装配点给；本模块只负责**算账与报数**）。
 *
 * @module dsh_ai1net/net/relay/content/runtime
 */

import { ContentPeerGroup } from './peer.js'
import type { PeerCounters } from './peer.js'
import { ContentSourceChain } from './source.js'
import type { SourceHitCounters, SourceTier } from './source.js'
import { ContentStore, DEFAULT_MAX_BYTES } from './store.js'
import type { ContentStoreCounters } from './store.js'
import { chunkify, planOf, reassemble, blockIdOf, DEFAULT_BLOCK_SIZE } from './chunker.js'
import type { ChunkTransforms } from './chunker.js'
import { keyIdOf } from './crypto.js'
import type { ContentCipher, ContentCryptoCounters } from './crypto.js'
import { DIRECT_CAND_MAX_ADDRS, isValidAddress } from '../direct/candidate.js'
import type { CandidateVerdict, DirectAddress } from '../direct/candidate.js'
import { DEFAULT_DIRECT_COOLDOWN_MS, DirectCooldown } from '../direct/punch.js'
import { DIRECT_ENV_KEY, resolveDirectSwitch } from '../direct/index.js'
import type { DirectSwitchState } from '../direct/index.js'

/* ── 🆕 S6：`peer` 档取块**通道**（接线） ───────────────────────────────────────── */

/** peer 档取块通道名。 */
export type PeerChannelName = 'direct' | 'wss'

/**
 * 🔴 通道优先级 —— **唯一权威**（⛔ 不许在调用方另写一份数组）。
 * `direct` 在前（省中继一跳）；不可用 / 未命中 / 出错 ⇒ 逐个往后回落。
 */
export const PEER_CHANNEL_ORDER: readonly PeerChannelName[] = ['direct', 'wss']

/**
 * 通道**此刻不可用**的具名原因。
 *
 * 🔴 与"未命中"**必须可区分**（`source.ts` 纪律 2 的同一条纪律）：
 * - `miss` = 通道问了，对端说"我这没有"；
 * - `unavailable` = 这条通道**根本没问**（开关关 / 冷却中 / 没候选 / 没接线 / 数据面未建成）。
 *
 * 混在一起 ⇒ "直连从没生效过"会被读成"直连问过了但没有"，正是本线的假绿形态。
 */
export type PeerChannelDownReason =
  /** 用户/运维把直连关了（`DSH_AI1NET_OVERLAY_DIRECT=0`）。 */
  | 'disabled'
  /** 开关**取值非法**（⛔ 不静默当开、⛔ 也不静默当关）。 */
  | 'invalid-switch'
  /** 判死后仍在冷却里（⛔ 本次连 socket 都不开）。 */
  | 'cooldown'
  /** 没有**准入过**的候选地址（候选交换还没喂进来 / 全被拒）。 */
  | 'no-address'
  /** 🔴 直连**数据面**未建成（S5 只做打洞**探测**）⇒ 具名回落，⛔ 不假装取到。 */
  | 'data-plane-pending'
  /** 该通道**未装配**（`wss` 缺省：relay 协议侧暂无内容取回 op）。 */
  | 'not-wired'

/** 一次 peer 取块的**对象**（逻辑名 ＋ 网 ＋ 组；组键由 `peer.ts` 判）。 */
export interface PeerRef {
  name: string
  network: string
  group: string
}

/** 一条取块通道 —— ⛔ 只回字节，**不做判定**（`available` 只答"此刻能不能问"）。 */
export interface PeerBlockChannel {
  readonly name: PeerChannelName
  /** 此刻是否可用（不可用 ⇒ **具名**，调用方据此记账并走下一通道）。 */
  available(peer: PeerRef, id: string): { ok: true } | { ok: false; reason: PeerChannelDownReason; detail: string }
  /** 取块：拿到字节（**落库字节**）⇒ 返回；对端说没有 ⇒ `undefined`；出错 ⇒ 抛。 */
  fetch(peer: PeerRef, id: string): Promise<Buffer | undefined>
}

/** `peer` 接线面的只读快照（探针 / 管理面读这一份）。 */
export interface PeerWireSnapshot {
  /** 通道优先级（= {@link PEER_CHANNEL_ORDER} 的副本）。 */
  order: PeerChannelName[]
  /** 每条通道是否已装配。 */
  wired: Record<PeerChannelName, boolean>
  /** 逐通道"真问了"的次数。 */
  attempts: Record<PeerChannelName, number>
  /** 逐通道**命中**（＝取回字节 ＋ **复算通过**）。 */
  hits: Record<PeerChannelName, number>
  /** 逐通道**未命中**（问了，对端说没有）。 */
  misses: Record<PeerChannelName, number>
  /** 逐通道**抛错**（与未命中可区分）。 */
  errors: Record<PeerChannelName, number>
  /** 逐通道**不可用**（根本没问）。 */
  unavailable: Record<PeerChannelName, number>
  /** 不可用原因的具名分布（`<channel>:<reason>` → 次数）。 */
  downReasons: Record<string, number>
  /** 🔴 **D7 闸门**：复算过的块数。 */
  idChecks: number
  /** 🔴 **D7 闸门**：复算**不符**被丢弃的块数（恒应 ≤ `idChecks`；命中时必为 0 增长）。 */
  idMismatches: number
  /** 已登记的直连候选 peer 数（只含准入过的）。 */
  directCandidates: number
  /** 最近一次 peer 取块的实况（⛔ 不许"没有原因地走了 wss"）。 */
  last: { peer: string; channel: PeerChannelName | null; reason: string } | null
}

/**
 * 直连通道的装配选项。
 *
 * ⚠️ `addresses` 是**唯一**的候选来源，而它由 {@link ContentRuntime.noteDirectCandidate} 喂养 ——
 * 那条路径只接受 S5 准入判定 `ok:true` 的结果 ⇒ 白名单判定**不在这里**（⛔ 不另写一份）。
 */
export interface DirectBlockChannelOptions {
  /** 开关解析结果（由 `direct/index.ts#resolveDirectSwitch` 产出）。 */
  switchState: DirectSwitchState
  /** 冷却表（与 S5 同一份纪律：`ms <= 0` ⇒ **构造期即抛**）。 */
  cooldown: DirectCooldown
  /** 该 peer 的准入候选地址（`undefined` = 没有 ⇒ 具名 `no-address`）。 */
  addresses: (peer: string) => readonly DirectAddress[] | undefined
}

/**
 * 直连通道的**数据面未建成**标记。
 *
 * ⛔ 为什么不直接返回 `undefined`：那会被记成"未命中"（= 对端没有），而真相是
 * "这条通道根本没能力取"。两者混同 ⇒ "直连零生效"被读成"直连没省到"（本线假绿形态）。
 */
export const DIRECT_DATA_PLANE_PENDING = 'data-plane-pending'

/**
 * 造一条**直连通道**（顺序链的①）。
 *
 * 🔴 三级闸门**顺序固定**（每一级都必须具名）：
 * ① 开关（关 / 非法 ⇒ `disabled` / `invalid-switch`）
 * ② 冷却（判死过 ⇒ `cooldown`；⛔ 本次连 socket 都不开）
 * ③ 候选地址（没准入过 ⇒ `no-address`）
 * ④ 数据面（S6 未建成 ⇒ `data-plane-pending`，⛔ 不假装取到）
 */
export function createDirectBlockChannel(opts: DirectBlockChannelOptions): PeerBlockChannel {
  return {
    name: 'direct',
    available(peer: PeerRef): { ok: true } | { ok: false; reason: PeerChannelDownReason; detail: string } {
      const s = opts.switchState
      if (s.enabled !== true) {
        return s.enabled === false
          ? { ok: false, reason: 'disabled', detail: `${s.envKey} 关闭（来源 ${s.source}）⇒ ⛔ 不打洞、⛔ 零 UDP socket，直接回落` }
          : { ok: false, reason: 'invalid-switch', detail: s.invalid === '' ? `${s.envKey} 取值非法` : s.invalid }
      }
      if (opts.cooldown.blocked(peer.name)) {
        return {
          ok: false,
          reason: 'cooldown',
          detail: `${peer.name} 在冷却中（${opts.cooldown.ms} ms）⇒ 本次不打洞，直接回落（⛔ 不进重试风暴）`,
        }
      }
      const addrs = opts.addresses(peer.name)
      if (addrs === undefined || addrs.length === 0) {
        return {
          ok: false,
          reason: 'no-address',
          detail: `${peer.name} 没有准入过的直连候选地址 ⇒ 回落（⛔ 不是"打洞失败"）`,
        }
      }
      return {
        ok: false,
        reason: 'data-plane-pending',
        detail:
          `有 ${addrs.length} 条准入候选、开关开、未冷却，但**直连数据面未建成**` +
          `（S5 只做打洞探测，打洞后的块交换需新增 UDP 应答端 ⇒ 独立后续项）⇒ 具名回落，⛔ 不假装取到`,
      }
    },
    async fetch(peer: PeerRef): Promise<Buffer | undefined> {
      // ⛔ 防御性：`available()` 在数据面建成前**恒不返回 ok:true** ⇒ 这里理应不可达。
      //    真被调到 ⇒ 大喊，而不是静默回"没有"（后者会把"没建成"伪装成"对端没有"）。
      throw new Error(
        `direct: 直连数据面未建成 —— ${peer.name} 的块交换未实现（${DIRECT_DATA_PLANE_PENDING}）；` +
          `⛔ 不许把它记成"未命中"，请走 available() 的具名降级`,
      )
    },
  }
}

/** 内容面运行时装配选项。 */
export interface ContentRuntimeOptions {
  /** 本节点所属**网**（`network.ts` 的 `OPS_NETWORK`）。 */
  network: string
  /** 本节点在内容面上的**组名**（同组才可互相取块 —— E5）。 */
  group: string
  /**
   * 🆕 单 B：组密钥加解密器。**缺省 `undefined` ⇒ 不启用加密**（行为逐字回到原行为）。
   * ⚠️ 给了它 ⇒ 块 id 挂**密文**（"β′"）、链返回**明文**、`/status` 多一个 `crypto` 块。
   */
  cipher?: ContentCipher
  /** 块缓存上限（字节）。缺省 `store.ts` 的 `DEFAULT_MAX_BYTES`（64 MiB）。 */
  storeMaxBytes?: number
  /** 单块上限（字节）。缺省 `store.ts` 的 `DEFAULT_MAX_BLOCK_BYTES`。 */
  maxBlockBytes?: number
  /** 命中回调（观测用）。⚠️ 与计数器**并存**：日志不能替代计数。 */
  onHit?: (tier: SourceTier, id: string) => void
  /** 未命中回调。 */
  onMiss?: (tier: SourceTier, id: string) => void
  /** 抛错回调。 */
  onError?: (tier: SourceTier, id: string, err: unknown) => void
  /** 🆕 解密被拒回调（**与未命中可区分**）。 */
  onDecodeRejected?: (tier: SourceTier, id: string, reason: 'decode-failed') => void
  /** 日志函数（可选）。⚠️ ⛔ 不许把明文块塞进日志（`OBS-23` 会扫）。 */
  log?: (line: string) => void
  /**
   * 🆕 S6：**额外注入**的取块通道（按 {@link PEER_CHANNEL_ORDER} 排顺序）。
   * ⚠️ 缺省只装内置的 `direct`（见 {@link ContentRuntimeOptions.direct}）；
   * `wss` 通道**必须注入**才有（relay 协议侧暂无内容取回 op）。
   */
  peerChannels?: Partial<Record<PeerChannelName, PeerBlockChannel>>
  /**
   * 🆕 S6：内置直连通道的选项。
   * - 缺省 ⇒ 装配（开关读 `process.env` ⇒ 与 `DSH_AI1NET_OVERLAY_DIRECT`「**缺省即开**」一致）；
   * - `false` ⇒ **不装配**（该通道缺 ⇒ 具名 `not-wired`）。
   */
  direct?: false | { env?: Readonly<Record<string, string | undefined>>; cooldownMs?: number }
}

/**
 * 内容面 `/status` 快照 —— **探针 `OBS-17` 的读取口径**（键名即契约）。
 *
 * ⚠️ `source` / `peer` / `store` 三块的键名与各自模块的 counters 类型**逐字一致**；
 * `blockSize` / `storeMaxBytes` 供"口径一致性"断言（第二个判据）。
 */
export interface ContentSnapshot {
  /** 块大小（字节）—— 与参数表 `CONTENT_BLOCK_SIZE` 比对（口径一致）。 */
  blockSize: number
  /** 块缓存上限（字节）—— 与参数表 `CONTENT_STORE_MAX_BYTES` 比对（口径一致）。 */
  storeMaxBytes: number
  /** **内容源优先级链**的逐档命中计数（E6 的机器判据）。 */
  source: SourceHitCounters
  /** 逐档**未命中**计数（全档皆无时逐档留痕）。 */
  sourceMiss: SourceHitCounters
  /** 逐档**抛错**计数（"抛错 ≠ 没有"）。 */
  sourceErrors: SourceHitCounters
  /** 问过的档位总数（= 各次取块走过的档之和）。 */
  sourceMissTotal: number
  /** 🆕 逐档**解密被拒**计数（`sourceErrors` 的细分；稳态应当不增长）。 */
  sourceDecodeRejected: SourceHitCounters
  /** **同组 peer** 计数（含跨组拒绝 —— E5 的机器判据）。 */
  peer: PeerCounters
  /** 本节点组键 `` `${network}|${group}` ``。 */
  peerGroup: string
  /** **内容寻址存储**的七键计数。 */
  store: ContentStoreCounters
  /** 已占用字节数。 */
  storeBytes: number
  /** 已缓存块数。 */
  storeBlocks: number
  /** 本节点**组内**已声明的 peer 名单（供上层做真机取块接线）。 */
  groupMembers: string[]
  /**
   * 🆕 S6：**peer 档接线面**（通道顺序 / 具名降级 / **D7 复算闸门**）。
   * ⚠️ 纯新增键 —— 既有消费方（`OBS-17` 只逐键看 `source`/`peer`/`store`）零影响。
   */
  peerWire: PeerWireSnapshot
  /**
   * 🆕 单 B：**组密钥加密判别器**（探针 `OBS-23` 的读取口径）。
   * ⚠️ **不启用加密时本键整体缺席** ⇒ `OBS-23` 记 **SKIP**（"缺省不启用"是合法状态）。
   */
  crypto?: ContentCryptoCounters
  /**
   * 🆕 C（域分离）：块 id 是否走**per-network keyed hash**。
   * ⚠️ **未启用域分离时本键整体缺席**（⛔ 不补 `false`）⇒ 与 `crypto` 同一纪律。
   */
  blockIdKeyed?: boolean
  /**
   * 🆕 C：域密钥的**可公开指纹**（16 hex；⛔ 不是密钥）。
   * 🔑 **跨机口径一致性**的机器判据：47 与 106 必须逐字相同。
   */
  blockIdKeyId?: string
}
/**
 * 内容面运行时 —— 一个进程一份，**唯一**的报数入口。
 *
 * ⚠️ 生命周期：构造即建（无 IO、无监听、无端口）⇒ 对既有行为**零影响**。
 * 这正是它能进 `main.ts`（relay 独立单元）而不触 R5 的原因 —— **不新增任何监听口**。
 */
export class ContentRuntime {
  readonly store: ContentStore
  readonly peers: ContentPeerGroup
  readonly source: ContentSourceChain
  /** 块大小口径（供快照与上层切分共用，避免两套默认值）。 */
  readonly blockSize: number
  /** 🆕 组密钥加解密器（`undefined` = 不启用加密）。 */
  readonly cipher: ContentCipher | undefined
  /**
   * 🆕 C（域分离）：块 id 的**域密钥**（`undefined` = 裸哈希口径 ⇒ 与逐字一致）。
   *
   * 🔑 派生方式 = `cipher.blockIdKeyOf(network)`（组密钥 ＋ network ⇒ 不新增密钥文件 / 不新增 env）。
   * ⇒ **加密与域分离同开同关**：没启用组密钥就没有域密钥，块 id 回到裸哈希（= 回滚路径）。
   *
   * ⛔ **这是密钥材料** —— 不许打印、不许进日志、不许进 `/status`
   * （`/status` 只放 {@link blockIdKeyId} 指纹）。
   */
  readonly netKey: Buffer | undefined
  /**
   * 🆕 C：域密钥的**可公开指纹**（`undefined` = 未启用域分离）。
   * ⚠️ 它是"**两机口径是否一致**"的机器判据：47 与 106 的该值必须逐字相同，
   * 否则跨机取块会**全部判校验失败**（而块本身是好的 —— 最难定位的形态）。
   */
  readonly blockIdKeyId: string | undefined

  private readonly storeMaxBytes: number
  /** 本节点所属网（候选登记的防御性比对用；⛔ 不从别处猜）。 */
  private readonly network: string
  /** 日志函数（未注入 ⇒ 静默）。 */
  private readonly log: ((line: string) => void) | undefined
  /** 自证写入的最后一个块 id（仅供 `selfProbe` 读回用）。 */
  private lastProbeId: string | undefined
  /** 🆕 S6：已装配的取块通道（按 {@link PEER_CHANNEL_ORDER} 排顺序）。 */
  private readonly peerChannels = new Map<PeerChannelName, PeerBlockChannel>()
  /** 🆕 S6：直连通道的开关解析结果（观测面用；未装配 ⇒ `undefined`）。 */
  private readonly directSwitch: DirectSwitchState | undefined
  /** 🆕 S6：直连候选地址表（**只经 `noteDirectCandidate` 写入**，⛔ 不从别处塞）。 */
  private readonly directAddrs = new Map<string, DirectAddress[]>()
  /**
   * 🆕 S6：接线面计数。
   *
   * ⚠️ `downReasons` 的键是 `` `${channel}:${reason}` `` —— 用字符串键而不是嵌套对象，
   * 是为了让 `JSON.stringify` 出来的 `/status` 一眼可读、探针逐键断言也简单。
   */
  private readonly wire = {
    attempts: { direct: 0, wss: 0 } as Record<PeerChannelName, number>,
    hits: { direct: 0, wss: 0 } as Record<PeerChannelName, number>,
    misses: { direct: 0, wss: 0 } as Record<PeerChannelName, number>,
    errors: { direct: 0, wss: 0 } as Record<PeerChannelName, number>,
    unavailable: { direct: 0, wss: 0 } as Record<PeerChannelName, number>,
    downReasons: {} as Record<string, number>,
    idChecks: 0,
    idMismatches: 0,
    last: null as PeerWireSnapshot['last'],
  }

  constructor(opts: ContentRuntimeOptions) {
    this.storeMaxBytes = opts.storeMaxBytes ?? DEFAULT_MAX_BYTES
    this.network = opts.network
    this.log = opts.log
    this.cipher = opts.cipher
    // 🆕 C：域密钥与 cipher **同开同关**（⛔ 不新增 env / 不新增密钥文件）。
    // ⚠️ 顺序：必须在 `new ContentStore` 之前 —— store 的两处复算用它。
    this.netKey = this.cipher?.blockIdKeyOf(opts.network)
    this.blockIdKeyId = this.netKey === undefined ? undefined : keyIdOf(this.netKey)
    this.store = new ContentStore({
      maxBytes: this.storeMaxBytes,
      ...(opts.maxBlockBytes === undefined ? {} : { maxBlockBytes: opts.maxBlockBytes }),
      ...(this.netKey === undefined ? {} : { netKey: this.netKey }),
    })
    this.peers = new ContentPeerGroup({
      network: opts.network,
      group: opts.group,
      // 🆕 启用加密才做 epoch 一致性判定（缺省 ⇒ 与逐字一致）
      ...(this.cipher === undefined ? {} : { epoch: this.cipher.epoch }),
      ...(opts.log === undefined ? {} : { log: opts.log }),
    })
    // ── 🆕 S6：装配取块通道（顺序由 `PEER_CHANNEL_ORDER` 定，⛔ 不在这里排）──────
    if (opts.direct !== false) {
      const env = opts.direct?.env ?? process.env
      const switchState = resolveDirectSwitch(env)
      this.directSwitch = switchState
      this.peerChannels.set(
        'direct',
        createDirectBlockChannel({
          switchState,
          cooldown: new DirectCooldown(opts.direct?.cooldownMs ?? DEFAULT_DIRECT_COOLDOWN_MS),
          addresses: (peer) => this.directAddrs.get(peer),
        }),
      )
    }
    const injected = opts.peerChannels ?? {}
    for (const name of PEER_CHANNEL_ORDER) {
      const ch = injected[name]
      // ⚠️ 注入的通道**覆盖**内置的（便于夹具替身），⛔ 但不许改名（顺序权威只此一份）
      if (ch !== undefined) this.peerChannels.set(name, ch)
    }
    this.source = new ContentSourceChain({
      fetchers: {
        // ① 本地：内容寻址存储命中即返回（零网络 —— 最省的档位）
        local: async (id: string) => {
          const bytes = this.store.get(id)
          return bytes === undefined
            ? undefined
            : { tier: 'local' as const, bytes }
        },
        // ② 同组 peer：**S6 接线** —— 逐候选 × 逐通道（direct → wss）尝试；
        //    🔴 取回的**落库字节**必须复算出同一个块 id（D7 闸门），否则**丢弃且不算命中**。
        //    ⛔ 绝不许在这里伪造字节 —— 那会把 E1 的"零回源"做成假绿（本线的老病根）。
        peer: async (id: string) => this.fetchFromPeers(id),
      },
      // 🆕 单 B：**唯一解密点**（生产路径）—— 五档一律在这里解密
      ...(this.cipher === undefined ? {} : { decode: (stored: Buffer) => this.cipher?.decodeBlock(stored) }),
      ...(opts.onHit === undefined ? {} : { onHit: opts.onHit }),
      ...(opts.onMiss === undefined ? {} : { onMiss: opts.onMiss }),
      ...(opts.onError === undefined ? {} : { onError: opts.onError }),
      ...(opts.onDecodeRejected === undefined ? {} : { onDecodeRejected: opts.onDecodeRejected }),
    })
    this.blockSize = DEFAULT_BLOCK_SIZE
  }

  /**
   * 🆕 S6：**peer 档接线的唯一执行点**。
   *
   * 顺序写死：**候选**（同组，`peer.ts` 的 E5 闸门）→ **通道**（`direct` → `wss`）。
   * 每一步都记账，且三类结果**互相可区分**：
   * - `unavailable`（这条通道压根没问）／`misses`（问了，对端没有）／`errors`（问了，炸了）／`hits`（拿到**且复算通过**）。
   *
   * @returns 命中 ⇒ `{tier:'peer', bytes}`（**落库字节**，解密由链上唯一解密点做）；否则 `undefined`
   */
  private async fetchFromPeers(id: string): Promise<{ tier: 'peer'; bytes: Buffer } | undefined> {
    const cands = this.peers.candidates(id)
    if (cands.length === 0) return undefined
    for (const c of cands) {
      // 🔴 E5：跨组 ⇒ **显式拒绝**（计数在 `markDenied` 内，语义与逐字不变）
      if (this.peers.markDenied(c.name, id)) continue
      const ref: PeerRef = { name: c.name, network: c.network, group: c.group }
      for (const name of PEER_CHANNEL_ORDER) {
        const ch = this.peerChannels.get(name)
        if (ch === undefined) {
          this.wire.unavailable[name] += 1
          this.noteDown(name, 'not-wired')
          continue
        }
        const av = ch.available(ref, id)
        if (!av.ok) {
          // ⛔ 不可用 ≠ 未命中：这条通道**没问**，只是被具名降级了
          this.wire.unavailable[name] += 1
          this.noteDown(name, av.reason)
          this.wire.last = { peer: c.name, channel: name, reason: av.reason }
          continue
        }
        this.wire.attempts[name] += 1
        let gotBytes: Buffer | undefined
        try {
          gotBytes = await ch.fetch(ref, id)
        } catch (err) {
          this.wire.errors[name] += 1
          this.wire.last = { peer: c.name, channel: name, reason: 'error' }
          this.logLine(`[content-peer] ⛔ channel=${name} peer=${c.name} 取块抛错：${String(err)}`)
          continue
        }
        if (gotBytes === undefined) {
          this.wire.misses[name] += 1
          this.wire.last = { peer: c.name, channel: name, reason: 'miss' }
          continue
        }
        // ── 🔴 **D7 闸门**：复算块 id（⛔ 这一行不许省、不许"先信后验"）────────────
        this.wire.idChecks += 1
        const actual = blockIdOf(gotBytes, this.netKey)
        if (actual !== id) {
          this.wire.idMismatches += 1
          this.wire.errors[name] += 1
          this.wire.last = { peer: c.name, channel: name, reason: 'id-mismatch' }
          this.logLine(
            `[content-peer] ⛔ 复算不符 channel=${name} peer=${c.name}` +
              ` 期望=${id.slice(0, 8)}… 实得=${actual.slice(0, 8)}… ⇒ **丢弃**（⛔ 不算命中、⛔ 不返回字节）`,
          )
          continue
        }
        this.wire.hits[name] += 1
        this.wire.last = { peer: c.name, channel: name, reason: 'hit' }
        return { tier: 'peer', bytes: gotBytes }
      }
    }
    return undefined
  }

  /** 记账：不可用原因分布（⛔ 不许"没有原因地走了另一条通道"）。 */
  private noteDown(channel: PeerChannelName, reason: PeerChannelDownReason): void {
    const key = `${channel}:${reason}`
    this.wire.downReasons[key] = (this.wire.downReasons[key] ?? 0) + 1
    this.wire.last = this.wire.last ?? { peer: '', channel, reason }
  }

  /** 日志（未注入 ⇒ 静默；⛔ 不把块字节写进日志）。 */
  private logLine(line: string): void {
    this.log?.(line)
  }

  /**
   * 🆕 S6：登记一条**直连候选**（**唯一入口**）。
   *
   * 🔴 **准入判定不在这里** —— 只接受 S5 `CandidateLedger#judge` 判过 `ok:true` 的结果
   * （那条链路复用 `network.ts#isAllowedDialer`，⛔ 本模块不另写一份白名单）。
   * 这里只做两件**防御性**收尾：① 网必须与本节点一致（跨网 ⇒ 拒）② 地址逐条过 `isValidAddress` ＋ 条数上限。
   */
  noteDirectCandidate(verdict: CandidateVerdict): { ok: true; peer: string; addrs: number } | { ok: false; reason: string } {
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    const msg = verdict.message
    if (msg.network !== this.network) {
      return { ok: false, reason: `cross-network（载荷 ${msg.network} ≠ 本节点 ${this.network}）` }
    }
    const addrs = msg.addrs.filter((a) => isValidAddress(a)).slice(0, DIRECT_CAND_MAX_ADDRS)
    if (addrs.length === 0) return { ok: false, reason: 'bad-address（过滤后为空）' }
    // ⚠️ 键 = **逻辑名** `<network>/<hostId>`（与 `peer.ts` 的 `PeerDeclaration.name` 同口径）
    //    —— 候选载荷里只有 `hostId`（relay 逻辑名的后半段），两处不同形 ⇒ 在这里统一，⛔ 别让调用方猜。
    const key = `${msg.network}/${msg.hostId}`
    this.directAddrs.set(key, addrs.map((a) => ({ ...a })))
    return { ok: true, peer: key, addrs: addrs.length }
  }

  /** 🆕 S6：候选下线（该 peer 不再作为直连对象）。 */
  withdrawDirectCandidate(peer: string): boolean {
    return this.directAddrs.delete(peer)
  }

  /** 🆕 S6：已登记的直连候选（只读视图）。 */
  directCandidates(): string[] {
    return [...this.directAddrs.keys()].sort()
  }

  /** 🆕 S6：接线面只读快照（探针 / 管理面共用这一份 —— ⛔ 别各写一套）。 */
  peerWireSnapshot(): PeerWireSnapshot {
    const wired = { direct: false, wss: false } as Record<PeerChannelName, boolean>
    for (const name of PEER_CHANNEL_ORDER) wired[name] = this.peerChannels.has(name)
    return {
      order: [...PEER_CHANNEL_ORDER],
      wired,
      attempts: { ...this.wire.attempts },
      hits: { ...this.wire.hits },
      misses: { ...this.wire.misses },
      errors: { ...this.wire.errors },
      unavailable: { ...this.wire.unavailable },
      downReasons: { ...this.wire.downReasons },
      idChecks: this.wire.idChecks,
      idMismatches: this.wire.idMismatches,
      directCandidates: this.directAddrs.size,
      last: this.wire.last === null ? null : { ...this.wire.last },
    }
  }

  /** 🆕 S6：直连开关的解析结果（`undefined` = 内置直连通道未装配）。 */
  directSwitchState(): DirectSwitchState | undefined {
    return this.directSwitch
  }

  /** 🆕 是否启用加密（判据用：区分"没启用"与"启用了但没解过"）。 */
  get cryptoEnabled(): boolean {
    return this.cipher !== undefined
  }

  /**
   * 🆕 C：**写侧变换**（加密 ＋ 域密钥）—— 一个对象同时给两样，⛔ 不许只给一半。
   *
   * ⛔ 不启用组密钥 ⇒ `undefined`（与逐字一致）。🔴 只给 `encode` 不给 `netKey` 的形态
   * = "块 id 挂密文但不带域维度" ⇒ 正是本线要根治的**静默失效**；所以两样在一个函数里产出。
   */
  private writeTransforms(): ChunkTransforms | undefined {
    const cipher = this.cipher
    if (cipher === undefined) return undefined
    const encode = (plain: Buffer): Buffer => cipher.encryptBlock(plain)
    return this.netKey === undefined ? { encode } : { encode, netKey: this.netKey }
  }

  /** 🆕 C：**读侧变换**（重组位的解密 ＋ 域密钥）。⚠️ 生产路径的解密在 `source` 链。 */
  private readTransforms(): ChunkTransforms | undefined {
    const cipher = this.cipher
    if (cipher === undefined) return undefined
    const decode = (stored: Buffer): Buffer | undefined => cipher.decodeBlock(stored)
    return this.netKey === undefined ? { decode } : { decode, netKey: this.netKey }
  }

  /**
   * 🆕 **写内容**（单 B 的写侧统一入口）：明文 → 切块 → 加密 → 内容寻址入库。
   *
   * ⚠️ 顺序不可颠倒：**先切块、再逐块加密**。若先加密整条流再切，块边界会落在密文上
   * ⇒ 单块改动会让其后所有块失效（丢掉 `E3`「只传变化块」）。
   */
  putContent(bytes: Buffer): { plan: string[]; size: number; contentId: string; dedupIds: string[] } {
    const r = chunkify(bytes, this.blockSize, this.writeTransforms())
    for (const c of r.chunks) this.store.put(c.id, c.bytes)
    // ⚠️ 返回**逐块有序** id（`plan`）而非去重后的 `ids`：取回/重组必须按序，去重列表只作"要几个块"的口径
    return { plan: r.chunks.map((c) => c.id), size: r.size, contentId: r.contentId, dedupIds: r.ids }
  }

  /**
   * 🆕 **取内容**（单 B 的读侧统一入口）：按计划逐块取（链已统一解密）→ 拼接。
   *
   * @returns 明文；任一块取不到 ⇒ `undefined`（⛔ 不许拼半截 —— 半截内容是最脏的失败形态）
   */
  async fetchContent(ids: readonly string[]): Promise<Buffer | undefined> {
    const parts: Buffer[] = []
    for (const id of ids) {
      const got = await this.source.fetch(id)
      if (got === undefined) return undefined
      parts.push(got.bytes)
    }
    return Buffer.concat(parts)
  }

  /**
   * 🆕 **按已知明文重组**（`E4` 口径：逐块复算 id 后才解密拼接）。
   *
   * ⚠️ 与 `fetchContent` **二选一**（同一批字节只过其中一处解密点）：
   * 本函数是**夹具 / 工具路径**，`fetchContent` 是**生产路径**。
   */
  async reassembleContent(stored: Map<string, Buffer>, ids: readonly string[]): Promise<Buffer | undefined> {
    try {
      return reassemble([...ids], stored, this.readTransforms())
    } catch (err) {
      this.lastReassembleError = err instanceof Error ? err.message : String(err)
      return undefined
    }
  }

  /** 最近一次 `reassembleContent` 的失败原文（⛔ 不吞错）。 */
  lastReassembleError: string | undefined

  /** 🆕 只算"这份内容要哪些块"（写侧 `putContent` 的坐标版 —— 查本地/peer 前用）。 */
  planContent(bytes: Buffer): { ids: string[]; size: number } {
    return planOf(bytes, this.blockSize, this.writeTransforms())
  }

  /**
   * 🆕 **启动自证**（单 B §5 F1/F2/F4① 的落点）—— 全走**真实**读写路径：
   * ① 同一明文加密两次 ⇒ 比字节（`detChecks` / `detMismatches`）；
   * ② 加密 → `store.put` → `source.fetch`（**走优先级链**）→ 解密 ⇒ 与明文逐字节相同
   *    （顺带让 `local` 档命中 +1 ⇒ `OBS-17` 的活性判据不因加密而退化）；
   * ③ 对密文做**字节级**明文标记扫描（`plainScans` / `plainLeaks`）。
   *
   * ⛔ 不启用加密 ⇒ 直接返回 `undefined`（不打日志、不计数）。
   */
  async selfProbe(marker: string): Promise<boolean | undefined> {
    const cipher = this.cipher
    if (cipher === undefined) return undefined
    const plain = Buffer.from(marker, 'utf8')
    const ok = cipher.selfProbe(marker, {
      put: (blob) => {
        // 🔴 C：这里的 id **必须**与 store 的复算口径一致（同样带 `netKey`）。
        //    漏传 ⇒ `store.put` 抛"块校验失败" ⇒ 启动自证直接失败（= 调用点漏改的现行判据）。
        const id = blockIdOf(blob, this.netKey)
        this.lastProbeId = id
        this.store.put(id, blob)
      },
      get: () => (this.lastProbeId === undefined ? undefined : this.store.get(this.lastProbeId)),
    })
    // ② 再走一次**优先级链**（local 档命中 +1；链上的解密点与 crypto.selfProbe 的不是同一批字节）
    if (this.lastProbeId !== undefined) {
      const got = await this.source.fetch(this.lastProbeId)
      if (got === undefined || !got.bytes.equals(plain)) return false
    }
    return ok
  }

  /**
   * 报数 —— **直读**四个零件的 counters（⛔ 不做二次加工、⛔ 不补零）。
   *
   * ⚠️ 探针 `OBS-17` 三件套全从本快照读：① 判别器齐全（逐键 `number`）
   * ② 口径一致（`blockSize` / `storeMaxBytes`）③ 活性（`source.local + source.peer`）。
   * 🆕 探针 `OBS-23` 读 `crypto` 块的十个键（**不启用加密时整块缺席 ⇒ 记 SKIP**）。
   */
  snapshot(): ContentSnapshot {
    return {
      blockSize: this.blockSize,
      storeMaxBytes: this.storeMaxBytes,
      source: this.source.counters(),
      sourceMiss: this.source.missCounters(),
      sourceErrors: this.source.errors(),
      sourceMissTotal: this.source.misses(),
      sourceDecodeRejected: this.source.decodeRejected(),
      peer: this.peers.counters(),
      peerGroup: this.peers.groupKey,
      store: this.store.counters(),
      storeBytes: this.store.bytes,
      storeBlocks: this.store.size,
      groupMembers: this.peers.sameGroupPeers(),
      // 🆕 S6：peer 档接线面（**纯新增键** ⇒ 既有消费方零影响）
      peerWire: this.peerWireSnapshot(),
      // ⚠️ 不启用加密 ⇒ 本键**整体缺席**（不是补零！补零会让"没启用"与"启用了但零值"同形）
      ...(this.cipher === undefined ? {} : { crypto: this.cipher.counters() }),
      // 🆕 C（域分离）：**同样"未启用即整体缺席"** —— 由 `blockIdKeyId` 的存在性
      //    区分"没开域分离"与"开了但指纹是空串"（⛔ 不补 false、⛔ 不补空串）。
      ...(this.blockIdKeyId === undefined ? {} : { blockIdKeyed: true, blockIdKeyId: this.blockIdKeyId }),
    }
  }
}
