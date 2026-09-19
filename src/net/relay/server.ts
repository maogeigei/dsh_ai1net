/**
 * relay 服务端 —— **worker 拨它、Manager 经它到 worker**（覆盖网络 R1）。
 *
 * ## 拓扑（与 SSH 版**语义等价**，所以 Manager 侧零改动）
 * ```text
 *   worker 侧 RelayClient ──(唯一一条出向 wss)──▶ 本服务（绑 127.0.0.1）
 *                                                   │ 为每个注册端口开一条回环监听
 *                                                   ▼
 *   Manager ──▶ 127.0.0.1:<动态分配端口> ──▶ 多路复用进那条 wss ──▶ worker 本地 127.0.0.1:<port>
 * ```
 * `Reachability.address` 仍是 `host:port` ⇒ `agentBaseUrlOf()` 拼出来的基址与 SSH 版
 * **同形**，调用方不需要知道底下换成了 relay。这是"可替换实现"能成立的前提。
 *
 * ## 安全姿态（默认拒绝，逐条对应方案 §10.1 的判据）
 * | 判据 | 做法 |
 * |---|---|
 * | ① 认证模型 | **每 worker 一密钥**（非共享 token）；`HMAC-SHA256(secret, hostId\|ts\|nonce\|portsCsv)`；`timingSafeEqual` 比较；`ts` 窗口 ±60s；nonce 防重放（有界 LRU） |
 * | ② 默认姿态 | 未认证连接 **只允许发 `HELLO`**，5s 未认证即关；未知类型直接关连接 |
 * | ③ 零新增入站 | 默认绑 `127.0.0.1`；**只开回环监听**（`localPort` 动态分配，避开既有端口区间） |
 * | ④ 爆炸半径 | worker 声明的端口必须落在**实例端口区间**内；每端口并发流上限；单流缓冲上限，超限**断流**而非静默丢弃 |
 * | ⑤ 可观测 | `status()`：认证成败计数 / 拒绝计数 / 掉流计数 / 每 host 心跳龄 + 每 endpoint 的 `localPort` 与在线态 |
 * | ⑥ **网维度**（P0-1） | 每条会话属于**一张网**（`HELLO.network`，缺省 `ops`）；会话与端点表按**逻辑名 `<network>/<hostId>`** 索引；`DIAL` 必须**同网**且在**本网白名单**里 ⇒ 跨网连"能不能拨"都走不到（结构性隔离，不是策略性） |
 *
 * ## ⚠️ 为什么 `network` **不进 MAC**
 * `HELLO` 的 MAC 输入刻意保持 `${hostId}|${ts}|${nonce}|${portsCsv}` **一字不改**：现网 <worker-a> / <worker-b>
 * 上跑的是旧客户端，改 MAC 公式 = 硬断（必须两端同时升级）。而网络维度的**真判据在服务端**
 * （白名单按网络分桶 + 同网校验），`network` 只是"我属于哪张网"的声明 —— 声明错了也不会多拿到
 * 任何东西：想拨 `ops/<host-b>` 就得有一个**在 `ops` 桶里的 hostId 密钥**。⇒ 安全性不依赖这个字段，
 * 而兼容性（旧客户端不声明 `network` ⇒ 按 `ops` 处理）正好是**存量全部落在运维网**的现网事实。
 *
 * ## 稳定性（本轮重点）
 * - **精确失败**：`HELLO` 必须被 `HELLO_ACK` 确认、`OPEN` 必须被 `OPEN_ACK` 确认；任何一步没回音都**断开并记数**（SSH 版的病根正是 `-R` 撞号无人检查返回值）。
 * - **不丢字节**：`OPEN` 到 `OPEN_ACK` 之间 Manager 侧数据被 TCP 层 `pause()` 挡住（`pauseOnConnect`），`OPEN_ACK` 后再 `resume()` ⇒ 没有"打开竞态窗口丢头几个字节"。
 * - **有界缓冲**：任一队列超 `queueMaxBytes` 就断**那一条流**，不影响同连接其它流，也不让内存无上限增长。
 * - **心跳**：client 每 `hbSec` 发 `PING`；服务端 45s 内没收到任何帧 ⇒ 判死链并回收该 host 全部流。
 *
 * @module dsh_ai1net/net/relay/server
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { MUX, WsConnection, WS_CLOSE, acceptWebSocket, decodeMux, encodeJsonFrame, encodeMux, parseJsonPayload, type MuxFrame } from './wire.js'
import { OPS_NETWORK, NAME_SEP, describeDialers, isNetworkId, logicalName, normalizeDialers, parseLogicalName } from './network.js'
import { lookupKey, type RelayKeyEntry } from './keys.js'
import { normalizePublicKey, verifyPeerGrant, verifyProof, type RevocationList } from './identity.js'
/**
 * **relay 侧的抖动观测**用与平台侧**同一份**统计（`absDeltas` / `statsFromDeltas`）
 * ⇒ "实时选路看到的 p95"与"relay `/status` 报出的 p95"不可能出现两个数（口径分叉 = 假红/假绿）。
 */
import { absDeltas, statsFromDeltas, jitterThresholds, type JitterStats } from './jitter.js'

/** WebSocket 升级路径 —— 与 nginx `location`（R2）逐字对应，改名要两边同改。 */
export const RELAY_PATH = '/dsh_ai1net-relay'
/** 默认回环端口（**只回环**，不是公网口）。 */
export const DEFAULT_RELAY_PORT = 20080
/** 默认握手超时：连接建立后多久没收到合法 `HELLO` 就断。 */
export const DEFAULT_AUTH_DEADLINE_MS = 5_000
/** `HELLO` 时间戳容忍窗口。 */
export const DEFAULT_AUTH_WINDOW_MS = 60_000
/** 死链判定：多久没收到任何帧。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000
/** 心跳下发间隔。 */
export const DEFAULT_HB_SEC = 15

/** 满载（`at-capacity`）时给对端的**排队建议时长**（ms）。 */
export const DEFAULT_CAPACITY_RETRY_AFTER_MS = 5_000

/**
 * **利用率软门默认值（%）** —— 到它就拒新接入，留 30%+ 余量（用户口径「连接稳定高效」）。
 *
 * ⚠️ 它**不是**容量值：`RELAY_MAX_HOSTS`（7515 / 45% 设计口径）一字不动，软门只是提前拦。
 * 值可从参数表键 `RELAY_UTIL_MAX_PCT` 覆盖（见 {@link RelayServerOptions.utilMaxPct}）。
 */
export const DEFAULT_UTIL_MAX_PCT = 70

/**
 * 从 env 读一个**纯数字**整数（非纯数字 / 空 ⇒ 默认值）。
 *
 * ⚠️ 与 `relayFailoverThresholds` / `jitterThresholds` 同款纪律：参数表值格必须是纯数字
 * （写 `70`，⛔ 不许写 `70（70% 余量）` —— 后者解析失败会**静默回退默认值**）。
 */
function envNum(key: string, dflt: number): number {
  const raw = (process.env[key] ?? '').trim()
  if (raw === '') return dflt
  return /^\d+$/.test(raw) ? Number(raw) : dflt
}

/**
 * 优雅停机的**通知窗口**（ms）：发出 `BYE` + `close 1001` 后等这么久，再强制收尾。
 * 这个值就是"停机耗时"的上界 —— 而停机耗时 = 对端的恢复时间。
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 300
/** 同一 (host, port) 的并发流上限。 */
export const DEFAULT_MAX_STREAMS_PER_PORT = 64
/** 单流缓冲上限（入向 open 竞态窗口 + 出向背压队列共用）。 */
export const DEFAULT_QUEUE_MAX_BYTES = 1 << 20

/** 拨号流 peer 的出向水位（WS 缓冲到这个量就请上层转排队）。 */
export const WS_PEER_HIGH_WATER = 256 * 1024
/** 每 host 保留的 nonce 数（防重放的有界窗口）。 */
const NONCE_KEEP = 256

/* ═══════════ presence（在线态）默认值 —— 全部来自 `瓶颈落地方案 §1` ═══════════ */

/**
 * 离线 **grace**（ms）：断连后先不改口，仍报在线。
 *
 * 依据 = `覆盖网络_瓶颈落地方案 §1` 第 5 条「**grace period 5–15 s + 离线 debounce 30 s**，
 * 防止'网络抖一下 = 状态闪烁'」。取区间上沿 **10 s**：presence 允许 5–15 s 陈旧（第 7 条），
 * 而"少报一次离线"比"多报一次离线"代价小（后者会让上层把健康节点当死的）。
 */
export const DEFAULT_PRESENCE_GRACE_MS = 10_000
/**
 * 离线 **debounce**（ms）：与 grace 相加才是真正的"转为离线"时刻（默认 10 + 30 = 40 s）。
 *
 * 为什么与 grace 分开算而不是合成一个 40 s：两者语义不同 —— grace 是"**抖动容忍**"
 * （抖动窗口内的重连**不该产生任何事件**），debounce 是"**事件合并**"
 * （窗口内多次上下线只留最后一次）。合成一个数会让"≤ grace 仍在线"这条判据无处可测。
 */
export const DEFAULT_PRESENCE_OFFLINE_DEBOUNCE_MS = 30_000
/**
 * **批合并窗口**（ms）—— 每 s 一次 pipeline 提交。
 *
 * 依据 = 第 2 条原文「每个网关把本地心跳攒起来，**每 1 s 一次 pipeline 提交**」＋ 第 4 条
 * 「一条消息里带 **user 数组**；最多每几秒推一批」。
 * 🔴 **为什么不取"零延迟逐次推"**：presence 允许 5–15 s 陈旧（第 7 条）⇒ 1 s 窗口完全够用，
 * 而逐次推会在抖动时制造**帧爆炸**（正是本改造要消灭的现象）。
 */
export const DEFAULT_PRESENCE_BATCH_MS = 1_000
/**
 * **TTL 安全网**相对 `HB_SEC` 的倍数（默认 ×3 ⇒ 15 s × 3 = **45 s**）。
 *
 * 依据 = 第 1 条原文「**存储带 TTL 只作安全网**（防网关崩溃漏事件）」⇒ 它是"**漏事件**"的兜底，
 * ⛔ 不是主判据（主判据永远是连接生命周期）。取 ×3 而非 ×1：本机实测心跳往返可达 336 ms 量级，
 * ×1 会在一次网络抖动里就把在线节点判死（假红）。
 * ⚠️ **它只兜底"没有活连接"的条目**；有活连接的条目由会话心跳（`idleTimeoutMs`）负责。
 */
export const DEFAULT_PRESENCE_TTL_FACTOR = 3
/**
 * 单条会话可订阅的 host 数上限（`0` = 不限；默认 0）。
 *
 * ⛔ **本键不是节流开关**：真正的节流是"1 s 批合并 + 只推变化"（第 2/4 条）。
 * 它只是**有界性**保证（防一条会话声明一个无限大的订阅集把服务端内存吃光）。
 */
export const DEFAULT_PRESENCE_SUB_MAX = 0

export interface RelayServerOptions {
  /** 监听地址。**默认且建议保持 `127.0.0.1`** —— 本机无防火墙（实测 `nft INPUT policy accept`），绑 `0.0.0.0` 会立刻公网可达。 */
  host?: string
  port?: number
  /** hostId → 预共享密钥（**hex**，每 worker 一个）。空 map ⇒ 所有 `HELLO` 被拒（默认拒绝）。 */
  keys: ReadonlyMap<string, string | RelayKeyEntry>
  /** 实例端口区间起点（worker 声明的端口必须 ≥ 它）。 */
  instancePortBase: number
  /** 实例端口区间宽度。 */
  instancePortSpan: number
  maxStreamsPerPort?: number
  queueMaxBytes?: number
  authDeadlineMs?: number
  authWindowMs?: number
  idleTimeoutMs?: number
  hbSec?: number
  /**
   * 允许同时在线的主机数上限。`0`（默认）= 不限。
   *
   * **满载是唯一的硬门**：满了就拒绝新节点加入（回 `at-capacity` + `retryAfterMs`），
   * 对端据此**排队等待**。已在册的 hostId 重连**永远优先**（它占的位子本来就是它的）。
   */
  maxHosts?: number
  /** 满载时建议对端多久后再来（ms）。默认 5000。 */
  capacityRetryAfterMs?: number
  /**
   * **利用率软门（%）** —— `used / max × 100 ≥ 它` ⇒ 拒绝新接入（⛔ 不打满）。
   *
   * `0` = 关闭（行为逐字回到改造前）。缺省 ⇒ env `RELAY_UTIL_MAX_PCT` ⇒ 70（见字段注释）。
   * ⚠️ **它不改任何既有生产值**：`RELAY_MAX_HOSTS` 仍是 7515，软门只是**提前**拦。
   */
  utilMaxPct?: number
  /** 优雅停机的通知窗口（ms），默认 300 —— 见 `DEFAULT_SHUTDOWN_GRACE_MS`。 */
  shutdownGraceMs?: number
  /**
   * **允许发起 `DIAL` 的白名单**（覆盖网络 R5 / P0-1），按**网络分桶**：
   * `Map<networkId, Set<hostId>>`。没列到的网络 ⇒ 该网络**一个都拨不动**（默认拒绝）。
   *
   * 也接受 R5 时代的**扁平 `Set<hostId>`**（等价于"这些都在 `ops` 网里"）⇒ 旧配置照旧可用，
   * 过渡期不必改任何 drop-in（见 `network.ts#normalizeDialers`）。
   *
   * 为什么用「服务端白名单 + 每主机独立密钥」而不是一个共享的拨号 token：
   * - 密钥表本就是**每 worker 一个**（`keys.ts`：爆炸半径 = 那一台）⇒ worker A 无法冒充
   *   `manager` 去认证；再叠一层白名单，**即使**某台 worker 的密钥泄露也**拨不动**别人的实例。
   * - 这条门是**收窄**而不是扩大：它只把「Manager 本来就能做的跨机代理」从"必须同机"变成
   *   "可以异地"，不新增任何主体、不新增任何监听口。
   *
   * P0-1 加的**第二道门**不是白名单，而是"**同网**"：不同网络的节点之间，连"能不能拨"这一步
   * 都走不到。
   * ⚠️ P0-3 起**对外不再有专属拒绝码**：跨网一律回 `target-offline`（与"本网无此节点"逐字同形），
   * 区分只留在服务端日志里 —— 否则"它在别张网"这句话本身就是**可探测的对端清单**（D4）。
   */
  dialers?: ReadonlySet<string> | ReadonlyMap<string, ReadonlySet<string>>
  /**
   * **受信签名者公钥**（覆盖网络）—— 用来验收 `HELLO` 里那条**节点入网凭据**的签名。
   *
   * ⚠️ **relay 侧这道门是"辅助"**（D2）：身份的真正判据在**节点自己**那里（`identity.ts` 的
   * `verifyPeerGrant`）。relay 也验一遍，是为了让"未授权节点"**在英国人就近被挡住**，
   * 而不是等它把端点注册进来、再由 Manager 去拒 —— 但**不能**把它当成唯一防线：
   * 控制面（这台 relay）被攻破时，唯一还站得住的正是节点本地的那一道。
   *
   * 空 ⇒ **不启用身份校验**（存量形态：只认 HMAC）。是否**强制**由 `requireIdentity` 决定。
   */
  trustedSignerKeys?: readonly string[]
  /** 有效的吊销清单（已验签）。给 ⇒ 被撤的 hostId / 节点公钥一律拒。 */
  revocations?: RevocationList
  /**
   * **强制**要求节点入网凭据（缺 / 无效 ⇒ 拒）。
   *
   * 缺省 `false`：现网 <worker-a> / <worker-b> 上跑的是**还没有身份层**的客户端，一律强制会**当场全断**。
   * ⇒ 采用与 `dsh_hosts.network_id` 同一条纪律：「**先加能力 → 再改代码 → 最后才开强制**」，
   * 每一步中断都不崩，且**任一步都能单独回滚**。
   */
  requireIdentity?: boolean
  /**
   * 是否**参与校验**（不必强制）节点凭据：`true`（默认）⇒ 客户端**带了**凭据就得验，
   * 验不过照样拒（"带了但无效"绝不放行）；`false` ⇒ 完全忽略凭据字段（仅调试用）。
   */
  verifyIdentity?: boolean
  /**
   * 是否为注册端口在 relay **本机**开回环监听（默认 `true`，即 R1–R4 的行为）。
   *
   * 置 `false` ⇒ relay 退化成**纯流转发**：不为任何端口绑本地口（本机暴露面 = 0，`/status`
   * 也不再给出 `localPort`）⇒ 「relay 与 Manager 是否同机」**彻底无关**。
   * 这就是「会合可换机」的收口开关，也是它的端到端验收手段（the regression suite T19）。
   */
  exposeLoopback?: boolean
  /* ── presence（在线态，覆盖网络「只做三件事」之一）—— 默认值见上方 DEFAULT_PRESENCE_* ── */
  /** 离线 grace（ms），默认 {@link DEFAULT_PRESENCE_GRACE_MS}。 */
  presenceGraceMs?: number
  /** 离线 debounce（ms），默认 {@link DEFAULT_PRESENCE_OFFLINE_DEBOUNCE_MS}。 */
  presenceOfflineDebounceMs?: number
  /** 批合并窗口（ms），默认 {@link DEFAULT_PRESENCE_BATCH_MS}。 */
  presenceBatchMs?: number
  /** TTL 安全网（ms）；省略 ⇒ `hbSec × DEFAULT_PRESENCE_TTL_FACTOR`。 */
  presenceTtlMs?: number
  /** 单会话订阅上限（`0` = 不限，默认）。 */
  presenceSubMax?: number
  /**
   * **内容分发判别器的注入位**（可选）。
   *
   * relay 是独立进程、内容面的装配点在平台侧 ⇒ relay 内核**不认识** content 的任何类型；
   * 谁装配谁注入一个"取快照"的纯函数即可（见 `RelayStatus.content`）。
   * ⛔ 不给（缺省）⇒ `/status` 不含 `content` 字段 ⇒ 既有消费方零影响。
   *
   * ⚠️ 必须是**纯读**：它会在每次 `/status` 时被调用（`/status` 是观测面，⛔ 不得有副作用）。
   */
  statusContent?: () => Record<string, unknown>
  log?: (line: string) => void
}

