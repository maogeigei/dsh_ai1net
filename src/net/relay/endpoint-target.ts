/**
 * 覆盖网络 R4 / 序㉑ **P-2** / 序㉒ **P-2b**：`translateEndpoint` 的**纯判定**部分（+ 键口径索引）。
 *
 * ## 它治的是什么
 *
 * `via='relay'` 的 host，其实例在 Worker 上监听 `127.0.0.1:<实例端口>`，而 Manager 要拨的是
 * relay 为那个端口在**中继机**上开的动态回环口号 ⇒ 必须在 Manager 侧翻译一次。
 *
 * 原实现把这个判定写在 `src/web/server.ts` 的 `buildServer` **闭包**里，于是：
 *
 * 1. **不可先红后绿**（闭包无法单测）⇒ 本轮先把判定抽成纯函数，再改语义；
 * 2. 🔴 **键口径不一致 ⇒ 整个闭包是死分支**（P-2 的实体）：控制面所有表（`hostVia` /
 *    `relayEndpoints` / 拨号池）的键都是**逻辑名** `<network>/<hostId>`，而调用方
 *    （`RemoteSpawner.translateEndpoint(host.hostId, raw)`）只给得到**裸 hostId**
 *    ⇒ `hostVia.get(hostId)` 恒 `undefined` ⇒ 早退原样透传 ⇒ 翻译**从未生效**。
 *    修法 = 先过 `hostNameIndex` 把裸 hostId 换成逻辑名，再判（见下）。
 *
 * ## 判定顺序（**失败关闭**是最后一条硬要求）
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 未知 host（不在 `dsh_hosts` 里） | **原样透传**（保持老行为：单机 / 默认 host 不受影响） |
 * | `via` 不是 `relay`（`local` / `manager-ssh`） | **原样透传**（隧道是同号反向转发，两边口号相同） |
 * | `via = relay`：① 拨号落点 | `127.0.0.1:<拨号口>` |
 * | `via = relay`：② **订阅推送落点**（序㉒ P-2b） | `127.0.0.1:<推送口>` |
 * | `via = relay`：③ relay 快照落点 | `127.0.0.1:<快照口>` |
 * | `via = relay`：三级都没有 | **`unreachable`（⛔ 绝不原样透传）** |
 *
 * 🔴 **三级链必须与地址解析链逐级对齐**（序㉒ P-2b）：`src/web/server.ts#RelayRendezvous.addressOf`
 * 的链是 ① 拨号 → ② `presenceLocalPort`（订阅推送）→ ③ relay 快照。本判定**只做两级**时，
 * P-1 修好之后会**真的**判错：门判据改成「订阅已建立 ∧ 链路活着」后订阅新鲜期长期成立
 * ⇒ 快照（③）趋冷，而拨号池（①）在"该 host 的槽位分不出来"时也给不出落点 ⇒ 落到"两级都没有"
 * ⇒ **判实例不可达（失败关闭）**，尽管**同一时刻 `addressOf` 能从订阅推送里答出落点**。
 * 症状 = 用户看到"实例打不开"，而地址解析链自己明明有答案 —— 典型的**两条链漂移**。
 *
 * 🔴 判据必须取 **`dsh_hosts.via` 原文**，⛔ **不能**取 `reachability.via`：后者在 host 离线 /
 * relay 快照陈旧时为 `undefined`，据此判"不是 relay ⇒ 原样透传"就是**失败开放** ——
 * 把 Worker 侧口号打到 Manager 本机（2026-09-16 实测：浏览器只见空响应、平台零日志）。
 *
 * @module dsh_ai1net/net/relay/endpoint-target
 */

import { VIA_RELAY } from '../reachability.js'
import { OPS_NETWORK, logicalName } from './network.js'

/**
 * 判定结果。
 *
 * `passthrough` 与 `unreachable` **必须分开**：前者是"这条路径本来就不需要翻译"，
 * 后者是"需要翻译但查不到 ⇒ 实例此刻不可达" —— 合成一个 `undefined` 就会把
 * "不需要翻译"误判成"不可达"（掉路由 = 本线最贵的一类假红）。
 *
 * `via` 三支（`dialed` / `pushed` / `snapshot`）**必须可分辨**：它是"落点是从哪一级拿到的"
 * 的唯一证据（判别器纪律 —— 出问题时能一眼看出两条链是否走了同一级）。
 */
