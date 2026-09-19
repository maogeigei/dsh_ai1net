/**
 * `RelayDialer` —— **会合可换机的收口件**（覆盖网络 R5）。
 *
 * ## 它解决的确切问题
 * R1–R4 的落点是「relay 在**自己主机**的回环上开监听，Manager 去连那个回环口」。这带来一条
 * 隐式前提：**Manager 必须与 relay 同机**（否则它根本够不到 relay 的 `127.0.0.1`）。
 * 于是"中继可换机 / 可多实例 / Manager 不再兼任会合"这件事**做不到**。
 *
 * ## 做法（关键的一步换位）
 * 把落点从 **relay 主机** 搬到 **Manager 本机**：
 * - Manager 也像 worker 一样**只拨出**一条 wss（`RelayClient` 的 `dialer` 模式）；
 * - 本类在 Manager 自己的回环上预先绑一**小池**本机口，每个口号"指向"某个 `(hostId, port)`；
 * - 有连接进来 ⇒ `client.openStream(hostId, port)` ⇒ 拿到一条 mux 流 ⇒ 与本机 socket 对接。
 *
 * ⇒ 对外形态**完全没变**（还是"一个 `127.0.0.1:port`"），所以 `translateEndpoint` 的调用方
 *   （`proxy.ts` / `RemoteSpawner` / `RemoteUserFs`）**一行都不用改**；变的是这个口号从哪来 ——
 *   从"relay 主机"变成"Manager 自己"。**relay 放哪台机器都不再影响 Manager。**
 *
 * ## 为什么用「预绑池」而不是「按需 listen」
 * `translateEndpoint` 是**同步**的（在请求路径上），而 `listen()` 是异步的 —— 按需绑会出现
 * "口号已经返回、监听还没起来"的竞态窗口（表现为**首次**请求偶发连接被拒，最难查的那种）。
 * 池在**启动时**一次性绑好 ⇒ 拿口号是纯查表，零竞态；容量上限也变成显式、可观测的。
 *
 * ⚠️ 池口号必须**避开 OS 临时端口段（32768–60999）**与实例端口段，否则会偶发撞号。
 *
 * @module dsh_ai1net/net/relay/dialer
 */

import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'
import type { RelayClient } from './client.js'
import { parseLogicalName } from './network.js'

export interface RelayDialerOptions {
  /** **拨号方模式**的客户端（`dialer: true`）。 */
  client: RelayClient
  /** 本机口池起点。**必须避开** OS 临时端口段与实例端口段。 */
  portBase: number
  /** 本机口池扫描宽度。 */
  portSpan: number
  /** 池大小 = 最多同时挂多少个 `(hostId, port)` 落点。默认 64。 */
  poolSize?: number
  log?: (line: string) => void
}

interface Slot {
  server: TcpServer
  localPort: number
  /** 当前指向的 `(hostId, port)`；`undefined` = 空闲可分配。 */
  key?: string
  /** 在途连接数（决定该槽位能不能被回收重分配）。 */
  active: number
  lastUsed: number
}

const DEFAULT_POOL = 64

export class RelayDialer {
  private readonly client: RelayClient
  private readonly log: (line: string) => void
  private readonly portBase: number
  private readonly portSpan: number
  private readonly poolSize: number
  /**
   * **本拨号通道声明的那张网**（P0-3）—— 从客户端拿，**不另配一份**。
   * 两处各配一次就会出现"通道在 A 网、判据按 B 网"这种最难查的错配。
   */
  private readonly network: string
  private readonly slots: Slot[] = []
  private bound = 0
  private denied = 0
  /**
   * **未分配槽位被连接命中的次数**（只丢弃那条连接、槽位原样保留）—— 序⑮ 缺陷 B 的判别器。
   * 这个计数存在的唯一理由：该路径过去**零日志零计数**，缺陷只在下一次分配时才以
   * `ECONNREFUSED` 的样子露面（现场看不出"这个口早就废了"）。
   */
  private stray = 0
  private closed = false

  constructor(opts: RelayDialerOptions) {
    this.client = opts.client
    this.log = opts.log ?? ((s: string) => process.stdout.write(`${s}\n`))
    this.portBase = opts.portBase
    this.portSpan = opts.portSpan
    this.poolSize = opts.poolSize ?? DEFAULT_POOL
    this.network = opts.client.networkId
  }

  /** 绑定整个池。**在 Manager 开始服务前 await 它**（否则 `localPortFor()` 恒返回 `undefined`）。 */
  async start(): Promise<void> {
    const next = this.portBase
    let p = next
    const limit = this.portBase + this.portSpan
    for (let i = 0; i < this.poolSize; i++) {
      let slot: Slot | undefined
      while (p < limit) {
        const port = p++
        const server = createTcpServer({ pauseOnConnect: true })
        const ok = await new Promise<boolean>((resolve) => {
          const onErr = (): void => {
            server.off('error', onErr)
            resolve(false)
          }
          server.once('error', onErr)
          server.listen(port, '127.0.0.1', () => {
            server.off('error', onErr)
            resolve(true)
          })
        })
        if (!ok) {
          server.close()
          continue
        }
        slot = { server, localPort: port, active: 0, lastUsed: 0 }
        break
      }
      if (slot === undefined) {
        this.log(`[relay-dialer] 口池只绑到 ${i}/${this.poolSize}（${this.portBase}..${limit} 已用尽）`)
        break
      }
      slot.server.on('connection', (tcp: Socket) => this.onConn(slot as Slot, tcp))
      this.slots.push(slot)
    }
    this.bound = this.slots.length
    this.log(`[relay-dialer] 本机落点池就绪：${this.bound} 个口（${this.portBase}..${this.portBase + this.portSpan}）`)
  }