/**
 * relay 一侧的「流对端」。
 *
 * 有两条完全不同的来路，但对数据面**必须同形**：
 * ① **注册端口**（R1–R4）：relay 主机上的一个 TCP socket（`net.Socket` 天然满足本接口）；
 * ② **拨号**（R5）：另一条 mux 会话（`WsStreamPeer` 把帧当字节流用）。
 *
 * 两者都只需要这 6 个方法 ⇒ 用结构化接口而不是 `Socket`，`onData` / `flushStream` / `closeStream`
 * **一行都不用分叉**。
 */
export interface StreamPeer {
  write(chunk: Buffer): boolean
  once(event: 'drain', cb: () => void): void
  pause(): void
  resume(): void
  end(): void
  destroy(): void
}

/** 拨号流的回程信息（挂在 worker 侧那条 `MuxStream` 上）。 */
interface DialInfo {
  /** 拨号方会话 —— 回程 `DATA` / `CLOSE` 的收件人。 */
  session: Session
  /** 拨号方那侧的 `streamId`（**与 worker 侧的 id 不是一个命名空间**，必须原样带回）。 */
  streamId: number
  /** worker 尚未 `OPEN_ACK` ⇒ 拨号方的数据先缓存（等价于 TCP 版的 `pauseOnConnect`）。 */
  ready: boolean
  pending: Buffer[]
  pendingBytes: number
}

interface MuxStream {
  id: number
  port: number
  /** 见 `StreamPeer`。 */
  peer: StreamPeer
  /** `OPEN` 已发但 `OPEN_ACK` 未回 —— 此刻入向数据只能缓存。 */
  opening: boolean
  /** 对端写满，暂停向它写（出向背压）。 */
  paused: boolean
  closed: boolean
  queued: Buffer[]
  queuedBytes: number
  /** 仅拨号流有。 */
  dial?: DialInfo
}

interface Session {
  id: string
  hostId: string
  /**
   * 本会话属于哪张网（P0-1）—— 注册时从 `HELLO.network` 取，**缺省 `ops`**（旧客户端兼容）。
   * 会话表按**逻辑名 `<network>/<hostId>`** 索引 ⇒ 两张网里的同名 hostId **互不干扰**。
   */
  network: string
  conn: WsConnection
  ports: Set<number>
  streams: Map<number, MuxStream>
  portStreams: Map<number, number>
  /**
   * 仅**拨号方**会话有：`拨号方 streamId → (worker 会话, worker 侧那条流)`。
   *
   * 拨号方发来的 `DATA` / `CLOSE` 带的是**它自己的** id，不查这张表就无处可去（worker 会话的
   * `streams` 里装的是 relay 分配的 id，两者不是一个命名空间）。
   */
  dialRoutes: Map<number, { session: Session; st: MuxStream }>
  nextStreamId: number
  lastSeen: number
  heartbeat: NodeJS.Timeout
  bytesIn: number
  bytesOut: number
  /** 注册时刻（诊断"这条会话活了多久"）。 */
  since: number
  /** 服务端**主动**发 `PING` 的时刻；`PONG` 回来时用它算 RTT。 */
  pingSentAt?: number
  /** 最近一次心跳 RTT —— 链路质量的**实测**值，也是判断"是不是半开"的旁证。 */
  rttMs?: number
  /**
   * **本会话的 RTT 样本环**（每个 `PONG` 记一个，上限 = `JITTER_SAMPLE_MAX`）。
   *
   * 🔴 为什么按**会话**存而不是存一个全局序列：不同对端的 RTT **基线不同**（47↔106 是跨云、
   * 47↔47 是回环）。把两台机器的 RTT 混进一条序列算差分，会把"切换对端"记成一次巨大抖动
   * ⇒ 假红。⇒ **差分在会话内算，直方图在会话间合并**（{@link RelayServer.jitterStats}）。
   */
  rttSamples?: number[]
  /**
   * presence 订阅集（`瓶颈落地方案 §1` 第 3 条：**订阅只活在连接期间**）。
   *
   * `undefined` = 未订阅（默认，零成本）；`'all'` = 本网全部；`Set` = 点名订阅的逻辑名。
   * ⛔ 没有"持久订阅"这种东西 —— 连接一断，条目随会话一起消失。
   */
  subs?: 'all' | Set<string>
  /**
   * 待推的在线态变更（**1 s 批合并的缓冲**；第 2/4 条）—— 键 = 逻辑名。
   *
   * 为什么是 Map 而不是数组：同一 host 在 1 s 内上下线多次时，**只留最后一次**才算"合并"
   * （数组会把中间态也推出去 ⇒ 批合并退化成"攒一批"而不是"合并"）。
   */
  presencePending: Map<string, PresenceEntry>
}

/**
 * 在线态的**服务端权威记录**。
 *
 * 🔑 **粒度 = 连接**（`conns`），对外聚合到 **host**：`conns.size > 0` ⇒ 在线。
 * 这样"同 hostId 两条连接断一条"天然仍是在线（第 6 条多设备聚合），而"全断"才进 grace。
 */
interface PresenceState {
  name: string
  network: string
  hostId: string
  /**
   * **连接 → 最后一次活动时刻**（多设备聚合的载体，也是 TTL 安全网的载体）。
   *
   * 🔴 为什么记"每个连接各自的时间"而不是一个 `Set<connId>` ＋ 会话表比对：
   * 同一 hostId 的第二条连接注册后，**第一条连接仍然是活的**（relay 有意不主动掐它 ——
   * 它只是不再在 `sessions` 表里）。若按"id 是否还在会话表里"来判死，那条**活着的**连接
   * 会被误摘 ⇒ 第二条再断时就是**假离线**（R11 净退化）。
   * 按"这个 id 自己多久没动静"判死则无此问题：活着的连接一直在刷，⛔ 永不被摘。
   */
  conns: Map<string, number>
  /** 最后一次连接活动（注册 / 收帧）。 */
  lastSeenMs: number
  /**
   * 最后一条连接消失的时刻；`0` = 当前有活连接。
   * 真正的"转离线"时刻 = `offlineSinceMs + grace + debounce`。
   */
  offlineSinceMs: number
  /** 该 host 声明的端口（`HELLO` 的 `ports` ＋ 运行期 `PORT_ADD/DEL`）。 */
  ports: Set<number>
  /** 对外**已发布**的在线态 —— 与实时判定区分开（前者是已告知谁，后者是事实）。 */
  published: boolean
  /** 最近一次**已发布状态**变化的时刻。 */
  changedAt: number
}

interface Endpoint {
  hostId: string
  /** 见 `Session.network`：端点也带网维度（表键 = `<network>/<hostId>:<port>`）。 */
  network: string
  port: number
  server?: TcpServer
  localPort: number
  session?: Session
  /**
   * `listen()` 落定（或失败）后 resolve —— 只有**运行期动态加端口**那条路要等它：
   * `PORT_ADD` 的应答里要回真实口号，而 `listen` 是异步的（注册路径不等，与 R1 行为一致）。
   */
  ready?: Promise<void>
}

/**
 * 一条**在线态**记录（presence）。
 *
 * 口径（`瓶颈落地方案 §1`）：
 * - 第 1 条：**来源是连接生命周期**（`conns` 非空 ⇒ 在线），⛔ 不是轮询推导；
 * - 第 6 条：**同 hostId 多连接按 device 聚合**（任一 device 在线 ⇒ 在线）⇒ 所以带上 `devices`；
 * - 第 5 条：断连后先过 **grace + debounce** 才改口 ⇒ 所以带上 `offlineInMs`（负值 = 已过窗口）。
 */
export interface PresenceEntry {
  /** 逻辑名 `<network>/<hostId>`（与 `/status` 同一键口径）。 */
  name: string
  hostId: string
  network: string
  online: boolean
  /** 同 hostId 的**在线连接数**（`> 1` = 多设备；聚合口径 = 任一在线即在线）。 */
  devices: number
  /** 该 host 声明的实例端口（供订阅方区分"离线"与"端口没了"）。 */
  ports: number[]
  /**
   * 每个声明端口在 **relay 本机**的回环落点（`localPort`；`0` = 未绑 / 纯流转发模式）。
   *
   * 🔑 **为什么把它放进 presence**：这正是 `/status` 除在线态之外**唯一**还被读的东西
   * （`web/server.ts#addressOf` / `#translateEndpoint` 的第二回退）。不带上它，"订阅生效后
   * 停止轮询"就会让那条回退路径拿不到地址 ⇒ **净退化（R11）**。
   * ⚠️ 它**不是**让 Manager 重新依赖"relay 同机"：拨号通道（R5）仍是首选，这只是兜底值。
   */
  localPorts: { port: number; localPort: number }[]
  /** 距最后一次连接活动多久（ms）。 */
  lastSeenAgoMs: number
  /**
   * 距**转为离线**还剩多久（ms）；**仅"已断连但仍在 grace/debounce 窗口内"时非 `undefined`**。
   * 负值 = 窗口已过（下一次 flush 就会推 `online:false`）。⛔ 在线时不填（不要制造无意义的字段）。
   */
  offlineInMs?: number
  /** 本条目最后一次**状态**变化时刻（帧数对账用：没有变化 ⇒ 不推）。 */
  changedAt: number
}

