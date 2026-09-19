/**
 * Worker agent（T08 S3；设计 §11.2）。
 *
 * **它是什么**：Worker 上唯一的"被拨入口" —— 一个内部 HTTP 服务，把实例生命周期
 * 暴露给 Manager。**它不做归属决策**（谁托管谁是 Manager + PG 的事），只负责
 * "在这台机器上把实例起停好"，并复用 **`LocalSpawner`**，因此 bwrap/uid/scope
 * 隔离、内存配额推导、崩溃退避与熔断、插件探活这些**本地语义全部原样保留**
 * （这是本方案相对 k8s 路线最大的成本优势）。
 *
 * 四条协议纪律（设计 §11.3）：
 *  1. **单向拨入**：Worker 不反向连 Manager、不写控制面数据（自己可以有库，见下）；
 *  2. **幂等键**：每个变更请求带 `operationId`，重复请求**回放上次结果**
 *     （否则 Manager 超时重试会起两个实例）；
 *  3. **最小接口**：只接受白名单动作，参数受限（folder 由 Manager 解析、patch 有长度上限）
 *     —— agent 若能被当任意命令执行器，Worker 沦陷 = 全集群沦陷；
 *  4. **self-fencing**：`POST /fence {userId, epoch}` —— 本地记录的 epoch 落后于
 *     Manager 下发的值 ⇒ **主动停掉该实例**（防双写的最后一道防线）。
 *
 * @module dsh_ai1net/worker/agent
 */
import { execFileSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import type { ServerConfig } from '../config.js'
import { LocalUserFs } from '../fs/local-user-fs.js'
import { userRoot } from '../fs/workspace.js'
import { isHomeFileName, isUserFsErrorCode, UserFsError, type HomeFileName } from '../fs/user-fs.js'
import { hashUid } from '../isolation.js'
import { LocalSpawner } from '../supervisor/orchestrator.js'
import { normalizeTunnelTarget, SshTunnel, type WorkerTunnel } from './tunnel.js'
import { loadClientIdentity } from '../net/relay/identity.js'
import { listOverlayRelayCandidates } from '../net/relay/directory.js'
import { overlayEnvSeeds, overlayEnvTrustedKeys } from '../net/relay/directory.js'
import { RelayTunnel, isRelayUrl } from './relay-tunnel.js'
import type { Instance } from '../supervisor/spawner.js'

/** 绑定的头部名（Manager/agent 双方约定）。 */
export const AGENT_TOKEN_HEADER = 'x-dsh-agent-token'

export interface WorkerAgentOptions {
  /** 本机在 `dsh_hosts.id` 里的标识。 */
  hostId: string
  /** 共享密钥（仅内网 + nft 白名单；本版是 bearer 式比较，HMAC/防重放留待后续）。 */
  token: string
  /** 监听端口。 */
  port: number
  /** 绑定地址（默认 `0.0.0.0`，靠 nft 只放行 Manager 网段）。 */
  host?: string
  /** 返回给 Manager 做代理的地址（同机 1a 用 `127.0.0.1`；跨机时填内网 IP）。 */
  instanceHost?: string
  /** 日志级别。 */
  logLevel?: string
  /**
   * **反向隧道**（跨机演练）：Worker 主动拨 Manager，形如 `root@<server-public-ip>:<ssh-port>`。
   * 不设则完全关闭（同机/单机形态零影响）。见 `tunnel.ts` 头注释。
   */
  tunnelTarget?: string
  /** 隧道私钥（默认 `~/.ssh/tunnel_ed25519`）。 */
  tunnelIdentity?: string
  /** ControlMaster socket（默认 `/tmp/dsh_ai1net-tunnel-<hostId>.sock`）。 */
  tunnelControlPath?: string
}

/** 变更类请求的幂等缓存条数上限（超出后丢最旧的 —— 只是省重试，不是审计）。 */
const OP_CACHE_MAX = 512
/** patch 内容长度上限（防把 agent 当大对象存储）。 */
const MAX_PATCH_BYTES = 256 * 1024

/** 按 uid 查 passwd 条目（查不到返回 undefined）。 */
function passwdEntryForUid(uid: number): string | undefined {
  try {
    const out = execFileSync('getent', ['passwd', String(uid)], { encoding: 'utf8' }).trim()
    return out === '' ? undefined : out
  } catch {
    return undefined
  }
}

/**
 * 确保该用户在本机的 OS 账号存在（幂等）—— **集群化后「建号」的责任落点**（2026-09-16 定）。
 *
 * **为什么必须落在这里**
 * - 账号是**机器本地状态**（`/etc/passwd`），而 uid 由 Manager 从控制面库分配、随
 *   `POST /launch` 投递 ⇒ **只有 agent 同时握有「uid」与「这台机器」**。
 * - 单机时代的 `dsh-provision.path`（观察目录出现 ⇒ 建号）靠本地控制面库算 uid，
 *   集群下算不出来：实测 `hashUid` 兜底把 guest 算成 **184656**（真实 100002），
 *   而 PG 是 Manager 专属（Worker 不连控制面库，见本文件头「边界」）⇒
 *   **不能把建号留在 Worker 本地被动触发**。
 *
 * **规格**与 `the provisioning script` 一致（`dsh-<短id>` / `-M` / `nologin` / 同 uid），
 * 因此与存量节点兼容且可重复执行（幂等）。
 *
 * ⚠️ 这是**受控固定动作**，不接受调用方传命令或路径 ⇒ 不违反「最小接口」纪律：
 *    `userId` 必须是 UUID 形状、`uid` 必须是 `>= baseUid` 的整数。
 */
export function ensureOsAccount(config: ServerConfig, userId: string, uid: number): void {
  // ① 参数校验先行（与平台无关）：非法输入在任何平台都该被拒绝
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error(`ensureOsAccount: invalid userId ${userId}`)
  }
  if (!Number.isInteger(uid) || uid < config.baseUid) {
    throw new Error(`ensureOsAccount: invalid uid ${uid} (baseUid=${config.baseUid})`)
  }
  // ② 非 Linux 节点没有 useradd 语义（客户端节点形态另议）
  if (process.platform !== 'linux') return
  // ⚠️ 判定**只看 uid**：uid 由 Manager 全局唯一分配 ⇒「同 uid」即「同一用户」，
  //    因此**不校验账号名**。存量账号存在历史命名差异（实测 47 上 guest 的账号是
  //    `dsh-eeccbc638afc46bdb663`，而按规则本该是 `dsh-4092b9652f6849779989`）——
  //    名字只是本机标识，权限判据始终是 uid；为它改名反而要动 /etc/passwd + 全量 chown。
  const entry = passwdEntryForUid(uid)
  if (entry === undefined) {
    const name = `dsh-${userId.replace(/-/g, '').slice(0, 20)}`
    execFileSync('useradd', ['-u', String(uid), '-M', '-s', '/usr/sbin/nologin', name], { stdio: 'pipe' })
  }
  // 目录已存在则对齐属主（目录可能尚未创建 ⇒ 留给 spawner 建）
  const root = userRoot(config.dataRoot, userId)
  if (existsSync(root)) execFileSync('chown', ['-R', `${uid}:${uid}`, root], { stdio: 'pipe' })
}

interface OpCache {
  order: string[]
  results: Map<string, unknown>
}

/**
 * 组装 agent。**复用 `LocalSpawner`**（隔离/配额/退避/熔断/探活全部原样保留）。
 *
 * ⚠️ **边界要读准**（2026-09-15 用户纠正）：本 agent **不写控制面数据**（尤其归属/租约 ——
 * 双写就是脑裂），所以 `apiKey` 与 `uid` **不由本机查控制面库**，而是 Manager 在
 * `POST /launch` 时随请求投递（与 k8s 用 per-user Secret 同一思路），只存内存。
 * 但这**不等于"Worker 不许有数据库"**：插件的 per-user 数据（如 `home/.dsh/mcn-plugin.db`）
 * 属于**实例业务数据**，由实例自己读写、跟着 home 走；Worker 也可以有自己的运维库。
 * 完整判据见设计 §1.3「数据分层」。
 */