  /**
   * 取 `(逻辑名, port)` 在本机的落点口号 —— **同步**返回，可直接用在 `translateEndpoint` 里。
   *
   * 返回 `undefined` 的四种情形**都必须让上层失败关闭**（不许回退成"原样透传"，那会变成
   * "Manager 拿 worker 侧口号往自己本机拨"的老毛病）：
   * ① 池未就绪；② 没有空闲槽位且都在途（容量到顶，会在日志里点名）；③ 参数非法；
   * ④ **跨网**（P0-3，见下）。
   *
   * ## 入参是逻辑名（P0-3）
   * 键必须是 `<network_id>/<hostId>:<port>`：只按裸 `hostId` 建键时，两张网各有一台同名
   * host 会**互相复用同一个落点** —— 也就是"给 A 网的口，发给了 B 网的目标"。
   */
  localPortFor(name: string, port: number): number | undefined {
    if (this.closed || this.bound === 0) return undefined
    if (name === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
    /**
     * ⛔ **跨网 ⇒ 本机口池直接拒**（P0-3 · 控制面侧的那道门）。
     *
     * 本通道只声明了一张网（`RelayClient.networkId`），relay 也**只会在这张网里找目标**
     * ⇒ 按"另一张网的逻辑名"分配落点 = 把一个**必然失败的落点**当成可用地址发出去
     * （上层会拿 `127.0.0.1:<口>` 去连，被 relay 拒、或撞上别的网的口）。
     * 失败关闭 + **点名两边是哪张网**：不许让它退化成"连不通"。
     */
    const { network } = parseLogicalName(name)
    if (network !== this.network) {
      this.denied += 1
      this.log(
        `[relay-dialer] ⛔ 跨网拒绝 ${name}:${port}（本通道 network=${this.network}，目标 network=${network}）`,
      )
      return undefined
    }
    const key = `${name}:${port}`
    const now = Date.now()
    const hit = this.slots.find((s) => s.key === key)
    if (hit !== undefined) {
      hit.lastUsed = now
      return hit.localPort
    }
    /**
     * 先找从未分配过的空槽，再找"空闲且最久没用过"的槽（LRU 回收）—— 两者都不动在途连接。
     *
     * 🔴 **两个候选都必须"真的还在听"**（`server.listening`，序⑮ 缺陷 B）：
     * 一旦某个槽位的监听已经关掉却还留在 `slots` 里，这里就会把一个**死口号**当成可用落点
     * 发出去 ⇒ 调用方 `ECONNREFUSED`（实测 = `/api/dsh/enter` 回 500 `fetch failed`）。
     * `listening` 是"这笔账到底还算不算数"的**唯一权威来源**；宁可失败关闭（下面点名），
     * ⛔ 也绝不把一个没人听的口号交出去。
     */
    const free = this.slots.find((s) => s.key === undefined && s.server.listening) ?? this.lruIdle()
    if (free === undefined) {
      this.denied += 1
      const dead = this.slots.filter((s) => !s.server.listening).map((s) => s.localPort)
      this.log(
        dead.length === 0
          ? `[relay-dialer] 口池已满（${this.bound} 个全在途）⇒ 拒绝 ${key}（失败关闭，不静默回退）`
          : `[relay-dialer] ⛔ 口池无可成交槽位（${this.bound} 个口里 ${dead.length} 个已不在听：${dead.join(',')}）⇒ 拒绝 ${key}（失败关闭，不静默回退）`,
      )
      return undefined
    }
    free.key = key
    free.lastUsed = now
    // **必须可见**：不打印的话，"这个回环口号对应哪台机的哪个端口"在运行期完全不可查，
    // 出问题只能靠猜（这正是本线反复踩的"静默"同族病）。重分配（LRU 回收）单独标出来。
    this.log(`[relay-dialer] 落点 127.0.0.1:${free.localPort} -> ${key}`)
    return free.localPort
  }

  private lruIdle(): Slot | undefined {
    let best: Slot | undefined
    for (const s of this.slots) {
      if (s.active > 0) continue
      // 不在听的槽⛔ 不许当"可回收空位"（同上：宁可失败关闭，也不发死口号）
      if (!s.server.listening) continue
      if (best === undefined || s.lastUsed < best.lastUsed) best = s
    }
    return best
  }

  /**
   * 本机连接 ⇒ 拨号流 ⇒ 对接。
   *
   * `pauseOnConnect` 让内核替我们挡住"流还没开好时的请求字节"⇒ 不存在丢头几个字节的竞态
   * （与 relay 侧 `onManagerConn` 用的是同一条手法）。拨号失败**必须**把连接拆掉：让调用方
   * 看到连接被重置，而不是一个挂住不动的请求。
   */
  private onConn(slot: Slot, tcp: Socket): void {
    tcp.setNoDelay(true)
    const key = slot.key
    if (key === undefined) {
      /**
       * 🔴 **未分配槽位被一条连接命中**（序⑮ · 缺陷 B 的修复点）。
       *
       * ⛔ 这里**绝不许** `slot.server.close()` —— 关掉的只是"这个口的服务器"，
       * 而槽位**仍留在 `slots` 里、`key` 仍是 `undefined`** ⇒ `localPortFor()` 的
       * `slots.find((s) => s.key === undefined)` **下次还会选中它**，把一个**已经没人听**的
       * 口号当成可用落点发出去 ⇒ 调用方拿 `ECONNREFUSED`（**用户可见**：
       * `POST /api/dsh/enter` 回 500 `fetch failed: connect ECONNREFUSED 127.0.0.1:25000`；
       * 47 上实测 3 条，2026-09-17 16:00:31/35/40；现场表现为"池报 64 个口、`ss` 只见 63"）。
       *
       * 另一种"看似彻底"的修法（顺手把槽位从 `slots` 摘掉）**是净退化**：那等于让**任意一条本地
       * 连接**都能永久蚕食池容量 —— 扫 64 次就把池扫空（R11）。
       * ⇒ 正确做法 = **只丢弃这条无法路由的连接，槽位原样保留**（它本来就没被分配过，
       *    监听继续有效、容量不变）。同时**必须留下计数与点名日志**：这个缺陷最难查之处
       *    恰恰是这条路径过去**零日志**，只在下一次分配时以 `ECONNREFUSED` 的样子露面。
       */
      this.stray += 1
      this.log(
        `[relay-dialer] ⛔ 未分配落点 127.0.0.1:${slot.localPort} 收到一条连接 ⇒ 只丢弃该连接、槽位保留（累计 ${this.stray} 次）`,
      )
      tcp.destroy()
      return
    }
    const idx = key.lastIndexOf(':')
    /**
     * ⛔ `DIAL.target` 是**裸 hostId**，不含网络段（服务端会显式拼上**拨号方自己**那张网，
     * 见 `server.ts#onDial`）。键从 P0-3 起是逻辑名 ⇒ 这里**必须**剥掉网络段再发。
     * 漏剥的表现极具误导性：服务端按 `logicalName('ops', 'ops/<host-b>')` = `ops/ops/<host-b>` 找会话，
     * 找不到 ⇒ 回 `target-offline`（"节点离线"），而节点其实**好好在册** ——
     * 实测踩过一次（2026-09-17 07:32 线上，`refused: 8 / streamsOpened: 0`）。
     */
    const { hostId } = parseLogicalName(key.slice(0, idx))
    const port = Number(key.slice(idx + 1))
    void this.client
      .openStream(hostId, port, 5_000)
      .then((duplex) => {
        if (tcp.destroyed) {
          duplex.destroy()
          return
        }
        slot.active += 1
        let released = false
        const release = (): void => {
          if (released) return
          released = true
          slot.active -= 1
        }
        tcp.on('close', release)
        duplex.on('close', release)
        tcp.on('error', () => tcp.destroy())
        duplex.on('error', () => tcp.destroy())
        tcp.pipe(duplex).pipe(tcp)
        tcp.resume() // `pauseOnConnect` 到此结束：流已就绪，可以放字节了
      })
      .catch((err: unknown) => {
        this.log(`[relay-dialer] 拨 ${key} 失败：${err instanceof Error ? err.message : String(err)}`)
        tcp.destroy()
      })
  }

  close(): void {
    this.closed = true
    for (const s of this.slots) {
      try {
        s.server.close()
      } catch {
        /* 已关 */
      }
    }
    this.slots.length = 0
    this.bound = 0
  }

  /**
   * 诊断视图（`/status` 与管理面用）：池有多大、几个已分配、被拒过几次、被误连过几次。
   *
   * ⚠️ `pool` 报的是**实际还在听的槽位数**（不是 `start()` 那一刻的那个数）：它必须与
   * "`ss` 数得出来的池口号数"**恒等**，否则就是"池在撒谎"（序⑮ 判据 a）。恒等不是靠这个写法
   * 保证的（修复已让槽位永不被单方面关掉），而是靠它把任何未来的关闭动作**立刻显形**。
   */
  status(): {
    pool: number
    assigned: number
    denied: number
    stray: number
    slots: { key: string; localPort: number; active: number }[]
  } {
    return {
      pool: this.slots.filter((s) => s.server.listening).length,
      assigned: this.slots.filter((s) => s.key !== undefined).length,
      denied: this.denied,
      stray: this.stray,
      slots: this.slots
        .filter((s) => s.key !== undefined)
        .map((s) => ({ key: s.key as string, localPort: s.localPort, active: s.active })),
    }
  }
}