export interface RelayStatus {
  listening: string
  online: string[]
  /**
   * 允许发起 `DIAL` 的白名单（R5 / P0-1）。**空数组 = 该能力关闭**（默认）。
   * `ops` 网的条目按 R5 的写法**省略网络前缀**（`manager`）；其它网写全逻辑名（`u:5/d1`）。
   * 逐网络视图见 `networks`。
   */
  dialers: string[]
  /**
   * **网维度视图**（P0-1）：每张网各有哪些拨号方、哪些节点在线。
   *
   * 为什么单列一个字段而不是只把 `network` 塞进 `sessions`：Step 3 的判据是
   * 「`u:A` 的节点**看不到**也到不了 `u:B` 的节点」—— "看不到"这一半必须**可断言**，
   * 而按网络聚合一眼就能看出"这张网里到底有谁"，不必让调用方自己去 group。
   */
  networks: { network: string; dialers: string[]; sessions: string[] }[]
  /** 容量视图（`max = 0` ⇒ 不限）。`free` 仅在有限容量时有意义。 */
  capacity: {
    max: number
    used: number
    free?: number
    /**
     * **当前利用率（%）** = `floor(used × 100 / max)`；`max = 0`（不限）⇒ `0`。
     * 判据 = 它 **必须 ≤ `utilMaxPct`**（否则新接入已被拒 ⇒ 说明软门在拦人）。
     */
    utilPct: number
    /** **利用率软门（%）** —— 探针拿它与参数表值对账（⛔ 防"装了但用的是另一套默认值"）。 */
    utilMaxPct: number
  }
  /**
   * **抖动观测块**（`E2` 的 relay 侧落点）。
   *
   * ⚠️ **没有样本时它也在**（各键为 0 / 空直方图）—— ⛔ 不许"没数据就少一个键"：
   * 那会让探针分不清「**没装**」与「**装了但还没采到**」，正是本线反复踩的"静默失效"。
   * 全部字段 = `jitter.ts` 的 `JitterStats` ＋ 四个本模块字段（见 `jitterStats()`）。
   */
  jitter: JitterStats & {
    /** 有 ≥2 个 RTT 样本的会话数（= 能算出差分的会话数）。 */
    sessions: number
    /** 劣化阈值（ms，= 参数表 **`JITTER_LIMIT_MS`**，就有的达标限值）—— 探针据此对账。 */
    thresholdMs: number
    /** `p95|ΔRTT| ≥ 阈值` ⇒ `true`（判别器；⛔ 不是"有样本就算超标"）。 */
    overThreshold: boolean
    /** 累计告警次数（每次告警都对应一行 `[relay-jitter]`）。 */
    alerts: number
  }
  counters: {
    authed: number
    authFailed: number
    refused: number
    /**
     * **因利用率软门（`RELAY_UTIL_MAX_PCT`）被拒的注册数**。
     *
     * ⛔ 与 `refused`（硬门 `at-capacity`）分开计：混在一起就分不清"真的装满了"与
     * "为保余量提前拦"—— 前者是容量不足（要扩容），后者是**按设计工作**。
     */
    utilRefused: number
    /** 通过节点凭据校验的注册数。 */
    identityOk: number
    /** 是否**强制**要求节点凭据。 */
    identityRequired: boolean
    /** 受信签名者把数（`0` + `identityRequired` ⇒ 谁也进不来，配置不完整）。 */
    trustedSigners: number
    /** 当前吊销清单里的 hostId 数。 */
    revokedHosts: number
    dropped: number
    streamsOpened: number
    protocolErrors: number
    backpressurePauses: number
    /**
     * （观测最小集）：`DIAL` 的**判别器计数**。
     *
     * 为什么需要它：443 单 §12 留下的教训原文是「**静默失效靠判别器定位**」，判别器就是
     * 「relay 到底有没有 `DIAL`」—— 今天它**只存在于日志行**（`DIAL manager -> <host-b>:21000 ok`），
     * 脚本无法断言 ⇒ 观测最小集缺了最关键的一条。
     *
     * 为什么不复用 `refused`：`refused` 是**所有**拒绝的合计（`HELLO` 越界、端口越界、`DIAL`…），
     * 而判别器要回答的是更窄的问题 —— **拨号这条路本身通不通**。三分支互斥且可加和：
     * - `dial` —— 拨号被**放行**（已回 `DIAL_ACK{ok:true}`，与 `streamsOpened` 同点自增）；
     * - `dialDenied` —— **策略拒绝**（不在拨号方白名单 / 服务停机中 / 每端口并发满）；
     * - `dialFailed` —— **目标不可达或请求非法**（节点离线或端口未声明 / `target`·`port` 非法）。
     *
     * 读法：`dial > 0` ⇒ 拨号路径通；三者恒 `0` 而业务流量存在 ⇒ 请求**根本没走到 `DIAL`**
     * （正是 `RemoteSpawner.translateEndpoint` 静默失效那类故障的指纹）。
     */
    dial: number
    dialDenied: number
    dialFailed: number
    /**
     * **presence 判别器**—— 口径与 `dial*` 同一条纪律：**不许只写日志**。
     *
     * - `subs` —— 当前**存活**的订阅数（**gauge**，不是累计）；连接断了订阅就没了（第 3 条：
     *   订阅只活在连接期间）⇒ 它必须能回到 `0`。"声明了订阅但 `subs` 恒 0" ⇒ 订阅层没生效。
     * - `pushed` —— 累计**推出去的 presence 帧数**（含首帧 `SNAP`）。稳态（无状态变化）时
     *   它**必须停住不走**（E1 的机器可读判据；⛔ 只靠人看日志是判不出来的）。
     * - `snaps` —— 其中 `SNAP` 的帧数（E4「首帧即全量」的机器可读判据）：**有订阅者却
     *   `snaps = 0`** ⇒ 首帧走的是"逐台拉"（N+1）那条老路。恒有 `snaps ≤ pushed`。
     * - `rejected` —— 被**显式拒绝**的订阅请求数（跨网 / 越界）。⛔ 与"静默返空"互斥：
     *   凡是拒绝都必须在这里 +1，否则就是本线反复踩的**假绿**。
     */
    subs: number
    pushed: number
    snaps: number
    rejected: number
    /**
     * `/status` 被读了几次（含**读它自己这一次**）。
     *
     * 🔑 存在的理由：原有的核心收益是"订阅生效后**不再轮询** `/status`"，而在此之前
     * **没有任何办法断言这件事**（"没人轮询"与"轮询了但没被记录"完全同形）。
     * 判据用法 = **两次读数之差**：差 `1` ⇒ 只有你在读（= 轮询确实停了）。
     */
    statusHits: number
  }
  endpoints: { hostId: string; network: string; port: number; localPort: number; online: boolean; streams: number }[]
  /**
   * **结构化**会话视图（`online` 那串是给人读的，这里是给程序 / 前端 / 告警用的）。
   * `lastSeenAgoMs` 与 `rttMs` 是判断"对端是否半开"的第一手证据。
   */
  sessions: {
    hostId: string
    /** 该会话所属网（P0-1）。 */
    network: string
    /** 逻辑名 `<network>/<hostId>` —— 跨网同名时用它区分，`hostId` 单看会歧义。 */
    name: string
    sessionId: string
    /** 已在线多久（ms）。 */
    upForMs: number
    /** 距最后一次收到帧多久（ms）。 */
    lastSeenAgoMs: number
    rttMs?: number
    ports: number[]
    streams: number
  }[]
  /**
   * **在线态视图**（presence）—— 与 `sessions` 的差别是**粒度**：
   * `sessions` 是"一条连接一行"（诊断用），`presence` 是"**一台 host 一行**"
   * （同 hostId 多连接**已按 device 聚合**，第 6 条）⇒ 这才是订阅方消费的那张表。
   *
   * ⚠️ 它同时是 `/status` **兜底路径**的数据源（D5：`/status` 降级但不删）⇒ 订阅与轮询
   * 两条路读的是**同一份事实**，不会出现"两条路给出不同在线态"。
   */
  presence: PresenceEntry[]
  /**
   * **内容分发视图（可选）** —— 块级内容寻址的判别器快照。
   *
   * ⚠️ **可选**：未装配内容面（或装配方没注入 provider）时该字段为 `undefined`，
   * 此时 `/status` 的 JSON **不含它** ⇒ 既有消费方（Manager / 探针 / 前端）**零影响**。
   * 这是本字段敢加进 `/status` 而不破坏兼容的原因（纯新增、缺省不出现）。
   *
   * ⚠️ 为什么不直接 import 内容模块：relay 是**独立进程**（`main.ts`），
   * 内容面的装配点在平台侧（`src/web/server.ts`）⇒ 两边**不共享进程内存**。
   * 故此处只定义一个**注入位**：谁装配谁把 `statusContent` 传进来（见 `RelayServerOptions`）。
   * 这样 relay 内核**不认识** content 的任何类型（零耦合，符合分层）。
   */
  content?: Record<string, unknown>
  /** presence 的时序口径（订阅方据此判陈旧，⛔ 不写死数字）。 */
  presenceTiming: { graceMs: number; offlineDebounceMs: number; batchMs: number; ttlMs: number; subMax: number }
}

export class RelayServer {
  private readonly opts: RelayServerOptions
  private readonly host: string
  private readonly port: number
  private readonly maxStreamsPerPort: number
  private readonly queueMaxBytes: number
  private readonly authDeadlineMs: number
  private readonly authWindowMs: number
  private readonly idleTimeoutMs: number
  private readonly hbSec: number
  private readonly maxHosts: number
  private readonly capacityRetryAfterMs: number
  /**
   * **利用率软门**（`E4`）：`used / max × 100 ≥ utilMaxPct` ⇒ **拒绝新接入**（⛔ 不打满）。
   *
   * 为什么要有它：`maxHosts`（7515，45% 设计口径）是"**硬容量**"——到那一格才拦，等于把
   * **余量（55%）**当成可用空间；而用户口径要求的是「连接稳定高效」⇒ 中继必须**留 30%+ 余量**，
   * 否则接入数一逼近容量，排队/重传/抖动会一起上来（那时再拦已经晚了）。
   * ⇒ 软门取 **70%**（参数表 `RELAY_UTIL_MAX_PCT`，⛔ **不改** `RELAY_MAX_HOSTS` 本身）。
   *
   * ⚠️ 值来源两级：`opts.utilMaxPct` → env `RELAY_UTIL_MAX_PCT` → 默认 70。
   * 走 env 兜底是**故意的**：装配点（`main.ts` 的 `--max-hosts` 那条路）**不在原有的在册文件集**内，
   * 若要求"必须由装配点传"，生产上就永远不会生效（= 静默失效）。
   */
  private readonly utilMaxPct: number
  private readonly shutdownGraceMs: number
  private readonly base: number
  private readonly span: number

  private http: HttpServer | undefined
  private sweeper: NodeJS.Timeout | undefined
  /** 正在优雅下线：此时**拒绝新注册**（回 `retryable=true`，对端会自行重连）。 */
  private draining = false
  /** 归一化后的拨号方白名单（`network → hostId 集合`）。**构造时定型**，运行期不可改（安全判据）。 */
  private readonly dialers: ReadonlyMap<string, ReadonlySet<string>>
  /** 受信签名者。**构造时定型** —— 与白名单同一条纪律：安全判据不在运行期被改。 */
  private readonly trustedSignerKeys: readonly string[]
  private readonly revocations: RevocationList | undefined
  private readonly requireIdentity: boolean
  private readonly verifyIdentity: boolean
  /** 会话表：键 = **逻辑名** `<network>/<hostId>`（P0-1：两张网里的同名 hostId 互不干扰）。 */
  private readonly sessions = new Map<string, Session>()
  /** 端点表：键 = `<network>/<hostId>:<port>`。 */
  private readonly endpoints = new Map<string, Endpoint>()
  private readonly seenNonces = new Map<string, Set<string>>()
  private authed = 0
  private authFailed = 0
  private refused = 0
  private dropped = 0
  private streamsOpened = 0
  private protocolErrors = 0
  /** 通过了**节点入网凭据**校验的注册数（原有的可观测判据：`0` 而 `authed > 0` ⇒ 身份层没生效）。 */
  private identityOk = 0
  private backpressurePauses = 0
  /** 判别器：`DIAL` 放行 / 策略拒绝 / 目标不可达（口径见 `RelayStatus.counters`）。 */
  private dial = 0
  private dialDenied = 0
  private dialFailed = 0

  /* ── presence── */
  /** 时序口径（全部可注入 ⇒ 单测不必真等 40 s）。 */
  private readonly presenceGraceMs: number
  private readonly presenceOfflineDebounceMs: number
  private readonly presenceBatchMs: number
  private readonly presenceTtlMs: number
  private readonly presenceSubMax: number
  /**
   * **内容分发判别器的注入位**（可选）—— 见 `RelayServerOptions.statusContent`。
   * `undefined` ⇒ `/status` 不含 `content` 字段（零影响既有消费方）。
   */
  private readonly statusContent: (() => Record<string, unknown>) | undefined
  /**
   * **在线态权威表** —— 键 = 逻辑名 `<network>/<hostId>`。
   *
   * 为什么权威在 relay 侧（D2）：在线态是**连接事实**，而连接终点在 relay。Manager 只消费 +
   * 缓存。⚠️ 这与「权威状态单点（归属 / 租约 / 骨干资格只能控制面写）」**不冲突** ——
   * 那条说的是**归属类**状态；presence 不是归属，它是"这条连接此刻在不在"。
   */
  private readonly presence = new Map<string, PresenceState>()
  /** 批合并定时器（1 s 窗口）—— presence 的**唯一**推送出口。 */
  private presenceTimer: NodeJS.Timeout | undefined
  /** 判别器：累计推出的 presence 帧数（含 `SNAP`）。稳态必须停住不走。 */
  private pushed = 0
  /**
   * 判别器：其中 `SNAP`（**首帧即全量**）的帧数。
   *
   * ⚠️ 单独立一个计数（而不是靠日志）才能把 E4 变成**可断言**的：
   * 有订阅者却一帧 `SNAP` 都没发过 ⇒ 说明首帧走的是"逐台拉"（N+1）那条老路。
   */
  private snaps = 0
  /** 判别器：被显式拒绝的订阅请求数。 */
  private rejected = 0
  /**
   * `/status` 的读取次数（**只在 HTTP 处理器里自增** ⇒ `status()` 被内部调用不计数）。
   * 首次读到的值就已包含"你这一次" ⇒ 判据用两次读数之差。
   */
  private statusHits = 0
  /** **判别器**：因**利用率软门**被拒的注册数（⛔ 与 `at-capacity` 硬门分开计 —— 两者意义不同）。 */
  private utilRefused = 0
  /** **判别器**：relay 侧观测到某会话抖动超标的次数（"告警"这条判据的可断言面）。 */
  private jitterAlerts = 0
  /**
   * `[relay-jitter]` 告警的**按会话节流表**（`key = network/hostId` → 上次告警时刻）。
   *
   * ⚠️ 用「会话 + 时间」两维节流：只按时间 ⇒ 多台同时抖会互相把对方的第一次挤掉；
   * 只按会话 ⇒ 持续抖动时会每 15 s 刷一行。
   */
  private readonly lastJitterWarnAt = new Map<string, number>()
  /** 告警最小间隔（ms）；心跳周期 × 4 ⇒ 每台每分钟左右最多一行。 */
  private readonly jitterWarnGapMs = DEFAULT_HB_SEC * 4 * 1000

