/**
 * 会合（Rendezvous）—— **"该拨谁、经谁到"的解析器**（覆盖网络 S0）。
 *
 * ## 定位（分层口径，勿破）
 * | 组件 | 职责 | 可多实例？ | 权威状态 |
 * |---|---|---|---|
 * | **会合 (rendezvous)** | 收 worker 注册、回"该拨谁"、下发中继分配；**不承载数据面流量** | ✅ 无状态可复制 | ❌ 只有位置视图 |
 * | **中继 (relay)** | 数据面：worker 拨它 → Manager / 其他节点经它到 worker | ✅ | ❌ |
 * | **控制面 (Manager)** | 归属 / 租约 / 骨干资格 / 容量准入 | ❌ 单点 | ✅ 唯一写入者 |
 *
 * ⛔ **硬约束**：会合与中继**不得**写入 `dsh_instances.host_id` / `epoch` / 骨干资格 ——
 * 否则就是双写脑裂。
 *
 * ## 现状与目标
 * 今天"会合 + 中继"**不是一个组件，而是 Manager 主机上 sshd 的副作用**：
 * 会合点 = `<server-public-ip>:<ssh-port>`，中继落点 = Manager 的 `127.0.0.1`。
 * 本模块的作用是**先把接口抽出来**，让 SSH 隧道退化成"第一个可替换实现"
 * —— ⛔ 这一步**不换协议**，只换绑定与寻址（换 WireGuard / TURN 属远期）。
 *
 * @module dsh_ai1net/net/rendezvous
 */

import { VIA_LOCAL, VIA_MANAGER_SSH, type Reachability } from './reachability.js'
import { parseLogicalName } from './relay/network.js'

export interface Rendezvous {
  /** 实现 id —— `Reachability.via` 指向它。 */
  readonly id: string
  /** 这个会合点**本身**怎么拨（诊断 / 管理面展示用）。 */
  dialTarget(): string
  /**
   * 解析某台 worker 的可达性。
   *
   * ⚠️ **入参是逻辑名 `<network_id>/<hostId>`**（P0-3）—— 不是裸 `hostId`。
   * 地址是**网内**语义：两张网各有一台 `node-1` 时，只给 `hostId` 的解析**必然有歧义**，
   * 而歧义会以"打到另一张网的同名节点"这种最贵的形态暴露。裸 `hostId` 仍兼容（⇒ 落 `ops`），
   * 但**调用方不许自己拼网络段** —— 名字由 `logicalName()` 产出。
   *
   * ⚠️ **本实现管不到 ⇒ 回 `undefined`，不抛** —— 由调用方决定回退哪种实现
   * （抛错会让"多实现并存"的过渡期没法跑）。
   */
  resolve(name: string): Promise<Reachability | undefined>
}

/**
 * 由调用方提供"**逻辑名** → `host:port`"的查表函数（会合实现不直接连 DB）。
 * 键是逻辑名（P0-3）：查表这一层也必须带网络维度，否则同名 host 两张网互相覆盖。
 */
export type AddressLookup = (name: string) => string | undefined

/** 同机直连：Manager 能直接连到 worker 的端口，不经任何中转（`<host-a>` 就是这一类）。 */
export class LocalRendezvous implements Rendezvous {
  readonly id = VIA_LOCAL

  constructor(private readonly addressOf: AddressLookup) {}

  dialTarget(): string {
    return '(direct)'
  }

  async resolve(name: string): Promise<Reachability | undefined> {
    const address = this.addressOf(name)
    if (address === undefined) return undefined
    const { network, hostId } = parseLogicalName(name)
    return { hostId, networkId: network, via: this.id, address, scheme: 'http' }
  }
}

/**
 * Manager 主机上的 sshd 反向隧道 —— **当前唯一在跑的实现**。
 *
 * 语义：worker 主动 `ssh -R <port>:127.0.0.1:<port> root@<manager>:<port>`，把端口投到
 * Manager 的 **loopback**（`127.0.0.1:<同号端口>`）⇒ Manager 经 `127.0.0.1:<port>` 到达它。
 *
 * ⚠️ 这正是要拆掉的那一层（C1 会合地址硬编码 + C2 中继落点 = Manager loopback）。
 * S4 把"接收 worker 反拨"搬进独立单元 `dsh_ai1net-relay.service` 后，本类应被 `relay:<id>`
 * 实现替换，而**调用方不需要改**（只认 `Rendezvous` 接口）。
 */
export class ManagerSshRendezvous implements Rendezvous {
  readonly id = VIA_MANAGER_SSH

  constructor(
    private readonly opts: {
      /** 会合点的 SSH 目标，如 `root@<server-public-ip>:<ssh-port>`。 */
      target: string
      addressOf: AddressLookup
    },
  ) {}

  dialTarget(): string {
    return this.opts.target
  }

  async resolve(name: string): Promise<Reachability | undefined> {
    const address = this.opts.addressOf(name)
    if (address === undefined) return undefined
    const { network, hostId } = parseLogicalName(name)
    return { hostId, networkId: network, via: this.id, address, scheme: 'http' }
  }
}

/**
 * 按 `via` 选实现的注册表。
 *
 * 为什么需要：S2 起 `dsh_hosts` 会带 `via` 列，`hostsProvider` 必须"**先读 via →
 * 选对应实现 → 解析成 `Reachability`**"；`via` 未设时回退旧 `endpoint` 语义。
 */
export class RendezvousRegistry {
  private readonly impls = new Map<string, Rendezvous>()

  constructor(impls: readonly Rendezvous[] = []) {
    for (const impl of impls) this.register(impl)
  }

  register(impl: Rendezvous): void {
    this.impls.set(impl.id, impl)
  }

  get(id: string): Rendezvous | undefined {
    return this.impls.get(id)
  }

  ids(): string[] {
    return [...this.impls.keys()]
  }
}
