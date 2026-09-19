/**
 * relay 客户端 —— **worker 侧拨出端**（覆盖网络 R1）。
 *
 * ## 为什么 worker 只拨出、不开入站
 * 实测（传输方案 §9.2）：47 的 agent / 控制面端口全绑回环，公网 `curl` 一律 `rc=28`；
 * 而 47 **没有本机防火墙**（`nft INPUT policy accept`）⇒ 任何 `0.0.0.0` 监听都会立刻公网可达。
 * 所以「worker 永不开入站口」是**硬约束**，不是偏好：只有拨出长连接，暴露面才是 O(1)。
 *
 * ## 安全（client 侧**二次校验**，不把安全全押在服务端）
 * 服务端被攻破时，它唯一能做的事是**给本 client 发 `OPEN`**。本 client 的答复规则：
 * 1. 端口必须在构造时给的 `ports` 白名单里（**不看**服务端声明的任何范围）；
 * 2. 目标**恒为 `127.0.0.1`** —— 永不接受可路由地址，天然断掉"把本机当跳板"；
 * 3. 白名单外的 `OPEN` ⇒ 回 `OPEN_ACK{ok:false}` 并**计数 + 打日志**（可观测，不静默）。
 * ⇒ 攻破 relay **不会**让攻击者碰到 22 / <PG_PORT> / 3080，最坏只碰到实例端口本身。
 *
 * ## 稳定性（R1）与**韧性（R1.5：启停 / 网络变化 / 中断 / 异常）**
 *
 * ### 状态机（**显式**——布尔说不出"正在握手"还是"正在退避"，也就无从观测恢复过程）
 * ```text
 *   idle ──start()──▶ connecting ──ws open──▶ handshaking ──HELLO_ACK──▶ up
 *     ▲                    │                        │                     │
 *     │                    └── 任一步失败 / 超时 ─────┴─────────────────────┘
 *     │                                     ▼
 *     └──stop()──▶ stopped ◀──stop()── backoff ──(延迟到点 / 地址变化 / 对端优雅告别)──▶ connecting
 * ```
 *
 * ### 四类场景的处置（每类都有对应字段，**可实测、可断言**）
 * | 场景 | 现象 | 处置 | 可观测字段 |
 * |---|---|---|---|
 * | **节点启停**（计划内重启） | 对端发 `close 1001` / `BYE` | **不消耗退避**：`gracefulRetryMs`（默认 300ms）后立刻重连；同时 `BYE` 让服务端**秒级**标离线，而不是干等 45s 心跳超时 | `restarts` |
 * | **网络变化**（IP 变 / 网卡上下） | 本机地址快照变了 | 巡检发现即**取消剩余退避、立即重拨**（旧退避的前提已失效） | `networkChanges` |
 * | **网络中断**（长时间断网） | 连不上 / 连上无帧 | 指数退避 **±25% 抖动**，上限 `reconnectMaxMs`（默认 30s），**永不放弃**（不设"重试 N 次后沉默"） | `attempts` / `nextRetryMs` |
 * | **网络异常**（半开、静默黑洞） | TCP 不报错但再无数据 | **半开巡检**：`2.5 × hbSec` 内没收到**任何**帧 ⇒ 主动断并重连（不等 OS 的 TCP 超时） | `lastFrameAgeMs` |
 * | **时钟漂移** | `HELLO` 被拒 `clock-skew` | 用拒绝帧里的 `serverTime` 算出偏移、**本地校正**后立即重试 —— 否则该节点**永久无法重连** | `clockSkewMs` |
 *
 * ### 诚实边界（不做做不到的事）
 * 断链**必然**终止全部在途流（多路复用帧没有重放日志）—— 本实现**不假装**能流级恢复。
 * 恢复语义分三层：**连接恢复 → 注册恢复（重连即自动重注册）→ 路由恢复（Manager 按 `online` 查表拿到新回环口）**；
 * **流级重试由上层负责**（HTTP 幂等请求、实例侧自身重连）。**不做半开流的"缝合"**。
 *
 * @module dsh_ai1net/net/relay/client
 */

import { createHmac, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
import { MUX, decodeMux, encodeJsonFrame, encodeMux, parseJsonPayload, type MuxFrame } from './wire.js'
import { OPS_NETWORK, NAME_SEP, assertNetworkId, logicalName } from './network.js'
import { signProof, publicKeyOfPrivate, type NodeGrant } from './identity.js'
import { MuxDuplex } from './duplex.js'
// 序④（443/TCP 兜底 · L1）：地址覆盖（只依赖 node 内建，**无循环依赖**）。
import { ensureOverlayAddrOverrides } from './addr-override.js'

/** 内建 `WebSocket` 的最小接口（Node 22 提供客户端实现；**不引 `ws`**）。 */
export interface WebSocketLike {
  binaryType: string
  readyState: number
  send(data: Uint8Array | ArrayBuffer | string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: { data?: unknown; code?: number; reason?: string }) => void): void
  bufferedAmount?: number
}

export type WebSocketCtor = new (url: string) => WebSocketLike

/**
 * 连接状态（**显式状态机**）。
 * `handshaking` 与 `backoff` 是 R1.5 新拆出来的：没有它们，"正在重连"与"正在握手"在日志里长得一样。
 */
export type RelayClientState = 'idle' | 'connecting' | 'handshaking' | 'up' | 'backoff' | 'queued' | 'stopped'

export interface RelayClientOptions {
  /** relay 的 WebSocket 地址：`ws://127.0.0.1:<relay-port>/dsh_ai1net-relay`（R1）或 `wss://<域名>/dsh_ai1net-relay`（R2）。 */
  url: string
  hostId: string
  /**
   * **本节点属于哪张网**（覆盖网络 ②·P0-1）。缺省 `ops`（运维网 = 平台自己的机器）。
   *
   * 为什么要有它：relay 的会话表原先只按 `hostId` 索引（扁平命名空间）⇒ 平台自己的 Worker隧道
   * 与未来的用户设备会挤进同一个命名空间，一进第二类节点就退化成「一张巨网 + 靠 ACL 兜」。
   * 声明网络后，relay 侧按 **`<network>/<hostId>`** 建会话，且**只在同网内**允许 `DIAL`。
   *
   * ⚠️ 该值**不进 MAC**（`HELLO` 的签名公式一字未改）—— 见 `server.ts` 模块头的理由：
   * 安全性由服务端的"按网络分桶白名单 + 同网校验"保证，改 MAC 会让现网旧客户端硬断。
   * 形状非法 ⇒ **构造时抛**（不静默回落 `ops`：那会让"配错网"伪装成"网络不通"）。
   */
  networkId?: string
  /** 预共享密钥（hex，与 relay 服务端 `keys` 里这一项**逐字节相同**）。 */
  secret: string
  /**
   * **本机的节点身份**（覆盖网络 序③）：私钥 PEM + 入网凭据（`grant` 及其签名）。
   *
   * 给了它 ⇒ `HELLO` 会多带四个字段（`nodeKey` / `grant` / `grantSig` / `nodeSig`），
   * relay 侧据此做**辅助**准入；**不给** ⇒ 退回纯 HMAC（存量形态，不强制时照旧可用）。
   *
   * ⚠️ 与 `networkId` 同一条纪律：**只加字段，MAC 的输入串一字不改** ——
   * 改 MAC 会让现网旧客户端硬断，而"多带几个字段"旧服务端会直接忽略（向前兼容）。
   * `nodeSig` 是对**同一个挑战串**（`hostId|ts|nonce|portsCsv`）用节点私钥的签名，
   * 目的是证明**握有私钥**（凭据是公开可转发的，光出示凭据 ≠ 有身份）。
   */
  identity?: {
    /** 节点私钥 PEM（**0600** 文件里读出来的那一份）。 */
    privateKeyPem: string
    /** 本机的入网凭据（由受信签名者签发）。 */
    grant: NodeGrant
    /** 凭据的签名（base64）。 */
    grantSig: string
  }
  /** 允许被中继到本机回环的端口（**白名单，唯一判据**）。 */
  ports: readonly number[]
  /**
   * **拨号方模式**（覆盖网络 R5）：本会话不申明任何端口，改成向 relay 请求"开一条到
   * `(hostId, port)` 的流"（`openStream()`）。
   *
   * 为什么它解决的是真问题：另一条路（relay 开回环监听、Manager 连回环）把落点钉在
   * **relay 主机的 `127.0.0.1`** 上 ⇒ Manager 必须与 relay 同机。拨号方模式下 Manager
   * 同样"只拨出"一条 wss ⇒ **relay 放哪台机器都行**。
   *
   * ⚠️ 服务端必须在 `dialers` 白名单里列出 `hostId`，否则 `HELLO` 会以 `no-ports` 被拒。
   */
  dialer?: boolean
  /** 退避下限（首次重试延迟）。默认 1000ms。 */
  reconnectMinMs?: number
  /** 退避上限（**永不放弃**，只是拉长间隔）。默认 30000ms。 */
  reconnectMaxMs?: number
  /** 被对端**优雅告知**下线（close `1000`/`1001` 或收到 `BYE`）后的重连延迟。默认 300ms。 */
  gracefulRetryMs?: number
  /**
   * 优雅重连的**快速重试窗口**（ms，默认 15000；`0` = 关闭）。
   *
   * 为什么是"窗口"而不是"次数"：对端重启耗时**不可预测**（实测一次 `RelayServer.stop()`
   * 就被对端收尾拖到 1.8s；systemd 拉起还要更多）。固定次数会"差一点点就恢复不了"，
   * 之后退避直接跳到上限 ⇒ 「计划内重启」被放大成长时间中断。
   * 窗口内一律用 `gracefulRetryMs` 的短间隔重试，出窗口才回落到指数退避。
   */
  gracefulBurstMs?: number
  /**
   * 排队等待上限（ms）。服务端**满载**（`at-capacity`）时本客户端排队重试；
   * 超过这个时长仍进不去 ⇒ `lastError` 明确报障。`0`（默认）= **无限等**（"排队等待"语义）。
   */
  queueMaxWaitMs?: number
  /** 心跳间隔（秒）。默认 15；服务端会在 `HELLO_ACK` 里下发实际值并覆盖它。 */
  hbSec?: number
  /** 半开判定阈值（ms）：连续这么久没收到**任何**帧就主动重连。默认 `2.5 × hbSec`。 */
  halfOpenMs?: number
  /** 本机地址巡检间隔（ms）；`0` = 关闭。默认 5000。 */
  netWatchMs?: number
  queueMaxBytes?: number
  /** WS 出向水位（字节）；超过则排队而非继续灌。默认 256 KiB。 */
  highWaterBytes?: number
  log?: (line: string) => void
  webSocketCtor?: WebSocketCtor
  /** 测试注入点：换成假连接用。 */
  connectImpl?: (port: number, host: string) => Duplex
  /** 测试注入点：时钟基准（用于构造"本机时钟漂移"场景）。默认 `Date.now`。 */
  nowImpl?: () => number
  /** 测试注入点：本机地址快照（用于构造"网络变化"场景）。默认取 `os.networkInterfaces()`。 */
  netSnapshot?: () => string
}