  constructor(opts: RelayServerOptions) {
    this.opts = opts
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? DEFAULT_RELAY_PORT
    this.maxStreamsPerPort = opts.maxStreamsPerPort ?? DEFAULT_MAX_STREAMS_PER_PORT
    this.queueMaxBytes = opts.queueMaxBytes ?? DEFAULT_QUEUE_MAX_BYTES
    this.authDeadlineMs = opts.authDeadlineMs ?? DEFAULT_AUTH_DEADLINE_MS
    this.authWindowMs = opts.authWindowMs ?? DEFAULT_AUTH_WINDOW_MS
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.hbSec = opts.hbSec ?? DEFAULT_HB_SEC
    this.maxHosts = opts.maxHosts ?? 0
    this.capacityRetryAfterMs = opts.capacityRetryAfterMs ?? DEFAULT_CAPACITY_RETRY_AFTER_MS
    this.utilMaxPct = opts.utilMaxPct ?? envNum('RELAY_UTIL_MAX_PCT', DEFAULT_UTIL_MAX_PCT)
    this.shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
    this.base = opts.instancePortBase
    this.span = opts.instancePortSpan
    this.trustedSignerKeys = opts.trustedSignerKeys ?? []
    this.revocations = opts.revocations
    this.requireIdentity = opts.requireIdentity ?? false
    this.verifyIdentity = opts.verifyIdentity ?? true
    this.presenceGraceMs = opts.presenceGraceMs ?? DEFAULT_PRESENCE_GRACE_MS
    this.presenceOfflineDebounceMs = opts.presenceOfflineDebounceMs ?? DEFAULT_PRESENCE_OFFLINE_DEBOUNCE_MS
    this.presenceBatchMs = opts.presenceBatchMs ?? DEFAULT_PRESENCE_BATCH_MS
    // TTL 安全网默认 = `HB_SEC` 的 3 倍（第 1 条：存储带 TTL 只作安全网，防网关崩溃漏事件）。
    this.presenceTtlMs = opts.presenceTtlMs ?? this.hbSec * 1_000 * DEFAULT_PRESENCE_TTL_FACTOR
    this.presenceSubMax = opts.presenceSubMax ?? DEFAULT_PRESENCE_SUB_MAX
    this.statusContent = opts.statusContent
    // ⚠️ 「强制身份」但「一把受信签名者都没有」= 谁也进不来（**仍然失败关闭**，不放开）。
    // 这是有意的：那台 relay 的配置**不完整**，此时"少拒一点"比"全拒"危险得多
    // （它会把"身份层根本没生效"伪装成"一切正常"）。启动日志会把它喊出来。
    // 白名单**在构造时**归一化（扁平 `Set` 也接受）⇒ 配置错（网络 id 非法）在这里就炸，
    // 而不是变成运行期"谁也没匹配上"的静默拒绝。
    this.dialers = normalizeDialers(opts.dialers)
  }

  private log(line: string): void {
    ;(this.opts.log ?? ((s: string) => process.stdout.write(`${s}\n`)))(`[relay] ${line}`)
  }

