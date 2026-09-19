/**
 * 可达性（Reachability）—— **"怎么到这台 worker"的可序列化描述**（覆盖网络 S0）。
 *
 * ## 为什么需要它
 * 现状里"怎么到一台 worker"被写死成两件事：`dsh_hosts.endpoint` 存一个 URL，
 * `clusterInstanceHost` 存一个**全局**主机名。两者都**表达不出"经谁中转"**，而现网
 * 恰好有两类语义完全不同的 host，字符串却同形：
 *
 * | hostId | endpoint | 真实语义 |
 * |---|---|---|
 * | `<host-a>`  | `http://127.0.0.1:<worker-port-a>` | **直连本机**（Manager 与 worker 同机，node 直接监听） |
 * | `<host-b>` | `http://127.0.0.1:<worker-port-b>` | **经 47 上 sshd 的反向隧道落点**（隧道的副作用） |
 *
 * ⇒ 换会合 / 中继组件时，表里**无法表达**「via（经哪个中继）+ 真实可达地址」，
 * 只能改表；越晚改代价越大（会合中继拆分方案 §2 C3）。
 *
 * `Reachability` 把这件事显式化：`via` 指向一个 `Rendezvous` 实现，`address` 是真实地址。
 *
 * ## P0-3：为什么要带 `networkId`
 * 地址是**网内**的：`127.0.0.1:<worker-port-b>` 在 `ops` 里指向 `<host-b>` 的 relay 落点，在 `u:5` 里
 * 可能指另一台。只带 `hostId` 的重达性描述**在多网下是有歧义的**，而歧义会以
 * "打到另一张网的同名节点"这种最贵的形态暴露（静默串网）。⇒ 本类型**必带**网络维度，
 * `parseReachability()` 从**逻辑名**（`<network_id>/<hostId>`）里取它，调用方不许自己拼。
 *
 * ## 边界（勿破）
 * 本模块**只做地址的表征与解析**，不承载任何权威状态 —— 归属 / 租约 / 骨干资格
 * 一律仍只由控制面写（与 `集群化改造方案 §1.3` 数据分层一致）。
 *
 * @module dsh_ai1net/net/reachability
 */

import { OPS_NETWORK, parseLogicalName } from './relay/network.js'

/** 同机直连：Manager 与 worker 在同一台机器上，不经任何中转。 */
export const VIA_LOCAL = 'local'

/** 今天唯一在跑的中转方式 = **Manager 主机上的 sshd 反向隧道**（S4 之后应被 relay 取代）。 */
export const VIA_MANAGER_SSH = 'manager-ssh'

/**
 * 自研中继单元 `dsh_ai1net-relay`（S4）：worker **只拨出**、relay **只绑回环**、
 * Manager 连 relay 分配的回环口 ⇒ 去掉对 sshd 的长期依赖（传输方案 §10 定案）。
 */
export const VIA_RELAY = 'relay'

export interface Reachability {
  /** 哪台 worker（**裸 hostId**，不含网络段 —— 网络在下一行，两者分开表达）。 */
  hostId: string
  /**
   * **属于哪张网**（P0-3 的结构性维度）：`ops` ｜ `u:<租户>` ｜ 其它显式命名。
   * 地址是**网内**语义，缺了它就等于"一张巨网 + 靠 ACL 兜"。
   */
  networkId: string
  /** **经谁可达** —— 一个 `Rendezvous` 实现的 id。 */
  via: string
  /** agent 的真实地址 `host:port`（**不含 scheme**）。 */
  address: string
  /** 传输层。 */
  scheme: 'http' | 'https'
}

/** 只取址所需的最小形状 —— 避免本模块反向依赖 `supervisor`。 */
export interface HostAddressable {
  hostId?: string
  agentUrl?: string
  reachability?: Reachability
  /**
   * **表里声明的会合形态**（`dsh_hosts.via` 原文，P0-3 加）。
   *
   * 为什么取址需要它：`via='relay'` 时 `agentUrl`（= `endpoint`）是 **relay 落点**而非直连地址，
   * 解析不出时必须**失败关闭**而不是回落它（见 `agentBaseUrlOf`）。少了这一位，那种回落
   * 在代码里**完全看不出来**（`agentUrl` 与真地址字符串同形）。
   */
  via?: string
}

/**
 * 把可达性拼成 agent 基址 —— **全仓唯一的拼接点**，别在别处再拼 `scheme://address`。
 */
export function agentBaseUrl(reach: Reachability): string {
  return `${reach.scheme}://${reach.address}`.replace(/\/+$/, '')
}

