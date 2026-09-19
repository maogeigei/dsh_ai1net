/**
 * Fastify bootstrap: assembles the HTTP server, registers plugins and routes,
 * and owns the DB lifecycle via the close hook.
 * @module dsh_ai1net/web/server
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { ServerConfig } from '../config.js'
import { createDbAdapter, type CredentialLandingRow, type DbAdapter, type PublicUser } from '../db/index.js'
import { createUserFs } from '../fs/provider.js'
import { RemoteUserFs } from '../fs/remote-user-fs.js'
import type { UserFs } from '../fs/user-fs.js'
import { decrypt, deriveKey } from '../crypto.js'
import { hashUid } from '../isolation.js'
import { addressPort, agentBaseUrlOf, parseReachability, VIA_MANAGER_SSH } from '../net/reachability.js'
import { LocalRendezvous, ManagerSshRendezvous, RendezvousRegistry } from '../net/rendezvous.js'
import { OPS_NETWORK, logicalName } from '../net/relay/network.js'
import { RelayRendezvous } from '../net/relay/rendezvous.js'
import { RelayDialer } from '../net/relay/dialer.js'
import { listOverlayRelayCandidates, resolveOverlayRelay } from '../net/relay/directory.js'
import type { OverlayRelayCandidates } from '../net/relay/directory.js'
import { RelayClient, waitUpOnStatus } from '../net/relay/client.js'
import { RelayCandidateObservation, candidateObsMs } from '../worker/relay-tunnel.js'
import { hostNameIndex, relayEndpointTarget } from '../net/relay/endpoint-target.js'
import { loadClientIdentity } from '../net/relay/identity.js'
import { RelayFailoverSupervisor, relayFailoverThresholds } from '../net/relay/switcher.js'
import type { RelayChannelHandle } from '../net/relay/switcher.js'
// ── 内容分发（块级内容寻址 · 同网段 peer 优先）────────────────────────────
// ⛔ 装配仅"接线"，不改 presence / 端点翻译 / 切流既有逻辑（设计文档 §3.1）。
import { ContentStore } from '../net/relay/content/store.js'
import { ContentSourceChain } from '../net/relay/content/source.js'
import { ContentPeerGroup } from '../net/relay/content/peer.js'
// 🆕 单 B：组密钥装载（平台侧**缺省不启用**；具名失败 ⇒ 不启用并留痕）
import { openContentCipher } from '../net/relay/content/crypto.js'
import { LocalSpawner } from '../supervisor/orchestrator.js'
import { LeasedSpawner } from '../supervisor/leased-spawner.js'
import { RemoteSpawner, type ClusterHost } from '../supervisor/remote-spawner.js'
import { registerDshProxy } from '../supervisor/proxy.js'
import type { Spawner } from '../supervisor/spawner.js'
import {
  BUILTIN_REF,
  normalizeProtocol,
  parseModels,
  readRefValue,
  reconcileCredentials,
  reconcileSettings,
  refForEntry,
  type SettingsEntry,
} from './model-landing.js'
import { backupHomeFile } from './home-files.js'
import { stateDir } from '../platform-paths.js'
import { rateLimit } from './middleware/rate-limit.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { adminUserOpsRoutes } from './routes/admin-user-ops.js'
import { businessPluginRoutes } from './routes/business-plugins.js'
import { desktopRoutes } from './routes/desktop.js'
import { dshRoutes } from './routes/dsh.js'
import { domainRoutes } from './routes/domain.js'
import { overlayRoutes } from './routes/overlay.js'
import { overlayNodeRoutes } from './routes/overlay-nodes.js'
import { skillRoutes } from './routes/skills.js'
import { whitelistRoutes } from './routes/whitelist.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DbAdapter
    config: ServerConfig
    supervisor: Spawner
    userFs: UserFs
  }
  interface FastifyRequest {
    user: PublicUser | null
  }
}

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web')

/* ── 覆盖网络 R3：relay 状态视图的三个时间常数（都在 Manager 本地回环上，量级取"秒"）── */
/** 单次 `/status` 查询超时。relay 在回环上 ⇒ 超过这个数就是它卡了，不值得等。 */
const RELAY_STATUS_TIMEOUT_MS = 2000
/** 轮询间隔。取 5s：`dsh_hosts` 目录本身 TTL 是 30s，比它更密即可。 */
const RELAY_STATUS_POLL_MS = 5000
/** 快照陈旧阈值：超过它一律认为 relay 视图不可信 ⇒ `relay` 实现退回 `manager-ssh`。 */
const RELAY_SNAPSHOT_TTL_MS = 15000

/* ── 覆盖网络 P0-2：引导目录的后台刷新节奏 ── */
/** 首次刷新延迟。**必须 > 0**：控制面自己既是目录服务端又是客户端，启动瞬间自己的 3080 还没 listen。 */
const OVERLAY_REFRESH_FIRST_MS = 15000
/** 刷新周期下限（目录给的 `refreshAfterSeconds` 更小也按它兜底，避免退化成"每秒取一次"）。 */
const OVERLAY_REFRESH_MIN_MS = 60000

/** Whether an `Origin` header belongs to the platform base domain (or a
 * per-user subdomain of it). Used to allow cross-subdomain API calls from dsh
 * instances (功能插件启停). */
function isAllowedOrigin(origin: string, baseDomain: string): boolean {
  if (baseDomain === '') return false
  try {
    const host = new URL(origin).hostname
    return host === baseDomain || host.endsWith('.' + baseDomain)
  } catch {
    return false
  }
}

/**
 * Build a fully-wired Fastify instance. Does not call `listen`; the caller owns
 * bind + shutdown.
 * @param config - resolved runtime configuration.
 */