export interface RelayClientStatus {
  state: RelayClientState
  /** 本节点声明/服务端确认的网络（P0-1）—— 与 `server.ts` 的 `/status` 同一词表。 */
  network: string
  /** 进入当前状态的时间戳（诊断"卡在哪个状态多久"）。 */
  stateSince: number
  sessionId?: string
  attempts: number
  /** 距下次重试还剩多少毫秒（仅 `backoff` 状态下有值）。 */
  nextRetryMs?: number
  /** 最近一次失败原因（**结构化**，不是"出错了"）。 */
  lastError?: string
  /** 本地时钟相对 relay 的偏移（正 = 本机快）。 */
  clockSkewMs: number
  /** 最近一次心跳 RTT。 */
  rttMs?: number
  /** 距最后一次收到帧的毫秒数（仅 `up` 状态下有值）—— **半开检测的观测量**。 */
  lastFrameAgeMs?: number
  streams: number
  /** 当前**拨号**流的条数（`openStream()` 开出、尚未关闭）。拨号方模式下的主要观测量。 */
  dialStreams: number
  /**
   * **运行期**加进来的端口（`PORT_ADD`，覆盖网络 R4）。
   * 必须可见：这类端口在断链后要靠重放恢复，**看不见就没法判断"到底还在不在"**。
   */
  dynamicPorts: number[]
  denied: number
  /** 成功进入 `up` 的次数减一（连接恢复计数）。 */
  reconnects: number
  /** 被对端优雅告知下线的次数（计划内重启）。 */
  restarts: number
  /** 本机地址变化次数（网络变化）。 */
  networkChanges: number
  /** 因满载排队过几次。 */
  queueWaits: number
  /** 当前这轮排队已等待多久（ms）；未排队 ⇒ `0`。 */
  queuedMs: number
  bytesIn: number
  bytesOut: number
  /**
   * **本轮"不健康"的起点**（序⑦ · 中继失败切流的触发信号）。
   *
   * 定义：**首次进入 `backoff` 的时刻**（epoch ms）；恢复 `up` 时**清空**。
   * ⚠️ `handshaking` / `connecting` **不计入**不健康 —— "正在握手" ≠ "挂了"，
   * 否则每次正常重连都会被误判成故障。只有 `backoff`（= 连不上 / 被拒 / 被踢后重试）
   * 开始累计才算。
   *
   * ⛔ **只读观测量**：它由既有状态机被动记账产生，**不驱动任何行为**（不改重试 /
   * 不改退避 / 不新增定时器）—— 判据已经存在（D2），这里只是把它**读出来**。
   */
  unhealthySinceMs?: number
  /** 距 {@link RelayClientStatus.unhealthySinceMs} 已过去多久（ms）；健康 ⇒ `0`。 */
  unhealthyForMs: number
  /**
   * **是否还在"计划内重启"的 burst 窗口内**（序⑨ 加；`gracefulBurstMs` 窗口，默认 15 s）。
   *
   * 🔑 存在的唯一理由：**换址等待必须能区分"对端正在重启"与"这台真挂了"**。
   * 两者在 `state` 上都表现为 `backoff`，靠 `state` 一个字分不开；而 burst 窗口是
   * `gracefulBurstMs` 期间**唯一**的区分依据（`scheduleRetry` 在 graceful / burst 两个分支里
   * 把 `attempts` 强制归零）。
   *
   * ⛔ **只读观测量**：由既有状态机被动产生，**不驱动任何行为**（不改重试 / 不改退避 / 不新增定时器）。
   */
  inGracefulBurstWindow: boolean
  /**
   * **presence 订阅视图**（序⑲）—— 订阅侧的判别器。
   *
   * 🔑 存在的理由：控制面必须能回答「**我现在到底还在不在推送上**」—— 否则"订阅静默失效"
   * 与"这张网里确实没人"完全同形（本线头号教训）。判据 = `state==='subscribed'` ＋
   * `lastSnapAgoMs/lastPushAgoMs` 的**新鲜度**。
   */
  presence: RelayPresenceStatus
}

/** presence 订阅的**连接期状态**（⛔ 不是持久订阅：连接一断，`state` 回 `idle`）。 */
export type RelayPresenceState =
  /** 未订阅（默认）。 */
  | 'idle'
  /** 已发 `SUB`、等首帧 `SNAP`（这一段是"可能静默"的唯一窗口 ⇒ 必须可观测）。 */
  | 'pending'
  /** 已拿到 `SNAP`：推送上。 */
  | 'subscribed'
  /**
   * 对端**不支持** SUB（老 relay：未知帧号 ⇒ 直接关连接）⇒ **已停止再试**。
   * 存在的意义：滚动升级期间新客户端遇到旧 relay 时，⛔ 不许把连接反复踢死。
   */
  | 'unsupported'

/** 一条在线态记录（与 `server.ts` 的 `PresenceEntry` 同形，这里只做结构性约束）。 */
export interface RelayPresenceEntry {
  name: string
  hostId: string
  network: string
  online: boolean
  devices: number
  ports: number[]
  /** 每个声明端口在 **relay 本机**的回环落点（`0` = 无）—— 让订阅路径也能供地址（见服务端注释）。 */
  localPorts: { port: number; localPort: number }[]
  lastSeenAgoMs: number
  offlineInMs?: number
  changedAt: number
}

export interface RelayPresenceStatus {
  state: RelayPresenceState
  /** 订阅范围：`all` = 本网全部；数字 = 点名订阅的个数（`idle`/`unsupported` ⇒ `0`）。 */
  scope: 'all' | number
  /** 最近一次收到 `SNAP` 距今多久（ms）；从未收到 ⇒ `undefined`（⛔ 别用 0 冒充"刚收到"）。 */
  lastSnapAgoMs?: number
  /** 最近一次收到 `PRESENCE` 增量距今多久（ms）；从未收到 ⇒ `undefined`。 */
  lastPushAgoMs?: number
  /**
   * **最近一次入站帧**（**任何**帧，含心跳 `PING`/`PONG`）距今多久（ms）—— `undefined` = 还没收到过。
   *
   * 🔑 门的判据看**它**（链路活没活），⛔ 不看上面两个"载荷年龄"（见 `presenceFresh()` 的 P-1 说明）。
   */
  lastInboundAgoMs?: number
  /** 门的**入站静默上界**（ms）：`max(服务端下发 TTL, 半开阈值)` —— 超过它才允许判"不新鲜"。 */
  linkSilentMaxMs: number
  /** **门此刻的判定结果**（= `presenceFresh()`）：让"门为什么开着/关着"一眼可判，⛔ 不静默。 */
  fresh: boolean
  /** 当前缓存里的在线态条数（**本地镜像**：订阅方读它，⛔ 不自己推导）。 */
  entries: number
  /** 当前缓存中 `online === true` 的条数（一眼看出"推送有没有真的更新过"）。 */
  onlineEntries: number
  /** 收到的 `SNAP` 帧数。 */
  snapFrames: number
  /** 收到的 `PRESENCE` 增量帧数（**稳态必须停住不走** —— E1 的机器可读判据）。 */
  pushFrames: number
  /**
   * **最近一帧带了几条记录**。
   *
   * 🔑 存在的理由：`pushFrames` 只回答"推了几帧"，答不了"一帧里装了几条" —— 而"批合并真的生效"
   * 恰恰是后半句（一帧带 host 数组，⛔ 不是逐个 host 一条）。没有它，"6 台同时上线合并成 1 帧"
   * 与"6 台各推 1 帧"在计数上无法区分。
   */
  lastFrameEntries: number
  /** 被服务端**显式拒绝**的订阅次数（跨网 / 越界；⛔ 静默返空不算）。 */
  rejected: number
  /** `SUB` 发出后"连接掉了都没等到 `SNAP`"的次数（老 relay 的指纹）⇒ 达阈值判 `unsupported`。 */
  subFailures: number
}

interface LocalStream {
  id: number
  port: number
  tcp: Duplex
  closed: boolean
  paused: boolean
  queued: Buffer[]
  queuedBytes: number
}

/**
 * **拨号方**的一条流（R5）：`duplex` 直接交给调用方 `pipe()`。
 *
 * 与 `LocalStream` 分开一张表，是因为两个方向的语义**刚好相反**：
 * `LocalStream.tcp` 是"本机应用"（写进去 = 交给本机应用），`DialStream.duplex` 是"调用方自己"
 * （写进去 = 往 relay 送）。混在一起迟早写反。
 */
interface DialStream {
  id: number
  duplex: MuxDuplex
  closed: boolean
  paused: boolean
  queued: Buffer[]
  queuedBytes: number
}

const DEFAULT_QUEUE_MAX = 1 << 20
const DEFAULT_HIGH_WATER = 256 * 1024
const FLUSH_INTERVAL_MS = 20
/**
 * presence TTL 的**保守默认**（ms）—— 只在"还没收到过 `SNAP`（因此没拿到服务端下发的 TTL）"
 * 时用。取值 = 服务端默认 `HB_SEC(15s) × 3`（`server.ts#DEFAULT_PRESENCE_TTL_FACTOR`）。
 * ⚠️ 它只影响"何时回退 `/status`"，⛔ 不参与任何在线态判定 ⇒ 宁可短（早回退）也不许长。
 */
const DEFAULT_PRESENCE_TTL_MS = 45_000

export class RelayClient {
  private readonly opts: RelayClientOptions
  private readonly allow: Set<number>
  private readonly log: (line: string) => void
  private readonly queueMax: number
  private readonly highWater: number
  /** 本节点所属网（P0-1）。构造时定型：网络的归属不该在运行期漂移。 */
  private readonly network: string
  /** 服务端在 `HELLO_ACK` 里回显的网（用于发现"我以为是 A、服务端当成 B"这类偏差）。 */
  private serverNetwork: string | undefined

  /**
   * 本客户端声明的网（P0-3）。
   *
   * 谁需要它：`RelayDialer` —— 口池里的落点**只对这张网有意义**（relay 只会在本网里找目标），
   * 所以申请一个"另一个网的逻辑名"的落点必须**在这里就被拒**，而不是发一个必然失败的假地址。
   */
  get networkId(): string {
    return this.network
  }

  /**
   * 服务端在 `HELLO_ACK` 里回显的网（用于发现"我以为是 A、服务端当成 B"这类偏差）。
   */
  get acknowledgedNetworkId(): string | undefined {
    return this.serverNetwork
  }

