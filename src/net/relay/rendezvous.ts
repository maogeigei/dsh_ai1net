/**
 * `relay:<id>` —— 会合实现的第三个（也是**去掉 sshd 依赖的那一个**）。
 *
 * ## 与其他两个实现的关系（同一 `Rendezvous` 接口，可共存、可逐个切换）
 * | 实现 | `via` | Manager 侧看到的地址 | 数据面 |
 * |---|---|---|---|
 * | `LocalRendezvous` | `local` | `127.0.0.1:<worker-port-a>`（同机直连） | 无中转 |
 * | `ManagerSshRendezvous` | `manager-ssh` | `127.0.0.1:<worker-port-b>`（**sshd 反向隧道落点**） | Manager 主机上的 sshd |
 * | **`RelayRendezvous`** | `relay` | `127.0.0.1:<relay 动态分配>`（**relay 开了回环监听**） | relay 的一条出向 wss |
 *
 * 三者对 Manager 侧**同形**（都是 `host:port`）⇒ 换实现不动调用方，这是 S0 抽 `Reachability`
 * 的全部意义（`src/net/rendezvous.ts:64` 早就写了"本类应被 `relay:<id>` 实现替换"）。
 *
 * ## 独有增益：**实时在线态**
 * 前两个实现只能回答"表里写的地址是什么"——`dsh_instances.status` 是 DB 快照，**不实时**。
 * relay 的注册由心跳维持（45s 无帧即判死）⇒ 本实现可以**先问在线、再给地址**，
 * 离线直接回 `undefined`（让上层回退别的实现，而不是往死地址上打、干等到超时）。
 *
 * @module dsh_ai1net/net/relay/rendezvous
 */

import { VIA_RELAY, type Reachability } from '../reachability.js'
import type { AddressLookup, Rendezvous } from '../rendezvous.js'
import { parseLogicalName } from './network.js'

export interface RelayRendezvousOptions {
  /** relay 自身的拨号目标（诊断 / 管理面展示用），如 `wss://dsh.<base-domain>/dsh_ai1net-relay`。 */
  dialTargetUrl: string
  /**
   * **逻辑名** → `host:port` 的查表函数（会合实现不直接连 DB，与另两个实现一致）。
   * 键是逻辑名（P0-3）⇒ 同名 host 分属两张网时各查各的，不会互相覆盖。
   */
  addressOf: AddressLookup
  /**
   * **实时**在线判定（relay 心跳驱动）。省略 = 不判在线（退化成与另两个实现相同的纯查表）。
   * 入参同样**逻辑名**（relay 的端点视图按 `network/hostId:port` 建键）。
   */
  online?: (name: string) => boolean
  /**
   * **订阅推送**的在线判定（**主路径**，presence）。
   *
   * 语义与 {@link RelayRendezvousOptions.online} 的关系（D5，"主路径 + 兜底"：
   * * 返回 `true` / `false` ⇒ **以它为准**（订阅新鲜，`/status` 的快照**不再被读**）；
   * * 返回 `undefined` ⇒ **这条不知道** ⇒ 回落到 `online`（= `/status` 快照 / 拨号自判）。
   *
   * 🔑 为什么不把两者合成一个：两者的**失败语义不同** —— `online` 的 `false` 可能只是
   * "快照陈旧"，而订阅的 `false` 是 relay 亲口说的"它现在不在"。混在一起会退化成
   * "一旦订阅可用就再也回不去"，回滚链（§7-②）就断了。
   */
  presence?: (name: string) => boolean | undefined
}

export class RelayRendezvous implements Rendezvous {
  readonly id = VIA_RELAY

  constructor(private readonly opts: RelayRendezvousOptions) {}

  dialTarget(): string {
    return this.opts.dialTargetUrl
  }

  async resolve(name: string): Promise<Reachability | undefined> {
    /**
     * **主路径 = 订阅推送**：订阅新鲜时它的答案就是权威答案（relay 亲口说的在线态）。
     * `undefined` = 订阅没生效 / 这条不在推送范围 ⇒ 才轮到下面的兜底。
     */
    const pushed = this.opts.presence?.(name)
    const online = pushed !== undefined ? pushed : this.opts.online?.(name)
    if (online === false) return undefined
    const address = this.opts.addressOf(name)
    if (address === undefined) return undefined
    const { network, hostId } = parseLogicalName(name)
    return { hostId, networkId: network, via: this.id, address, scheme: 'http' }
  }
}