export type RelayEndpointDecision =
  | { kind: 'passthrough'; why: 'unknown-host' | 'not-relay' }
  | { kind: 'local'; port: number; via: 'dialed' | 'pushed' | 'snapshot' }
  | { kind: 'unreachable'; why: 'no-dialed-port' }

export interface RelayEndpointTargetInput {
  /** host 是否在控制面目录里（`dsh_hosts`）—— 未知 ⇒ 老行为。 */
  known: boolean
  /** `dsh_hosts.via` **原文**（`known = false` 时无意义）。 */
  via: string | undefined
  /**
   * **拨号落点**查询（R5：落点在 Manager 本机）。
   *
   * ⚠️ 传 thunk 而不是值：`RelayDialer#localPortFor` **会按需绑池口 / 发起一次拨号**
   * （有副作用，且是请求路径上的同步调用）⇒ 只有真的需要它（`known ∧ via === relay`）时才准调用。
   * 传值会把"非 relay 的 host 也去占一个池口"变成常态。
   */
  dialedPort: () => number | undefined
  /**
   * **订阅推送**里的回环落点（序㉒ P-2b）—— 即 `presenceLocalPort(name, port)` 的结果。
   *
   * `undefined` = 订阅不新鲜 / 该 host 不在推送范围 / 该端口没有落点（三种都交给下一级兜底）。
   * ⚠️ 这里收的是**已经解析出来的值**（不是 thunk）：`presenceLocalPort` 是纯内存查表、无副作用
   * ⇒ 与 `dialedPort` 不同，没有"必须先问要不要调"的问题。
   */
  pushedLocalPort?: number
  /** relay `/status` 快照里的动态回环口号（`undefined` = 没有 / 已陈旧）。 */
  snapshotLocalPort?: number
}

/** 纯判定：给 `via` 原文 ＋ **三级**落点来源，回答"Manager 该拨哪儿"。 */
export function relayEndpointTarget(input: RelayEndpointTargetInput): RelayEndpointDecision {
  if (!input.known) return { kind: 'passthrough', why: 'unknown-host' }
  if (input.via !== VIA_RELAY) return { kind: 'passthrough', why: 'not-relay' }
  // ① 拨号落点（首选：落点在 Manager 本机 ⇒ relay 换机器也成立）
  const dialed = input.dialedPort()
  if (dialed !== undefined && dialed > 0) return { kind: 'local', port: dialed, via: 'dialed' }
  // ② 订阅推送落点（P-2b；与 `addressOf` 的第 ② 级同源、同顺序）
  const pushed = input.pushedLocalPort
  if (pushed !== undefined && pushed > 0) return { kind: 'local', port: pushed, via: 'pushed' }
  // ③ relay 快照落点（R3 的原路径；只有"没订阅 / 订阅不新鲜"时才走到这里）
  const snap = input.snapshotLocalPort
  if (snap !== undefined && snap > 0) return { kind: 'local', port: snap, via: 'snapshot' }
  // 失败关闭：⛔ 不回退成"原样透传 Worker 侧口号"（那正是"空响应 + 平台零日志"的成因）。
  return { kind: 'unreachable', why: 'no-dialed-port' }
}

/**
 * `dsh_hosts` 行 ⇒ **`hostId` → 逻辑名** 索引 —— P-2 的**键口径唯一来源**。
 *
 * 🔑 存在的理由：`RemoteSpawner.translateEndpoint(host.hostId, …)` 只给得到**裸 hostId**，
 * 而控制面的每张表都按**逻辑名**建键 ⇒ 没有这张索引，闭包只能拿 hostId 去查、恒 `undefined`。
 * ⚠️ `dsh_hosts.id` 是主键（两条网各有一台同名 host 的说法只存在于"键用了裸 id"的旧代码里）
 * ⇒ 索引按裸 id 建键**不会**丢行。
 *
 * @param fallbackNetwork `network_id` 为空时的归属网（与 DB 列默认值同口径）。
 */
export function hostNameIndex(
  rows: readonly { id: string; networkId: string }[],
  fallbackNetwork: string = OPS_NETWORK,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of rows) {
    out.set(row.id, logicalName(row.networkId === '' ? fallbackNetwork : row.networkId, row.id))
  }
  return out
}