  private ws: WebSocketLike | undefined
  /**
   * 序④（443/TCP 兜底 · L1）：**地址覆盖**是否已在建连点装过。
   * 只装一次（`ensureOverlayAddrOverrides` 幂等），避免每次重连都解析 env。
   */
  private addrOverridesReady = false
  private state: RelayClientState = 'idle'
  private stateSince = Date.now()
  private stopped = true
  private attempts = 0
  private sessionId: string | undefined
  private lastError: string | undefined
  /** 服务端明确告知「重试也解决不了」（密钥/主机名配错）时的原因；用于把重试间隔拉到上限、不刷日志。 */
  private lastFatalReason: string | undefined
  private clockSkewMs = 0
  private rttMs: number | undefined
  private pingSentAt: number | undefined
  private lastFrameAt = 0
  private nextRetryAt: number | undefined
  private upCount = 0
  private restarts = 0
  /**
   * 序⑦：**本轮"不健康"的起点**（首次进入 `backoff` 的时刻；`up` 时清空）。
   * ⛔ 纯观测量 —— 不参与任何控制流（见 {@link RelayClientStatus.unhealthySinceMs}）。
   */
  private unhealthySince: number | undefined
  /** 优雅重启的**快速重试窗口**截止时刻（`undefined` = 不在窗口内）。 */
  private burstUntil: number | undefined
  /** burst 日志限流（每 1s 最多一行 —— 15s 窗口 × 250ms 重试 = 60 行噪音，观测≠刷屏）。 */
  private burstLoggedAt = 0
  private queueWaits = 0
  private queuedSince: number | undefined
  private networkChanges = 0
  private netSignature: string | undefined
  private hbSec = 15
  private hbTimer: NodeJS.Timeout | undefined
  private retryTimer: NodeJS.Timeout | undefined
  private flushTimer: NodeJS.Timeout | undefined
  private healthTimer: NodeJS.Timeout | undefined
  private netTimer: NodeJS.Timeout | undefined
  private readonly streams = new Map<number, LocalStream>()
  /**
   * **运行期**加进来的端口（覆盖网络 R4）：`HELLO` 里声明的是静态表，实例端口走 `PORT_ADD`。
   *
   * 为什么必须单独记一份：relay 的 endpoint 表是**随会话**建立的 —— relay 一重启/断链，
   * 那些回环监听就全没了，而本地 `allow` 并不知情 ⇒ 不重放就会"本地以为还转着、实际已断"。
   * （与 `SshTunnel` 里 `forwarded` 记账同一类坑，只是那边靠 20s 对账自愈。）
   */
  private readonly dynamicPorts = new Set<number>()
  private portReqId = 1
  /** 见 `DialStream`：拨号流的 id 由**本侧**分配（relay 只做配对，与 worker 侧 id 不是一个命名空间）。 */
  private readonly dialStreams = new Map<number, DialStream>()
  private nextDialId = 1
  private readonly dialWaiters = new Map<number, { resolve: (r: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>()
  /** 在途的 `PORT_ADD`/`PORT_DEL` 请求（按 `reqId` 关联应答；超时/断链都要收口）。 */
  private readonly portWaiters = new Map<
    number,
    { resolve: (r: { ok: boolean; localPort?: number; error?: string }) => void; timer: NodeJS.Timeout }
  >()
  private denied = 0
  private bytesIn = 0
  private bytesOut = 0

  /* ── presence（序⑲）：订阅 + 本地镜像 ── */
  /** 订阅范围（`undefined` = 未订阅）。`'all'` = 本网全部；数组 = 点名的逻辑名。 */
  private presenceSub: 'all' | string[] | undefined
  /** 本地镜像：**订阅方唯一该读的在线态来源**（键 = 逻辑名）。 */
  private readonly presenceMap = new Map<string, RelayPresenceEntry>()
  private presenceState: RelayPresenceState = 'idle'
  /** 发过 `SUB` 但还没拿到 `SNAP` 的时刻；`0` = 没有在途订阅请求。 */
  private subSentAt = 0
  /** 服务端下发的 presence TTL（ms）；未收到过 `SNAP` ⇒ 用默认值（保守）。 */
  private presenceTtlMs = DEFAULT_PRESENCE_TTL_MS
  private snapFrames = 0
  private pushFrames = 0
  private lastFrameEntries = 0
  private presenceRejected = 0
  private subFailures = 0
  private lastSnapAt = 0
  private lastPushAt = 0
  constructor(opts: RelayClientOptions) {
    this.opts = opts
    this.allow = new Set(opts.ports)
    this.log = opts.log ?? ((s: string) => process.stdout.write(`${s}\n`))
    this.queueMax = opts.queueMaxBytes ?? DEFAULT_QUEUE_MAX
    this.highWater = opts.highWaterBytes ?? DEFAULT_HIGH_WATER
    this.hbSec = opts.hbSec ?? 15
    // 非法网络 id ⇒ **构造时抛**（配置错别拖到握手被拒才暴露）。
    this.network = assertNetworkId(opts.networkId ?? OPS_NETWORK, 'relay client networkId')
    if (opts.dialer === true && opts.ports.length > 0) {
      // 与服务端 `dialer-must-not-declare-ports` 同一条口径：配错就在这里炸，别等 `HELLO` 被拒。
      throw new Error('relay client: dialer mode must not declare ports')
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.netSignature = this.snapshotNet()
    this.startNetWatch()
    this.dial()
  }

  /**
   * 主动停机 —— **优雅告别**：先发 `BYE` 再关连接。
   * 少了这一帧，服务端要等 45s 心跳超时才认为本节点下线（计划内重启的恢复时间就从毫秒变 45 秒）。
   */
  stop(): void {
    this.stopped = true
    clearInterval(this.hbTimer)
    clearInterval(this.healthTimer)
    clearInterval(this.netTimer)
    clearTimeout(this.retryTimer)
    this.stopFlusher()
    this.hbTimer = undefined
    this.healthTimer = undefined
    this.netTimer = undefined
    this.retryTimer = undefined
    this.nextRetryAt = undefined
    this.teardownStreams()
    this.failPortWaiters('client stopping')
    const ws = this.ws
    this.ws = undefined
    this.sessionId = undefined
    this.setState('stopped')
    if (ws !== undefined) {
      try {
        if (ws.readyState === 1) this.send(encodeJsonFrame(MUX.BYE, 0, { reason: 'client stopping' }))
        ws.close(1000, 'client stopping')
      } catch {
        /* 已关 */
      }
    }
  }

  status(): RelayClientStatus {
    const now = this.now()
    return {
      state: this.state,
      network: this.network,
      stateSince: this.stateSince,
      sessionId: this.sessionId,
      attempts: this.attempts,
      nextRetryMs: this.nextRetryAt === undefined ? undefined : Math.max(0, this.nextRetryAt - now),
      lastError: this.lastError,
      clockSkewMs: this.clockSkewMs,
      rttMs: this.rttMs,
      lastFrameAgeMs: this.state === 'up' ? now - this.lastFrameAt : undefined,
      streams: this.streams.size,
      dialStreams: this.dialStreams.size,
      dynamicPorts: [...this.dynamicPorts].sort((a, b) => a - b),
      denied: this.denied,
      reconnects: this.upCount === 0 ? 0 : this.upCount - 1,
      restarts: this.restarts,
      networkChanges: this.networkChanges,
      queueWaits: this.queueWaits,
      queuedMs: this.queuedSince === undefined ? 0 : now - this.queuedSince,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      unhealthySinceMs: this.unhealthySince,
      unhealthyForMs: this.unhealthySince === undefined ? 0 : Math.max(0, now - this.unhealthySince),
      inGracefulBurstWindow: this.state === 'backoff' && this.burstUntil !== undefined && now < this.burstUntil,
      presence: this.presenceStatus(),
    }
  }

  /* ═══════════ presence 订阅（序⑲）═══════════ */

  /**
   * **订阅在线态**（`瓶颈落地方案 §1` 第 3 条：订阅式扇出，只推给"正在看的人"）。
   *
   * `hosts` 省略 ⇒ 订阅**本网全部**（`all`）。订阅**只活在连接期间**（第 3 条）⇒
   * 断线重连后由客户端自己重发，⛔ 服务端不保存任何持久订阅。
   *
   * ⚠️ **可重复调用**：调用即"以最后一次为准"（改范围会先发 `UNSUB` 再发 `SUB`），
   * 这比"调用两次报错"更符合控制面"周期对账"的用法。
   */
  subscribePresence(hosts?: readonly string[]): void {
    if (this.presenceState === 'unsupported') return
    this.presenceSub = hosts === undefined ? 'all' : hosts.map((h) => this.qualify(h))
    if (this.state !== 'up') {
      // 还没连上 ⇒ 记下范围，`onHelloAck` 起来时会自动发（⛔ 不在握手前发，那会被当未认证帧）。
      this.presenceState = 'pending'
      return
    }
    this.sendSubscribe()
  }

  /** **退订**（幂等）。控制面在"不再需要推送"时调用它 ⇒ `/status` 轮询会自动恢复（兜底路径）。 */
  unsubscribePresence(): void {
    const had = this.presenceSub !== undefined
    this.presenceSub = undefined
    this.presenceState = 'idle'
    this.subSentAt = 0
    this.presenceMap.clear()
    if (had && this.state === 'up') this.send(encodeJsonFrame(MUX.UNSUB, 0, { all: true }))
  }

  /**
   * presence 视图 —— 控制面读它（⛔ **不要自己另建一份在线态**，否则就是双权威）。
   *
   * `entries` 只在订阅生效期间有值；`state !== 'subscribed'` ⇒ 调用方**必须**回退 `/status`
   * （D5：`/status` 是兜底路径，不是废弃路径）。
   */
  presenceStatus(): RelayPresenceStatus {
    const now = this.now()
    let onlineEntries = 0
    for (const e of this.presenceMap.values()) if (e.online) onlineEntries += 1
    return {
      state: this.presenceState,
      scope: this.presenceSub === undefined ? 0 : this.presenceSub === 'all' ? 'all' : this.presenceSub.length,
      lastSnapAgoMs: this.lastSnapAt === 0 ? undefined : now - this.lastSnapAt,
      lastPushAgoMs: this.lastPushAt === 0 ? undefined : now - this.lastPushAt,
      // ⚠️ `lastFrameAt` 只在 `up` 期间被刷新；`idle` 时它可能是上一轮的残值 ⇒ 只在 `up` 时报。
      lastInboundAgoMs: this.state === 'up' ? now - this.lastFrameAt : undefined,
      linkSilentMaxMs: this.presenceLinkSilentMaxMs(),
      fresh: this.presenceFresh(),
      entries: this.presenceMap.size,
      onlineEntries,
      snapFrames: this.snapFrames,
      pushFrames: this.pushFrames,
      lastFrameEntries: this.lastFrameEntries,
      rejected: this.presenceRejected,
      subFailures: this.subFailures,
    }
  }

  /** 本地在线态镜像（键 = 逻辑名）；未订阅 ⇒ 空数组（调用方据此回退 `/status`）。 */
  presenceEntries(): RelayPresenceEntry[] {
    return [...this.presenceMap.values()]
  }

  /** 单条查询：`undefined` = **不知道**（⛔ 与"离线"必须能分开 —— 否则会把未知当死）。 */
  presenceOf(name: string): RelayPresenceEntry | undefined {
    return this.presenceMap.get(name)
  }

  /**
   * 订阅**可用**（= 允许拿这份镜像替代 `/status` 兜底）—— D5「主路径 / 兜底」的**唯一开关**。
   *
   * 🔑 判据 = 「**订阅已建立 ∧ 链路活着**」，⛔ **不是**「presence 载荷新鲜度」。
   *
   * 为什么必须这样定（在册缺陷 **P-1**，2026-09-17 序 ⑳ 实测）：presence 是**变化驱动**的
   * —— 稳态（无状态变化）下一帧都不推（`pushed/snaps` 自 relay 起就恒为 1，这是**设计属性**、
   * ⛔ 不是故障）。若把门的判据定成"最近一次 presence 载荷距今 ≤ TTL"，那"**没有变化**"就会被
   * 读成"**没有数据**" ⇒ 45 s 后门必然重开、`/status` 轮询照旧在跑 ⇒ 核心收益归零
   * （实测降幅仅 **1.10×**，而设计目标 ≥ 10×；门开关占空比 5.0% ⇒ 理论降幅 1.05×，吻合）。
   *
   * 镜像的**有效性**本来就不靠"载荷多久没来"，靠两件事：
   * ① **订阅已建立**（`state === 'subscribed'`，即拿到过首帧全量 `SNAP`）；
   * ② **通道有序可靠**（WS over TCP）⇒ relay 侧每一次变化**必然**以 `PRESENCE` 帧按序到达，
   *    不会漏、不会乱序 ⇒ 载荷的**年龄与内容正确性无关**。
   * 只有**链路死**才会让镜像失效，而链路死由半开巡检兜（`2.5 × hbSec` 内**没有任何**入站帧
   * ⇒ 主动断链重连）；断链时 `presenceState` 立刻离开 `subscribed` ⇒ 本函数随即回 `false`
   * ⇒ 上层必然回退 `/status`（D5 的兜底路径，⛔ 一行都没删）。
   *
   * `ttlMs`（服务端下发，生产 45 s）在此退化为**入站静默上界**的一员：与半开阈值取大
   * （`presenceLinkSilentMaxMs`）—— 兜"半开巡检的 tick 还没到"的那一个极窄窗口，
   * ⛔ 不再当"载荷新鲜度"用。
   *
   * ⚠️ **已知残余**（写进设计说明，不在此处兜）：relay 侧**静默**清掉订阅而 socket 仍活 ⇒ 本判据
   * 察觉不到。当前代码里这条路径**不可达**（唯一清空 `session.subs` 的是显式 `UNSUB`；relay 重启 /
   * 会话回收都会断 socket ⇒ 走 ①/② 的路径被发现）。一旦真出现，正解 = 心跳帧携带订阅态断言，
   * 或周期性 `SNAP` 复核（⛔ 不靠缩短 TTL）。
   */
  presenceFresh(ttlMs?: number): boolean {
    if (this.presenceState !== 'subscribed') return false
    // 没拿到过首帧全量 ⇒ 镜像没有权威来源（空表 ≠ "这张网里没人"）。
    if (this.lastSnapAt === 0) return false
    return this.now() - this.lastFrameAt <= this.presenceLinkSilentMaxMs(ttlMs)
  }

  /**
   * 门的**入站静默上界**（ms）。
   *
   * 🔴 取 `max(服务端 TTL, 半开阈值)` 的理由：上界**不得比链路巡检更紧** —— 否则门会比
   * "链路真的死了"更早打开（那就是把 P-1 换个方向重犯：拿一个与镜像有效性无关的时钟当判据）。
   * ⚠️ 测试档把 TTL 压到 3 s 而心跳仍是 15 s ⇒ 若只用 TTL，测试里门会无谓地开合（假红源）。
   */
  private presenceLinkSilentMaxMs(ttlMs?: number): number {
    const bound = ttlMs ?? this.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS
    return Math.max(bound, this.halfOpenMs())
  }

  /** **半开阈值**（ms）—— 唯一来源：半开巡检与门判据共用，⛔ 不引入第二个时间口径。 */
  private halfOpenMs(): number {
    return this.opts.halfOpenMs ?? Math.max(3_000, Math.round(this.hbSec * 1_000 * 2.5))
  }

  private qualify(h: string): string {
    // 裸 `hostId` 按本网补全；给了完整逻辑名就**原样保留**（跨网与否由服务端判，这里不猜）。
    return h.includes(NAME_SEP) ? h : logicalName(this.network, h)
  }

  private sendSubscribe(): void {
    if (this.presenceSub === undefined) return
    const payload = this.presenceSub === 'all' ? { all: true } : { hosts: this.presenceSub }
    this.subSentAt = this.now()
    if (this.presenceState !== 'subscribed') this.presenceState = 'pending'
    this.send(encodeJsonFrame(MUX.SUB, 0, payload))
  }

  /** 重连后重订阅（第 6 条：**重连后必须重新拉一次全量** —— 首帧 `SNAP` 就是那个全量）。 */
  private resendPresenceSub(): void {
    if (this.presenceSub === undefined || this.presenceState === 'unsupported') return
    this.presenceMap.clear()
    this.sendSubscribe()
  }

  /**
   * `SNAP` —— **首帧即全量**（第 6 条，⛔ 无 N+1）：整表替换而不是增量合并。
   *
   * 为什么必须整表替换：relay 重启后回环口号会全部重分配，增量合并会把过期条目永远留下
   * （这正是 ssh 版"静默打到别人实例"的同族病，`web/server.ts#refreshRelay` 已为轮询路径
   * 踩过一次 ⇒ 订阅路径不许复现）。
   */
  private onSnapFrame(frame: MuxFrame): void {
    const msg = parseJsonPayload(frame.payload)
    if (msg === null || msg.ok !== true) {
      this.log('[relay-client] ⛔ SNAP 负载非法 ⇒ 忽略（不回退状态机，等下一个帧）')
      return
    }
    this.presenceMap.clear()
    for (const e of toPresenceEntries(msg.entries)) this.presenceMap.set(e.name, e)
    // TTL 口径由**服务端**下发（⛔ 客户端不写死数字：写死就会在服务端调参后悄悄不一致）。
    if (typeof msg.ttlMs === 'number' && msg.ttlMs > 0) this.presenceTtlMs = msg.ttlMs
    this.snapFrames += 1
    this.lastSnapAt = this.now()
    this.subSentAt = 0
    this.presenceState = 'subscribed'
    this.lastFrameEntries = this.presenceMap.size
    this.log(`[relay-client] presence SNAP ${this.presenceMap.size} 条（scope=${this.presenceSub === 'all' ? 'all' : (this.presenceSub?.length ?? 0)}）`)
  }

  /** `PRESENCE` 增量（或**显式拒绝**）。一帧带数组 ⇒ 就地合并。 */
  private onPresenceFrame(frame: MuxFrame): void {
    const msg = parseJsonPayload(frame.payload)
    if (msg === null) {
      this.log('[relay-client] ⛔ PRESENCE 负载非法 ⇒ 忽略')
      return
    }
    if (msg.ok !== true) {
      // 🔴 **显式拒绝**必须计数 + 响亮：静默返空与"本网没人"完全同形（本线头号教训）。
      this.presenceRejected += 1
      const why = typeof msg.error === 'string' ? msg.error : 'unknown'
      this.log(`[relay-client] presence ⛔ 订阅被拒：${why}（rejected=${this.presenceRejected}）`)
      this.presenceState = 'idle'
      this.presenceSub = undefined
      return
    }
    const entries = toPresenceEntries(msg.entries)
    for (const e of entries) this.presenceMap.set(e.name, e)
    this.pushFrames += 1
    this.lastFrameEntries = entries.length
    this.lastPushAt = this.now()
    if (this.presenceState !== 'subscribed') {
      this.presenceState = 'subscribed'
      this.subSentAt = 0
    }
  }

  /**
   * 连接掉了 ⇒ presence 订阅**随之消失**（第 3 条），必须让上层能看见这件事。
   *
   * 🔴 **老 relay 的指纹**：发了 `SUB` 却**没等到 `SNAP` 连接就掉了** —— 未知帧号会直接关连接。
   * 达阈值 ⇒ 判 `unsupported` 并**停止再试**：滚动升级期间"新客户端 + 旧 relay"绝不能变成
   * "连接被反复踢死"（那会把升级顺序依赖变成生产事故）。
   */
  private onPresenceDown(): void {
    if (this.subSentAt !== 0) {
      this.subFailures += 1
      this.subSentAt = 0
      if (this.subFailures >= 2) {
        this.presenceState = 'unsupported'
        this.log(
          `[relay-client] presence ⛔ 对端不认 SUB（${this.subFailures} 次"发了 SUB 没等到 SNAP 就断"）⇒ 停止订阅，改由 /status 兜底`,
        )
        return
      }
    }
    if (this.presenceSub !== undefined) this.presenceState = 'pending'
    // ⚠️ **保留**上一次的 entries 但把新鲜度打掉：`presenceFresh()` 会因为 state!=='subscribed'
    // 直接回 false ⇒ 上层必然回退 `/status`，而不会拿着过期数据当事实。
  }

  /* ═══════════ 连接生命周期 ═══════════ */

  private now(): number {
    return (this.opts.nowImpl ?? Date.now)()
  }

  private setState(s: RelayClientState): void {
    if (this.state === s) return
    /**
     * 序⑦：**只记账、不驱动** —— 首次进入 `backoff` 记起点，回到 `up` 清空。
     * ⚠️ `connecting` / `handshaking` **不碰**这个字段：于是
     * `backoff → connecting → backoff` 这段**持续累计**（"一直连不上"是一个连续事件），
     * 而正常重连成功（`… → up`）会把它清掉。
     */
    if (s === 'backoff' && this.unhealthySince === undefined) this.unhealthySince = this.now()
    else if (s === 'up') this.unhealthySince = undefined
    this.state = s
    this.stateSince = this.now()
  }

  private dial(): void {
    /**
     * 序④（443/TCP 兜底）· L1「去 CF」：**建连点是地址覆盖的唯一注入点**。
     *
     * 为什么不靠 dispatcher：本项目不引 `undici`/`ws`，用的是内建全局 `WebSocket`，
     * 它不接受自定义 dispatcher ⇒「换地址但保留 SNI」只能在**解析层**做（见 `addr-override.ts`）。
     * ⛔ 未配 `DSH_AI1NET_OVERLAY_ADDR_OVERRIDES` ⇒ 零动作、连补丁都不打 ⇒ 与今天逐字一致。
     */
    if (!this.addrOverridesReady) {
      this.addrOverridesReady = true
      ensureOverlayAddrOverrides(undefined, this.log)
    }
    const Ctor = this.opts.webSocketCtor ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
    if (Ctor === undefined) {
      this.log('[relay-client] fatal: no WebSocket implementation (Node ≥ 22 required)')
      return
    }
    this.setState('connecting')
    let ws: WebSocketLike
    try {
      ws = new Ctor(this.opts.url)
    } catch (err) {
      this.scheduleRetry(`ctor threw: ${errText(err)}`)
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('open', () => this.onOpen())
    ws.addEventListener('message', (ev) => this.onMessage(ev.data))
    // 带上 close code / reason：服务端的拒绝理由要能**在 client 日志里看到**，否则又是"静默失败"。
    // `1000 / 1001` = 对端**计划内**下线（正常关闭 / going away）⇒ 走 graceful 快速重连，不消耗退避。
    ws.addEventListener('close', (ev) => {
      const code = typeof ev.code === 'number' ? ev.code : 0
      const reason = typeof ev.reason === 'string' && ev.reason !== '' ? ` reason=${ev.reason}` : ''
      const graceful = code === 1000 || code === 1001
      if (graceful) this.restarts += 1
      this.onDown(`closed by peer code=${code}${reason}`, graceful)
    })
    ws.addEventListener('error', () => this.onDown('transport error'))
  }

  private onOpen(): void {
    this.setState('handshaking')
    // **校正后**的时间戳：`clockSkewMs` 为 0 时即本地时间；
    // 被 `clock-skew` 拒过一次之后它已经带上偏移，于是第二次握手能过 —— 这是"时钟漂移节点自愈"的落点。
    const ts = this.now() - this.clockSkewMs
    const nonce = randomBytes(16).toString('hex')
    // 排序后拼 csv：client 与 server 对同一字符串算 MAC ⇒ 不存在"顺序不同导致验签失败"的坑。
    const portsCsv = [...this.opts.ports].sort((a, b) => a - b).join(',')
    const mac = createHmac('sha256', Buffer.from(this.opts.secret, 'hex')).update(`${this.opts.hostId}|${ts}|${nonce}|${portsCsv}`).digest('hex')
    /**
     * P0-1：**只加 `network` 一个字段**，MAC 的输入串**一字不改**。
     *
     * 为什么不动 MAC：现网 <worker-a> / <worker-b> 上跑的是旧客户端，改公式 = 必须两端同时升级（硬断）。
     * 而网络维度的真判据在**服务端**（按网络分桶的白名单 + 同网校验），这里的 `network`
     * 只是"我属于哪张网"的声明 ⇒ 声明错了也换不到任何额外权限（见 `server.ts` 模块头）。
     */
    this.send(encodeJsonFrame(MUX.HELLO, 0, { v: 1, hostId: this.opts.hostId, network: this.network, ts, nonce, portsCsv, mac, ...this.identityFields(`${this.opts.hostId}|${ts}|${nonce}|${portsCsv}`) }))
  }

  /**
   * 序③：**身份字段**（`nodeKey` / `grant` / `grantSig` / `nodeSig`）。
   *
   * ⛔ 不改 MAC 的输入串（见 `onOpen` 理由）；这是**追加**字段，旧服务端会直接忽略。
   * ⛔ 身份**没配就不加这些字段**（而不是加空值）—— 空值会让"未配身份"与"配了但坏了"
   * 在服务端日志里长得一样，而这两者的处置完全相反（前者是过渡期正常态，后者必须报障）。
   *
   * `nodeSig` 覆盖的挑战串**与 MAC 完全同形**（`hostId|ts|nonce|portsCsv`）⇒ 服务端无需
   * 为身份层再造一个挑战格式；两者对"这次握手的是什么"有同一个答案。
   */
  private identityFields(challenge: string): Record<string, unknown> {
    const id = this.opts.identity
    if (id === undefined) return {}
    return {
      nodeKey: publicKeyOfPrivate(id.privateKeyPem),
      grant: id.grant,
      grantSig: id.grantSig,
      nodeSig: signProof(id.privateKeyPem, challenge),
    }
  }

  private onDown(why: string, graceful = false, fixedDelayMs?: number): void {
    if (this.retryTimer !== undefined) return
    const wasUp = this.state === 'up'
    clearInterval(this.hbTimer)
    clearInterval(this.healthTimer)
    this.failPortWaiters(`link down: ${why}`)
    this.failDialWaiters(`link down: ${why}`)
    this.hbTimer = undefined
    this.healthTimer = undefined
    this.pingSentAt = undefined
    this.stopFlusher()
    this.teardownStreams()
    this.teardownDialStreams(`link down: ${why}`)
    const ws = this.ws
    this.ws = undefined
    this.sessionId = undefined
    if (ws !== undefined) {
      try {
        ws.close()
      } catch {
        /* 已关 */
      }
    }
    this.setState('backoff')
    // presence：订阅随连接消失（第 3 条）⇒ 必须让上层看得见"现在已经不在推送上了"。
    this.onPresenceDown()
    if (this.stopped) return
    this.scheduleRetry(wasUp ? `${why} (was up)` : why, graceful, fixedDelayMs)
  }

  private scheduleRetry(why: string, graceful = false, fixedDelayMs?: number): void {
    if (this.stopped || this.retryTimer !== undefined) return
    this.lastError = why
    const min = this.opts.reconnectMinMs ?? 1_000
    const max = this.opts.reconnectMaxMs ?? 30_000
    const gracefulMs = Math.max(50, this.opts.gracefulRetryMs ?? 300)
    let delay: number
    let tag = ''
    let quiet = false // burst 窗口内的重复重试按秒限流（否则 15s 窗口刷 60 行）
    if (fixedDelayMs !== undefined) {
      // **排队等位**：按服务端给的 `retryAfterMs` 回来。不是故障 ⇒ 不消耗退避、不累计 attempts。
      this.attempts = 0
      delay = Math.max(100, Math.round(fixedDelayMs))
      tag = ' [queued]'
    } else if (graceful) {
      // 计划内下线不是故障 ⇒ **不消耗退避**，并开启一段**快速重试窗口**（对端重启不是瞬间就绪）。
      const winMs = this.opts.gracefulBurstMs ?? gracefulBurstMsDefault()
      this.burstUntil = winMs > 0 ? this.now() + winMs : undefined
      this.burstLoggedAt = 0
      this.attempts = 0
      delay = gracefulMs
      tag = ` [graceful, burst window ${winMs}ms]`
    } else if (this.burstUntil !== undefined && this.now() < this.burstUntil) {
      // 重启窗口内**持续**短间隔重试（重启耗时不可预测）；出窗口才回落到指数退避。
      this.attempts = 0
      delay = gracefulMs
      const now = this.now()
      if (now - this.burstLoggedAt >= 1_000) {
        this.burstLoggedAt = now
        tag = ` [burst, ${Math.round(this.burstUntil - now)}ms left]`
      } else {
        quiet = true
      }
    } else {
      this.attempts += 1
      const exp = Math.min(max, min * 2 ** Math.min(this.attempts - 1, 6))
      const jitter = exp * 0.25 * (Math.random() * 2 - 1) // ±25% 抖动：多 worker 不能在同一秒一起冲
      delay = Math.max(200, Math.round(exp + jitter))
      // 服务端已明确"重试也解决不了"（密钥/主机名错）⇒ 退到上限，避免把日志刷爆；**仍然持续重试**，配置一改好即自动恢复。
      if (this.lastFatalReason !== undefined) delay = max
    }
    this.nextRetryAt = this.now() + delay
    if (!quiet) {
      this.log(
        `[relay-client] down (${why}); attempt #${this.attempts}${tag}, retry in ${delay}ms` +
          (this.lastFatalReason !== undefined ? ` ⛔ fatal=${this.lastFatalReason}（修好配置即自动恢复）` : ''),
      )
    }
    const timer = setTimeout(() => {
      this.retryTimer = undefined
      this.nextRetryAt = undefined
      if (!this.stopped) this.dial()
    }, delay)
    // ⚠️ 这里**故意不 unref**（本文件其余内部定时器都 unref，唯独这个不行）：
    // 断链之后 WebSocket handle 已消失，若连"重试计划"也是 unref 的，事件循环里就没有活跃句柄了
    // ⇒ **进程静默退出**：既不重连、也不报错，日志停在最后一行。
    // 实测（R1.5 跨机）：服务端重启后客户端"人间蒸发"，`/status` 里再也等不到它上线。
    // 「我正在重连」本身就是必须让进程活下去的理由。
    this.retryTimer = timer
  }

  /** 取消剩余退避、**立即**重拨（用于"网络变化"与"时钟校正完成"这两类前提已变的场景）。 */
  private retryNow(why: string): void {
    if (this.stopped) return
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      this.nextRetryAt = undefined
    }
    this.log(`[relay-client] immediate retry: ${why}`)
    this.dial()
  }

  /**
   * 半开巡检 —— **网络异常的兜底**。
   * 半开（断网 / NAT 表项过期 / 中间设备静默丢包）时 TCP 层**不会报错**，只会永远静默；
   * 靠 OS 的 TCP 超时要几百秒。这里用"多久没收到任何帧"这个可观测量主动判死。
   */
  private startHealthWatch(): void {
    clearInterval(this.healthTimer)
    const halfOpen = this.halfOpenMs()
    const tick = Math.max(500, Math.round(halfOpen / 4))
    const timer = setInterval(() => {
      if (this.stopped || this.state !== 'up') return
      const age = this.now() - this.lastFrameAt
      if (age > halfOpen) {
        this.log(`[relay-client] half-open suspected: no frame for ${age}ms (> ${halfOpen}ms) ⇒ reconnect`)
        this.onDown(`half-open: no frame for ${age}ms`)
      }
    }, tick)
    timer.unref()
    this.healthTimer = timer
  }

  /**
   * 本机地址巡检 —— **网络变化的处置**。
   * IP 变了 / 网卡上下，旧的退避前提就失效了：此时干等退避纯属浪费，直接重拨。
   * （`up` 状态下不主动断：地址变化不一定影响已建立的连接，交给半开巡检判定。）
   */
  private startNetWatch(): void {
    clearInterval(this.netTimer)
    const every = this.opts.netWatchMs ?? 5_000
    if (every <= 0) return
    const timer = setInterval(() => {
      if (this.stopped) return
      const sig = this.snapshotNet()
      if (sig === this.netSignature) return
      this.netSignature = sig
      this.networkChanges += 1
      this.log(`[relay-client] local address change #${this.networkChanges} ⇒ ${sig}`)
      if (this.state !== 'up') this.retryNow('local address changed')
    }, every)
    timer.unref()
    this.netTimer = timer
  }

  private snapshotNet(): string {
    if (this.opts.netSnapshot !== undefined) return this.opts.netSnapshot()
    const out: string[] = []
    const ifaces = networkInterfaces()
    for (const name of Object.keys(ifaces).sort()) {
      for (const info of ifaces[name] ?? []) {
        if (info.internal) continue
        out.push(`${name}:${info.family}:${info.address}`)
      }
    }
    return out.sort().join('|')
  }

  /* ═══════════ 帧处理 ═══════════ */

  private onMessage(data: unknown): void {
    const buf = toBuffer(data)
    if (buf === null) return
    this.lastFrameAt = this.now() // 半开检测的**唯一**依据：任何帧（含心跳）都算"链路还活着"
    const frame = decodeMux(buf)
    if (frame === null) {
      this.log('[relay-client] short frame from relay ⇒ reconnect')
      this.onDown('short frame')
      return
    }
    switch (frame.type) {
      case MUX.HELLO_ACK:
        this.onHelloAck(frame)
        return
      case MUX.HELLO_ERR:
        this.onHelloErr(frame)
        return
      case MUX.BYE: {
        const msg = parseJsonPayload(frame.payload)
        const reason = msg !== null && typeof msg.reason === 'string' ? msg.reason : 'peer said bye'
        this.restarts += 1
        this.log(`[relay-client] peer BYE: ${reason} ⇒ fast reconnect`)
        this.onDown(`peer bye: ${reason}`, true)
        return
      }
      case MUX.OPEN:
        this.onOpenRequest(frame)
        return
      case MUX.PORT_ACK:
        this.onPortAck(frame)
        return
      case MUX.DIAL_ACK:
        this.onDialAck(frame)
        return
      case MUX.DATA:
        this.onRemoteData(frame)
        return
      case MUX.CLOSE: {
        const dial = this.dialStreams.get(frame.streamId)
        if (dial !== undefined) {
          // 对端关流 ⇒ 结束**读侧**（`eof`，不是 `destroy`）：写侧允许半开，调用方可能还有最后一点要送。
          dial.duplex.eof()
          dial.closed = true
          this.dialStreams.delete(frame.streamId)
          this.log(`[relay-client] dial stream ${frame.streamId} closed by relay`)
          return
        }
        const known = this.streams.has(frame.streamId)
        this.closeLocal(frame.streamId, 'relay closed stream')
        if (known) this.log(`[relay-client] stream ${frame.streamId} closed by relay`)
        return
      }
      case MUX.PING:
        this.send(encodeMux(MUX.PONG, 0, frame.payload))
        return
      case MUX.PONG:
        // RTT 采样：`PING` 发出到 `PONG` 回来的往返（含服务端处理时间）。
        if (this.pingSentAt !== undefined) {
          this.rttMs = this.now() - this.pingSentAt
          this.pingSentAt = undefined
        }
        return
      case MUX.SNAP:
        this.onSnapFrame(frame)
        return
      case MUX.PRESENCE:
        this.onPresenceFrame(frame)
        return
      default:
        this.log(`[relay-client] unknown mux type=${frame.type} ⇒ reconnect`)
        this.onDown('unknown frame type')
    }
  }

  private onHelloAck(frame: MuxFrame): void {
    const msg = parseJsonPayload(frame.payload)
    if (msg === null || typeof msg.sessionId !== 'string') {
      this.onDown('malformed hello-ack')
      return
    }
    this.sessionId = msg.sessionId
    // P0-1：服务端回显它认定的网。不一致 ⇒ **响亮地说出来**（多数是两边 `DSH_AI1NET_OVERLAY_NETWORK_ID`
    // 配置不同；不打印的话，症状只会是"跨机代理莫名其妙拨不通"，而那是七八种原因里最难猜的一种）。
    this.serverNetwork = typeof msg.network === 'string' ? msg.network : undefined
    if (this.serverNetwork !== undefined && this.serverNetwork !== this.network) {
      this.log(
        `[relay-client] ⚠ 网络不一致：本机声明 "${this.network}"，服务端认定 "${this.serverNetwork}"` +
          '（检查两端的 DSH_AI1NET_OVERLAY_NETWORK_ID / 白名单归属）',
      )
    }
    this.attempts = 0
    this.lastFatalReason = undefined
    this.burstUntil = undefined
    this.burstLoggedAt = 0
    this.queuedSince = undefined
    this.nextRetryAt = undefined
    // 时钟偏移：用服务端时间戳对齐（不含 RTT/2 修正，量级足够——我们只关心是否越过 ±60s 的窗口）。
    if (typeof msg.serverTime === 'number') this.clockSkewMs = this.now() - msg.serverTime
    const hbSec = typeof msg.hbSec === 'number' && msg.hbSec > 0 ? msg.hbSec : this.hbSec
    this.hbSec = hbSec
    const accepted = Array.isArray(msg.accepted) ? msg.accepted.filter((p): p is number => typeof p === 'number') : []
    const rejected = [...this.opts.ports].filter((p) => !accepted.includes(p))
    this.upCount += 1
    this.lastFrameAt = this.now()
    this.setState('up')
    this.log(
      `[relay-client] registered host=${this.opts.hostId} network=${this.network} session=${this.sessionId} accepted=[${accepted.join(',')}]` +
        ` clockSkew=${this.clockSkewMs}ms` +
        (rejected.length > 0 ? ` ⚠ rejected=[${rejected.join(',')}]` : '') +
        (this.upCount > 1 ? ` (reconnect #${this.upCount - 1})` : ''),
    )
    clearInterval(this.hbTimer)
    const timer = setInterval(() => {
      this.pingSentAt = this.now()
      this.send(encodeMux(MUX.PING, 0))
    }, hbSec * 1_000)
    timer.unref()
    this.hbTimer = timer
    this.startHealthWatch()
    // ── 注册恢复：**重连后把运行期加的端口重放一遍** ────────────────────────────
    // relay 的 endpoint 表随会话消失；不重放 = 本地以为转着、Manager 侧其实已经没有那个口了
    // （症状是"实例页偶发打不开"，且与网络抖动相关 —— 最难查的那种）。
    this.allow.clear()
    for (const p of this.opts.ports) this.allow.add(p)
    for (const p of this.dynamicPorts) this.allow.add(p)
    if (this.dynamicPorts.size > 0) void this.replayDynamicPorts()
    // presence（第 6 条）：**重连必须重新拉一次全量** —— 见 `resendPresenceSub`。
    this.resendPresenceSub()
  }

  /** 把运行期端口重新声明一遍（重连后调用；逐条独立，单条失败不影响其余）。 */
  private async replayDynamicPorts(): Promise<void> {
    for (const port of [...this.dynamicPorts]) {
      const res = await this.requestPort(port, true, 5_000)
      if (!res.ok) this.log(`[relay-client] ⚠ 重连后重放端口 ${port} 未成功：${res.error ?? 'unknown'}`)
    }
  }

  /**
   * 运行期加一个可被中继的端口 —— 对应 ssh 版的 `ssh -O forward`（覆盖网络 R4）。
   *
   * **返回 `false` 而不抛**：加不上不该让 agent 崩 —— 实例在本机照样可用，只是"跨机代理"
   * 这一跳不可用，这与 `SshTunnel.forward()` 的既有语义一致（跨机代理降级 ≠ 本机功能降级）。
   */
  async addPort(port: number, timeoutMs = 5_000): Promise<boolean> {
    if (this.allow.has(port)) return true
    const res = await this.requestPort(port, true, timeoutMs)
    if (res.ok) {
      this.dynamicPorts.add(port)
      // ⚠️ 必须同时进 `allow` —— 否则服务端会开回环口、也把 `OPEN` 发过来，而这里因为白名单
      // 里没有它而回 `OPEN_ACK{ok:false}` ⇒ **口开着、流全被拒**（最难看的一种半通）。
      this.allow.add(port)
    } else {
      this.log(`[relay-client] addPort ${port} 失败：${res.error ?? 'unknown'}`)
    }
    return res.ok
  }

  /** 撤销一个运行期端口 —— 对应 `ssh -O cancel`；**不再有监听留在 relay 上**。 */
  async removePort(port: number, timeoutMs = 5_000): Promise<boolean> {
    if (!this.dynamicPorts.has(port)) return true
    const res = await this.requestPort(port, false, timeoutMs)
    if (res.ok) {
      this.dynamicPorts.delete(port)
      this.allow.delete(port)
    }
    return res.ok
  }

  /** 当前运行期端口（诊断用 —— `describeClientStatus` 会打出来）。 */
  get runtimePorts(): number[] {
    return [...this.dynamicPorts].sort((a, b) => a - b)
  }

  private requestPort(
    port: number,
    add: boolean,
    timeoutMs: number,
  ): Promise<{ ok: boolean; localPort?: number; error?: string }> {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve({ ok: false, error: 'bad-port' })
    if (this.state !== 'up' || this.ws === undefined) {
      // 链路没起来就没法谈"加端口"：明确回失败（**不排队**）—— 上层有 20s 对账自愈兜底。
      return Promise.resolve({ ok: false, error: `not up (${this.state})` })
    }
    const reqId = this.portReqId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.portWaiters.delete(reqId)
        resolve({ ok: false, error: 'timeout' })
      }, Math.max(200, timeoutMs))
      timer.unref()
      this.portWaiters.set(reqId, { resolve, timer })
      if (!this.send(encodeJsonFrame(add ? MUX.PORT_ADD : MUX.PORT_DEL, 0, { reqId, port }))) {
        clearTimeout(timer)
        this.portWaiters.delete(reqId)
        resolve({ ok: false, error: 'send failed' })
      }
    })
  }

  private onPortAck(frame: MuxFrame): void {
    const msg = parseJsonPayload(frame.payload)
    const reqId = msg !== null && typeof msg.reqId === 'number' ? msg.reqId : -1
    const waiter = this.portWaiters.get(reqId)
    if (waiter === undefined) return // 迟到的 ACK（已超时收口）：丢掉，不当错误
    clearTimeout(waiter.timer)
    this.portWaiters.delete(reqId)
    const ok = msg !== null && msg.ok === true
    const localPort = msg !== null && typeof msg.localPort === 'number' ? msg.localPort : undefined
    const error = msg !== null && typeof msg.error === 'string' ? msg.error : undefined
    waiter.resolve(ok ? { ok: true, localPort } : { ok: false, error: error ?? 'rejected' })
  }

  /** 断链时把所有在途端口请求收口（否则调用方会一直挂在超时上）。 */
  private failPortWaiters(why: string): void {
    for (const [reqId, w] of [...this.portWaiters]) {
      clearTimeout(w.timer)
      this.portWaiters.delete(reqId)
      w.resolve({ ok: false, error: why })
    }
  }

  /**
   * 注册被拒（`HELLO_ERR`）—— **区分"能自救"与"得改配置"**。
   * `clock-skew` 是唯一能自愈的一类：拿服务端时间戳校正本地基准后立即重试。
   * 其余（`unknown-host` / `bad-mac` / `nonce-replay`…）属配置问题，退到上限重试并明确打标。
   */
  private onHelloErr(frame: MuxFrame): void {
    const msg = parseJsonPayload(frame.payload)
    const reason = msg !== null && typeof msg.reason === 'string' ? msg.reason : 'unknown'
    const retryable = msg !== null && msg.retryable === true
    const serverTime = msg !== null && typeof msg.serverTime === 'number' ? msg.serverTime : undefined
    if (serverTime !== undefined) this.clockSkewMs = this.now() - serverTime
    if (!retryable) this.lastFatalReason = reason

    // ── 满载 ⇒ **排队等待**（不是"失败"，也不是"换一个节点偷偷连"）─────────────
    if (reason === 'at-capacity') {
      const retryAfterMs = msg !== null && typeof msg.retryAfterMs === 'number' && msg.retryAfterMs > 0 ? msg.retryAfterMs : 5_000
      this.queueWaits += 1
      if (this.queuedSince === undefined) this.queuedSince = this.now()
      const waited = this.now() - this.queuedSince
      const cap = this.opts.queueMaxWaitMs ?? 0
      if (cap > 0 && waited > cap) {
        this.lastError = `at-capacity: queued ${waited}ms > ${cap}ms`
        this.log(`[relay-client] ⛔ 满载排队已 ${waited}ms 超过上限 ${cap}ms ⇒ 记故障（上限可调 queueMaxWaitMs）`)
      } else {
        this.log(
          `[relay-client] relay 满载 ⇒ 排队（第 ${this.queueWaits} 次，已等 ${Math.round(waited)}ms，${Math.round(retryAfterMs)}ms 后重试）；` +
            `容量信息 ${JSON.stringify(msg?.capacity ?? {})}`,
        )
      }
      this.onDown(`at-capacity (queued #${this.queueWaits}, waited ${Math.round(waited)}ms)`, false, retryAfterMs)
      if (!this.stopped) this.setState('queued') // 语义：**在排队**，而不是"退避重试"
      return
    }

    this.log(
      `[relay-client] HELLO rejected reason=${reason} retryable=${retryable} clockSkew≈${this.clockSkewMs}ms` +
        (retryable ? ' ⇒ 按提示修正后立即重试' : ' ⛔ 非重试可解（检查密钥 / hostId 配置）'),
    )
    // 能自救的那一类：本地校正已在上面的 `clockSkewMs` 里生效，立即重试（`onOpen` 会用校正后的基准重算 MAC）。
    this.onDown(`hello rejected: ${reason}`, reason === 'clock-skew')
  }

  /* ═══════════ 拨号方（覆盖网络 R5） ═══════════ */

  /**
   * 请 relay 开一条到 `(target, port)` 的双向流，返回可直接 `pipe()` 的 `Duplex`。
   *
   * **与 `addPort()` 的关系是"对称的另一半"**：`addPort` = 让别人能连**我**（inbound），
   * `openStream` = 让我能连**别人**（outbound）。relay 侧两条路共用同一套流机制与并发口径。
   *
   * **失败一律抛错**（不返回"看起来能用"的对象）：拨号失败必须让调用方**立刻**看见 ——
   * 否则又退化成"静默失败"，那正是 R1 起反复强调要根治的病。
   */
  async openStream(target: string, port: number, timeoutMs = 5_000): Promise<MuxDuplex> {
    if (this.opts.dialer !== true) throw new Error('relay client: openStream() requires dialer mode')
    if (this.state !== 'up') throw new Error(`relay client: link not up (state=${this.state})`)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`relay client: bad port ${port}`)
    if (target === '') throw new Error('relay client: empty dial target')
    const id = this.nextDialId++
    if (this.nextDialId > 0xffffffff) this.nextDialId = 1
    const duplex = new MuxDuplex({
      onOut: (chunk) => this.pumpDial(id, chunk),
      onClosed: () => this.send(encodeJsonFrame(MUX.CLOSE, id, { reason: 'dialer closed' })),
    })
    const st: DialStream = { id, duplex, closed: false, paused: false, queued: [], queuedBytes: 0 }
    this.dialStreams.set(id, st)
    /**
     * ⛔ **这里不许挂 `duplex.on('data', …)` 把读侧接回出向。**
     *
     * 出向**唯一**入口是 `_write` → `onOut` → `pumpDial`：`duplex.write()` 走 `_write`，
     * `tcp.pipe(duplex)` 也走 `_write` ⇒ 两者本来就是同一条路，**不需要**再补一个监听。
     *
     * 挂上去等于把**读侧**（`onRemoteData` → `feed()` → `push()` 触发 `'data'`）也接到出向上
     * ⇒ **入向的字节被原样回灌**：worker 把它写进 agent socket，agent 拿 `HTTP/1.1 200 OK`
     * 当请求行解析 ⇒ 非法字节流 ⇒ Fastify `clientError` 回 `400`（写裸 socket、**不写 pino
     * 日志**）⇒ 用户 `POST /api/dsh/enter` 回 500。
     *
     * 2026-09-17 实锤（序 ⑭）：106 `tcpdump` 见 `<worker 侧连接> > <TUNNEL_PORT_1>` 的载荷是
     * `HTTP/1.1 200 OK … {"isDirectory":true}`（响应方向反了）；本仓
     * the regression suite **T23** 逐帧记账复现同一现象（修前红：目标端收到 2 段回灌字节）。
     */
    const res = await this.requestDial(id, target, port, timeoutMs)
    if (!res.ok) {
      this.closeDial(id, res.error ?? 'dial refused')
      throw new Error(`relay client: dial ${target}:${port} refused: ${res.error ?? 'unknown'}`)
    }
    this.log(`[relay-client] dial ${target}:${port} up (stream=${id})`)
    return duplex
  }

  private requestDial(id: number, target: string, port: number, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.dialWaiters.delete(id)
        resolve({ ok: false, error: 'dial timeout' })
      }, timeoutMs)
      timer.unref()
      this.dialWaiters.set(id, { resolve, timer })
      this.send(encodeJsonFrame(MUX.DIAL, id, { target, port }))
    })
  }

  private onDialAck(frame: MuxFrame): void {
    const w = this.dialWaiters.get(frame.streamId)
    if (w === undefined) return
    this.dialWaiters.delete(frame.streamId)
    clearTimeout(w.timer)
    const msg = parseJsonPayload(frame.payload)
    if (msg !== null && msg.ok === true) {
      w.resolve({ ok: true })
      return
    }
    const error = msg !== null && typeof msg.error === 'string' ? msg.error : 'refused'
    w.resolve({ ok: false, error })
  }

  /**
   * 拨号流的出向：调用方写下来的字节 ⇒ 打进 relay（水位满时排队，**不丢**）。
   *
   * 返回值 = "是否已直接送出"（`false` ⇒ 已入队，调用方应稍后 `resume()`）—— 与
   * `MuxDuplexOptions.onOut` 的背压语义对齐。
   */
  private pumpDial(id: number, chunk: Buffer): boolean {
    const st = this.dialStreams.get(id)
    if (st === undefined || st.closed) return false
    if (st.paused || this.overWater()) {
      const ok = queueOrDropDial(st, chunk, this.queueMax, () => this.closeDial(id, 'egress queue overflow'), this.log)
      if (!ok) return false
      if (!st.paused) {
        st.paused = true
        st.duplex.pause()
      }
      this.ensureFlusher()
      return false
    }
    this.bytesOut += chunk.length
    this.send(encodeMux(MUX.DATA, id, chunk))
    return true
  }

  private closeDial(id: number, why: string): void {
    const st = this.dialStreams.get(id)
    if (st === undefined || st.closed) return
    st.closed = true
    this.dialStreams.delete(id)
    this.send(encodeJsonFrame(MUX.CLOSE, id, { reason: why }))
    try {
      st.duplex.destroy()
    } catch {
      /* 已断 */
    }
  }

  private failDialWaiters(why: string): void {
    for (const w of this.dialWaiters.values()) {
      clearTimeout(w.timer)
      w.resolve({ ok: false, error: why })
    }
    this.dialWaiters.clear()
  }

  private teardownDialStreams(why: string): void {
    for (const st of [...this.dialStreams.values()]) {
      st.closed = true
      try {
        st.duplex.destroy(new Error(why))
      } catch {
        /* 已断 */
      }
    }
    this.dialStreams.clear()
  }

  private onOpenRequest(frame: MuxFrame): void {
    const msg = parseJsonPayload(frame.payload)
    const port = msg !== null && typeof msg.port === 'number' ? msg.port : -1
    const refuse = (why: string): void => {
      this.denied += 1
      this.log(`[relay-client] DENY open stream=${frame.streamId} port=${port}: ${why}`)
      this.send(encodeJsonFrame(MUX.OPEN_ACK, frame.streamId, { ok: false, error: why }))
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return refuse('bad port')
    /**
     * 拨号方**不服务任何端口**：收到 `OPEN` 只可能是服务端把它当 worker 用了（配错）。
     * 必须**响亮地拒**，而不是默默建立一条指向本机随机端口的流（那就是最早的"静默拨错"同族病）。
     */
    if (this.opts.dialer === true) return refuse('dialer serves no ports')
    // 🔒 唯一判据是**本机白名单**，不采信服务端声明的任何范围。
    if (!this.allow.has(port)) return refuse('port not in worker allow-list')
    const factory = this.opts.connectImpl ?? ((p: number, h: string) => connect(p, h))
    const tcp = factory(port, '127.0.0.1') // 目标恒为回环，永不接受可路由地址
    tuneStream(tcp)
    const st: LocalStream = { id: frame.streamId, port, tcp, closed: false, paused: false, queued: [], queuedBytes: 0 }
    this.streams.set(frame.streamId, st)
    let settled = false
    tcp.once('connect', () => {
      settled = true
      this.send(encodeJsonFrame(MUX.OPEN_ACK, frame.streamId, { ok: true }))
    })
    tcp.on('data', (chunk: Buffer) => this.pumpToRelay(st, chunk))
    tcp.once('error', (err: Error) => {
      if (settled) {
        this.closeLocal(frame.streamId, 'local tcp error')
        return
      }
      settled = true
      this.denied += 1
      this.log(`[relay-client] local connect 127.0.0.1:${port} failed: ${err.message}`)
      this.send(encodeJsonFrame(MUX.OPEN_ACK, frame.streamId, { ok: false, error: 'local connect failed' }))
    })
    tcp.once('close', () => {
      if (!st.closed) this.closeLocal(frame.streamId, 'local tcp closed')
    })
  }

  private onRemoteData(frame: MuxFrame): void {
    // 拨号流先查（它的 id 属于本侧命名空间，与 `streams` 那张表不重叠，但顺序上先判更安全）。
    const dial = this.dialStreams.get(frame.streamId)
    if (dial !== undefined) {
      this.bytesIn += frame.payload.length
      // 读侧水位满时 `feed()` 返回 false：这里**不能**丢字节，交给 relay 侧的队列兜（它有自己的上限）。
      dial.duplex.feed(frame.payload)
      return
    }
    const st = this.streams.get(frame.streamId)
    if (st === undefined || st.closed) return
    this.bytesIn += frame.payload.length
    if (st.paused) {
      queueOrDrop(st, frame.payload, this.queueMax, () => this.closeLocal(frame.streamId, 'ingress queue overflow'), this.log)
      return
    }
    if (!st.tcp.write(frame.payload)) {
      st.paused = true
      st.tcp.once('drain', () => this.flush(st))
    }
  }

  private pumpToRelay(st: LocalStream, chunk: Buffer): void {
    if (st.closed) return
    if (st.paused || this.overWater()) {
      const ok = queueOrDrop(st, chunk, this.queueMax, () => this.closeLocal(st.id, 'egress queue overflow'), this.log)
      if (!ok) return
      if (!st.paused) {
        st.paused = true
        st.tcp.pause()
      }
      this.ensureFlusher()
      return
    }
    this.bytesOut += chunk.length
    this.send(encodeMux(MUX.DATA, st.id, chunk))
  }

  private overWater(): boolean {
    const ws = this.ws
    if (ws === undefined) return true
    const buffered = ws.bufferedAmount
    return typeof buffered === 'number' && buffered > this.highWater
  }

  /** WS 缓冲回落后把暂停流的队列放出去；只在**确实有暂停流**时跑定时器。 */
  private ensureFlusher(): void {
    if (this.flushTimer !== undefined || this.stopped) return
    const timer = setInterval(() => {
      if (this.stopped || this.ws === undefined) {
        this.stopFlusher()
        return
      }
      if (!this.overWater()) {
        for (const st of [...this.streams.values()]) {
          if (st.closed || !st.paused) continue
          while (st.queued.length > 0 && !this.overWater()) {
            const chunk = st.queued.shift()
            if (chunk === undefined) break
            st.queuedBytes -= chunk.length
            this.bytesOut += chunk.length
            this.send(encodeMux(MUX.DATA, st.id, chunk))
          }
          if (st.queued.length === 0) {
            st.paused = false
            st.tcp.resume()
          }
        }
        // 拨号流的队列走**同一个** flusher：两套定时器迟早互相踩（`flushTimer` 只有一个）。
        for (const st of [...this.dialStreams.values()]) {
          if (st.closed || !st.paused) continue
          while (st.queued.length > 0 && !this.overWater()) {
            const chunk = st.queued.shift()
            if (chunk === undefined) break
            st.queuedBytes -= chunk.length
            this.bytesOut += chunk.length
            this.send(encodeMux(MUX.DATA, st.id, chunk))
          }
          if (st.queued.length === 0) {
            st.paused = false
            st.duplex.resume()
          }
        }
      }
      let stillPaused = false
      for (const st of this.streams.values()) if (!st.closed && st.paused) stillPaused = true
      for (const st of this.dialStreams.values()) if (!st.closed && st.paused) stillPaused = true
      if (!stillPaused) this.stopFlusher()
    }, FLUSH_INTERVAL_MS)
    timer.unref()
    this.flushTimer = timer
  }

  private stopFlusher(): void {
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer)
    this.flushTimer = undefined
  }

  private flush(st: LocalStream): void {
    if (st.closed) return
    st.paused = false
    while (st.queued.length > 0) {
      const chunk = st.queued.shift()
      if (chunk === undefined) break
      st.queuedBytes -= chunk.length
      if (!st.tcp.write(chunk)) {
        st.paused = true
        st.tcp.once('drain', () => this.flush(st))
        return
      }
    }
  }

  private closeLocal(streamId: number, why: string): void {
    const st = this.streams.get(streamId)
    if (st === undefined || st.closed) return
    st.closed = true
    this.streams.delete(streamId)
    this.send(encodeJsonFrame(MUX.CLOSE, streamId, { reason: why }))
    try {
      st.tcp.end()
    } catch {
      /* 已断 */
    }
    const timer = setTimeout(() => st.tcp.destroy(), 2_000)
    timer.unref()
  }

  private teardownStreams(): void {
    for (const st of [...this.streams.values()]) {
      st.closed = true
      try {
        st.tcp.destroy()
      } catch {
        /* 已断 */
      }
    }
    this.streams.clear()
  }

  private send(buf: Buffer): boolean {
    const ws = this.ws
    if (ws === undefined || ws.readyState !== 1) return false
    try {
      ws.send(buf)
      return true
    } catch (err) {
      this.log(`[relay-client] send failed: ${errText(err)}`)
      return false
    }
  }
}