/**
 * 取一台 host 的 agent 基址：**可达性优先，回退旧 `agentUrl`**。
 *
 * S0 阶段的等价性：现网每个 host 都只有 `agentUrl`（`reachability` 全为 `undefined`）
 * ⇒ 本函数返回的就是原先直接用的那个字符串，**行为零变化**。
 *
 * ⚠️ 两者皆缺时**抛错**，不返回空串 —— "静默打到空地址"是跨机下最难查的失败。
 *
 * ## ⛔ `via='relay'` 时**不许**回落到 `agentUrl`（P0-3）
 * `agentUrl` 就是 `dsh_hosts.endpoint`。relay 语义下它存的是**落点**（`127.0.0.1:<动态口>`，
 * 旧形态则是 Worker 侧口号），与 `reachability.address` **字符串同形、语义完全不同**。
 * 解析失败（离线 / 跨网 / 快照陈旧）时回落它 ⇒ 请求被打到**控制面本机的同号端口**上，
 * 而那个端口可能正被**另一张网的落点**或**某个实例**占着 —— 与 A1「假 404 / 静默写坏」同族。
 * ⇒ 宁可**显式失败**（上层拿得到原因），也不发一个"看起来像地址"的东西出去。
 */
export function agentBaseUrlOf(host: HostAddressable): string {
  if (host.reachability !== undefined) return agentBaseUrl(host.reachability)
  if (host.via === VIA_RELAY) {
    throw new Error(
      `host "${host.hostId ?? '?'}" 声明 via=relay 但解析不出落点：拒绝回落到 endpoint ` +
        '（relay 语义下 endpoint 是落点，回落会打到本机同号端口）',
    )
  }
  if (host.agentUrl !== undefined && host.agentUrl !== '') return host.agentUrl.replace(/\/+$/, '')
  throw new Error(`host "${host.hostId ?? '?'}" 既无 reachability 也无 agentUrl：拒绝静默降级`)
}

/**
 * 从**逻辑名** + 旧的 `endpoint` 字符串解析出 `Reachability`（S2 迁移回填用 · P0-3 收口）。
 *
 * ## 为什么第一个参数是"逻辑名"而不是 `hostId`（P0-3 的唯一入口）
 * 地址是**网内**语义。若这里只收裸 `hostId`，网络维度就得由**每个调用方**自己补 ——
 * 而本线复盘里"散着拼字符串"最后必出三套不一致的口径。⇒ 收 `place` 的唯一入口改成收
 * `<network_id>/<hostId>`：网络段由**本函数**切出来（`parseLogicalName`），调用方不碰。
 * ⚠️ **裸 `hostId` 仍兼容**（⇒ 落 `ops`）：过渡期不破坏现网调用方与既有单测。
 *
 * 强制面：`endpoint` 历史上是完整 URL（`http://127.0.0.1:<worker-port-b>`），也容忍裸
 * `host:port` —— 没写 scheme 时按 `http` 处理，与 `RemoteSpawner` 原先"直接把它当
 * fetch 基址"的行为一致（fetch 会补 `http://`）。
 */
export function parseReachability(
  name: string,
  endpoint: string,
  via: string = VIA_MANAGER_SSH,
): Reachability {
  const { network, hostId } = parseLogicalName(name)
  const trimmed = endpoint.trim()
  const matched = /^(https?):\/\/(.*)$/i.exec(trimmed)
  if (matched !== null) {
    return {
      hostId,
      networkId: network,
      via,
      address: matched[2].replace(/\/+$/, ''),
      scheme: matched[1].toLowerCase() === 'https' ? 'https' : 'http',
    }
  }
  return { hostId, networkId: network, via, address: trimmed.replace(/\/+$/, ''), scheme: 'http' }
}

/** `Reachability` → 旧 `endpoint` 字符串（与 `parseReachability` 互逆，回填/回滚用）。 */
export function toEndpoint(reach: Reachability): string {
  return agentBaseUrl(reach)
}

/**
 * 从 `host:port` 里取端口（覆盖网络 R3）。
 *
 * 为什么需要：relay 为每个注册端口在**它自己的回环**上开一条监听，回环口号由 `listen(0)`
 * 动态分配 ⇒ Manager 拿不到、也推不出，只能拿「要拨的端口号」去 relay 的 `/status` 里查。
 * 而那个号码就住在 `dsh_hosts.endpoint` 里（`http://127.0.0.1:<worker-port-b>`）⇒ 统一在这里剥出来，
 * 别在调用方各写一遍 `split(':')`（IPv6 字面量会切错）。
 */
export function addressPort(address: string): number | undefined {
  const idx = address.lastIndexOf(':')
  if (idx < 0) return undefined
  const raw = address.slice(idx + 1).trim()
  if (!/^\d+$/.test(raw)) return undefined
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}