  async start(): Promise<void> {
    const http = createServer((req, res) => {
      if (req.url === '/status') {
        this.statusHits += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(this.status(), null, 2))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(`dsh_ai1net relay: WebSocket upgrade only, at ${RELAY_PATH}\n`)
    })
    http.headersTimeout = 10_000
    http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
    this.http = http
    this.draining = false
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => reject(err)
      http.once('error', onErr)
      http.listen(this.port, this.host, () => {
        http.off('error', onErr)
        resolve()
      })
    })
    this.log(`listening ws://${this.host}:${this.port}${RELAY_PATH} (loopback only) instance-ports=${this.base}..${this.base + this.span - 1}`)
    this.sweeper = setInterval(() => this.sweep(), 5_000)
    this.sweeper.unref()
    /**
     * presence 的**批合并出口**（第 2 条：每 1 s 一次 pipeline 提交）。
     *
     * ⚠️ 与 `sweeper`（5 s，扫端点）**分开**：两者周期不同、职责不同（一个是兜底巡检，
     * 一个是推送节拍）。合并会让 presence 的时延被 5 s 拖累 ⇒ 白丢第 4 条的收益。
     */
    this.presenceTimer = setInterval(() => this.flushPresence(), Math.max(50, this.presenceBatchMs))
    this.presenceTimer.unref()
  }

  /**
   * 停机 —— **优雅下线**：先给每条会话发 `BYE` + `close 1001`（going away）。
   *
   * 为什么不能直接掐 TCP：掐掉之后对端只能靠**心跳超时**（默认 45s）才发现 ⇒ 「计划内重启」
   * 会被放大成 45 秒的服务中断。发 `1001` 后对端**不消耗退避**地立刻重连（实测见 §12 的 T8）。
   */
  async stop(): Promise<void> {
    this.draining = true
    if (this.sweeper !== undefined) clearInterval(this.sweeper)
    if (this.presenceTimer !== undefined) clearInterval(this.presenceTimer)
    const sessions = [...this.sessions.values()]
    // 第一步：**告知**，不是掐断 —— 发 `BYE` + `close 1001`，对端据此立刻开始快速重连。
    for (const session of sessions) {
      if (!session.conn.isClosed) {
        session.conn.sendBinary(encodeJsonFrame(MUX.BYE, 0, { reason: 'server restarting' }))
        session.conn.close(WS_CLOSE.GOING_AWAY, 'server restarting')
      }
    }
    // 第二步：给一个**可控**的小窗口让通知真的发出去（默认 300ms），然后**不再等**对端回 close 帧。
    // ⚠️ 这里是实测踩出来的：原来"边发边 drop"，`http.close()` 要等 socket 收尾 ⇒ `stop()` 实测
    // 耗时 1.8s+，把对端的快速重连窗口整个耗光（§12 T8 复盘）。停机耗时 = 恢复时间，必须可控。
    if (sessions.length > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.shutdownGraceMs)
        t.unref()
      })
    }
    // 第三步：**强制**收尾 —— 通知已发出，剩下的不等了。
    for (const session of sessions) {
      this.dropSession(session, 'server stopping (graceful)')
      session.conn.destroy()
    }
    for (const ep of this.endpoints.values()) ep.server?.close()
    this.endpoints.clear()
    const http = this.http
    this.http = undefined
    if (http !== undefined) {
      // 立刻掐掉残留连接（含空闲 keep-alive）：`close()` 只等"已建立的请求"收尾，
      // 空闲 keep-alive 连接会让它一直挂着 ⇒ **进程迟迟不退、端口不释放**。
      // 实测（R1.5 跨机）：旧进程没退 ⇒ 新进程 `EADDRINUSE` ⇒ 客户端只能一直撞那个正在
      // `draining` 的旧实例，表现为"重启后再也连不上"。
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
    this.log('stopped (graceful: every session was told going-away)')
  }

  /** 实际绑定端口（`port: 0` 时由内核分配）—— 测试与诊断用。 */
  get boundPort(): number {
    const addr = this.http?.address()
    return addr !== null && addr !== undefined && typeof addr === 'object' ? addr.port : this.port
  }

  /**
   * 某 host 是否**实时**在线（心跳驱动，非 DB 快照 —— 这正是 relay 相对现状的增益）。
   *
   * `network` 缺省 `ops`：R5 之前的调用方（含既有单测）只说 hostId，语义不变；
   * 一旦涉及第二张网就**必须显式给**（否则问的是"运维网里那个同名节点"—— 这是个正确的默认，
   * 因为跨网同名才是歧义源）。
   */
  isOnline(hostId: string, network: string = OPS_NETWORK): boolean {
    return this.sessions.has(logicalName(network, hostId))
  }

  /** 某 (host, port) 在 Manager 侧对应的回环端口；离线或未注册 ⇒ `undefined`（**不猜**）。 */
  localPortOf(hostId: string, port: number, network: string = OPS_NETWORK): number | undefined {
    const ep = this.endpoints.get(endpointKey(network, hostId, port))
    if (ep === undefined || ep.session === undefined || ep.localPort === 0) return undefined
    return ep.localPort
  }

  /** 当前利用率（%）；`max = 0`（不限容量）⇒ `0`。 */
  private utilPct(): number {
    if (this.maxHosts <= 0) return 0
    return Math.floor((this.sessions.size * 100) / this.maxHosts)
  }

  /**
   * **relay 侧抖动聚合**。
   *
   * 口径（⛔ 三条都来自 `Session.rttSamples` 的设计理由，别改）：
   * 1. **差分在会话内算**（不同对端 RTT 基线不同，混序列会把"换对端"记成巨大抖动 = 假红）；
   * 2. **直方图在会话间合并**（合并的是差分，基线已被消掉）；
   * 3. **无样本 ⇒ 也返回结构完整的块**（⛔ 不许少键）。
   */
  private jitterStats(): RelayStatus['jitter'] {
    const st = jitterThresholds()
    const deltas: number[] = []
    let sessions = 0
    let samples = 0
    for (const s of this.sessions.values()) {
      const ring = s.rttSamples
      if (ring === undefined) continue
      samples += ring.length
      if (ring.length < 2) continue
      sessions += 1
      for (const d of absDeltas(ring)) deltas.push(d)
    }
    const base = statsFromDeltas(deltas, st)
    return {
      ...base,
      // ⚠️ 覆盖 `statsFromDeltas` 的 `deltas + 1` 口径 —— 合并后"样本数"必须 = 各环长度之和。
      samples,
      sessions,
      thresholdMs: st.switchMs,
      overThreshold: deltas.length >= st.minSamples && base.p95AbsDeltaMs >= st.switchMs,
      alerts: this.jitterAlerts,
    }
  }

  status(): RelayStatus {
    const now = Date.now()
    const byNetwork = new Map<string, string[]>()
    for (const session of this.sessions.values()) {
      const bucket = byNetwork.get(session.network) ?? []
      bucket.push(session.hostId)
      byNetwork.set(session.network, bucket)
    }
    for (const network of this.dialers.keys()) if (!byNetwork.has(network)) byNetwork.set(network, [])
    return {
      listening: `${this.host}:${this.port}${RELAY_PATH}`,
      dialers: describeDialers(this.dialers),
      networks: [...byNetwork.keys()].sort().map((network) => ({
        network,
        dialers: [...(this.dialers.get(network) ?? [])].sort(),
        sessions: (byNetwork.get(network) ?? []).sort(),
      })),
      capacity:
        this.maxHosts > 0
          ? {
              max: this.maxHosts,
              used: this.sessions.size,
              free: Math.max(0, this.maxHosts - this.sessions.size),
              utilPct: this.utilPct(),
              utilMaxPct: this.utilMaxPct,
            }
          : { max: 0, used: this.sessions.size, utilPct: 0, utilMaxPct: this.utilMaxPct },
      /** 抖动观测块（结构恒在，⛔ 不因"没样本"而缺键）。 */
      jitter: this.jitterStats(),
      online: [...this.sessions.values()].map(
        (s) =>
          `${s.network === OPS_NETWORK ? s.hostId : logicalName(s.network, s.hostId)}(session=${s.id} ports=${[...s.ports].sort((a, b) => a - b).join('/')} streams=${s.streams.size} hbAge=${now - s.lastSeen}ms in=${s.bytesIn}B out=${s.bytesOut}B)`,
      ),
      counters: {
        authed: this.authed,
        authFailed: this.authFailed,
        refused: this.refused,
        /** 利用率软门拒绝数（⛔ 与硬门 `refused` 分开）。 */
        utilRefused: this.utilRefused,
        dropped: this.dropped,
        streamsOpened: this.streamsOpened,
        protocolErrors: this.protocolErrors,
        backpressurePauses: this.backpressurePauses,
        /** 判别器：`DIAL` 放行 / 策略拒绝 / 目标不可达（脚本据此断言"拨号这条路通不通"）。 */
        dial: this.dial,
        dialDenied: this.dialDenied,
        dialFailed: this.dialFailed,
        /** 通过节点凭据校验的注册数 / 是否强制身份（`requireIdentity`）与受信签名者把数。 */
        identityOk: this.identityOk,
        identityRequired: this.requireIdentity,
        trustedSigners: this.trustedSignerKeys.length,
        revokedHosts: this.revocations?.hosts.length ?? 0,
        /**
         * presence 判别器（口径见 `RelayStatus.counters` 的注释）。
         * `subs` 是 gauge（连接断了必须回到 0）；`pushed` 稳态必须**停住不走**。
         */
        subs: this.countSubs(),
        pushed: this.pushed,
        snaps: this.snaps,
        rejected: this.rejected,
        statusHits: this.statusHits,
      },
      endpoints: [...this.endpoints.values()].map((ep) => ({
        hostId: ep.hostId,
        network: ep.network,
        port: ep.port,
        localPort: ep.localPort,
        online: ep.session !== undefined,
        streams: ep.session?.portStreams.get(ep.port) ?? 0,
      })),
      sessions: [...this.sessions.values()].map((s) => ({
        hostId: s.hostId,
        network: s.network,
        name: logicalName(s.network, s.hostId),
        sessionId: s.id,
        upForMs: now - s.since,
        lastSeenAgoMs: now - s.lastSeen,
        rttMs: s.rttMs,
        ports: [...s.ports].sort((a, b) => a - b),
        streams: s.streams.size,
      })),
      /**
       * presence：**订阅与轮询读的是同一份事实**（D5）—— 订阅走 `SNAP` / `PRESENCE` 帧，
       * 轮询走 `/status`，两条路都从这里取数 ⇒ 不可能出现"两条路给出不同在线态"。
       */
      presence: [...this.presence.values()].map((st) => this.presenceEntry(st, now)),
      presenceTiming: {
        graceMs: this.presenceGraceMs,
        offlineDebounceMs: this.presenceOfflineDebounceMs,
        batchMs: this.presenceBatchMs,
        ttlMs: this.presenceTtlMs,
        subMax: this.presenceSubMax,
      },
      /**
       * 内容分发判别器快照 —— **可选**（未注入 ⇒ 本键不出现，旧消费方零影响）。
       * ⚠️ 用 `...(cond ? {content} : {})` 而不是 `content: undefined`：
       * 后者在 `JSON.stringify` 时同样消失，但会让"键存在"的断言在**内存态**下也成立
       * ⇒ 两种模式下行为不一致（本线最忌的"看着一样、其实不同"）。显式展开只保留一种形态。
       */
      ...(this.statusContent === undefined ? {} : { content: this.statusContent() }),
    }
  }

  /* ═══════════ 连接建立与认证 ═══════════ */

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? ''
    // 前缀匹配是**故意**收紧的：`/status` 不在此前缀下 ⇒ R2 的 nginx location 无法把它代理出去。
    if (!url.startsWith(RELAY_PATH)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const conn = acceptWebSocket(req, socket as Socket, head)
    if (conn === null) return

    let session: Session | undefined
    // 未认证超时：没有它，一个空闲 socket 就能白占服务端资源。
    const deadline = setTimeout(() => {
      if (session === undefined && !conn.isClosed) {
        this.authFailed += 1
        this.log(`AUTH TIMEOUT remote=${conn.remote}`)
        conn.close(WS_CLOSE.POLICY_VIOLATION, 'auth required')
      }
    }, this.authDeadlineMs)
    deadline.unref()

    conn.on('protocolError', (why: string) => {
      this.protocolErrors += 1
      this.log(`protocol error remote=${conn.remote}: ${why}`)
    })
    conn.on('error', (err: Error) => this.log(`socket error remote=${conn.remote}: ${err.message}`))
    conn.on('close', () => {
      clearTimeout(deadline)
      if (session !== undefined) this.dropSession(session, 'connection closed')
    })
    conn.on('message', (buf: Buffer, isBinary: boolean) => {
      if (session === undefined) {
        if (!isBinary) {
          conn.close(WS_CLOSE.UNSUPPORTED_DATA, 'binary only')
          return
        }
        const frame = decodeMux(buf)
        if (frame === null) {
          conn.close(WS_CLOSE.PROTOCOL_ERROR, 'short frame')
          return
        }
        if (frame.type !== MUX.HELLO) {
          this.authFailed += 1
          this.log(`AUTH DENY remote=${conn.remote} why=hello expected, got type=${frame.type}`)
          conn.close(WS_CLOSE.POLICY_VIOLATION, 'hello first')
          return
        }
        const accepted = this.handleHello(conn, frame)
        if (accepted !== undefined) {
          clearTimeout(deadline)
          session = accepted
        }
        return
      }
      this.onFrame(session, buf, isBinary)
    })
  }

  /** 校验 `HELLO`；通过则建 session 并回 `HELLO_ACK`，否则关连接并返回 `undefined`。 */
  private handleHello(conn: WsConnection, frame: MuxFrame): Session | undefined {
    const msg = parseJsonPayload(frame.payload)
    /**
     * 拒绝注册 —— **必须结构化**（`HELLO_ERR` + 关闭码）。
     *
     * `retryable` 是给对端判断"要不要立刻重试"的：
     * - `true`（时钟偏移 / 服务端正在下线）⇒ 对端**修正后立刻重连**就能好；
     * - `false`（主机名 / 密钥 / 端口配错）⇒ 重试一万次也一样 ⇒ 对端退到上限重试并**明确报障**，
     *   而不是刷日志（"静默失败"与"刷屏噪音"是同一枚硬币的两面）。
     * `serverTime` 让对端能**自己算出时钟偏移并校正** —— 没有它，一个时钟漂移 > 窗口的节点
     * 会**永久无法重连**（这条曾是设计缺口，见传输方案 §12）。
     */
    const deny = (why: string, retryable = false, extra: Record<string, unknown> = {}): undefined => {
      this.authFailed += 1
      this.log(`AUTH DENY remote=${conn.remote} why=${why} retryable=${retryable}`)
      if (!conn.isClosed) {
        conn.sendBinary(
          encodeJsonFrame(MUX.HELLO_ERR, 0, { reason: why, retryable, serverTime: Date.now(), windowMs: this.authWindowMs, ...extra }),
        )
      }
      // 关闭码本身就是给运维看的信号：`retryable` ⇒ 1013（过会儿再来），否则 1008（策略拒绝）。
      conn.close(retryable ? WS_CLOSE.TRY_AGAIN_LATER : WS_CLOSE.POLICY_VIOLATION, why)
      return undefined
    }
    if (msg === null) return deny('malformed-hello')
    if (this.draining) return deny('server-draining', true)
    const thisNow = Date.now() // 同一次校验内**只取一次**时间，避免"刚过窗/刚进窗"的边界撕裂
    const hostId = typeof msg.hostId === 'string' ? msg.hostId : ''
    /**
     * P0-1：本节点属于**哪张网**。
     *
     * 缺省 `ops`：现网 <worker-a> / <worker-b> 上跑的是**不带这个字段**的旧客户端，而它们本来就在运维网里
     * ⇒ 这条默认值正好等于事实（不改任何 drop-in 也不会走错网，见模块头的"为什么不进 MAC"）。
     * 给了但**形状非法** ⇒ **失败关闭**（`bad-network`），不静默当 `ops` ——
     * 静默回落会把"网配错了"伪装成"网络不通"，那是最难查的一类。
     */
    const networkClaim = msg.network === undefined ? OPS_NETWORK : typeof msg.network === 'string' ? msg.network.trim() : ''
    if (!isNetworkId(networkClaim)) return deny('bad-network')
    const network = networkClaim
    const ts = typeof msg.ts === 'number' ? msg.ts : 0
    const nonce = typeof msg.nonce === 'string' ? msg.nonce : ''
    const portsCsv = typeof msg.portsCsv === 'string' ? msg.portsCsv : ''
    const mac = typeof msg.mac === 'string' ? msg.mac.toLowerCase() : ''
    /**
     * **成员资格**：密钥表就是权威 —— 它同时给出"这条密钥属于哪个 hostId"与
     * "该 hostId 属于哪张网"。HELLO 里的 `network` 只是**待校验的声明**。
     *
     * ⇒ 声明与登记不一致 ⇒ **失败关闭**（`network-mismatch`）：⛔ 不回落 `ops`、⛔ 不放行。
     * 这一条补的正是「任何持有任意密钥的 host 都能进同一扁平命名空间」那个缺口
     * （`设计文档 §待办②`）。
     */
    const entry = lookupKey(this.opts.keys, network, hostId)
    if (hostId === '' || entry === undefined || entry.secret === '') return deny('unknown-host')
    if (entry.network !== network) return deny('network-mismatch')
    const secret = entry.secret
    if (nonce.length < 16 || nonce.length > 64) return deny('bad-nonce')
    if (mac.length !== 64) return deny('bad-mac-length')
    const skew = thisNow - ts // 有符号：正是这个符号让对端知道该往前还是往后校正
    if (Math.abs(skew) > this.authWindowMs) return deny('clock-skew', true)
    const nonceKey = logicalName(network, hostId)
    const seen = this.seenNonces.get(nonceKey)
    if (seen !== undefined && seen.has(nonce)) return deny('nonce-replay', true)
    const want = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${hostId}|${ts}|${nonce}|${portsCsv}`).digest('hex')
    if (!safeEqualHex(want, mac)) return deny('bad-mac')
    /**
     * ── 节点入网凭据────────────────────────────────────────────────────
     *
     * 两道**独立**证明，都要过：
     * ① `grant` + `grantSig` —— 这台机器**被授权进入这张网**（由受信签名者签发）；
     * ② `nodeSig` —— **握有**那把节点私钥（光出示凭据只是"有证书"；凭据是公开可转发的，
     *    谁抄到都能出示 ⇒ 没有第②条，"入网 = 签名"就退化成了"入网 = 抄一段 JSON"）。
     *
     * ⛔ **失败一律拒**，且原因**结构化**回给对端（对端据此明确报障，而不是无限重试）。
     * ⛔ 无关"兜底"：`grant` 无效时**绝不**"那就只按 HMAC 放行"（那等于身份层形同虚设）。
     */
    const nodeKey = typeof msg.nodeKey === 'string' ? msg.nodeKey.trim() : ''
    const identityRequested = this.requireIdentity || msg.grant !== undefined || nodeKey !== ''
    if (identityRequested && !this.verifyIdentity) {
      // `verifyIdentity=false` 只允许出现在"不强制"的调试场景；**强制**时它是配置矛盾 ⇒ 拒。
      if (this.requireIdentity) return deny('identity-verification-disabled')
    } else if (identityRequested) {
      /**
       * **不可验 = 不接受**（与 `directory.ts` 同条判据）：一把受信签名者都没有时，
       * "带了凭据"这件事**无法判定** ⇒ 拒。⛔ 不因为"没配"就放行。
       */
      if (this.trustedSignerKeys.length === 0) return deny('identity-no-trusted-signers')
      const normNodeKey = normalizePublicKey(nodeKey)
      if (normNodeKey === undefined || msg.grant === undefined || typeof msg.grantSig !== 'string') {
        return deny('identity-incomplete')
      }
      const verdict = verifyPeerGrant(msg.grant, msg.grantSig, {
        trustedSignerKeys: this.trustedSignerKeys,
        network, // 跨网签发 ⇒ network-mismatch
        hostId, // 凭据被搬到别的 hostId ⇒ host-mismatch
        nodeKey: normNodeKey, // 声明的节点公钥 ≠ 凭据里那把 ⇒ key-mismatch
        revocations: this.revocations,
        nowMs: thisNow,
      })
      if (!verdict.ok) return deny(`identity-${verdict.reason}`)
      if (!verifyProof(normNodeKey, `${hostId}|${ts}|${nonce}|${portsCsv}`, msg.nodeSig)) {
        return deny('identity-bad-proof')
      }
      this.identityOk += 1
    }
    /**
     * **拨号方**（R5）与 **被连方**（worker）是两种身份，各自的门不一样：
     * - worker **必须**声明端口（`no-ports` 照旧拒绝），它注册即开回环监听；
     * - 拨号方**必须不**声明端口（它是来"开流"的，不是来"被连"的）—— 两条都收紧，
     *   免得一个身份同时拿到两种能力（最小权限）。
     * 放行与否只看**服务端白名单在本网那一桶**（`dialers.get(network)`）—— 默认拒绝：
     * 没列到的网络里，**一个 hostId 都拨不动**（P0-1 的"结构性隔离"就落在这里）。
     */
    const wantDialer = this.dialers.get(network)?.has(hostId) === true
    if (portsCsv === '' && !wantDialer) return deny('no-ports')
    if (portsCsv !== '' && wantDialer) return deny('dialer-must-not-declare-ports')
    const ports: number[] = []
    // ⚠️ 必须显式分支：`''.split(',')` 是 `['']`，`Number('')` 为 `0` ⇒ 会被下面的 `bad-port` 拒掉，
    // 于是"拨号方空端口表"这条合法路径**永远走不到**（T18/T19 首跑就是这么红的两条）。
    // 这里**不**用 `if (part === '') continue` 放宽：非拨号方的空/残缺端口表仍旧照原样拒绝。
    if (portsCsv !== '') {
      for (const part of portsCsv.split(',')) {
        const p = Number(part)
        if (!Number.isInteger(p) || p <= 0 || p > 65535) return deny('bad-port')
        if (p < this.base || p >= this.base + this.span) return deny('port-out-of-range')
        if (ports.includes(p)) return deny('duplicate-port')
        ports.push(p)
      }
    }
    // nonce 窗口（有界，防内存被重放表撑爆）
    const bucket = seen ?? new Set<string>()
    if (seen === undefined) this.seenNonces.set(nonceKey, bucket)
    bucket.add(nonce)
    while (bucket.size > NONCE_KEEP) {
      const oldest = bucket.values().next().value
      if (oldest === undefined) break
      bucket.delete(oldest)
    }

    const sessionKey = logicalName(network, hostId)
    const old = this.sessions.get(sessionKey)
    if (old !== undefined) {
      this.log(`host ${sessionKey} re-registered ⇒ dropping old session ${old.id}`)
      this.dropSession(old, 'superseded by new session')
    }
    // ── 容量准入（**满载是唯一的硬门**）────────────────────────────────────────
    // `maxHosts = 0` ⇒ 不限（默认，行为与 R1 一致）。满载时：
    //   ① **不驱逐**任何在线节点（后来者无权踢走先到者）；
    //   ② **已在册**的 hostId 重连**永远优先**（它占的位子本来就是它的）⇒ 只拦"新面孔"；
    //   ③ 回 `at-capacity` + `retryAfterMs` ⇒ 对端**排队等待**，而不是放弃或死循环硬撞。
    if (this.maxHosts > 0 && !this.sessions.has(sessionKey) && this.sessions.size >= this.maxHosts) {
      this.refused += 1
      return deny('at-capacity', true, {
        retryAfterMs: this.capacityRetryAfterMs,
        capacity: { max: this.maxHosts, used: this.sessions.size, free: 0, utilPct: this.utilPct(), utilMaxPct: this.utilMaxPct },
      })
    }
    /**
     * ── **利用率软门**（`E4`：留 30%+ 余量，⛔ 不打满）─────────────────────
     *
     * 与上面的 `at-capacity` **是两道不同的门**（⛔ 不许合并、⛔ 不许改 `maxHosts`）：
     * - `at-capacity` = **硬容量**（7515 / 45% 设计口径）—— 到那一格是"装不下了"；
     * - 本道 = **软余量**（`RELAY_UTIL_MAX_PCT`，默认 70%）—— 到它是"**再装下去会不稳**"。
     *
     * 🔑 为什么必须提前拦而不是打满再说：中继的"高效"取决于**排队深度**。接入数一逼近容量，
     * 转发延迟的**方差**先炸（尾延迟），那时再拦已经晚了 —— 而用户对交互式会话的第一诉求
     * 就是「不卡」。⇒ 判据 = `utilPct ≥ utilMaxPct` ⇒ 拒绝**新面孔**（⛔ 不驱逐任何在线节点、
     * ⛔ 已在册的 hostId 重连仍永远优先 —— 与硬门逐字同规则）。
     *
     * ⚠️ 回 `retryable = true`：这是**临时**状态（容量会释放）⇒ 对端排队重试，而不是永久性拒绝。
     */
    if (this.maxHosts > 0 && this.utilMaxPct > 0 && !this.sessions.has(sessionKey)) {
      const pct = this.utilPct()
      if (pct >= this.utilMaxPct) {
        this.utilRefused += 1
        this.log(
          `⛔ UTIL DENY 拒绝新接入 host=${sessionKey}：利用率 ${pct}% ≥ 软门 ${this.utilMaxPct}%` +
            `（used=${this.sessions.size} max=${this.maxHosts}，留余量 ${100 - this.utilMaxPct}%；⛔ 不驱逐在线节点）`,
        )
        return deny('at-util-limit', true, {
          retryAfterMs: this.capacityRetryAfterMs,
          capacity: { max: this.maxHosts, used: this.sessions.size, free: 0, utilPct: pct, utilMaxPct: this.utilMaxPct },
        })
      }
    }
    const sessionId = randomBytes(8).toString('hex')
    const session: Session = {
      id: sessionId,
      hostId,
      network,
      conn,
      ports: new Set(ports),
      streams: new Map(),
      portStreams: new Map(),
      dialRoutes: new Map(),
      nextStreamId: 1,
      lastSeen: Date.now(),
      since: Date.now(),
      heartbeat: setInterval(() => undefined),
      bytesIn: 0,
      bytesOut: 0,
      /** presence：未订阅 ⇒ 这个 Map 永远是空的（零成本）。 */
      presencePending: new Map(),
    }
    clearInterval(session.heartbeat)
    // **双向**保活：服务端也主动发 `PING`（不只是等对端的）。
    // 三个作用：① 测 RTT（可观测）② 让"半开"在对端也能被察觉 ③ 出向始终有流量，NAT 表项不过期。
    session.heartbeat = setInterval(() => {
      if (Date.now() - session.lastSeen > this.idleTimeoutMs) {
        this.log(`session ${session.id} (${hostId}) idle ${this.idleTimeoutMs}ms ⇒ drop`)
        this.dropSession(session, 'idle timeout')
        return
      }
      session.pingSentAt = Date.now()
      try {
        session.conn.sendBinary(encodeMux(MUX.PING, 0))
      } catch {
        /* 写失败 ⇒ 交给 idle 超时兜底 */
      }
    }, Math.max(1_000, this.hbSec * 1_000))
    session.heartbeat.unref()

    this.sessions.set(sessionKey, session)
    // 注册即开回环监听 ⇒ `resolve()` 变成纯查表（Manager 侧零改动的前提）。
    for (const p of ports) this.ensureEndpoint(network, hostId, p).session = session
    /**
     * presence（第 1 条）：**注册即在线** —— 在线态从连接生命周期来，⛔ 不等任何人来轮询。
     *
     * 🔴 **顺序必须在本行之上那个 `ensureEndpoint` 循环之后**（收口前实测踩到）：
     * `presenceEntry` 里要带 `localPorts`（回环落点口号），而那个口号正是 `ensureEndpoint`
     * 才分配的。先 touch 再分配 ⇒ 首次推送里的落点是 **0**；而 `publishPresence` 只在
     * "在线态翻转"时才重推 ⇒ 那个 0 **永远修不回来** ⇒ 订阅方 `addressOf` 查不到落点 ⇒
     * 实例页拨不通（**假死：不报错、不 5xx，只是打不开**）。这正是本线头号教训的形态。
     */
    this.presenceTouch(session)
    this.authed += 1
    conn.sendBinary(
      encodeJsonFrame(MUX.HELLO_ACK, 0, {
        sessionId,
        accepted: ports,
        /** 本会话是不是"拨号方"（R5）—— 对端据此决定能不能用 `openStream()`。 */
        dialer: wantDialer,
        /**
         * **服务端认定的网**（P0-1）—— 回显给对端，让"我落在哪张网里"在**客户端日志**上可见。
         * 没有它，一个写错 `network` 的节点只能从"拨不通"倒推，而拨不通的原因有七八种。
         */
        network,
        /** 本会话的逻辑名（`<network>/<hostId>`），与 `/status` 同一口径。 */
        name: sessionKey,
        hbSec: this.hbSec,
        // 让对端**立刻**得到时钟基准（不必等到被拒一次才知道自己漂了）。
        serverTime: Date.now(),
        base: this.base,
        span: this.span,
      }),
    )
    this.log(`AUTH OK host=${sessionKey} session=${sessionId} ports=[${ports.join(',')}] remote=${conn.remote}`)
    return session
  }

  /* ═══════════ 已认证连接上的帧 ═══════════ */

  private onFrame(session: Session, buf: Buffer, isBinary: boolean): void {
    session.lastSeen = Date.now()
    // presence：任何帧都刷新"这条连接活着"（TTL 安全网的输入）。⛔ 心跳不会因此产生事件。
    this.presenceTouch(session)
    if (!isBinary) {
      this.protocolErrors += 1
      session.conn.close(WS_CLOSE.UNSUPPORTED_DATA, 'binary only')
      return
    }
    const frame = decodeMux(buf)
    if (frame === null) {
      this.protocolErrors += 1
      session.conn.close(WS_CLOSE.PROTOCOL_ERROR, 'short frame')
      return
    }
    switch (frame.type) {
      case MUX.OPEN_ACK:
        this.onOpenAck(session, frame)
        return
      case MUX.DATA:
        this.onData(session, frame)
        return
      case MUX.CLOSE: {
        // 拨号方的 `CLOSE` 带的是**它自己的** id ⇒ 先查拨号路由表，再查普通流表。
        const route = session.dialRoutes.get(frame.streamId)
        if (route !== undefined) {
          this.closeStream(route.session, route.st, 'dialer closed')
          return
        }
        const st = session.streams.get(frame.streamId)
        if (st !== undefined) this.closeStream(session, st, 'worker closed')
        return
      }
      case MUX.PING:
        session.conn.sendBinary(encodeMux(MUX.PONG, 0, frame.payload))
        return
      case MUX.PONG:
        // RTT 采样（服务端 PING → 对端 PONG 的往返）。
        if (session.pingSentAt !== undefined) {
          session.rttMs = Date.now() - session.pingSentAt
          session.pingSentAt = undefined
          /**
           * ── **抖动可观测**（`E2` 的 relay 侧落点）──
           *
           * 采样点选在 `PONG` 到达这一刻是应该的：这是**唯一**的"新测量"时刻（⛔ 不是巡检时
           * 去读缓存 —— 那样同一个值会被反复记、差分恒 0、jitter 假绿，见 `jitter.ts`
           * 的 `JITTER_SAMPLE_GAP_MS` 注释）。
           *
           * 判定 = 本会话 `p95|ΔRTT| ≥ JITTER_LIMIT_MS` ⇒ 记一次告警 + 写一行
           * `[relay-jitter]`（⛔ **按会话 + 按时间**节流：心跳本身就 15 s 一次，
           * 但采样一旦变成"每次 PONG 一行"会把日志刷满，本线吃过这个亏）。
           */
          const st = jitterThresholds()
          const ring = session.rttSamples ?? []
          ring.push(session.rttMs)
          const cap = Math.max(2, st.sampleMax)
          if (ring.length > cap) ring.splice(0, ring.length - cap)
          session.rttSamples = ring
          const j = st.enabled && ring.length >= 2 ? statsFromDeltas(absDeltas(ring), st) : undefined
          if (j !== undefined && j.deltas >= st.minSamples && j.p95AbsDeltaMs >= st.switchMs) {
            this.jitterAlerts += 1
            const key = `${session.network}/${session.hostId}`
            const last = this.lastJitterWarnAt.get(key)
            const nowMs = Date.now()
            if (last === undefined || nowMs - last >= this.jitterWarnGapMs) {
              this.lastJitterWarnAt.set(key, nowMs)
              this.log(
                `[relay-jitter] ⚠ 会话 ${key} 抖动超标（p95|ΔRTT|=${j.p95AbsDeltaMs}ms ≥ 阈值 ${st.switchMs}ms，` +
                  `样本 ${j.samples} 个，最近 rtt=${session.rttMs}ms）⇒ 该链路的对端应换更稳的候选`,
              )
            }
          }
        }
        return
      case MUX.BYE: {
        // 对端**主动告别** ⇒ 立刻回收，**不等 45s 心跳超时**（把"计划内重启"的恢复时间压到毫秒级）。
        const msg = parseJsonPayload(frame.payload)
        const reason = msg !== null && typeof msg.reason === 'string' ? msg.reason : 'peer bye'
        this.log(`BYE from ${session.hostId} (${session.id}): ${reason}`)
        this.dropSession(session, `peer bye: ${reason}`)
        return
      }
      case MUX.PORT_ADD:
        void this.onPortChange(session, frame, true)
        return
      case MUX.PORT_DEL:
        void this.onPortChange(session, frame, false)
        return
      case MUX.DIAL:
        this.onDial(session, frame)
        return
      case MUX.SUB:
        this.onSubscribe(session, frame, true)
        return
      case MUX.UNSUB:
        this.onSubscribe(session, frame, false)
        return
      default: {
        this.protocolErrors += 1
        this.log(`unknown mux type=${frame.type} from ${session.hostId}`)
        session.conn.close(WS_CLOSE.PROTOCOL_ERROR, 'unknown frame type')
      }
    }
  }

  /**
   * 运行期端口增删（覆盖网络 R4）—— 对应 ssh 版的 `-O forward` / `-O cancel`。
   *
   * 校验口径**与 `HELLO` 逐条同源**（同一个 `[base, base+span)` 窗口 ＋ 去重）：两条路径若有
   * 分歧，"注册能过、动态加不能过"会成为极难查的不一致。窗口是**纵深防御**（真正的门是 worker
   * 自己的白名单，见 `client.ts` 的 `onOpenRequest`）：注意 relay 只把流量导回**worker 自己**的
   * 回环，不会把 relay 主机上的任意端口暴露出去。
   */
  private async onPortChange(session: Session, frame: MuxFrame, add: boolean): Promise<void> {
    const msg = parseJsonPayload(frame.payload)
    const reqId = msg !== null && typeof msg.reqId === 'number' ? msg.reqId : 0
    const port = msg !== null && typeof msg.port === 'number' ? msg.port : -1
    const reply = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      session.conn.sendBinary(encodeJsonFrame(MUX.PORT_ACK, 0, { reqId, port, ok, ...extra }))
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return reply(false, { error: 'bad-port' })
    if (port < this.base || port >= this.base + this.span) return reply(false, { error: 'port-out-of-range' })
    if (!add) {
      const known = session.ports.delete(port)
      this.closeEndpoint(session.network, session.hostId, port)
      this.presenceSyncPorts(session)
      return reply(true, { removed: known })
    }
    const existing = this.endpoints.get(endpointKey(session.network, session.hostId, port))
    if (session.ports.has(port) && existing !== undefined) {
      // **幂等**：已经在册就直接回成功（调用方可能是"重连后补一次对账"，报错反而会误导）。
      await existing.ready
      return reply(true, { localPort: existing.localPort, existed: true })
    }
    const ep = this.ensureEndpoint(session.network, session.hostId, port)
    ep.session = session
    session.ports.add(port)
    this.presenceSyncPorts(session)
    await ep.ready
    this.log(`host ${logicalName(session.network, session.hostId)} +port ${port} -> 127.0.0.1:${ep.localPort}`)
    return reply(true, { localPort: ep.localPort })
  }

  /**
   * 拨号方请求开一条到 `(target, port)` 的流（覆盖网络 R5）。
   *
   * 与 `onManagerConn` 的差别**只有一处**：对端不是 relay 主机上的 socket，而是另一条会话。
   * 因此除了 `peer` 换成 `WsStreamPeer`、以及多存一块"`OPEN_ACK` 前的水坝"以外，其余逐条同源
   * （流号分配、每端口并发上限、`OPEN` 下发、`OPEN_ACK` 放行）—— 两条路**不能有第二套口径**，
   * 否则"注册能过、拨号不能过"会变成最难查的那种不一致。
   *
   * 为什么校验 `worker.ports.has(port)` 而不是只查 endpoint 表：端点表**随会话建立**，
   * 而"端口已声明"才是 worker 侧白名单的镜像。两者都查 = 纵深防御；真正的门仍在 worker。
   */
  private onDial(session: Session, frame: MuxFrame): void {
    const done = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      if (!session.conn.isClosed) {
        session.conn.sendBinary(encodeJsonFrame(MUX.DIAL_ACK, frame.streamId, { ok, ...extra }))
      }
    }
    if (this.dialers.get(session.network)?.has(session.hostId) !== true) {
      this.refused += 1
      this.dialDenied += 1
      this.log(
        `DIAL refused: ${logicalName(session.network, session.hostId)} 不在网络 "${session.network}" 的拨号方白名单里`,
      )
      done(false, { error: 'not-a-dialer' })
      return
    }
    if (this.draining) {
      this.dialDenied += 1
      done(false, { error: 'server-draining', retryable: true })
      return
    }
    const msg = parseJsonPayload(frame.payload)
    const target = msg !== null && typeof msg.target === 'string' ? msg.target : ''
    const port = msg !== null && typeof msg.port === 'number' ? msg.port : -1
    if (target === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      this.dialFailed += 1
      done(false, { error: 'bad-target' })
      return
    }
    const dialerName = logicalName(session.network, session.hostId)
    /**
     * 目标**只在同一张网里找**（P0-1）：`DIAL.target` 是 hostId、不含网络维度 ⇒ 这里显式拼上
     * **拨号方自己**的网络。⛔ 绝不"在别的网里找到一个同名 host 就连过去" ——
     * 那正是「一张巨网 + 靠 ACL 兜」的形态，也是本项目要消灭的东西。
     */
    const worker = this.sessions.get(logicalName(session.network, target))
    if (worker === undefined) {
      /**
       * 本网里没有 ⇒ 再查一遍别的网，**只为日志**。
       *
       * ⛔ **对外与 `target-offline` 逐字同形**（P0-3 · D4「不下发对端清单」）：
       * 回一句 `dialer-not-in-network` + "它在 X 网"等于告诉拨号方「**这个 hostId 存在**、住在哪」
       * —— 那就是一份**可探测的对端清单**，判据「`u:A` 看不到 `u:B` 的节点」当场失效
       * （拿一串猜测的 hostId 打过来，按响应就能把别张网的成员枚举出来）。
       * ⇒ 区分只留**服务端日志**（下一行，含 `foreign`）：运维照样分得清"配错网"与"节点离线"，
       *   而拨号方**无从区分**"不存在"与"在别张网"。
       */
      const foreign = this.findInOtherNetwork(session.network, target)
      this.refused += 1
      this.dialFailed += 1
      if (foreign !== undefined) {
        this.log(
          `DIAL ${dialerName} -> ${target}:${port} 拒绝：该节点在别张网（${foreign}）⇒ 跨网隔离 ` +
            'dialer-not-in-network（**仅日志用语**；对外统一回 target-offline）',
        )
        done(false, { error: 'target-offline' })
        return
      }
      this.log(`DIAL ${dialerName} -> ${target}:${port} refused (worker offline / port not declared)`)
      done(false, { error: 'target-offline' })
      return
    }
    if (worker.conn.isClosed || !worker.ports.has(port)) {
      this.refused += 1
      this.dialFailed += 1
      this.log(`DIAL ${dialerName} -> ${target}:${port} refused (worker offline / port not declared)`)
      done(false, { error: 'target-offline' })
      return
    }
    const live = worker.portStreams.get(port) ?? 0
    if (live >= this.maxStreamsPerPort) {
      this.refused += 1
      this.dialDenied += 1
      done(false, { error: 'busy' })
      return
    }
    const id = worker.nextStreamId++
    if (worker.nextStreamId > 0xffffffff) worker.nextStreamId = 1
    const st: MuxStream = {
      id,
      port,
      peer: new WsStreamPeer(session.conn, frame.streamId, WS_PEER_HIGH_WATER),
      opening: true,
      paused: false,
      closed: false,
      queued: [],
      queuedBytes: 0,
      dial: { session, streamId: frame.streamId, ready: false, pending: [], pendingBytes: 0 },
    }
    worker.streams.set(id, st)
    worker.portStreams.set(port, live + 1)
    session.dialRoutes.set(frame.streamId, { session: worker, st })
    this.streamsOpened += 1
    // 判别器：**放行**点 —— 与 `streamsOpened` 同点自增，两条计数必须同步增长（口径：已回 ok:true）。
    this.dial += 1
    // 先回拨号方（它的写侧从此刻起可用），再让 worker 开流；两端各自的水坝保证不丢字节。
    done(true, { workerStreamId: id })
    worker.conn.sendBinary(encodeJsonFrame(MUX.OPEN, id, { port }))
    this.log(
      `DIAL ${dialerName} -> ${logicalName(session.network, target)}:${port} ok (workerStream=${id} dialStream=${frame.streamId})`,
    )
  }

  /**
   * 同名 hostId 是否存在于**别的网**；返回那张网的 id。
   *
   * ⚠️ **只喂日志**（P0-3）：调用方拿到非 `undefined` 后写一行"该节点在别张网（X）"，
   * 但**对外仍回 `target-offline`**。别把它接到响应体上 —— 那等于把"别张网里有哪些 hostId"
   * 做成一个可枚举的接口。
   */
  private findInOtherNetwork(network: string, hostId: string): string | undefined {
    for (const s of this.sessions.values()) {
      if (s.network !== network && s.hostId === hostId) return s.network
    }
    return undefined
  }

  /**
   * 拨号方送来的数据 ⇒ 往 worker 走（**方向与 `onData` 相反**，所以必须是独立的一条路）。
   *
   * worker 尚未 `OPEN_ACK` 时**只能缓存**：这一刻 worker 还没开始读那个口，直接发过去会让它
   * 按"data before open-ack"判协议错（`client.ts` 那条判据在 worker 侧同样生效）。
   */
  private onDialerData(session: Session, route: { session: Session; st: MuxStream }, frame: MuxFrame): void {
    const st = route.st
    const info = st.dial
    if (info === undefined || st.closed) return
    session.bytesIn += frame.payload.length
    if (!info.ready) {
      info.pending.push(frame.payload)
      info.pendingBytes += frame.payload.length
      if (info.pendingBytes > this.queueMaxBytes) {
        this.dropped += 1
        this.log(`dial stream ${frame.streamId} 起始水坝 ${info.pendingBytes}B > ${this.queueMaxBytes}B ⇒ close`)
        this.closeStream(route.session, st, 'dial pre-open queue overflow')
      }
      return
    }
    this.pumpToWorker(route.session, st, frame.payload)
  }

  private onOpenAck(session: Session, frame: MuxFrame): void {
    const st = session.streams.get(frame.streamId)
    if (st === undefined || st.closed) return
    const msg = parseJsonPayload(frame.payload)
    if (msg === null || msg.ok !== true) {
      const why = msg !== null && typeof msg.error === 'string' ? msg.error : 'worker refused'
      this.dropped += 1
      this.log(`stream ${frame.streamId} (${session.hostId}:${st.port}) refused by worker: ${why}`)
      this.closeStream(session, st, `worker refused: ${why}`)
      return
    }
    st.opening = false
    st.peer.resume() // 放开 Manager 侧读取（打开竞态窗口到此结束）
    /**
     * **水坝放水**（拨号流专属）：拨号方在 worker `OPEN_ACK` 之前写下的字节此刻才允许进 worker。
     * 不这样做就会出现"头几个字节丢了"—— 与 TCP 版靠 `pauseOnConnect` 挡住的是同一件事。
     */
    const info = st.dial
    if (info !== undefined) {
      info.ready = true
      const pending = info.pending
      info.pending = []
      info.pendingBytes = 0
      for (const chunk of pending) this.pumpToWorker(session, st, chunk)
    }
    const queued = st.queued
    st.queued = []
    st.queuedBytes = 0
    for (const chunk of queued) {
      session.bytesIn += chunk.length
      session.conn.sendBinary(encodeMux(MUX.DATA, st.id, chunk))
    }
  }

  private onData(session: Session, frame: MuxFrame): void {
    // 拨号方这条路：`frame.streamId` 属于**拨号方的**命名空间 ⇒ 必须先查路由表。
    const route = session.dialRoutes.get(frame.streamId)
    if (route !== undefined) {
      this.onDialerData(session, route, frame)
      return
    }
    const st = session.streams.get(frame.streamId)
    if (st === undefined || st.closed) return
    if (st.opening) {
      this.dropped += 1
      this.log(`stream ${frame.streamId} got DATA before OPEN_ACK ⇒ drop`)
      this.closeStream(session, st, 'protocol: data before open-ack')
      return
    }
    session.bytesOut += frame.payload.length
    if (st.paused) {
      st.queued.push(frame.payload)
      st.queuedBytes += frame.payload.length
      if (st.queuedBytes > this.queueMaxBytes) {
        this.dropped += 1
        this.log(`stream ${frame.streamId} egress queue ${st.queuedBytes}B > ${this.queueMaxBytes}B ⇒ drop`)
        this.closeStream(session, st, 'egress queue overflow')
      }
      return
    }
    if (!st.peer.write(frame.payload)) {
      st.paused = true
      this.backpressurePauses += 1
      st.peer.once('drain', () => this.flushStream(session, st))
    }
  }

  private flushStream(session: Session, st: MuxStream): void {
    if (st.closed) return
    st.paused = false
    while (st.queued.length > 0) {
      const chunk = st.queued.shift()
      if (chunk === undefined) break
      st.queuedBytes -= chunk.length
      if (!st.peer.write(chunk)) {
        st.paused = true
        st.peer.once('drain', () => this.flushStream(session, st))
        return
      }
    }
  }

  /* ═══════════ endpoint（Manager 侧入口） ═══════════ */

  private ensureEndpoint(network: string, hostId: string, port: number): Endpoint {
    const key = endpointKey(network, hostId, port)
    const found = this.endpoints.get(key)
    if (found !== undefined) return found
    const ep: Endpoint = { hostId, network, port, localPort: 0 }
    if (this.opts.exposeLoopback === false) {
      /*
       * **纯流转发模式**（R5）：不绑任何本地口。
       * 端点条目仍然登记（`online` / 计数照旧），但 `localPort` 恒为 `0` ⇒ 靠 `/status`
       * 找落点的那条路会**自然失败**（失败关闭，不是静默透传）；而拨号路径完全不受影响。
       */
      this.endpoints.set(key, ep)
      return ep
    }
    ep.server = createTcpServer({ pauseOnConnect: true }, (tcp) => this.onManagerConn(ep, tcp))
    ep.ready = new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      ep.server?.on('error', (err: Error) => {
        this.log(`endpoint ${key} listen error: ${err.message}`)
        // ⚠️ 失败也必须 resolve：否则 `PORT_ADD` 的应答永远不来 ⇒ 调用方挂死等一个不存在的 ACK。
        done()
      })
      ep.server?.listen(0, '127.0.0.1', () => {
        const addr = ep.server?.address()
        if (addr !== null && addr !== undefined && typeof addr === 'object') ep.localPort = addr.port
        this.log(`endpoint ${key} -> 127.0.0.1:${ep.localPort} (loopback)`)
        /**
         * 🔴 落点口号是**异步**才拿到的（就在上面这一行）⇒ 必须在它落地**之后**再推一次 presence。
         * ⛔ 只在 `handleHello` 里 touch 一次是不够的：那一刻 `localPort` 还是 `0`（实测踩到）。
         * 订阅方（Manager）随后就靠它 `addressOf`；推不出去 = 页面**打不开但不报错**。
         * ⚠️ 这**不违反 E1**：首次分配 + 运行期新增端口都是真的状态变化，且同一 host 的多次入队
         * 会被 `presencePending`（按 host 去重）并进**同一帧**。
         */
        this.presenceSyncPortsByKey(network, hostId)
        done()
      })
    })
    this.endpoints.set(key, ep)
    return ep
  }

  /**
   * 收掉一个 endpoint（**worker 主动撤销端口**）。
   *
   * 为什么必须真的把条目从 `endpoints` 里删掉、而不只是解绑 session：`/status` 是 Manager
   * 唯一的地址来源 ⇒ 留一个"已关闭但还带着旧口号"的条目，Manager 会照旧拨它 ⇒ 打到死口上。
   * **查不到 ⇒ 翻译不出来 ⇒ 上层明确失败**，这才是能查的病（"静默拨到死地址"是最难查的）。
   */
  private closeEndpoint(network: string, hostId: string, port: number): void {
    const key = endpointKey(network, hostId, port)
    const ep = this.endpoints.get(key)
    if (ep === undefined) return
    this.endpoints.delete(key)
    // 在途流不在这里掐：它们各自的 Manager 侧 TCP 收尾会走 `forgetStream`。
    try {
      ep.server?.close()
    } catch {
      /* 已关 */
    }
    ep.session?.portStreams.delete(port)
    ep.session = undefined
    this.log(`endpoint ${key} closed (worker 撤销该端口)`)
  }

  private onManagerConn(ep: Endpoint, tcp: Socket): void {
    tcp.setNoDelay(true)
    const session = ep.session
    if (session === undefined || session.conn.isClosed) {
      this.refused += 1
      this.log(`refuse ${ep.hostId}:${ep.port} (worker offline)`)
      tcp.destroy()
      return
    }
    const live = session.portStreams.get(ep.port) ?? 0
    if (live >= this.maxStreamsPerPort) {
      this.refused += 1
      this.log(`refuse ${ep.hostId}:${ep.port} (busy, ${live} streams)`)
      tcp.destroy()
      return
    }
    const id = session.nextStreamId++
    if (session.nextStreamId > 0xffffffff) session.nextStreamId = 1
    const st: MuxStream = { id, port: ep.port, peer: tcp, opening: true, paused: false, closed: false, queued: [], queuedBytes: 0 }
    session.streams.set(id, st)
    session.portStreams.set(ep.port, live + 1)
    this.streamsOpened += 1

    // `pauseOnConnect` 让 TCP 层替我们挡住 OPEN_ACK 之前的数据 ⇒ 不存在"丢头几个字节"的竞态。
    tcp.on('data', (chunk: Buffer) => this.pumpToWorker(session, st, chunk))
    tcp.on('end', () => this.closeStream(session, st, 'manager eof'))
    tcp.on('error', (err: Error) => {
      this.log(`stream ${id} tcp error: ${err.message}`)
      this.closeStream(session, st, 'manager tcp error')
    })
    tcp.on('close', () => this.forgetStream(session, st))

    session.conn.sendBinary(encodeJsonFrame(MUX.OPEN, id, { port: ep.port }))
  }

  private pumpToWorker(session: Session, st: MuxStream, chunk: Buffer): void {
    if (st.closed) return
    if (st.opening) {
      st.queued.push(chunk)
      st.queuedBytes += chunk.length
      if (st.queuedBytes > this.queueMaxBytes) {
        this.dropped += 1
        this.log(`stream ${st.id} open-queue ${st.queuedBytes}B > ${this.queueMaxBytes}B ⇒ drop`)
        this.closeStream(session, st, 'open queue overflow')
        return
      }
      st.peer.pause()
      return
    }
    session.bytesIn += chunk.length
    if (!session.conn.sendBinary(encodeMux(MUX.DATA, st.id, chunk))) {
      // 连接级背压：一条 wss 承载全部流，暂停所有入向源，`drain` 后恢复。
      // 粗粒度但**有界**——比"无界排队"安全，也比"只暂停一条流"正确。
      this.backpressurePauses += 1
      for (const s of session.streams.values()) s.peer.pause()
      session.conn.once('drain', () => {
        for (const s of session.streams.values()) if (!s.closed) s.peer.resume()
      })
    }
  }

  private closeStream(session: Session, st: MuxStream, why: string): void {
    if (st.closed) return
    st.closed = true
    session.conn.sendBinary(encodeJsonFrame(MUX.CLOSE, st.id, { reason: why }))
    const left = (session.portStreams.get(st.port) ?? 1) - 1
    if (left <= 0) session.portStreams.delete(st.port)
    else session.portStreams.set(st.port, left)
    st.peer.end()
    const killer = setTimeout(() => st.peer.destroy(), 2_000)
    killer.unref()
    // 拨号流：把拨号方路由表里的条目一并删掉（否则它会留一条指向已死流的条目）。
    const info = st.dial
    if (info !== undefined) info.session.dialRoutes.delete(info.streamId)
    this.log(`stream ${st.id} (${session.hostId}:${st.port}) closed: ${why}`)
  }

  private forgetStream(session: Session, st: MuxStream): void {
    if (st.closed) {
      // `closeStream` 已维护计数；这里只删条目（幂等）。
      session.streams.delete(st.id)
      return
    }
    st.closed = true
    const left = (session.portStreams.get(st.port) ?? 1) - 1
    if (left <= 0) session.portStreams.delete(st.port)
    else session.portStreams.set(st.port, left)
    session.streams.delete(st.id)
    const info = st.dial
    if (info !== undefined) info.session.dialRoutes.delete(info.streamId)
    session.conn.sendBinary(encodeJsonFrame(MUX.CLOSE, st.id, { reason: 'manager tcp closed' }))
  }

  /* ═══════════ presence（在线态）—— 权威表 + 订阅扇出 + 1 s 批合并 ═══════════ */

  /**
   * 取（必要时建）某 host 的在线态记录。键 = **逻辑名**（P0-1：两张网的同名 host 各算一台）。
   */
  private presenceState(network: string, hostId: string): PresenceState {
    const name = logicalName(network, hostId)
    let st = this.presence.get(name)
    if (st === undefined) {
      st = {
        name,
        network,
        hostId,
        conns: new Map(),
        lastSeenMs: Date.now(),
        offlineSinceMs: 0,
        ports: new Set(),
        published: false,
        changedAt: 0,
      }
      this.presence.set(name, st)
    }
    return st
  }

  /**
   * 某 host 当前**活着**的连接数（TTL 窗口内的连接才算数）。
   *
   * 这就是第 6 条「多设备按 device 聚合」的**唯一判据**：任一条连接活着 ⇒ 整台在线。
   */
  private presenceDevices(st: PresenceState, now: number): number {
    let n = 0
    for (const ts of st.conns.values()) if (now - ts <= this.presenceTtlMs) n++
    return n
  }

  /**
   * **连接生命周期驱动在线**（第 1 条）：注册 / 收帧 ⇒ 这条连接算"活着"。
   *
   * ⚠️ **只在"离线 → 在线"时产生事件**；重复 touch（心跳每 15 s 一次）**零事件、零帧**
   * —— 这正是"彻底干掉每 30 s 全员轮询"的落点。
   */
  private presenceTouch(session: Session): void {
    const st = this.presenceState(session.network, session.hostId)
    const now = Date.now()
    st.conns.set(session.id, now)
    st.lastSeenMs = now
    st.offlineSinceMs = 0
    for (const p of session.ports) st.ports.add(p)
    if (!st.published) this.publishPresence(st, true, now)
  }

  /** 某条连接消失（第 6 条：**还有别的连接就什么都不做** —— 多设备聚合的意义就在这里）。 */
  private presenceDrop(session: Session): void {
    const st = this.presence.get(logicalName(session.network, session.hostId))
    if (st === undefined || !st.conns.delete(session.id)) return
    // 还有活连接 ⇒ 聚合后仍在线：⛔ 不产生任何事件（否则双设备的机器会产生双倍帧 = 净退化）
    if (this.presenceDevices(st, Date.now()) > 0) return
    // 起算 grace + debounce；**此刻先不改口**（第 5 条：防"网络抖一下 = 状态闪烁"）
    st.offlineSinceMs = Date.now()
  }

  /**
   * 运行期端口增删后同步（让订阅方拿到的 `ports` 与 `HELLO` / `PORT_ADD` 一致）。
   *
   * 🔑 **必须入队推送**（`force = true`）——`ports` / `localPorts` 也是"事实"：
   * 之后 Manager 侧 `/status` 轮询会被挂起，订阅推送**是它唯一在更新的落点来源**
   * （`web/server.ts` 的 `addressOf` ②）。只改本地 `st.ports` 而不推 ⇒ 新端口永远到不了订阅方
   * ⇒ 页面拨不通（同样是**假死**，不是报错）。这也**不违反 E1**：端口变了就是状态真的变了，
   * 属于"≤1 帧/次变化"的正常配额（并由批合并并进同一帧）。
   */
  private presenceSyncPorts(session: Session): void {
    const st = this.presence.get(logicalName(session.network, session.hostId))
    if (st === undefined) return
    st.ports = new Set(session.ports)
    this.publishPresence(st, st.published, Date.now(), true)
  }

  /**
   * 与 `presenceSyncPorts` 同义，但调用方只知道 `network` / `hostId`（= `ensureEndpoint` 的回调里
   * 只有键，没有 `Session`）。⛔ 不复制逻辑 —— 两条路都汇到 `publishPresence(force)`。
   */
  private presenceSyncPortsByKey(network: string, hostId: string): void {
    const st = this.presence.get(logicalName(network, hostId))
    if (st === undefined) return
    this.publishPresence(st, st.published, Date.now(), true)
  }

  private presenceEntry(st: PresenceState, now: number): PresenceEntry {
    const ports = [...st.ports].sort((a, b) => a - b)
    const devices = this.presenceDevices(st, now)
    const entry: PresenceEntry = {
      name: st.name,
      hostId: st.hostId,
      network: st.network,
      online: st.published,
      devices,
      ports,
      // 回环落点 = `/status` 里 `endpoints[]` 的同一份事实（D5：订阅与轮询读同一份来源）。
      localPorts: ports.map((port) => ({
        port,
        localPort: this.endpoints.get(endpointKey(st.network, st.hostId, port))?.localPort ?? 0,
      })),
      lastSeenAgoMs: now - st.lastSeenMs,
      changedAt: st.changedAt,
    }
    // 仅在"已断连、还在 grace/debounce 窗口内"时给出倒计时（在线时不填，⛔ 不制造无意义字段）。
    if (devices === 0 && st.published) {
      entry.offlineInMs = st.offlineSinceMs + this.presenceGraceMs + this.presenceOfflineDebounceMs - now
    }
    return entry
  }

  /**
   * 状态**真的变了**才入队（第 2/4 条的前提：没有变化就一个帧都不发）。
   *
   * ⚠️ 这里是 presence 唯一的"写入出口" —— 任何新的状态来源都必须走它，否则会绕过批合并
   * （= 帧爆炸）。第 3 条：只入队给**订阅了该 host**的会话（订阅式扇出，不是广播）。
   */
  private publishPresence(st: PresenceState, online: boolean, now: number, force = false): void {
    if (!force && st.published === online && st.changedAt !== 0) return
    st.published = online
    st.changedAt = now
    const entry = this.presenceEntry(st, now)
    for (const s of this.sessions.values()) {
      if (s.subs === undefined) continue
      if (s.subs !== 'all' && !s.subs.has(st.name)) continue
      s.presencePending.set(st.name, entry)
    }
  }

  /**
   * **批合并出口**（第 2 条：每 1 s 一次 pipeline 提交）。
   *
   * 三件事按序做完：① grace/debounce 到期 ⇒ 真的改口离线；② TTL 安全网摘掉"指向已消失会话"的
   * 连接 id（兜"漏掉 close 事件"）；③ 每条订阅会话把攒下的一批**拼成一帧**发出去。
   */
  private flushPresence(): void {
    const now = Date.now()
    // ① 离线 debounce 到期 ⇒ 改口（10 s + 30 s = 40 s 之后才第一次说"它离线了"）
    for (const st of this.presence.values()) {
      if (!st.published || st.offlineSinceMs === 0) continue
      if (this.presenceDevices(st, now) > 0) continue
      if (now - st.offlineSinceMs >= this.presenceGraceMs + this.presenceOfflineDebounceMs) {
        this.publishPresence(st, false, now)
      }
    }
    // ② TTL 安全网（第 1 条：存储带 TTL 只作安全网，防网关崩溃漏事件）
    //    逐**连接**判死：某个 connId 超过 TTL 没动静 ⇒ 它已经不在了（典型成因 = 漏掉了 close 事件）。
    for (const st of this.presence.values()) {
      const before = st.conns.size
      for (const [id, ts] of [...st.conns]) if (now - ts > this.presenceTtlMs) st.conns.delete(id)
      const pruned = before - st.conns.size
      if (pruned === 0) continue
      if (this.presenceDevices(st, now) > 0) continue
      if (st.offlineSinceMs === 0) {
        st.offlineSinceMs = now
        // 摘掉的是"已消失的连接" ⇒ 走正常 grace/debounce 收口（⛔ 不在这里直接改口，
        // 否则 TTL 就绕过了第 5 条的抖动容忍）。
        this.log(`presence ${st.name} 摘掉 ${pruned} 个超 TTL 未活动的连接 ⇒ 起算 grace+debounce`)
      } else if (st.published && now - st.offlineSinceMs >= this.presenceGraceMs + this.presenceOfflineDebounceMs) {
        this.publishPresence(st, false, now)
      }
    }
    // ③ 推送：**每条订阅会话一帧**（一帧带 host 数组；⛔ 不是逐个 host 一条）
    for (const s of this.sessions.values()) {
      if (s.presencePending.size === 0) continue
      const entries = [...s.presencePending.values()]
      s.presencePending.clear()
      try {
        s.conn.sendBinary(encodeJsonFrame(MUX.PRESENCE, 0, { ok: true, entries, at: now }))
        this.pushed += 1
      } catch {
        /* 写失败 ⇒ 交给会话自己的 idle 超时兜底（⛔ 不在这里 dropSession，避免重入） */
      }
    }
  }

  /** 订阅方当前应看到的全量（`SNAP` 用；一帧拿全，⛔ 无 N+1）。 */
  private presenceSnapshot(session: Session): PresenceEntry[] {
    const now = Date.now()
    const out: PresenceEntry[] = []
    for (const st of this.presence.values()) {
      if (st.network !== session.network) continue
      if (session.subs !== undefined && session.subs !== 'all' && !session.subs.has(st.name)) continue
      // 只推"该 host 已在册"的条目（从未见过的主机无法枚举 —— 这是订阅语义的固有边界）。
      out.push(this.presenceEntry(st, now))
    }
    return out
  }

  /** 现在有多少条**存活**的订阅（`subs` 判别器；连接断了就没了 ⇒ 必须能回到 0）。 */
  private countSubs(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.subs !== undefined) n += 1
    return n
  }

  /**
   * `SUB` / `UNSUB`（第 3 条：**订阅只活在连接期间**）。
   *
   * 🔴 **跨网订阅必须显式拒绝**（D6）：本线头号教训是"静默失败会被当成正常"，
   * 而"静默返空"与"这张网里确实没人"**完全同形** ⇒ 拒绝必须带上原因 + 计数（`rejected`）。
   */
  private onSubscribe(session: Session, frame: MuxFrame, on: boolean): void {
    const now = Date.now()
    const msg = parseJsonPayload(frame.payload)
    if (msg === null) {
      this.rejectSubscribe(session, on, 'bad-payload')
      return
    }
    const net = typeof msg.network === 'string' && msg.network !== '' ? msg.network : session.network
    if (net !== session.network) {
      this.rejectSubscribe(session, on, `cross-network:${net}`)
      return
    }
    if (!on) {
      // 退订**幂等**：本来就没订阅也不报错（否则会制造无意义的拒绝计数）。
      session.subs = undefined
      session.presencePending.clear()
      return
    }
    const all = msg.all === true
    const rawHosts = Array.isArray(msg.hosts) ? msg.hosts.filter((h): h is string => typeof h === 'string' && h !== '') : []
    if (!all && rawHosts.length === 0) {
      this.rejectSubscribe(session, on, 'empty-subscription')
      return
    }
    if (this.presenceSubMax > 0 && rawHosts.length > this.presenceSubMax) {
      this.rejectSubscribe(session, on, `too-many:${rawHosts.length}`)
      return
    }
    const watched = new Set<string>()
    for (const h of rawHosts) {
      // 接受两种写法：裸 `hostId`（按本网补全）与完整逻辑名（必须落在本网，否则同属跨网 = 拒绝）。
      const target = h.includes(NAME_SEP) ? h : logicalName(session.network, h)
      const { network: targetNet } = parseLogicalName(target)
      if (targetNet !== session.network) {
        this.rejectSubscribe(session, on, `cross-network-host:${target}`)
        return
      }
      watched.add(target)
    }
    session.subs = all ? 'all' : watched
    session.presencePending.clear()
    // 🔑 **首帧即全量**（第 6 条：重连后必须重新拉一次全量）—— 一帧完成，⛔ 不逐 host 拉
    try {
      session.conn.sendBinary(
        encodeJsonFrame(MUX.SNAP, 0, {
          ok: true,
          entries: this.presenceSnapshot(session),
          graceMs: this.presenceGraceMs,
          offlineDebounceMs: this.presenceOfflineDebounceMs,
          batchMs: this.presenceBatchMs,
          ttlMs: this.presenceTtlMs,
          at: now,
        }),
      )
      this.pushed += 1
      this.snaps += 1
    } catch {
      /* 同上：写失败交给 idle 超时 */
    }
    this.log(
      `presence SUB host=${logicalName(session.network, session.hostId)} scope=${session.subs === 'all' ? 'all' : `${watched.size} 个点名`} subs=${this.countSubs()}`,
    )
  }

  private rejectSubscribe(session: Session, on: boolean, why: string): void {
    this.rejected += 1
    this.log(
      `presence ${on ? 'SUB' : 'UNSUB'} ⛔ 拒绝 host=${logicalName(session.network, session.hostId)} 原因=${why} rejected=${this.rejected}`,
    )
    try {
      session.conn.sendBinary(encodeJsonFrame(MUX.PRESENCE, 0, { ok: false, error: why, at: Date.now() }))
    } catch {
      /* 写失败同上 */
    }
  }

  private dropSession(session: Session, why: string): void {
    clearInterval(session.heartbeat)
    // ⚠️ 只有"当前 session 还是我"时才解绑 —— 否则新 session 刚注册就被旧 session 的收尾删掉。
    const key = logicalName(session.network, session.hostId)
    if (this.sessions.get(key) === session) this.sessions.delete(key)
    for (const st of session.streams.values()) {
      st.closed = true
      st.peer.destroy()
      // 这条流的对端若是「拨号方」，把它的路由条目一并清掉（否则拨号方留一条指向死流的记录）。
      if (st.dial !== undefined) st.dial.session.dialRoutes.delete(st.dial.streamId)
    }
    session.streams.clear()
    session.portStreams.clear()
    // 本会话若是**拨号方**：它在别人的会话里占着流 ⇒ 一并收掉，否则 worker 侧留悬挂流。
    for (const route of [...session.dialRoutes.values()]) {
      this.closeStream(route.session, route.st, 'dialer session dropped')
    }
    session.dialRoutes.clear()
    for (const ep of this.endpoints.values()) {
      if (ep.session === session) ep.session = undefined
    }
    if (!session.conn.isClosed) session.conn.close(WS_CLOSE.NORMAL, why)
    // presence（第 5 条）：**先不改口** —— 起算 grace + debounce；订阅方在窗口内会看到
    // `online:true` ＋ `offlineInMs` 倒计时，到期才收到 `online:false`（把抖动合并掉）。
    this.presenceDrop(session)
    this.log(`session ${session.id} (${key}) dropped: ${why}`)
  }

  /** 兜底巡检：endpoint 指向的 session 已不在册（只可能走异常路径）⇒ 标离线，避免 Manager 打到死连接。 */
  private sweep(): void {
    for (const ep of this.endpoints.values()) {
      if (ep.session !== undefined && this.sessions.get(logicalName(ep.network, ep.hostId)) !== ep.session) {
        ep.session = undefined
        this.log(`endpoint ${endpointKey(ep.network, ep.hostId, ep.port)} marked offline (stale session)`)
      }
    }
  }
}

/**
 * 端点表键 = `<network>/<hostId>:<port>`。
 *
 * `port` 用 `:` 分隔（与 `hostId` 的字符集不冲突），网络维度由 `/` 承担 —— 这样"跨网同名 host"
 * 与"同网不同端口"两种情形在键里都天然可分。
 */
function endpointKey(network: string, hostId: string, port: number): string {
  return `${logicalName(network, hostId)}:${port}`
}

/** 未配置拨号白名单 ⇒ `normalizeDialers` 返回**空 map** ⇒ 任何网络的 `DIAL` 一律被拒（默认拒绝）。 */

/**
 * 拨号流的 `peer` —— 把「一条 mux 会话 + 一个流号」当字节流用（覆盖网络 R5）。
 *
 * ## 背压为什么看 `bufferedAmount` 而不是 `write()` 的返回值
 * WS 的 `send()` 只是入队，**永远"成功"** ⇒ 拿返回值当背压判据等于没有背压（这正是 ssh 版
 * "静默失败"的同族病）。真正的判据是 socket 出向水位，与 `RelayClient.overWater()` 同一口径。
 *
 * ## `pause()` / `resume()` 为什么是空实现
 * WS 没有"暂停对端"这种能力。relay 不需要它：`write()` 返回 `false` ⇒ 上层的
 * `paused` / `queued` 机制接手（数据进 relay 自己的队列），对端慢**不会**把 relay 撑爆。
 */
class WsStreamPeer implements StreamPeer {
  constructor(
    private readonly conn: WsConnection,
    private readonly streamId: number,
    private readonly highWater: number,
  ) {}

  write(chunk: Buffer): boolean {
    if (this.conn.isClosed) return false
    this.conn.sendBinary(encodeMux(MUX.DATA, this.streamId, chunk))
    return this.conn.bufferedAmount < this.highWater
  }

  once(_event: 'drain', cb: () => void): void {
    this.conn.once('drain', cb)
  }

  pause(): void {
    /* WS 无法暂停对端；背压由 relay 自己的队列兜住（见类注释）。 */
  }

  resume(): void {
    /* 同上。 */
  }

  /** 关流：**必须**告诉拨号方（它那边的 `openStream()` 在等这个语义，缺了就是"静默断开"）。 */
  end(): void {
    if (!this.conn.isClosed) this.conn.sendBinary(encodeJsonFrame(MUX.CLOSE, this.streamId, { reason: 'relay closed' }))
  }

  destroy(): void {
    this.end()
  }
}

/** 定长 hex 常量时间比较（长度不等直接 false，不泄漏长度以外的信息）。 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