/** 队列入队；超上限 ⇒ 回调（断流）并返回 `false`。 */
function queueOrDrop(st: LocalStream, chunk: Buffer, max: number, onOverflow: () => void, log: (s: string) => void): boolean {
  st.queued.push(chunk)
  st.queuedBytes += chunk.length
  if (st.queuedBytes > max) {
    log(`[relay-client] stream ${st.id} queue ${st.queuedBytes}B > ${max}B ⇒ drop stream`)
    onOverflow()
    return false
  }
  return true
}

/** 与 `queueOrDrop` 同口径，只是对象换成拨号流（字段刻意同名；断流动作不同，所以没合并）。 */
function queueOrDropDial(st: DialStream, chunk: Buffer, max: number, onOverflow: () => void, log: (s: string) => void): boolean {
  st.queued.push(chunk)
  st.queuedBytes += chunk.length
  if (st.queuedBytes > max) {
    log(`[relay-client] dial stream ${st.id} queue ${st.queuedBytes}B > ${max}B ⇒ drop stream`)
    onOverflow()
    return false
  }
  return true
}

/** `net.Socket` 专有开关（`Duplex` 上没有）；测试注入的假连接会走 `?.` 空转。 */
function tuneStream(tcp: Duplex): void {
  const s = tcp as Duplex & { setNoDelay?: (on: boolean) => void }
  s.setNoDelay?.(true)
}