export function buildWorkerAgent(
  config: ServerConfig,
  options: WorkerAgentOptions,
): { app: FastifyInstance; spawner: LocalSpawner; stop: () => Promise<void> } {
  /** launch 时投递、仅存内存的凭据与 uid（Worker 不连 DB）。 */
  const apiKeys = new Map<string, string>()
  const uids = new Map<string, number>()
  const spawner = new LocalSpawner(
    config,
    async (userId: string) => apiKeys.get(userId) ?? null,
    async (userId: string) => uids.get(userId) ?? hashUid(userId, config.baseUid),
  )
  /**
   * 文件面（T08 S5）：**复用同一个 `LocalUserFs`** —— 用户卷本来就在本机，
   * 所以"跨机文件面"= 把这个实现经 HTTP 暴露出去，而不是重新实现一套路径语义。
   */
  const userFs = new LocalUserFs((userId: string) => userRoot(config.dataRoot, userId))

  /**
   * 反向隧道（可选）。静态转发 = **agent 自身端口** + `DSH_AI1NET_TUNNEL_STATIC_PORTS`（如控制面 PG）；
   * 实例端口在 launch/stop 时动态加减，并在 `/healthz`（Manager 的心跳）里**对账自愈**。
   *
   * S1：会合地址**优先取 config**（`DSH_AI1NET_RENDEZVOUS_URL` → 兜底 `DSH_AI1NET_TUNNEL_TARGET`，在
   * `config.ts` 里单点解析）；显式 `options.tunnelTarget` 仍是最优先（测试/嵌入用）。
   *
   * R4：**按 scheme 选传输实现** —— 裸 `user@host:port` / `ssh://` ⇒ `SshTunnel`（旧路，保留可秒回滚）；
   * `ws://` / `wss://` ⇒ `RelayTunnel`（自研 relay，去掉对 sshd 的长期依赖）。两者同实现
   * `WorkerTunnel` 面 ⇒ 本段以下所有代码（自愈 / 对账 / `/healthz`）**与传输无关**。
   */
  const rendezvousRaw = (options.tunnelTarget ?? config.clusterRendezvousUrl ?? '').trim()
  const staticPorts = [
    options.port,
    ...(process.env.DSH_AI1NET_TUNNEL_STATIC_PORTS ?? '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0),
  ]
  const tunnel: WorkerTunnel | undefined =
    rendezvousRaw === ''
      ? undefined
      : isRelayUrl(rendezvousRaw)
        ? new RelayTunnel({
            url: rendezvousRaw,
            hostId: options.hostId,
            // 密钥必须显式给：**缺了就抛** —— 静默降级到别的传输会让"以为切过去了"变成假象。
            secret: (() => {
              const secret = (process.env.DSH_AI1NET_RELAY_SECRET ?? '').trim()
              if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
                throw new Error('DSH_AI1NET_RENDEZVOUS_URL 用了 relay（ws/wss）⇒ 必须同时给 DSH_AI1NET_RELAY_SECRET（64 hex）')
              }
              return secret
            })(),
            staticPorts,
            /**
             * **C2 装配点：中继失败切流**。
             *
             * ⛔ **不改会合面**：起始地址仍然是上面那个 `rendezvousRaw`（= `DSH_AI1NET_RENDEZVOUS_URL`
             * 的既有取值顺序，一行没动）。这里只补一件事 —— 起始那台**不健康**时，
             * 从**同一份引导链**（`listOverlayRelayCandidates`）里换到下一条。
             *
             * 为什么候选链不走 `rendezvousRaw`：那是"当前连哪台"的答案，不是"还有哪些台"的清单；
             * 而链是**已签名目录 / 内置种子**的产物 ⇒ ⛔ 不可能指向任意 url（引不出任意重定向）。
             * 链里取不到候选 ⇒ 什么都不做（D6），**行为与改造前逐字一致**。
             */
            failover: {
              candidates: async () =>
                (
                  await listOverlayRelayCandidates({
                    envUrl: '',
                    seeds: overlayEnvSeeds(),
                    trustedKeys: overlayEnvTrustedKeys(),
                    cacheFile: process.env.DSH_AI1NET_OVERLAY_DIR_CACHE ?? '',
                    log: (line: string) => console.error(line),
                  })
                ).urls,
            },
            /**
             * **本机节点身份**。配了 `DSH_AI1NET_OVERLAY_NODE_KEY_FILE` + `..._NODE_GRANT_FILE`
             * 才会带上（缺省 = 只做 HMAC，过渡期形态不变）。
             * ⚠️ **配了却读不出来 ⇒ 起动即抛**（见 `identity.ts#loadClientIdentity`）——
             * 静默退化成"没身份"会让"凭据坏了"表现成"一切正常"，等 relay 一开强制就整台失联。
             */
            identity: loadClientIdentity({
              keyFile: config.overlayNodeKeyFile,
              grantFile: config.overlayNodeGrantFile,
              log: (line: string) => console.error(line),
            }),
            log: (line: string) => console.error(line),
          })
        : new SshTunnel({
            target: normalizeTunnelTarget(rendezvousRaw),
            identity:
              options.tunnelIdentity ??
              process.env.DSH_AI1NET_TUNNEL_IDENTITY ??
              `${process.env.HOME ?? '/root'}/.ssh/tunnel_ed25519`,
            controlPath: options.tunnelControlPath ?? `/tmp/dsh_ai1net-tunnel-${options.hostId}.sock`,
            staticPorts,
          })
  let tunnelReady = tunnel === undefined

  /**
   * **隧道自愈**：master 失联就重建（重建会自动补回 staticPorts 的静态转发）。
   *
   * ⚠️ 为什么不能只在 `/healthz` 里做（2026-09-15 想清楚的一个死角）：`/healthz` 是**经隧道**
   * 才打得进来的 —— 隧道一断，Manager 的心跳就进不来，自愈**永远不会被触发**（自己把自己锁死）。
   * ⇒ 必须由 **agent 本地定时器**驱动（下面 20s 一跳），`/healthz` 里再顺手做一次。
   */
  const healTunnel = async (): Promise<void> => {
    if (tunnel === undefined) return
    if (tunnelReady && (await tunnel.isMasterAlive())) return
    tunnelReady = false
    try {
      await tunnel.ensureMaster()
      tunnelReady = true
      console.error('[tunnel] master 失联 → 已重建（含静态转发）')
    } catch (err) {
      console.error('[tunnel] 重建失败，下轮再试：', err instanceof Error ? err.message : err)
    }
  }

  /**
   * **本 worker 此刻真的在管的实例端口**（对账口径的**唯一**来源）。
   *
   * 🔴 覆盖网络线 序 ㊽：必须是**两条腿的并集** ——
   *   ① `listUserInstances()` = 本进程 `launch` 过的（`LocalSpawner.mains`）；
   *   ② `adoptedInstancePorts()` = 本进程**认领**来的存量实例（⛔ 不进 `mains`，见其文件头 序 ㉕）。
   *
   * 只取 ① 就是本次实测的缺陷：worker 重启后 `mains` 空 ⇒ 上一进程遗留的实例端口**没人重新声明**，
   * relay 端点表里只留一条 `online=false` 的孤儿条目（实测 47 侧 `<host-b>:<worker-port-b>`）⇒ Manager 侧
   * `(hostId, port)` 翻译不出来。并进 ② 之后，`forward(port)` 会把那条孤儿**就地覆盖**成在线
   * （relay 侧 `ensureEndpoint` 复用既有条目、只换绑定会话，⛔ 不新开口、⛔ 不动白名单）。
   */
  const liveInstancePorts = async (): Promise<Set<number>> => {
    const live = new Set(
      (await spawner.listUserInstances()).map((i) => i.port).filter((p): p is number => p !== undefined),
    )
    for (const port of spawner.adoptedInstancePorts()) live.add(port)
    return live
  }

  /** 把活着的实例端口补齐、把已消失的撤掉（崩溃退出也走这里收敛，不必逐个挂 exit 钩子）。 */
  const reconcileTunnel = async (): Promise<void> => {
    if (tunnel === undefined || !tunnelReady) return
    const live = await liveInstancePorts()
    for (const port of live) await tunnel.forward(port)
    for (const port of tunnel.ports) {
      if (!live.has(port) && !staticPorts.includes(port)) await tunnel.cancel(port)
    }
  }

  /** 隧道一拍 = 自愈 ＋ 对账（序 ㊽：定时器与"认领落定"回调**共用同一份语义**，⛔ 不写第二套）。 */
  const tunnelTick = async (): Promise<void> => {
    await healTunnel()
    await reconcileTunnel()
  }

  let tunnelTimer: NodeJS.Timeout | undefined
  if (tunnel !== undefined) {
    void tunnel
      .ensureMaster()
      .then(() => {
        tunnelReady = true
      })
      .catch((err: unknown) => {
        console.error('[tunnel] 建立失败（跨机代理将不可用，本机功能不受影响）：', err instanceof Error ? err.message : err)
      })
    tunnelTimer = setInterval(() => {
      void tunnelTick()
    }, 20_000)
    tunnelTimer.unref?.()
    /**
     * 序 ㊽：**认领（rehydrate）落定即登记** —— ⛔ 不等 20 s 对账节拍。
     *
     * 认领来的存量实例端口**只有这一条路**会被声明给 relay（它们不进 `mains`）⇒ 若只靠 20 s
     * 定时器，重启后有一段"实例活着但中继查不到落点"的窗口；本回调把它压到探活落定的那一刻。
     * ⚠️ 定时器**保留**：它仍是断链自愈 / 端口漂移的兜底（回调只负责"起步那一拍"）。
     */
    spawner.onRehydrateSettled = () => {
      void tunnelTick()
    }
  }
  const app = Fastify({ logger: { level: options.logLevel ?? 'info' }, bodyLimit: MAX_PATCH_BYTES + 4096 })
  const cache: OpCache = { order: [], results: new Map() }
  /** agent 侧记住的 epoch（self-fencing 判据）。 */
  const epochs = new Map<string, number>()

  const remember = (op: string, value: unknown): void => {
    if (cache.results.has(op)) return
    cache.results.set(op, value)
    cache.order.push(op)
    while (cache.order.length > OP_CACHE_MAX) {
      const oldest = cache.order.shift()
      if (oldest !== undefined) cache.results.delete(oldest)
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz') return // 存活探测不带凭据
    const given = request.headers[AGENT_TOKEN_HEADER]
    const expected = options.token
    const a = Buffer.from(typeof given === 'string' ? given : '')
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/healthz', async () => {
    const instances = await spawner.listUserInstances()
    // 心跳里顺手自愈 + 对账（主驱动是本地定时器，见 healTunnel 的注释）
    await healTunnel()
    await reconcileTunnel()
    return {
      ok: true,
      hostId: options.hostId,
      instances: instances.length,
      tunnel: tunnel === undefined ? null : { ready: tunnelReady, ports: tunnel.ports },
    }
  })

  /** 对账用：**一次拿回整机**（设计 §11.6，替代逐用户查询）。 */
  app.get('/instances', async () => ({ instances: await spawner.listUserInstances() }))

  app.post('/launch', async (request, reply) => {
    const body = request.body as {
      userId?: string
      folder?: string
      patch?: string
      epoch?: number
      operationId?: string
      apiKey?: string | null
      uid?: number
    }
    if (body.userId === undefined || body.operationId === undefined) {
      return reply.code(400).send({ error: 'userId and operationId are required' })
    }
    const cached = cache.results.get(body.operationId)
    if (cached !== undefined) return cached // 幂等回放
    // 先落凭据/uid/**epoch**（重放路径也安全：同值覆盖）。
    // ⚠️ epoch 记录的是「Manager 的意图」，因此必须在**尝试 spawn 之前**落 ——
    //    "实例本来就在跑"（AlreadyRunningError 分支）时也要记，否则 `/fence` 拿不到
    //    我的 epoch，self-fencing 就永远不触发（2026-09-15 T08 S3 实测踩到）。
    if (body.apiKey !== undefined && body.apiKey !== null) apiKeys.set(body.userId, body.apiKey)
    if (body.uid !== undefined) uids.set(body.userId, body.uid)
    if (body.epoch !== undefined) epochs.set(body.userId, body.epoch)
    // 建号必须先于 spawn：OS 账号缺席时 bwrap 里的 `setpriv --reuid` 会直接失败
    // （现象是"实例起不来"，不会报权限错）。幂等：已建过只对账属主；uid 被他人占用则 fail-loud。
    if (body.uid !== undefined) {
      try {
        ensureOsAccount(config, body.userId, body.uid)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: `provision-failed: ${why}` })
      }
    }
    try {
      const instance = await spawner.launch(body.userId, body.folder ?? '', body.patch)
      // 跨机：把该实例端口经隧道打到 Manager 侧（失败不阻断 —— 本机仍可用）
      if (tunnel !== undefined && tunnelReady && instance.port !== undefined) await tunnel.forward(instance.port)
      const payload = { instance: { ...instance, launchToken: spawner.launchTokenOf(body.userId) } }
      remember(body.operationId, payload)
      return payload
    } catch (err) {
      // 已在跑：**返回现有实例**而不是报错 —— 这让重试天然安全（与 AlreadyRunningError 语义对齐）。
      const msg = err instanceof Error ? err.message : String(err)
      if (/already has a running/i.test(msg)) {
        const currents = await spawner.listUserInstances()
        const found = currents.find((i) => i.userId === body.userId)
        if (found !== undefined) {
          const payload = { instance: { ...found, launchToken: spawner.launchTokenOf(body.userId) }, note: 'already-running' }
          remember(body.operationId, payload)
          return payload
        }
      }
      return reply.code(500).send({ error: msg })
    }
  })

  app.post('/stop', async (request, reply) => {
    const body = request.body as { userId?: string; operationId?: string }
    if (body.userId === undefined || body.operationId === undefined) {
      return reply.code(400).send({ error: 'userId and operationId are required' })
    }
    const cached = cache.results.get(body.operationId)
    if (cached !== undefined) return cached
    const before = await spawner.status(body.userId)
    await spawner.stop(body.userId)
    if (tunnel !== undefined && tunnelReady && before.main?.port !== undefined) await tunnel.cancel(before.main.port)
    epochs.delete(body.userId)
    apiKeys.delete(body.userId) // 凭据只该活在实例生命周期内
    const payload = { ok: true }
    remember(body.operationId, payload)
    return payload
  })

  app.get('/status/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const status = await spawner.status(userId)
    return reply.send({ userId, main: status.main ?? null })
  })

  /** 代理目标（Manager 用）。未运行时返回 `{ running: false }`。 */
  app.get('/endpoint/:userId', async (request) => {
    const { userId } = request.params as { userId: string }
    const endpoint = await spawner.endpointFor(userId)
    return endpoint === undefined
      ? { running: false }
      : { running: true, host: options.instanceHost ?? '127.0.0.1', port: endpoint.port }
  })

  /** self-fencing：我持有的 epoch 落后于 Manager 下发的值 ⇒ **自杀**。 */
  app.post('/fence', async (request, reply) => {
    const body = request.body as { userId?: string; epoch?: number }
    if (body.userId === undefined || body.epoch === undefined) {
      return reply.code(400).send({ error: 'userId and epoch are required' })
    }
    const mine = epochs.get(body.userId)
    if (mine === undefined || mine >= body.epoch) return { fenced: false, mine: mine ?? null }
    await spawner.stop(body.userId)
    epochs.delete(body.userId)
    return { fenced: true, mine }
  })

  app.post('/restart-probe/:userId', async (request) => {
    const { userId } = request.params as { userId: string }
    return spawner.restartAndProbe(userId)
  })

  /**
   * 活动信号转发（Manager 代理到用户流量时调用）。
   * 为什么要转发：idle-reap 是**本地语义**（`LocalSpawner` 的 `lastActive` + TTL/LRU），
   * 不转发的话 worker 会以为实例一直没人用、把它回收掉。
   */
  app.post('/touch/:userId', async (request) => {
    const { userId } = request.params as { userId: string }
    spawner.touch(userId)
    return { ok: true }
  })

  app.post('/watchdog/:userId', async (request) => {
    const { userId } = request.params as { userId: string }
    return { instance: (await spawner.spawnWatchdog(userId)) ?? null }
  })

  // ── 文件面（T08 S5；供 Manager 的 RemoteUserFs 调用）──────────────────────
  // 请求体/响应都是**工作区相对路径 + base64**，与 `UserFs` 的语义一一对应；
  // 失败时回 `{error: code}` 并把 `UserFsError.code` 映射成对应 HTTP 状态
  // —— 这正是 `user-fs.ts` 里那个 seam 设计的用法（路由按 code 回给前端）。

  /** 统一包装：把 `UserFsError` 还原成 wire 形态（其余错误 → 500）。 */
  const fsCall = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof UserFsError) {
        await reply.code(err.status).send({ error: err.code })
        return undefined
      }
      const msg = err instanceof Error ? err.message : String(err)
      await reply.code(500).send({ error: 'internal', detail: msg.slice(0, 200) })
      return undefined
    }
  }

  app.post('/fs/init', async (request, reply) => {
    const body = request.body as { userId?: string; uid?: number }
    if (body.userId === undefined) return reply.code(400).send({ error: 'userId is required' })
    return (await fsCall(reply, async () => {
      await userFs.initUserRoot(body.userId as string, body.uid)
      return { ok: true }
    })) ?? reply
  })

  app.post('/fs/list', async (request, reply) => {
    const body = request.body as { userId?: string; relPath?: string }
    if (body.userId === undefined) return reply.code(400).send({ error: 'userId is required' })
    return (await fsCall(reply, () => userFs.listDir(body.userId as string, body.relPath ?? ''))) ?? reply
  })

  app.post('/fs/mkdir', async (request, reply) => {
    const body = request.body as { userId?: string; relPath?: string }
    if (body.userId === undefined) return reply.code(400).send({ error: 'userId is required' })
    return (await fsCall(reply, async () => {
      await userFs.mkdir(body.userId as string, body.relPath ?? '')
      return { ok: true }
    })) ?? reply
  })

  app.post('/fs/create', async (request, reply) => {
    const body = request.body as { userId?: string; relPath?: string; name?: string; type?: 'file' | 'dir' }
    if (body.userId === undefined || body.name === undefined) {
      return reply.code(400).send({ error: 'userId and name are required' })
    }
    // ⚠️ 必须包成对象：`createEntry` 返回的是字符串（净化后的文件名），直接 return 会被
    // Fastify 当 text/plain 发出，而调用方（RemoteUserFs）按 JSON 解析 ⇒ 静默 500。
    const created = await fsCall(reply, () =>
      userFs.createEntry(body.userId as string, body.relPath ?? '', body.name as string, body.type ?? 'file'),
    )
    return created === undefined ? reply : { name: created }
  })

  app.post('/fs/upload', async (request, reply) => {
    const body = request.body as { userId?: string; relPath?: string; name?: string; dataBase64?: string }
    if (body.userId === undefined || body.name === undefined || body.dataBase64 === undefined) {
      return reply.code(400).send({ error: 'userId, name and dataBase64 are required' })
    }
    // 同上：`upload` 返回的是净化后的文件名，必须包成对象。
    const uploaded = await fsCall(reply, () =>
      userFs.upload(
        body.userId as string,
        body.relPath ?? '',
        body.name as string,
        Buffer.from(body.dataBase64 as string, 'base64'),
      ),
    )
    return uploaded === undefined ? reply : { name: uploaded }
  })

  app.post('/fs/read', async (request, reply) => {
    const body = request.body as { userId?: string; relPath?: string; maxBytes?: number }
    if (body.userId === undefined || body.relPath === undefined) {
      return reply.code(400).send({ error: 'userId and relPath are required' })
    }
    const out = await fsCall(reply, () => userFs.readFile(body.userId as string, body.relPath as string, body.maxBytes))
    if (out === undefined) return reply
    return { name: out.name, dataBase64: out.data.toString('base64') }
  })

  app.post('/fs/isdir', async (request, reply) => {
    const body = request.body as { userId?: string; relPath?: string }
    if (body.userId === undefined) return reply.code(400).send({ error: 'userId is required' })
    const out = await fsCall(reply, () => userFs.isDirectory(body.userId as string, body.relPath ?? ''))
    return out === undefined ? reply : { isDirectory: out }
  })

  app.post('/fs/plugins', async (request, reply) => {
    const body = request.body as { userId?: string }
    if (body.userId === undefined) return reply.code(400).send({ error: 'userId is required' })
    return (await fsCall(reply, () => userFs.listInstalledPlugins(body.userId as string))) ?? reply
  })

  app.post('/fs/handoff', async (request, reply) => {
    const body = request.body as { userId?: string; content?: string }
    if (body.userId === undefined || body.content === undefined) {
      return reply.code(400).send({ error: 'userId and content are required' })
    }
    return (await fsCall(reply, async () => {
      await userFs.writeHandoff(body.userId as string, body.content as string)
      return { ok: true }
    })) ?? reply
  })

  /**
   * **home 下的平台托管配置文件**读—— 为什么必须由 worker 提供：
   * 用户卷（含 `home/`）在**本机**，控制面（Manager）隔着网络 ⇒ 它直接读只会读到
   * 自己盘上一个不存在的路径（返回空串、还不报错 ⇒ 静默空操作）。
   *
   * ⛔ 只收**裸文件名**且必须在白名单里（`settings.yaml` / `.credentials.yaml`）：
   * 这是"平台写自己的两个配置文件"，⛔ 不是"给远端一个任意文件读接口"。
   * 越界/非法名一律 400 `bad_path`。
   */
  app.post('/fs/home-read', async (request, reply) => {
    const body = request.body as { userId?: string; name?: unknown }
    if (body.userId === undefined) return reply.code(400).send({ error: 'userId is required' })
    if (!isHomeFileName(body.name)) return reply.code(400).send({ error: 'bad_path' })
    const out = await fsCall(reply, () => userFs.readHomeFile(body.userId as string, body.name as HomeFileName))
    return out === undefined ? reply : { text: out }
  })

  app.post('/fs/home-write', async (request, reply) => {
    const body = request.body as { userId?: string; name?: unknown; text?: unknown }
    if (body.userId === undefined || typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'userId and text are required' })
    }
    if (!isHomeFileName(body.name)) return reply.code(400).send({ error: 'bad_path' })
    return (await fsCall(reply, async () => {
      await userFs.writeHomeFile(body.userId as string, body.name as HomeFileName, body.text as string)
      return { ok: true }
    })) ?? reply
  })

  /** 本机 dataRoot（Manager 的 RemoteUserFs 用它做 `resolvePath` 的路径数学）。 */
  app.get('/fs/root', async () => ({ dataRoot: config.dataRoot }))

  app.get('/', async () => ({ agent: 'dsh_ai1net-worker', hostId: options.hostId }))

  return {
    app,
    spawner,
    /**
     * 停机：**先收实例、再关 HTTP**。
     * 为什么必须收：实例是 worker 自己的子进程，停机不收就变孤儿（占用端口与内存）；
     * 而且孤儿会继承 stdout ⇒ 调用方的管道永不关闭（2026-09-15 实测：verify 脚本挂死）。
     * 归属与租约由 Manager 侧处理（worker 不写控制面数据），所以这里只停进程。
     */
    stop: async (): Promise<void> => {
      if (tunnelTimer !== undefined) clearInterval(tunnelTimer)
      await app.close()
      await spawner.teardown()
      await tunnel?.close()
    },
  }
}