export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const db = await createDbAdapter(config)
  const encryptionKey = deriveKey(config.encryptionSecret)
  // ── 模型条目落地（＋ 138）────────────────────────────────────────────
  //   用户口径（2026-09-13 定）：条目**各自开关、可同时启用**；admin 配的**平台共享模型
  //   **也列入**、用户可开关（`users.shared_model_enabled`）；平台只负责把「**已启用**」
  //   的都配好 —— 具体用哪个模型在 dsh 对话框的模型选择器里挑。
  //
  //   🔴 2026-09-19 追加门禁：平台共享模型**不再是"人人默认可用"** ——
  //   admin 必须在**用户列表**里逐个开启（`users.shared_model_granted`，v11，默认关闭），
  //   用户才能用（也才会在「设置 → 模型设置」里看到那一块）。
  //   ⇒ 落地判据 = `granted ∧ enabled`（两个开关分属**不同的人**：前者 admin，后者用户）。
  //
  //   为什么必须由平台写文件：官方「设置 → 模型」页在平台环境**必然报错**（该页要 Host
  //   settings 镜像，而平台是浏览器经域名访问远程服务器 ⇒ `isLoopback=false` ⇒ persistence
  //   降级 `memory` ⇒ 页面报「加载提供方目录失败」）。详见 `ensure-role-profile-patch.cjs`。
  //
  //   为什么**仍然不注入 env**（2026-09-13 读官方源码定的）：dsh 凭据解析顺序是
  //   `inherited process environment (read-only, wins) > $DSH_HOME/.credentials.yaml > …`，
  //   且 `dsh-credentials-local.write()` 里有 `assertUnshadowed()` —— 只要 env 存在同名 ref，
  //   保存就报错（"supplied read-only by the launching environment …"）⇒ 注入 env 等于
  //   **把用户锁死在"不能自配 key"**。所以共享 key 改成**预置进凭据文件**，本函数恒返回 null。
  //
  //   落地两处（字段名 2026-09-13 读官方包实测，勿凭记忆改 —— 见 model-landing.ts 头注释）：
  //     · `$DSH_HOME/.credentials.yaml` 的 `refs.<REF>`
  //     · `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<route>`
  //
  //   ⛔ 备份**绝不能落在用户 home 里**：dsh 用 chokidar watch 整个 home，一个**实例读不了**
  //   的文件（root 属主 600）会让它抛 `EACCES` ⇒ **实例崩溃循环**（2026-09-13 实测踩过，
  //   当时 .credentials.yaml.bak-platform 直接把 guest 打进 attempt=5）。
  interface Managed {
    refs: string[]
    routes: string[]
  }
  /** 托管清单落点：**平台状态目录**（不在 home、也不在文档库）。 */
  const managedDir = join(stateDir(), 'model-landing')
  /** 只有清单里的 ref / route 才允许被平台改写或删除 —— 用户自己配的一律不碰。 */
  const readManaged = async (userId: string): Promise<Managed> => {
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    try {
      const raw = JSON.parse(await readFile(join(managedDir, userId + '.json'), 'utf8')) as Record<string, unknown>
      return { refs: strs(raw.refs), routes: strs(raw.routes) }
    } catch {
      return { refs: [], routes: [] } // 不存在 / 读坏 ⇒ 视为"平台还没管过任何东西"（保守）
    }
  }
  const writeManaged = async (userId: string, m: Managed): Promise<void> => {
    await mkdir(managedDir, { recursive: true })
    await writeFile(join(managedDir, userId + '.json'), JSON.stringify(m), { mode: 0o600 })
  }
  // `readTextOrEmpty` / `writeHomeFile` 已抽到 `./home-files.js`（2026-09-15：语言偏好
  // 持久化也要用同一套「写 home 文件」语义 —— 与其复制一份，不如共用；约束见该模块头注释）。

  /**
   * 平台共享条目（admin 配的、已启用的那些）—— 三条件**全满足**才纳入：
   *   ① **管理员已授权**该用户（v11，默认关闭，只能由 admin 在用户列表里开）
   *   ② **用户自己没有关掉**（用户侧偏好）
   *   ③ 该用户**不是那个 admin 本人**（admin 用的是他自己配的，再回落一次等于重复）
   *
   * ①② 是**两个不同的人的两个开关**，缺一不给 —— 判据是"生效 = 门禁 ∧ 偏好"，
   * ⛔ 别把任意一个当成"可以覆盖另一个"。
   */
  const sharedLandingRows = async (userId: string): Promise<CredentialLandingRow[]> => {
    if (!(await db.getSharedModelGranted(userId))) return []
    if (!(await db.getSharedModelEnabled(userId))) return []
    const admins = (await db.listPublicUsers()).filter((u) => u.role === 'admin')
    if (admins.length === 0 || admins[0].id === userId) return []
    return db.listCredentialLandingRows(admins[0].id)
  }

  /**
   * 把「已启用条目」对账进实例的两个配置文件。**幂等**，且只在真有变化时写盘。
   * 合并顺序 = **自己的在前** ⇒ 同一个 ref 上，用户自己配的 key 永远赢过平台共享的那把。
   */
  const landModels = async (userId: string): Promise<void> => {
    const owner = await db.findUserById(userId)
    if (owner === undefined) return
    const previous = await readManaged(userId)
    const rows = [...(await db.listCredentialLandingRows(userId)), ...(await sharedLandingRows(userId))]
    const seen = new Set<string>()
    const creds: Array<{ ref: string; value: string }> = []
    const providers: SettingsEntry[] = []
    for (const row of rows) {
      const ref = refForEntry({ route: row.route, baseUrl: row.baseUrl })
      if (seen.has(ref)) continue
      let value: string
      try {
        value = decrypt(row.encryptedRef, encryptionKey)
      } catch {
        // 解不开的条目跳过：宁可少配一个厂家，也不能让整次 spawn 失败。
        console.error('model landing: 解不开的条目已跳过', { userId, name: row.name })
        continue
      }
      seen.add(ref)
      creds.push({ ref, value })
      // 有 route 才写 settings.yaml。两种情形：
      //   · **目录厂家**（route 命中官方 pi-ai catalog，baseUrl 为空）⇒ 只写 `apiKeyEnv`，
      //     endpoint / 协议 / 模型目录全由官方目录提供（补做）。
      //   · **自定义厂家**（baseUrl 非空）⇒ endpoint + 协议 + 模型清单必须齐全。
      // 内置 DeepSeek 没有 route ⇒ 只写 `refs.DEEPSEEK_API_KEY`，不进 settings.yaml。
      const route = row.route ?? ''
      if (route !== '') {
        if (row.baseUrl === null || row.baseUrl === '') {
          providers.push({ route, apiKeyEnv: ref })
        } else {
          providers.push({
            route,
            apiKeyEnv: ref,
            baseURL: row.baseUrl,
            api: normalizeProtocol(row.api),
            models: parseModels(row.models),
          })
        }
      }
    }
    // 🔴 读写**必须走 `userFs`**—— 用户卷跟着实例走：实例在 worker 上时
    //    `home/` 就在那台机。原先这里直接 `join(owner.home_dir, …)` + 本机 fs ⇒
    //    控制面读到自己盘上一个不存在的路径（**空串、不报错**）⇒ 落地静默变成空操作：
    //    托管清单被清空、目标文件一个字节没动（2026-09-19 实测，guest 就是这种用户）。
    //    `userFs` 的归属与本 seam 其它方法**同一份**粘性选机（`hostIdForFile`）⇒
    //    "落地与实例同机"由这条路由保证，⛔ 别在这里自己拼路径。
    const credText = (await userFs.readHomeFile(userId, '.credentials.yaml')) ?? ''
    const setText = (await userFs.readHomeFile(userId, 'settings.yaml')) ?? ''
    // 一次性交接：老实现把平台共享 key 写进 `refs.DEEPSEEK_API_KEY` 时没有托管清单，
    // 新逻辑会把它当成"用户自己写的" ⇒ 关掉共享开关后那行仍留着（"关掉即生效"不成立）。
    // 首次运行（没有任何清单）且**文件里那行确实等于平台共享 key 明文**时，认领它；
    // 不相等 = 用户自己配的 ⇒ 绝不碰。
    let prevRefs = previous.refs
    if (previous.refs.length === 0 && previous.routes.length === 0) {
      if (readRefValue(credText, BUILTIN_REF) !== null) {
        const shared = await sharedDeepseekKey()
        if (shared !== null && shared === readRefValue(credText, BUILTIN_REF)) prevRefs = [BUILTIN_REF]
      }
    }
    const nextCred = reconcileCredentials(credText, creds, prevRefs)
    const nextSet = reconcileSettings(setText, providers, previous.routes)
    // 备份在**平台侧**做（旧文本就在手上），写入走 `userFs`（可能落到远端那台机）。
    if (nextCred.text !== credText) {
      await backupHomeFile(owner.home_dir, '.credentials.yaml', credText)
      await userFs.writeHomeFile(userId, '.credentials.yaml', nextCred.text)
    }
    if (nextSet.text !== setText) {
      await backupHomeFile(owner.home_dir, 'settings.yaml', setText)
      await userFs.writeHomeFile(userId, 'settings.yaml', nextSet.text)
    }
    await writeManaged(userId, { refs: nextCred.managed, routes: nextSet.managed })
  }

  /**
   * 平台共享的那把内置 DeepSeek key 明文。
   *
   * 🔴 **本函数刻意不判门禁**（踩过）：它有两个用途，其中一个**不该**被判。
   *   ① 「一次性交接」用它**认领**老实现写下的那一行（判断"这行是不是平台自己写的"）
   *      —— 这是**归属判据**，与"该用户现在有没有授权"无关。若在这里判门禁，被撤销授权的
   *      用户反而**认领不出来** ⇒ 那行永远删不掉 ⇒ "关掉即生效"不成立（红腿实测到了）。
   *   ② 写配置失败时退回 env 注入的保底值 —— 这一路**必须**判门禁，判在**调用点**
   *      （`resolveApiKey` 里），⛔ 别挪回这里。
   */
  const sharedDeepseekKey = async (): Promise<string | null> => {
    const admins = (await db.listPublicUsers()).filter((u) => u.role === 'admin')
    if (admins.length === 0) return null
    const ref = await db.getEnabledCredentialKeyRef(admins[0].id)
    if (ref === null) return null
    try {
      return decrypt(ref, encryptionKey)
    } catch {
      return null // 密文坏了 ⇒ 当作没配，等 admin 重填
    }
  }

  /**
   * 「该给实例注入什么 env」的答案：**什么也不注入**（恒 `null`）。
   * 保留函数名与签名是因为 `Spawner` 的接口就是这么定义的（见上面那段大注释：注入 env 会把
   * 用户在模型页的保存打回错误）。写配置失败时**退回 env 注入保底** —— 宁可让用户暂时用
   * 平台共享 key，也不能因为写文件出错就让实例起不来。
   */
  const resolveApiKey = async (userId: string): Promise<string | null> => {
    try {
      await landModels(userId)
      return null
    } catch (err) {
      console.error('model landing failed, falling back to env injection', err)
      // 🔴 **门禁判在这里**（不能挪进 `sharedDeepseekKey`）：这是"落地失败"的应急路，
      //    不判就等于给未授权用户在异常路径上开门 —— 门禁类判据一律失败关闭。
      if (!(await db.getSharedModelGranted(userId))) return null
      if (!(await db.getSharedModelEnabled(userId))) return null
      const admins = (await db.listPublicUsers()).filter((u) => u.role === 'admin')
      if (admins.length === 0 || admins[0].id === userId) return null
      return await sharedDeepseekKey()
    }
  }
  const resolveUid = async (userId: string): Promise<number> => {
    const user = await db.findUserById(userId)
    return user?.uid ?? hashUid(userId, config.baseUid)
  }
  // cluster 模式（T08 S3/S4）：实例在 worker 上，Manager 只投递操作 + 代理。
  // fail-loud：没配 agent 地址就直接报错，别等第一个用户点进来才发现。
  if (config.deployMode === 'cluster' && config.clusterAgentUrl === '') {
    throw new Error('deployMode=cluster requires DSH_AI1NET_CLUSTER_AGENT_URL (e.g. http://127.0.0.1:9000)')
  }
  // cluster：RemoteSpawner（传输）+ LeasedSpawner（**归属租约**）——
  // 后者保证"能不能拉起先问归属"，这是多机下防双写同一个 home 的承重件（设计 §3.2）。
  let leased: LeasedSpawner | undefined
  // ── 多 worker 的 host 目录（T08 S6）────────────────────────────────────
  // 由 `dsh_hosts` 派生并**随用随刷新**（TTL 30 s）⇒ **新增 worker 不必重启 Manager**。
  // 同时供三处使用：RemoteSpawner 的按 host 路由、LeasedSpawner 的 fence 目标、
  // 以及 `selectHost` 的容量准入 —— 都读**同一份**内存目录，避免三套各自漂移。
  const hostDirectory = new Map<string, ClusterHost>()
  hostDirectory.set(config.clusterHostId, {
    hostId: config.clusterHostId,
    agentUrl: config.clusterAgentUrl,
    token: config.clusterAgentToken,
    instanceHost: config.clusterInstanceHost,
  })
  /**
   * 会合解析（覆盖网络 S2）：**`via` → `Rendezvous` 实现 → `Reachability`**。
   *
   * 为什么要有这一层：`endpoint` 只说得清"拨哪个地址"，说不清"**经谁**" —— 而现网两条
   * 记录的 endpoint 恰好**字符串同形、语义不同**（`<host-a>` 同机直连 / `<host-b>` 隧道落点）。
   * `via` 列把"经谁"显式化 ⇒ 换中继 / 会合时不必改表语义（会合中继拆分方案 §2 C3）。
   *
   * ⚠️ **S2 阶段行为零变化**：两种现役实现的 `resolve()` 都只把 endpoint 拆成
   * `{scheme, address}`，`agentBaseUrlOf()` 拼回来与旧 `agentUrl` **逐字相等**
   * （判据写死在 the regression suite，不靠肉眼比）。
   *
   * 🔑 **键是逻辑名** `<network>/<hostId>`（P0-3）—— 网络维度是**结构性**的，控制面的每一张
   * 内存表都必须带着它；只按裸 hostId 建键时，两张网的同名 host 会**互相覆盖**（静默串网）。
   */
  const hostAddresses = new Map<string, string>()
  /**
   * 每台 host 的 **agent 端口**（从 `dsh_hosts.endpoint` 剥出来的那个号码）。
   *
   * 为什么需要（覆盖网络 R3）：relay 为**每个注册端口**在它自己的回环上开一条监听，回环口号
   * 由 `listen(0)` **动态分配**（实测 42067）⇒ Manager 既拿不到也推不出，只能拿「要拨的端口号」
   * 去 relay 的 `/status` 里查回环口号。而 agent 端口与 ssh 隧道落点**同号**（隧道就是同号反向
   * 转发，见 `worker/tunnel.ts#forward`）⇒ 这个号码现有表里就有，**不需要新增列**。
   *
   * 🔑 **键是逻辑名**（P0-3），与 `hostAddresses` 同口径。
   */
  const hostAgentPorts = new Map<string, number>()
  /**
   * 每台 host **表里声明的会合形态**（`dsh_hosts.via` 原文），与 `reachability` 分开存。
   *
   * 为什么不能用 `reachability` 反推（R4 实测教训）：`Reachability` 是**实时解析结果**，
   * host 离线 / relay 快照陈旧时 `resolve()` 会回 `undefined`。若此时按"不是 relay ⇒ 原样透传"
   * 处理，就会把 **Worker 侧口号**打到 Manager 本机（连接被拒、空响应、无日志）。
   * ⇒ 「这台该走哪种会合」必须读**表里的静态声明**；「此刻可拨到什么地址」才读 `reachability`。
   *
   * 🔑 **键是逻辑名**（P0-3），与 `hostAddresses` 同口径。
   */
  const hostVia = new Map<string, string>()
  /**
   * **`hostId` → 逻辑名** 索引（P-2）—— `translateEndpoint` 的**唯一入口**。
   *
   * 🔑 为什么必须有它：`RemoteSpawner` 调翻译器时只给得到**裸 hostId**
   * （`endpointFor` → `translateEndpoint(host.hostId, raw)`），而上面每张表的键都是**逻辑名**
   * ⇒ 直接拿 hostId 去查恒 `undefined` ⇒ 翻译**从未生效**（整个闭包成了死分支，在册缺陷 P-2）。
   * 映射公式只在 `hostNameIndex` 里写一份（⛔ 不在闭包里再写第二份）。
   */
  const hostNameById = new Map<string, string>()
  /**
   * relay 的实时视图（覆盖网络 R3）：`<network>/<hostId>:<port>` → `{ localPort, online }`。
   *
   * ⚠️ **键是逻辑名**（P0-3）：只按裸 hostId 建键时，两张网各有一台同名 host 会**互相覆盖**
   * —— 后刷进来的那张网把前一张的落点顶掉 ⇒ 请求被静默路由到**另一张网**的节点上
   * （这正是 Step 1 在 relay 侧修掉的病，控制面这一份当时还是旧的）。
   *
   * ⚠️ **只在刷新成功时整表替换**（不做增量合并）：relay 重启后回环口号会**全部重分配**，
   * 增量会把过期口号永远留在表里 ⇒ Manager 继续往一个已不存在的口上打。
   * 这正是 ssh 版「静默打到别人实例」的同一类病，不能在替代品里复现。
   * 刷新失败时**保留上一份**，靠 `relaySnapshotAt` 判陈旧（陈旧 ⇒ `online` 回 false ⇒ 自动回退 `manager-ssh`）。
   */
  const relayEndpoints = new Map<string, { localPort: number; online: boolean }>()
  let relaySnapshotAt = 0
  /**
   * 「当前通道的 `RelayClient`」的**延迟绑定**取值器。
   *
   * 🔑 存在的唯一理由是**初始化顺序**：`/status` 轮询的首次调用发生在拨号通道建立**之前**，
   * 那时 `failover` 还在 TDZ 里（直接引用会 `ReferenceError`）。而把 `failover` 提前声明成
   * `let` 又会丢掉"当前通道只有**一个**权威来源"这条纪律（为它专门收敛过）。
   * ⇒ 用一个可空函数引用，**谁都不破坏**。
   */
  let currentClientRef: (() => RelayClient | undefined) | undefined
  const currentClient = (): RelayClient | undefined => currentClientRef?.()
  /**
   * presence：**订阅是否新鲜** —— D5「主路径 / 兜底」的**唯一开关**。
   *
   * ⚠️ 必须是函数而不是布尔量：通道会被换址，"订阅有没有"随通道走 ⇒ 每次调用现读。
   * `undefined`（还没起通道 / 已切走）也算不新鲜 ⇒ 回退 `/status`，语义安全。
   */
  const presenceLive = (): boolean => currentClient()?.presenceFresh() === true
  /**
   * 订阅新鲜度变化的**可 grep 记录**（⛔ 别让"轮询停了"变成看不见的静默行为）。
   *
   * ⚠️ 这里直接写 stdout 而不用 `overlayLog`：本函数会在 `overlayLog` 初始化**之前**被首次
   * 调用（首次 `refreshRelay` 就在那一行 `void refreshRelay()`）⇒ 引用它同样会 TDZ。
   */
  let pollSuspended = false
  const notePollGate = (suspend: boolean): void => {
    if (suspend === pollSuspended) return
    pollSuspended = suspend
    process.stdout.write(
      suspend
        ? '[overlay-presence] 订阅新鲜 ⇒ `/status` 轮询**挂起**（兜底路径待命）\n'
        : '[overlay-presence] 订阅不新鲜 ⇒ `/status` 轮询**恢复**（兜底路径生效）\n',
    )
  }
  const refreshRelay = async (): Promise<void> => {
    if (config.relayStatusUrl === '') return
    /**
     * 🔑 **原有的核心收益点**：订阅生效期间**一次都不拉**（E-判据：稳态 `/status` 命中 = 0）。
     * ⛔ 不是"删掉轮询"（D5：`/status` 是回滚链的一环）—— 只是**在不需要时不拉**。
     */
    notePollGate(presenceLive())
    if (pollSuspended) return
    try {
      const res = await fetch(config.relayStatusUrl, { signal: AbortSignal.timeout(RELAY_STATUS_TIMEOUT_MS) })
      if (!res.ok) return
      const body = (await res.json()) as { endpoints?: unknown }
      const rows = Array.isArray(body.endpoints) ? body.endpoints : []
      const next = new Map<string, { localPort: number; online: boolean }>()
      for (const raw of rows) {
        const ep = raw as {
          hostId?: unknown
          network?: unknown
          port?: unknown
          localPort?: unknown
          online?: unknown
        }
        if (typeof ep.hostId !== 'string' || typeof ep.port !== 'number') continue
        if (typeof ep.localPort !== 'number' || ep.localPort <= 0) continue
        // `network` 缺失 = 老 relay（P0-1 之前）⇒ 按 `ops` 读（与 DB 的列默认值同口径）。
        const network = typeof ep.network === 'string' && ep.network !== '' ? ep.network : OPS_NETWORK
        next.set(`${logicalName(network, ep.hostId)}:${ep.port}`, {
          localPort: ep.localPort,
          online: ep.online === true,
        })
      }
      relayEndpoints.clear()
      for (const [k, v] of next) relayEndpoints.set(k, v)
      relaySnapshotAt = Date.now()
    } catch {
      // relay 不可达 / 超时 ⇒ **保留上一份快照**（临时抖动不抖路由），由陈旧判定兜底。
    }
  }
  if (config.relayStatusUrl !== '') {
    void refreshRelay()
    const relayTimer = setInterval(() => void refreshRelay(), RELAY_STATUS_POLL_MS)
    relayTimer.unref()
  }
  /**
   * 覆盖网络 R5：**Manager 侧拨号通道** —— 「会合可换机」的收口件（`会合中继拆分` §9.4 那个断点）。
   *
   * 配了 `DSH_AI1NET_RELAY_DIAL_SECRET` ⇒ Manager 也像 worker 一样**只拨出**一条 wss，并把落点建在
   * **自己的回环**上（`RelayDialer` 的预绑口池）⇒ **不再依赖 relay 主机的 `127.0.0.1`**，
   * relay 可以放在任何一台机器上（也可以多实例）。
   * 没配 ⇒ `relayDialer` 为 `undefined` ⇒ 全部回落到 `/status` 快照，**行为与 R3 完全一致**。
   *
   * 密钥必须是 64 位 hex（与 relay 密钥表同格式）。格式不对 ⇒ **不启用**并明确报一行 ——
   * 而不是带着一个坏密钥去反复握手失败（那会变成刷日志的噪音）。
   */
  /**
   * 覆盖网络 P0-2：**relay 地址走引导三级链**（env 显式 > 缓存目录 > 内置种子）。
   *
   * 为什么必须在这里改：`config.relayUrl` 只可能来自 env ⇒ 域名 / 机器一换，
   * **用户设备上的那个值我们改不到**，只能让所有人重装（`§A2` 点名的灾难）。
   * 引导链把地址变成"可在线轮换的下发物"；env 仍然**压制一切**（运维最后手段）。
   * 取不到（返回空串）⇒ 与"未配 relay"**完全同行为**（落回 `/status` 快照 / `manager-ssh`）。
   */
  const overlayLog = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  const relayResolved = await resolveOverlayRelay({
    envUrl: config.relayUrl,
    seeds: config.overlayBootstrapSeeds,
    trustedKeys: config.overlayDirTrustedKeys,
    cacheFile: config.overlayDirectoryCacheFile,
    log: overlayLog,
  })
  const relayUrl = relayResolved.url
  const dialLog = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  /** 拨号通道能不能起：地址有了 + 密钥是 64 位 hex。**任一条不满足 ⇒ 完全不启用**（与 R5 同语义）。 */
  const secretOk = /^[0-9a-f]{64}$/.test(config.relayDialSecret)
  const dialerEnabled = relayUrl !== '' && config.relayDialSecret !== '' && secretOk
  if (relayUrl !== '' && config.relayDialSecret !== '' && !secretOk) {
    dialLog('[relay-dialer] ⛔ DSH_AI1NET_RELAY_DIAL_SECRET 不是 64 位 hex ⇒ 拨号通道**不启用**（落回 /status 快照）')
  }
  /**
   * 起一条拨号通道。抽成函数是因为 P0-2 要在**运行期换址**（见下面的后台刷新）。
   *
   * **先建新的、成功了再关旧的**：新通道任何一步失败都直接返回 `undefined`、旧通道原样保留
   * —— 换址失败绝不能把"本来能用"的跨机通路打掉。
   */
  const startDialer = async (
    url: string,
  ): Promise<{ client: RelayClient; dialer: RelayDialer } | undefined> => {
    const client = new RelayClient({
      url,
      hostId: config.relayDialHost,
      secret: config.relayDialSecret,
      ports: [],
      dialer: true,
      /**
       * Manager 也是**一台机器**，同样要证明"被授权进入这张网"。
       * 与 worker 侧同一装配入口（`loadClientIdentity`）⇒ 两侧只有一种写法。
       */
      identity: loadClientIdentity({
        keyFile: config.overlayNodeKeyFile,
        grantFile: config.overlayNodeGrantFile,
        log: dialLog,
      }),
      log: dialLog,
    })
    client.start()
    const dialer = new RelayDialer({
      client,
      portBase: config.relayDialPortBase,
      portSpan: config.relayDialPortSpan,
      poolSize: config.relayDialPool,
      log: dialLog,
    })
    // **必须 await**：口池绑完之前 `localPortFor()` 恒返回 undefined（失败关闭）⇒
    // 不 await 就会在启动瞬间把"能给地址"缩成一个窗口期。
    try {
      await dialer.start()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      dialLog(`[relay-dialer] ⛔ 落点池绑定失败（${msg}）⇒ 本条通道放弃，已有通道不受影响`)
      try {
        dialer.close()
      } catch {
        /* 已关 */
      }
      client.stop()
      return undefined
    }
    /**
     * presence：**订阅本网全部在线态**（第 3 条：订阅式扇出）。
     *
     * ⚠️ 放在口池绑定**成功之后**：绑不上就等于这条通道没有，订阅了也没人消费，
     * 反而会留下"subs=1 但没人用"的假象。订阅失败不影响通道本身（自动回退 `/status`）。
     */
    client.subscribePresence()
    return { client, dialer }
  }
  /**
   * **通道句柄把 dialer 一起带着走** —— `relayDialer` 不再是一个独立可变量，
   * 而是"监管器当前通道"的投影。这样"当前是谁"只有**一个**权威来源，
   * ⛔ 不会出现"监管器已切到新通道、别处还拿着旧 dialer"的分叉。
   */
  type C1Handle = RelayChannelHandle & { dialer: RelayDialer; client: RelayClient }
  const toHandle = (
    url: string,
    started: { client: RelayClient; dialer: RelayDialer },
  ): C1Handle => ({
    url,
    dialer: started.dialer,
    client: started.client,
    health: () => {
      const st = started.client.status()
      return { state: st.state, attempts: st.attempts, unhealthyForMs: st.unhealthyForMs }
    },
    close: () => {
      try {
        started.dialer.close()
      } catch {
        /* 已关 */
      }
      try {
        started.client.stop()
      } catch {
        /* 已关 */
      }
    },
  })
  const overlayResolveOpts = (): Parameters<typeof listOverlayRelayCandidates>[0] => ({
    envUrl: config.relayUrl,
    seeds: config.overlayBootstrapSeeds,
    trustedKeys: config.overlayDirTrustedKeys,
    cacheFile: config.overlayDirectoryCacheFile,
    log: overlayLog,
  })
  /** 切流阈值（唯一一份默认值在 `switcher.ts`；这里只是取一份实例）。 */
  const failoverThresholds = relayFailoverThresholds()
  /**
   * ── **候选链取址的唯一入口（含只读观测）** ──
   *
   * 两处**既有**调用点（下面对监管器给的 `candidates` 与 {@link refreshOverlay}）共用本函数：
   * ① 候选**只在同一处**被解析 ⇒ ⛔ **不新增任何网络 I/O**（`refreshOverlay` 本来就要解析一次）；
   * ② 每次**真实**解析都落进观测 ⇒ 观测面不是"另做一次"的样子货（E3 的可断言面）。
   *
   * 🔴 **等价性证明（⛔ 语义零变化）**：`refreshOverlay` 原来调的是
   * `resolveOverlayRelay(overlayResolveOpts())` —— 该函数**未传 `exclude`**，而 `exclude` 缺省时
   * 它就是 `{url: chain.urls[0] ?? '', source: chain.source, detail: chain.detail, refreshAfterSeconds}`
   * 的**薄包装**（见 `directory.ts#resolveOverlayRelay`），且调用点**只用到 `url` 与 `source`**
   * ⇒ 这里取 `chain.urls[0] ?? ''` / `chain.source` **逐字等价**。
   * ⚠️ 若将来该调用点要用到 `exclude`，必须改回 `resolveOverlayRelay`（⛔ 不许在这里自己写排除逻辑）。
   */
  const candObs = new RelayCandidateObservation('manager', overlayLog, candidateObsMs())
  const resolveChain = async (): Promise<OverlayRelayCandidates> => {
    const got = await listOverlayRelayCandidates(overlayResolveOpts())
    candObs.record(got.urls, got.source, got.detail)
    return got
  }
  /**
   * 换址版等待：**非抛**，只回答"通没通"（`open` 要的是布尔）。
   *
   * 🔴 **RC-1（C1 装配点）**：实现已抽到 `net/relay/client.ts#waitUpOnStatus`
   * （三个装配点共用一份，D7）。相对改造前的**唯一**差别 = **终态失败（死候选）立即返回 `false`**，
   * ⛔ 不再白等满 `upTimeoutMs`。
   * ⚠️ 为什么这里最痛：生产目录前两条候选**同在 47**（见下面 `open` 的注释）⇒ 每次从 47 切走
   * **必然**先试同机的 `relay-direct`（已随 47 一起死）⇒ 白等 ≡ `upTimeoutMs`(12 000 ms)，
   * 实测两样本逐行复核（§2-P10）。**慢候选（连得上、只是 `up` 来得晚）不受影响**。
   */
  const waitUpOn = (client: RelayClient, timeoutMs: number): Promise<boolean> =>
    waitUpOnStatus(client, timeoutMs, {
      onDead: (st) =>
        overlayLog(
          `[relay-failover] ⛔ 新通道终态失败（state=${st.state} attempts=${st.attempts} ` +
            `burst=${st.inGracefulBurstWindow} lastError="${st.lastError ?? ''}"）⇒ 提前放弃，不等满 ${timeoutMs}ms`,
        ),
    })
  /**
   * **中继失败切流的唯一实现**（C1 装配点）。
   *
   * 触发信号全部复用现成状态机（D2）：`RelayClient.status()` 的 `state/attempts/unhealthyForMs`
   * ——⛔ 不新造心跳、不新增探测帧。
   */
  const failover = new RelayFailoverSupervisor({
    /**
     * ⚠️ **换址版的 `open` 比启动版严一档**：启动只要"口池绑好"（`startDialer` 的语义，
     * P0-2 要求启动不依赖网络）；**换址**必须等新通道真到 `up` ——
     * 否则会把"口池绑好了"误当成"通了"，切到一条**同样连不上**的中继上
     * （生产目录前两条候选落在同一台机器，这个坑一定会踩到）。
     * 到不了 `up` ⇒ 关掉它、返回 `undefined` ⇒ 监管器保持原通道并把该候选进冷却（D4 + 链推进）。
     */
    open: async (url) => {
      const started = await startDialer(url)
      if (started === undefined) return undefined
      if (!(await waitUpOn(started.client, failoverThresholds.upTimeoutMs))) {
        try {
          started.dialer.close()
        } catch {
          /* 已关 */
        }
        started.client.stop()
        return undefined
      }
      return toHandle(url, started)
    },
    /** 走 `resolveChain` ⇒ 每次解析都落进观测（`E3` 的可断言面）；返回值与原实现逐字一致。 */
    candidates: async () => (await resolveChain()).urls,
    log: overlayLog,
    thresholds: failoverThresholds,
  })
  /** 当前拨号通道（由监管器的"当前通道"派生 —— 单一权威来源）。 */
  const currentDialer = (): RelayDialer | undefined =>
    (failover.channel as C1Handle | undefined)?.dialer
  // 把「当前通道的 client」接上去（`presenceLive()` / `presenceOf()` 的取数入口）。
  currentClientRef = () => (failover.channel as C1Handle | undefined)?.client
  /**
   * **订阅推送**给出的在线态（主路径，D5）。
   *
   * 返回 `undefined` 的两种情况**都必须回退兜底**（⛔ 不许把它当 `false`）：
   * ① 订阅不新鲜（没订阅 / 已断 / 老 relay 不认 `SUB`）；② 这条 host 不在推送范围。
   * —— 把"不知道"当成"离线"会让**健康的节点被摘掉路由**（本线最贵的一类假红）。
   */
  const presenceOnline = (name: string): boolean | undefined => {
    const c = currentClient()
    if (c === undefined || !c.presenceFresh()) return undefined
    const e = c.presenceOf(name)
    return e === undefined ? undefined : e.online
  }
  /** 订阅里的**回环落点**（`/status` 的那份数据，改由推送带来；查不到 ⇒ `undefined` 交给下一级兜底）。 */
  const presenceLocalPort = (name: string, port: number): number | undefined => {
    const c = currentClient()
    if (c === undefined || !c.presenceFresh()) return undefined
    const hit = c.presenceOf(name)?.localPorts.find((lp) => lp.port === port)
    return hit === undefined || hit.localPort <= 0 ? undefined : hit.localPort
  }
  if (dialerEnabled) {
    const started = await startDialer(relayUrl)
    if (started !== undefined) failover.seed(toHandle(relayUrl, started))
    /**
     * 健康巡检**独立定时器**：目录刷新周期可能长达分钟级（`refreshAfterSeconds`），
     * 而故障切换要在 `RELAY_FAILOVER_DEADLINE_MS`（30 s）内完成 ⇒ 两者节奏必须分开。
     */
    failover.start()
    /**
     * 启动候选链**周期重发**（幂等、`unref()`、⛔ 零网络 I/O —— 只重发上次快照）。
     * 与监管器的关系：监管器**只在需要换址时**解析，而探针是**事后**读 ⇒ 没有它就可能读不到行。
     * ⚠️ 只在 `dialerEnabled` 时启动 —— 没有拨号通道就**不是 relay 客户端**，此时"候选数"无意义，
     * 观测行**应当缺席**（探针会把"该路径无观测行"判红并点名，⛔ 不制造一行假 `unresolved`）。
     */
    candObs.start()
  }
  /**
   * 覆盖网络 P0-2：**后台刷新目录**（启动后再取一次，之后按目录给的刷新周期）。
   *
   * 为什么不能在启动时"一次算完"：**控制面自己也是客户端**（47 同机既是目录签发方、又是
   * Manager）⇒ 启动那一刻自己的 3080 还没 `listen`，取目录必然 `502`；若就此定死，
   * Manager 就**永远**拿不到目录里 `relays[]` / `bootstrap[]` 的轮换结果（能力等于没有）。
   * 所以分成两步：**启动只用"缓存 / 种子"起来（启动不依赖网络）**，随后后台再取一次目录；
   * 地址**真的变了**才换通道（无变化时零动作、零日志噪音）。
   *
   * 换址动作统一走 {@link RelayFailoverSupervisor.replace}（"先建新、成功再关旧" +
   * 冷却表 + `[relay-switch]` 日志 + `switches` 计数），⛔ 不再在本函数里自己关旧通道。
   */
  const refreshOverlay = async (): Promise<void> => {
    if (!dialerEnabled) return
    /**
     * 改走 `resolveChain()` —— 与原 `resolveOverlayRelay(...)` **逐字等价**（证明见 `resolveChain`），
     * 但**每次目录刷新都落进候选观测** ⇒ Manager 侧观测行天然每 `refreshAfterSeconds` 更新一次
     * （⛔ 不需要为观测另加一次网络往返）。
     */
    const chain = await resolveChain()
    const nextUrl = chain.urls[0] ?? ''
    const cur = failover.channel?.url ?? relayUrl
    if (nextUrl === '' || nextUrl === cur) return
    overlayLog(`[overlay-dir] 🔁 目录给出的地址变了：${cur} -> ${nextUrl}（source=${chain.source}）⇒ 换拨号通道`)
    /**
     * （D1）：显式声明 `'directory'` —— 这条换址的触发条件（"目录里的地址变了"）与
     * "旧通道是否可用"**无关** ⇒ ⛔ **没有打破冷却的权力**（有的话，"当前站在 106、目录首位是 47"
     * 的每一轮巡检都会把刚冷却的 47 换回来 = 两位互相抢 = D5 想防的抖动风暴）。
     */
    await failover.replace(nextUrl, `目录地址变更（source=${chain.source}）`, 'directory')
  }
  if (dialerEnabled) {
    const first = setTimeout(() => void refreshOverlay(), OVERLAY_REFRESH_FIRST_MS)
    first.unref()
    const timer = setInterval(
      () => void refreshOverlay(),
      Math.max(OVERLAY_REFRESH_MIN_MS, relayResolved.refreshAfterSeconds * 1000),
    )
    timer.unref()
  }
  const rendezvous = new RendezvousRegistry([
    new LocalRendezvous((id) => hostAddresses.get(id)),
    new ManagerSshRendezvous({
      target: config.clusterRendezvousUrl,
      addressOf: (id) => hostAddresses.get(id),
    }),
    // `relay`（R3 / R5）：**既没配 `/status`、也没启用拨号通道 ⇒ 不注册** ⇒ `via='relay'`
    // 回落到 `manager-ssh`（`hostsProvider` 的回退分支），即"没配就完全等同今天"。
    ...(config.relayStatusUrl === '' && currentDialer() === undefined
      ? []
      : [
          new RelayRendezvous({
            dialTargetUrl: relayUrl,
            // 键一律是**逻辑名** `<network>/<hostId>`（P0-3）：跨网同名 host 不会互相命中。
            addressOf: (name) => {
              const port = hostAgentPorts.get(name)
              if (port === undefined) return undefined
              // ① 首选**拨号通道**：落点在 Manager 自己本机 ⇒ relay 换机器也成立（R5）
              //    ⚠️ 这里同时是**控制面侧的跨网门**：通道只声明一张网，跨网申请**必然回 undefined**
              //    （`RelayDialer` 里带日志地拒掉）⇒ 绝不会把别张网的落点发出去。
              const dialed = currentDialer()?.localPortFor(name, port)
              if (dialed !== undefined) return `127.0.0.1:${dialed}`
              // ② 回退：**订阅推送**带来的回环落点（订阅新鲜时它才是唯一在更新的那份）
              const pushed = presenceLocalPort(name, port)
              if (pushed !== undefined) return `127.0.0.1:${pushed}`
              // ③ 再回退：relay 快照（只有"没订阅 / 订阅不新鲜"时才会走到这里 —— 即 R3 的原路径）
              //    仅在 relay 与 Manager 同机时可用
              const hit = relayEndpoints.get(`${name}:${port}`)
              return hit === undefined ? undefined : `127.0.0.1:${hit.localPort}`
            },
            online: (name) => {
              const port = hostAgentPorts.get(name)
              if (port === undefined) return false
              /**
               * ① **有新鲜快照** ⇒ 沿用 R3 的「先问在线、再给地址」：能明确区分"离线"与"端口没了"，
               *    失败语义更准（离线走 `undefined`，不必真去拨一次）。
               */
              if (Date.now() - relaySnapshotAt <= RELAY_SNAPSHOT_TTL_MS) {
                const hit = relayEndpoints.get(`${name}:${port}`)
                if (hit !== undefined) return hit.online === true
              }
              /**
               * ② **没有快照**（relay 在别的机器上 / 未配 `/status`）⇒ 交给**拨号本身**判定：
               *    离线会拿到 `target-offline`，是**带原因的显式失败**，不会静默路由到别处。
               */
              return currentDialer() !== undefined
            },
            /**
             * **主路径 = 订阅推送**（新鲜时它是权威答案，`online` 那条兜底就不会被调用）。
             * 返回 `undefined` ⇒ 回落到上面 `online`（= R3 的既有行为，一行未改）。
             */
            presence: presenceOnline,
          }),
        ]),
  ])
  const hostsProvider = async (): Promise<ClusterHost[]> => {
    const rows = await db.listDshHosts()
    /**
     * **逻辑名 = 控制面里"这台 host"的唯一键**（P0-3）。
     *
     * 网络维度取自 `dsh_hosts.network_id`（P0-1 迁的列，**本步才真正被消费**）——
     * 在此之前它只是"表里有、没人读"，于是控制面所有键（地址表 / via 表 / 端口表 /
     * relay 端点表 / 拨号口池）都按**裸 hostId**，两张网各有一台同名 host 时会**互相覆盖**。
     *
     * ⚠️ P-2：映射由 `hostNameIndex` 统一提供（闭包 `translateEndpoint` 用的是**同一份**），
     * 这里只是把它读出来；`??` 那支是**类型兜底**（索引按 `rows` 建 ⇒ 实际不可达）。
     */
    const nameOf = (row: { id: string; networkId: string }): string =>
      hostNameById.get(row.id) ?? logicalName(row.networkId === '' ? OPS_NETWORK : row.networkId, row.id)
    // P-2：填 `hostId → 逻辑名`（闭包拿到裸 hostId 后靠它回到"控制面的键口径"）
    hostNameById.clear()
    for (const [id, name] of hostNameIndex(rows)) hostNameById.set(id, name)
    // 先同步地址表（会合实现不直接连 DB），再逐行解析 —— 两遍是为了让 `resolve()` 只看纯内存表。
    for (const row of rows) {
      const name = nameOf(row)
      const address = parseReachability(name, row.endpoint, row.via).address
      hostAddresses.set(name, address)
      hostVia.set(name, row.via)
      const port = addressPort(address)
      if (port === undefined) hostAgentPorts.delete(name)
      else hostAgentPorts.set(name, port)
    }
    for (const row of rows) {
      // `via` 认不出来（老行 / 手写错值）⇒ 回退到"今天唯一在跑的实现"，**不抛**（过渡期要能跑）。
      const impl = rendezvous.get(row.via) ?? rendezvous.get(VIA_MANAGER_SSH)
      hostDirectory.set(row.id, {
        hostId: row.id,
        agentUrl: row.endpoint, // 保留：`agentBaseUrlOf` 的回退路径，S2 阶段与 reachability 等价
        reachability: impl === undefined ? undefined : await impl.resolve(nameOf(row)),
        token: row.agentToken,
        instanceHost: config.clusterInstanceHost,
        // 表里的声明（P0-3）：`agentBaseUrlOf` 靠它区分"解析不出"与"可以回落 endpoint"。
        via: row.via,
      })
    }
    return [...hostDirectory.values()]
  }
  /**
   * 按用户归属解析 host（实例面与**文件面**共用这一份，避免两套路由漂移）。
   *
   * 为什么两处都要用：用户工作区在**那台 worker 的本地盘**；若文件面固定打一台 agent，
   * 就会出现「实例跑在 A、mkdir/上传写到 B」⇒ 实例看不到自己的文件、甚至 cwd 不存在而崩
   * （2026-09-15 生产切换暴露）。
   */
  const hostIdForUser = async (userId: string): Promise<string | undefined> =>
    (await db.findUserInstance(userId, 'main'))?.hostId ?? undefined

  /**
   * **文件面专用**路由：没有归属就**先选机并钉住**。
   *
   * 为什么不能直接用 hostIdForUser：新用户还没有归属，"写文件"和"launch"会各自选一次机，
   * 两次可能选到不同机器 ⇒「文件写到 A、实例起在 B」⇒ 实例看不到自己的文件（2026-09-15 实测）。
   * 首次触达工作区就把归属钉住，后续（含 launch）全走粘性 ⇒ 两面必然一致。
   */
  const hostIdForFile = async (userId: string): Promise<string | undefined> => {
    const owned = await hostIdForUser(userId)
    if (owned !== undefined && owned !== null) return owned
    const chosen = (await selectHost(userId)) ?? config.clusterHostId
    if (chosen === '') return undefined
    await db.pinInstanceHost(userId, chosen)
    return chosen
  }
  /**
   * 选机：**① 粘性优先 ② 再按容量准入**。
   *
   * ⚠️ 顺序不能颠倒（2026-09-15 生产切换时补的缺口）：用户工作区在**本地盘**、跟着机器走，
   * 把"已有历史数据的用户"调度到另一台 ⇒ 他打开实例看到**空工作区**。
   * ⇒ 有历史归属且那台还 `up` 就留在原地；只有**从未有过归属**（新用户）才按容量挑最空的。
   * `capacityMb <= 0` = 未声明（不设限）；`-1` = 显式禁用承载。
   */
  const reserveMb = Number(process.env.DSH_AI1NET_CLUSTER_RESERVE_MB ?? '512')
  const selectHost = async (userId?: string): Promise<string | undefined> => {
    const rows = await db.listDshHosts()
    const eligible = rows.filter((h) => h.status === 'up' && h.capacityMb !== -1)
    if (userId !== undefined) {
      const owned = (await db.findUserInstance(userId, 'main'))?.hostId ?? null
      if (owned !== null && eligible.some((h) => h.id === owned)) return owned
    }
    const candidates = eligible.filter(
      (h) => h.capacityMb <= 0 || h.usedMb + reserveMb <= h.capacityMb,
    )
    if (candidates.length === 0) return undefined // 无候选 ⇒ 回退到配置里那台
    candidates.sort((a, b) => a.usedMb - b.usedMb)
    return candidates[0].id
  }
  /**
   * ── 内容分发装配（块级内容寻址 · 同网段 peer 优先）──────────────────────
   *
   * ⚠️ **本块是"仅装配"**（设计文档 §3.1）：只把 `store` / `source` / `peer` 三个纯逻辑模块
   * **接线并暴露计数**，⛔ 不改 presence、不改端点翻译、不改切流、不新开监听口（R5）。
   *
   * **回滚 = 整段移除本块**（§6 装配级回滚）：新模块文件留着不加载 ⇒ 零副作用。
   *
   * 三档 fetcher 的落点（本阶段）：
   * - `local`  —— 直接查 `ContentStore`（同进程已持有的块）；
   * - `peer`   —— 走 `ContentPeerGroup.candidates()` 的结果（同组 peer；真机取块经既有 wss）；
   * - `edge` / `region` / `origin` —— **本阶段未装配**（缺档 ⇒ 链按"该档没有"处理并**照样计数**，
   *   这正是 `ContentSourceChain` 纪律 2/3 要的行为：⛔ 不许因为没装配就静默缩短链路）。
   *
   * ⚠️ 之所以敢先不装配 `origin`：本项目的 E1 判据（回源 ≈ 1 份 × 组数）测的是
   * "**同组内多台只回源一次**"，判据落在 `local` / `peer` 两档的命中计数上；
   * 真回源路径（平台代理层）本就在 `proxy.ts`，与本块正交。
   *
   * 🔴 **两个参数就地读 env（⛔ 不进 `config.ts`）**：`config.ts` **不在本项目在册文件集**
   *   （设计文档 §3.1）⇒ 动它 = 命中 §9-2 回头条件（超范围）。故装配层就地取：
   *   - `CONTENT_STORE_MAX_BYTES` —— 块缓存上限（缺省 64 MiB，见 `store.ts` 推算）；
   *   - `CONTENT_GROUP` —— 本节点在内容面上的**组名**（缺省 `local`）。
   *   ⚠️ 二者都是"纯新增、缺省可用"⇒ 不设也不影响既有行为（⛔ 不动任何既有键）。
   */
  const contentStoreMaxBytes =
    Number(process.env.CONTENT_STORE_MAX_BYTES ?? '') > 0
      ? Number(process.env.CONTENT_STORE_MAX_BYTES)
      : undefined
  const contentGroup = process.env.CONTENT_GROUP ?? 'local'
  /**
   * 🆕 单 B：**平台侧接入加密，但缺省不启用**。
   *
   * 🔑 为什么平台侧**默认关**：① 平台进程服务真实用户，密钥落点越少越好（单内 §7.2
   * "密钥本体只走 `0600` 落文件"）；② `OBS-23` 的读取面是 **relay** 的 `/status`
   * ⇒ 判据在 relay 侧成立即可；③ `peer` 取回通道尚未接线 ⇒ 跨进程密钥一致性今天**不构成收益**。
   * ⚠️ 要开只需配 `CONTENT_GROUP_KEY_FILE`（**纯新增、缺省可用** ⇒ 不设即回到行为）。
   */
  const platformKeyFile = process.env.CONTENT_GROUP_KEY_FILE ?? ''
  const platformGraceMs = Number(process.env.CONTENT_EPOCH_GRACE_MS ?? '')
  const { cipher: contentCipher } =
    platformKeyFile === ''
      ? { cipher: undefined }
      : openContentCipher({
          file: platformKeyFile,
          group: contentGroup,
          network: OPS_NETWORK,
          ...(Number.isFinite(platformGraceMs) && platformGraceMs > 0 ? { graceMs: platformGraceMs } : {}),
          log: overlayLog,
        })
  const contentStore = new ContentStore({
    maxBytes: contentStoreMaxBytes,
  })
  const contentPeers = new ContentPeerGroup({
    // 本节点在内容面上的分组：网 = 运维网（平台自己的机器），组 = 本机（同网段走本机多实例验证）
    network: OPS_NETWORK,
    group: contentGroup,
    ...(contentCipher === undefined ? {} : { epoch: contentCipher.epoch }),
    log: overlayLog,
  })
  const contentSource = new ContentSourceChain({
    fetchers: {
      local: async (id: string) => {
        const bytes = contentStore.get(id)
        return bytes === undefined ? undefined : { tier: 'local' as const, bytes }
      },
      peer: async (id: string) => {
        // 同组有候选 ⇒ 由上层真机路径去取；本阶段没有真实取回通道时诚实回"没有"
        // （⛔ 不许伪造字节 —— 那会让 E1 的"零回源"变成假绿）
        const cands = contentPeers.candidates(id)
        return cands.length === 0 ? undefined : undefined
      },
    },
    // 🆕 单 B：唯一解密点（生产路径）；未启用加密 ⇒ 不注入 ⇒ 行为逐字不变
    ...(contentCipher === undefined ? {} : { decode: (stored: Buffer) => contentCipher?.decodeBlock(stored) }),
    onHit: (tier, id) => overlayLog(`[content] 命中 tier=${tier} block=${id.slice(0, 8)}…`),
    onMiss: (tier, id) => overlayLog(`[content] 未命中 tier=${tier} block=${id.slice(0, 8)}…`),
    onError: (tier, id, err) =>
      overlayLog(`[content] ⛔ tier=${tier} 抛错 block=${id.slice(0, 8)}… err=${String(err)}`),
    onDecodeRejected: (tier, id) =>
      overlayLog(`[content] ⛔ tier=${tier} 取回的块解密失败 block=${id.slice(0, 8)}…（认证未过）`),
  })
  /** 内容面计数快照（供 `/status` 类观测读取；⛔ 只读，不改任何既有字段）。 */
  const contentCounters = (): Record<string, unknown> => ({
    store: contentStore.counters(),
    storeBytes: contentStore.bytes,
    storeBlocks: contentStore.size,
    /** ⚠️ 键名与 `ContentSourceChain.counters()` 同构 ⇒ 探针可逐档断言。 */
    source: contentSource.counters(),
    sourceMiss: contentSource.missCounters(),
    sourceErrors: contentSource.errors(),
    sourceMissTotal: contentSource.misses(),
    /** 🆕 单 B：逐档解密被拒（`sourceErrors` 的细分）+ 加密判别器块。 */
    sourceDecodeRejected: contentSource.decodeRejected(),
    // ⚠️ 不启用 ⇒ 键整体缺席（补零会让"没启用"与"启用了但零值"同形）
    ...(contentCipher === undefined ? {} : { crypto: contentCipher.counters() }),
    peer: contentPeers.counters(),
    peerGroup: contentPeers.groupKey,
  })
  void contentCounters // 暴露给后续观测面（S5 探针项）；本阶段先建在作用域内，避免"装了但没人读"

  const supervisor: Spawner =
    config.deployMode === 'cluster'
      ? (leased = new LeasedSpawner(
          new RemoteSpawner({
            agentUrl: config.clusterAgentUrl,
            token: config.clusterAgentToken,
            instanceHost: config.clusterInstanceHost,
            defaultHostId: config.clusterHostId,
            hostsProvider,
            resolveApiKey,
            resolveUid,
            // 按 host 路由：每次操作都落到"该用户实例所在那台"（与文件面同一份）
            hostIdFor: hostIdForUser,
            /**
             * 覆盖网络 R4：**实例端点的 relay 翻译**。
             *
             * `via='relay'` 的 host，其实例在 Worker 上监听 `127.0.0.1:<实例端口>`，而 Manager
             * 要拨的是 relay 为那个端口开的**动态回环口号** ⇒ 必须按 `(hostId, 实例端口)` 查
             * relay 快照翻译。查不到就回 `undefined`（= 实例不可达）—— **绝不原样透传**，
             * 那会拨到一个"在 Manager 上毫无意义"的端口上。
             *
             * 非 `relay` 形态（`local` / `manager-ssh`）**原样返回**：隧道是同号反向转发，
             * 两边口号相同 ⇒ 不需要也没法翻译（这正是 S3 端口区间隔离能根治撞号的前提）。
             *
             * ⚠️ 判据必须取 **`dsh_hosts.via` 原文**（`hostVia`），**不能**取 `reachability.via`：
             * 后者在 host 离线 / relay 快照陈旧时为 `undefined`，若据此判"不是 relay ⇒ 原样透传"，
             * 就会**失败开放** —— 把 Worker 侧口号打到 Manager 本机（2026-09-16 实测：浏览器只见
             * 空响应、平台零日志）。未知 host 仍按老行为原样返回（单机 / 默认 host 不受影响）。
             */
            translateEndpoint: (hostId, ep) => {
              /**
               * 🔴 **P-2：先把裸 hostId 换成逻辑名**（控制面所有表的键口径）。
               *
               * 原实现直接 `hostVia.get(hostId)` ⇒ **恒 `undefined`** ⇒ 早退原样透传 ⇒
               * 这个闭包整体是**死分支**（翻译从未生效；`translateEndpoint` 的第一版还漏过赋值）。
               * 判定本体已抽成纯函数 `relayEndpointTarget`（可单测、可先红后绿）。
               */
              const name = hostNameById.get(hostId)
              const decision = relayEndpointTarget({
                known: name !== undefined,
                via: name === undefined ? undefined : hostVia.get(name),
                // ⚠️ thunk：`localPortFor` **会按需绑池口 / 真的拨一次** ⇒ 只在 via=relay 时才准调
                dialedPort:
                  name === undefined ? () => undefined : () => currentDialer()?.localPortFor(name, ep.port),
                /**
                 * 🔴 **P-2b：第 ②' 级 = 订阅推送落点**。
                 *
                 * 必须与 `addressOf`（上方 `RelayRendezvous`）的三级链**同源、同顺序**：
                 * ① 拨号落点 → ② `presenceLocalPort` → ③ relay 快照。少这一级时，P-1 修好之后
                 * （订阅新鲜期长期成立 ⇒ 快照趋冷）会在"拨号池分不出槽位、但推送里有落点"时
                 * **判实例不可达（失败关闭）**，而同一时刻地址解析链能答出落点 ⇒ 两条链漂移 ⇒
                 * 用户看到"实例打不开"，日志却什么都没有。
                 */
                pushedLocalPort: name === undefined ? undefined : presenceLocalPort(name, ep.port),
                snapshotLocalPort:
                  name === undefined ? undefined : relayEndpoints.get(`${name}:${ep.port}`)?.localPort,
              })
              if (decision.kind === 'passthrough') return ep
              if (decision.kind === 'local') return { host: '127.0.0.1', port: decision.port }
              // 失败关闭 + **点名**（⛔ 不回原样透传：那会拨到 Manager 本机，症状只有"空响应 + 零日志"）
              overlayLog(
                `[overlay-endpoint] ⛔ ${name ?? hostId}:${ep.port} 在册且 via=relay，但拨号落点 / 订阅推送 / relay 快照三级都查不到 ⇒ 判实例不可达（失败关闭）`,
              )
              return undefined
            },
          }),
          db,
          {
            hostId: config.clusterHostId,
            agentUrl: config.clusterAgentUrl,
            agentToken: config.clusterAgentToken,
            capacityMb: Number(process.env.DSH_AI1NET_CLUSTER_CAPACITY_MB ?? '0'),
            // 专用 Manager 部署设 DSH_AI1NET_CLUSTER_REGISTER_SELF=0（见 LeasedSpawner 的注释）
            registerSelf: (process.env.DSH_AI1NET_CLUSTER_REGISTER_SELF ?? '1') !== '0',
            ttlMs: Number(process.env.DSH_AI1NET_CLUSTER_LEASE_TTL_MS ?? '30000'),
            renewMs: Number(process.env.DSH_AI1NET_CLUSTER_LEASE_RENEW_MS ?? '10000'),
            selectHost,
            agentFor: (hostId: string) => {
              const h = hostDirectory.get(hostId)
              // 取址统一走可达性入口（S0）—— `agentUrl` 已降级为可选旧字段
              return h === undefined ? undefined : { agentUrl: agentBaseUrlOf(h), token: h.token }
            },
          },
        ))
      : new LocalSpawner(config, resolveApiKey, resolveUid)
  // 注册本机 + 起心跳（异步，不阻塞启动；心跳失败只影响该 worker 的状态位）
  if (leased !== undefined) {
    void leased.start().catch((err: unknown) => {
      console.error('[cluster] heartbeat/register failed to start:', err)
    })
  }
  /**
   * 按需补齐 host 目录（2026-09-16 加，覆盖网络线缺陷 A1）。
   *
   * **为什么文件面必须自己会刷新**：`hostDirectory` 是**惰性** Map —— 唯一的写入者是
   * `hostsProvider()`，而此前只有 `RemoteSpawner.ensureHosts()`（TTL 30 s）会调它 ⇒
   * Manager 重启后若用户先碰文件面（"我的文件" / launch 的 folder 检查），表里只有本机
   * ⇒ `agentFor('<host-b>')` 返回 `undefined` ⇒ 旧行为**静默回退到本机 agent** ⇒ worker 上当然
   * 没有这个用户 ⇒ 假 `404 {"error":"not_found"}`，与"文件夹不存在"完全同形，且平台零日志。
   * （判别器 = relay 有没有 `DIAL`：没有 = 请求根本没出这台机。回归用例见
   * the regression suite。）
   *
   * **成本**：只在**未命中**时查库（正常路径零开销）；并发去重 + 5 s 冷却，
   * 避免一个真正不存在的 hostId 把 PG 打穿。
   */
  const DIRECTORY_COOLDOWN_MS = 5_000
  let directoryRefreshing: Promise<void> | undefined
  let directoryRefreshedAt = 0
  const ensureHostDirectory = async (hostId: string): Promise<void> => {
    if (hostDirectory.has(hostId)) return
    if (directoryRefreshing !== undefined) return directoryRefreshing
    if (Date.now() - directoryRefreshedAt < DIRECTORY_COOLDOWN_MS) return
    directoryRefreshedAt = Date.now()
    // **可观测性**（别省这一行）：本行出现 = 真的走进了"未命中 ⇒ 补齐"这条路径，
    // 也就是"旧实现会静默把请求打到本机 agent"的那个窗口。没有它，"这次为什么没 404"
    // 只能靠推断；本项目吃过的静默失效亏，根子都在"关键分支不可观测"。
    console.log(`[cluster] host 目录未命中 ${hostId} ⇒ 按需补齐（重启窗口期常见）`)
    directoryRefreshing = hostsProvider()
      .then(() => undefined)
      .finally(() => {
        directoryRefreshing = undefined
      })
    return directoryRefreshing
  }
  const userFs = createUserFs(config, {
    hostIdFor: hostIdForFile,
    agentFor: (hostId: string) => {
      const h = hostDirectory.get(hostId)
      // 同上一处：取址只经可达性入口（文件面与实例面共用同一份路由，别各自拼）
      return h === undefined ? undefined : { agentUrl: agentBaseUrlOf(h), token: h.token }
    },
    ensureHost: ensureHostDirectory,
  })
  // T08 S5：cluster 模式下**所有 worker 的 dataRoot 必须是同一绝对路径**（基线约定，
  // 设计 §14.3）。不一致会让 `resolvePath` 算出的"实例眼里的路径"与实际不符 ⇒
  // 文件面与 launch 的 folder 都会错。这里在启动时**报出来**，别等用户点进去才发现。
  if (userFs instanceof RemoteUserFs) {
    void userFs
      .probeWorkerRoot()
      .then((root) => {
        if (root !== undefined && root !== userFs.workerDataRoot) {
          console.error(
            `[cluster] worker dataRoot 与配置不一致：agent 报 ${root}，本进程按 ${userFs.workerDataRoot} 计算路径。` +
              '请把 DSH_AI1NET_CLUSTER_WORKER_DATA_ROOT 设为 worker 上的实际值（所有 worker 必须同路径）。',
          )
        }
      })
      .catch(() => {
        /* 探测失败不阻塞启动：会有心跳/调用失败暴露 */
      })
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: config.maxUploadBytes,
  })

  app.decorate('db', db)
  app.decorate('config', config)
  app.decorate('supervisor', supervisor)
  app.decorate('userFs', userFs)
  app.decorateRequest('user', null)

  // Reverse proxy (subdomain + legacy subpath). Registered first so its global
  // onRequest hook intercepts per-user subdomain traffic before other hooks.
  await registerDshProxy(app)

  // CORS for cross-subdomain API calls from dsh instances (功能插件启停 section
  // runs in the browser on `<user>.dsh.<base-domain>` and calls portal APIs on
  // `dsh.<base-domain>`). Cookie is HttpOnly + SameSite=None (secure mode) with
  // Domain=.dsh.<base-domain>, so credentials ride along; we only need to allow
  // the Origin. Restricted to the platform base domain and its subdomains.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (origin === undefined || origin === '') return
    if (!isAllowedOrigin(origin, config.baseDomain)) return
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Access-Control-Allow-Credentials', 'true')
    reply.header('Vary', 'Origin')
    if (request.raw.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Content-Type')
      reply.header('Access-Control-Max-Age', '600')
      return reply.code(204).send()
    }
  })

  app.addHook('onClose', async () => {
    await supervisor.teardown()
    await db.close()
  })

  // Rate limiting first so auth/admin surfaces are covered by default.
  await app.register(rateLimit)

  // Domain-specific route groups (API).
  await app.register(authRoutes)
  await app.register(adminRoutes)
  // admin 视角的「用户服务 / 工作区文件」—— admin 在「服务管理」里管**任意用户**
  await app.register(adminUserOpsRoutes)
  await app.register(businessPluginRoutes)
  await app.register(desktopRoutes)
  await app.register(dshRoutes)
  await app.register(domainRoutes)
  await app.register(overlayRoutes)
  // （P2/S5）：覆盖网络**管理面**（节点清单只读 ＋ 直连开关读写）—— 全部走 requireAdmin
  await app.register(overlayNodeRoutes)
  await app.register(skillRoutes)
  await app.register(whitelistRoutes)

  // Static placeholder SPA last, so exact API routes take precedence over the
  // wildcard static handler.
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
  })

  return app
}