function toBuffer(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把 `SNAP` / `PRESENCE` 负载里的 `entries` 数组**逐条校验**后再采用（序⑲）。
 *
 * 为什么逐条校验而不是 `as RelayPresenceEntry[]`：这是**跨进程**来的数据（WS 帧），
 * 一条字段缺失的条目如果被直接当成事实，症状是"某台机器永远显示离线" ——
 * 与本线反复踩的"静默失败"同族（宁可**丢这一条**并留着上一条，也不采用半截数据）。
 */
function toPresenceEntries(raw: unknown): RelayPresenceEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RelayPresenceEntry[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (typeof e.name !== 'string' || e.name === '') continue
    if (typeof e.hostId !== 'string' || typeof e.network !== 'string') continue
    if (typeof e.online !== 'boolean') continue
    out.push({
      name: e.name,
      hostId: e.hostId,
      network: e.network,
      online: e.online,
      devices: typeof e.devices === 'number' ? e.devices : 0,
      ports: Array.isArray(e.ports) ? e.ports.filter((p): p is number => typeof p === 'number') : [],
      localPorts: Array.isArray(e.localPorts)
        ? (e.localPorts as unknown[]).flatMap((raw) => {
            if (raw === null || typeof raw !== 'object') return []
            const lp = raw as { port?: unknown; localPort?: unknown }
            if (typeof lp.port !== 'number' || typeof lp.localPort !== 'number') return []
            return [{ port: lp.port, localPort: lp.localPort }]
          })
        : [],
      lastSeenAgoMs: typeof e.lastSeenAgoMs === 'number' ? e.lastSeenAgoMs : 0,
      offlineInMs: typeof e.offlineInMs === 'number' ? e.offlineInMs : undefined,
      changedAt: typeof e.changedAt === 'number' ? e.changedAt : 0,
    })
  }
  return out
}

/** 便于诊断：把 client 当前状态压成一行（`systemctl status` / 日志里直接可读）。 */
export function describeClientStatus(s: RelayClientStatus): string {
  const retry = s.nextRetryMs === undefined ? '' : ` nextRetryIn=${Math.round(s.nextRetryMs)}ms`
  const frame = s.lastFrameAgeMs === undefined ? '' : ` lastFrameAge=${s.lastFrameAgeMs}ms`
  const rtt = s.rttMs === undefined ? '' : ` rtt=${s.rttMs}ms`
  const dyn = s.dynamicPorts.length === 0 ? '' : ` dyn=[${s.dynamicPorts.join(',')}]`
  return (
    `state=${s.state}(for ${Math.round(Date.now() - s.stateSince)}ms) net=${s.network} session=${s.sessionId ?? '-'} ` +
    `attempts=${s.attempts}${retry} streams=${s.streams}${dyn} denied=${s.denied} ` +
    `reconnects=${s.reconnects} restarts=${s.restarts} netChanges=${s.networkChanges} ` +
    `queue=${s.queueWaits}(waited ${Math.round(s.queuedMs)}ms) ` +
    `skew=${s.clockSkewMs}ms${rtt}${frame} in=${s.bytesIn}B out=${s.bytesOut}B` +
    (s.lastError === undefined ? '' : ` lastError="${s.lastError}"`)
  )
}

/**
 * **`gracefulBurstMs` 的默认值口径**（序⑨ 参数表化）。
 *
 * 改造前它是本仓**唯一一个不可配的时延常量**（全仓只有 `?? 15_000` 一处、无 env 键、无装配点赋值）
 * ⇒ 运行时无法调，违反本线"阈值零魔数"纪律（`overlay-probe` 的 E6）。
 * 现在：可用 `RELAY_GRACEFUL_BURST_MS` 覆写，**默认值语义逐字不变**（`15_000`）。
 *
 * ⚠️ 改这个值 = **改"计划内重启不触发切流"的窗口长度**（{@link RelayClientStatus.inGracefulBurstWindow}
 * 就是它）⇒ 动它必须先回写设计说明（序⑨ D3：默认值 ⛔ 不许改）。
 */
export function gracefulBurstMsDefault(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RELAY_GRACEFUL_BURST_MS
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 15_000
}

/**
 * **换址等待的"终态失败"判据**（序⑨ · RC-1 的唯一判据来源）。
 *
 * ## 它治的是什么
 * `waitUpOn` 原来只轮询 `state === 'up'`，直到 `deadline` 才 `return false`
 * ⇒ **连不上的死候选**与**连得上但慢的候选**在这一层**不可区分**，代价**恒为 `upTimeoutMs`**。
 * 实测（序⑨ §2-P10 逐行复核）：生产目录前两条候选同在 47（`web/server.ts` 的 `open` 注释已承认
 * "这个坑一定会踩到"）⇒ 每次从 47 切走**必然**先试同机的 `relay-direct`（已随 47 一起死）
 * ⇒ **固定白等 12 000 ms**：`[relay-skip] ⛔ 新通道起不来` 与 open 发起时刻的间隔 ≡ `upTimeoutMs`。
 *
 * ## 三条同时成立才算"终态失败"
 * 1. **已在 `backoff`** —— 连不上 / 被拒 / 被踢后重试。
 *    ⚠️ `connecting` / `handshaking` **不算**（"正在连" ≠ "挂了"）；`queued` 也不算
 *    （满载排队会 `attempts = 0`，下一条判据自然不成立）。
 * 2. **不在 burst 窗口内**（{@link RelayClientStatus.inGracefulBurstWindow} 为假）——
 *    `gracefulBurstMs`（默认 15 s）窗口内是"对端正在重启"，**计划内下线不是故障**（本文件顶部设计）
 *    ⇒ ⛔ 把它当终态失败就等于"每次 relay 重启/部署都切一次流"，正是 D5 要防的抖动。
 * 3. **已发生 ≥ 1 次非 burst 退避**（`attempts ≥ 1`）—— 首次失败即记账
 *    （`scheduleRetry` 在非 graceful / 非 burst 分支里 `attempts += 1`），
 *    含 `lastFatalReason`（密钥 / 主机名错）分支。
 *
 * ⛔ **只读判据**：不驱动重试 / 不改退避 / 不新增定时器（D2 = 复用既有状态机）。
 */
export function openedChannelFailedTerminally(s: RelayClientStatus): boolean {
  return s.state === 'backoff' && !s.inGracefulBurstWindow && s.attempts >= 1
}

/** {@link waitUpOnStatus} 的选项。 */
export interface WaitUpStatusOptions {
  /** 轮询间隔（ms）。默认 `100` —— 与改造前那三份内联实现逐字一致。 */
  pollMs?: number
  /**
   * 判死时回调（各装配点接自己的 logger）。
   * ⛔ **只用于日志**：它不参与判定，也不改变返回值。
   */
  onDead?: (s: RelayClientStatus) => void
}

/**
 * **换址版"等它到 `up`"** —— 序⑦ 起三个装配点各写一份，序⑨ D7 收口成**唯一一份实现**。
 *
 * 语义：**非抛**，只回答"通没通"（`open()` 要的是布尔）。
 * - 到 `up` ⇒ `true`；
 * - **终态失败**（{@link openedChannelFailedTerminally}）⇒ **立即 `false`**（序⑨ RC-1：⛔ 不白等满）；
 * - 到 `timeoutMs` ⇒ `false`（**慢候选照旧享受完整预算** —— 护栏用例 F18）。
 *
 * 三处消费点（D7）：`web/server.ts`（C1 · Manager 换址）／`worker/relay-tunnel.ts`
 * （C2 · worker 实例面）／`net/relay/main.ts`（C3 · 独立 `relay --client`）。
 * ⛔ **启动路径不用它**：启动只要"口池绑好"（见 C1 的 `open` 注释），不依赖网络到达。
 */
export async function waitUpOnStatus(
  client: { status(): RelayClientStatus },
  timeoutMs: number,
  opts: WaitUpStatusOptions = {},
): Promise<boolean> {
  const pollMs = Math.max(10, Math.round(opts.pollMs ?? 100))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const st = client.status()
    if (st.state === 'up') return true
    if (openedChannelFailedTerminally(st)) {
      opts.onDead?.(st)
      return false
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
