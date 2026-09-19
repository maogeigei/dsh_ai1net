/**
 * Per-user DSH supervisor: a resident main DSH plus an **on-demand** watchdog.
 *
 * The watchdog is not spawned at launch; it is pulled up once when the main
 * crashes (to repair) or when a post-restart command must be executed. This
 * keeps the steady-state footprint at one process per active user while still
 * providing crash repair + command handoff. The watchdog's agent-level
 * repair/session-resume is harness-internal and deferred to real-harness
 * integration (see manual/architecture.md).
 * @module dsh_ai1net/supervisor/orchestrator
 */

import { execFileSync, spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { handoffPath, homeRoot, userRoot, workspaceRoot } from '../fs/workspace.js'
import {
  breakerActive,
  breakerCooldownMs,
  breakerUntil,
  decideCrashAction,
  openBreaker,
  pruneHistory,
  type BreakerPolicy,
  type BreakerState,
  type CrashPolicyConfig,
} from './crash-policy.js'
import { createPortGuard, type PortGuard } from './firewall.js'
import { findInstancePort, scrubEnv } from './spawn.js'
import {
  AlreadyRunningError,
  CrashBreakerOpenError,
  type Endpoint,
  type Instance,
  type InstanceRole,
  type InstanceStatus,
  type Spawner,
  type UserStatus,
} from './spawner.js'

// Re-exported so existing importers (routes) keep resolving from this module.
export {
  AlreadyRunningError,
  CrashBreakerOpenError,
  type Instance,
  type InstanceRole,
  type InstanceStatus,
  type UserStatus,
}

/** Task given to the one-shot headless watchdog so it doesn't error on a
 * missing task; executes any post-restart command from the handoff path. */
const WATCHDOG_TASK = 'Read DSH_AI1NET_HANDOFF_PATH. If it contains a JSON {"command": ...}, run that command. Then exit.'
/* ─────────────────────────────────────────────────────────────────────────────
 * 实例内存：**基础 MIN、最多浮动到 MAX**（2026-09-14 用户要求 —— 与「插件开关」解耦）
 *
 * 两段历史都记下来，免得再走回头路：
 *   · **R1-④（2026-09-13）** 曾把配额改成 `基准 + Σ(插件内存预估)`，为修
 *     「guest 启用 univer 后 gateway ≈390 MB 撞死写的 384M ⇒ cgroup OOM kill 死循环」。
 *   · **2026-09-14 实测暴露该设计的软肋：用「估计表」去定「硬上限」，估偏低就真 OOM** ——
 *     ① 未知插件按 0 计 ⇒ 装了重插件也不加配额；
 *     ② 表本身偏乐观：admin 带上 mcn 后**峰值 409 MiB**，而当时上限 384 ⇒ **一分钟内被 OOM 杀 4 次**，
 *        直接打出 crash 熔断（`/var/log/dsh-crash-breaker.log` 20:04:53）；
 *     ③ 配额随「开关插件」跳动 ⇒ 界面上的「预估」与实例**真实上限**绑死，语义混乱
 *        （用户 2026-09-14 指出：「开关插件只是显示给用户看内存占用的预估，怎么会实际影响实例内存」）。
 *
 * 现规则（用户原话：「实例内存不要受插件开关影响，只受 min 和 max 值影响」；
 *   随后明确「改成基础 min 最大可以浮动到 max」）——**cgroup 给两个参数**：
 *   `MemoryHigh = MIN_MEM_MB`（**基础/软限**：超过即开始回收·限速）＋
 *   `MemoryMax  = MAX_MEM_MB`（**上界/硬限**：越界 OOM）⇒ 实际占用在两者之间浮动；
 *   V8 老生代上限仍跟随配额（留 `HEAP_HEADROOM_MB` 余量，见 `heapMbFor`）。
 *   ⚠️ **插件成本表已从配额计算中移除**：给用户看的预估仍在插件客户端（`MEM_TABLE`），
 *      但它**只用于显示**、不再是硬上限的来源。
 *
 * 取值依据：MIN = **448**（= 用户 2026-09-14 裁定的 base「base 448 没问题」；0.1.5 基座实测 ~312 MiB ⇒ 留 ~136 MiB 余量）；
 *   MAX = 1024 是宿主容量不变量（宿主 1870M，并发数由 maxIdleInstances + available 决定）。
 * 回滚：把 `instanceMemMb()` 换回「基准 + Σ插件表」即可（旧实现见 git 历史；/94/96 记有两次调整理由）。
 * ──────────────────────────────────────────────────────────────────────────── */
// MIN = **基础值**（cgroup `MemoryHigh`）—— 实例稳态落在这附近；MAX = **上浮上界**（cgroup `MemoryMax`，越界 OOM）。
//   ⚠️ 448 = 用户裁定的 base，**别擅自调**（2026-09-14：我曾擅自抬到 512，被纠正）。
const MIN_MEM_MB = 448
const MAX_MEM_MB = 1024
const HEAP_HEADROOM_MB = 96      // 配额里留给非堆部分（native/栈/共享）

/** 实例内存**基础值**（MB）= cgroup 软限 `MemoryHigh`：超过它内核开始回收/限速。
 *  **不再读 profile 的 bundles**（2026-09-14 起与「插件开关」解耦）。 */
function instanceBaseMb(): number {
  return Math.max(128, MIN_MEM_MB)
}

/** 实例内存**上浮上界**（MB）= cgroup 硬限 `MemoryMax`：越界 OOM；V8 堆也按它推导。 */
function instanceMaxMb(): number {
  return Math.max(instanceBaseMb(), MAX_MEM_MB)
}

/** V8 老生代上限跟随配额（不再写死 160）。 */
function heapMbFor(memMb: number): number {
  return Math.max(128, Math.min(256, memMb - HEAP_HEADROOM_MB))
}

/**
 * 把「堆上限」从既有 NODE_OPTIONS 里摘掉，换成按配额推导的值。
 *
 * 为什么不让 env 决定堆：`DSH_INSTANCE_NODE_OPTIONS` 曾在平台进程 env 里被设成
 * `--max-old-space-size=160`（此前下调过），而该值**不在** systemd 的 manager env / unit 里
 * （2026-09-13 实测：`systemctl unset-environment` 后进程 env 里仍有）⇒ 靠改配置改不动它。
 * 规则改为：**堆由代码按配额推导**（与 MemoryMax 同一口径，不可能再对不上）；
 * env 仍然有效，但只承载**其它**选项（如 `--trace-gc`）。要强行指定堆，用 `DSH_AI1NET_HEAP_MB_OVERRIDE`。
 */
function withHeap(base: string | undefined, memMb: number): string {
  const override = Number(process.env.DSH_AI1NET_HEAP_MB_OVERRIDE ?? '')
  const mb = Number.isFinite(override) && override > 0 ? override : heapMbFor(memMb)
  const rest = (base ?? '')
    .split(/\s+/)
    .filter((t) => t !== '' && !t.startsWith('--max-old-space-size'))
  rest.push(`--max-old-space-size=${mb}`)
  return rest.join(' ')
}


/**
 * 列出 `dest` 与 `stopAt` 之间的**祖先目录**（由外到内），用于 bwrap 的 `--tmpfs`（见
 * {@link mountParentDirArgs}：`--tmpfs` 自带 0755，且**兼容 47 上的 bwrap 0.4.0**）。
 *
 * 背景（T08 S1.6，2026-09-15 实测）：bwrap **只创建挂载点本身**，沿途缺失的父目录由它自建，
 * 而权限是 **`0700 root:root`** —— 实测 `--bind /opt/a/b/c /opt/a/b/c` 会得到 `/opt`、
 * `/opt/a`、`/opt/a/b` **全是 0700**。后果：**实例以非 root 的 uid 穿越这些路径时 EACCES**。
 * 已实测到的两处症状：
 *   ① 宿主上 `/etc/ssl/openssl.cnf` 是指向 `/etc/pki/tls/openssl.cnf` 的**符号链接** ⇒ 解析要穿过
 *      `/etc/pki`（0700）⇒ node 报 `OpenSSL configuration error … Permission denied`、**exitCode 13**
 *      （OpenCloudOS 9.6 实测；另一台上**没有**该文件故静默跳过 ⇒ 同一份代码一台能跑一台崩）；
 *   ② **用户工作区在沙箱内不可穿越** ⇒ 实例按**绝对路径**读写自己的文件被拒。
 * 修法：把这些祖先目录**显式建成 0755**。**权限不扩大** —— 这些目录里只有随后绑定的白名单内容
 * （整绑 `/etc/pki` 的替代方案已否决：会带入 `/etc/pki/tls/private/postfix.key`，违反 R5）。
 */
function mountParentDirList(dest: string, stopAt: string): string[] {
  const dirs: string[] = []
  let cur = dirname(dest)
  while (cur !== stopAt && cur !== '/' && cur !== '' && cur !== '.') {
    dirs.push(cur)
    cur = dirname(cur)
  }
  return dirs.reverse() // 由外到内（`--perms` 只作用于紧接着的那一个 `--dir`）
}

/**
 * 把 {@link mountParentDirList} 的结果摊平成 bwrap 参数。
 * ⚠️ **不要再"就近调用"它**（例如插在 `--bind` 之前）—— 见 `bwrapArgs` 里"统一前置"
 * 那段注释：就近创建会在嵌套前缀下遮掉已绑好的挂载点。当前实现只在**一处**统一使用。
 */
function mountParentDirArgs(dest: string, stopAt: string): string[] {
  // ⚠️ **必须用 `--tmpfs`，不能用 `--perms 0755 --dir`**（2026-09-15 实测，差点打断生产）：
  //   · `--perms` 是 bubblewrap **0.5+** 才有的选项；**47 上是 0.4.0** ⇒ 传了直接
  //     `bwrap: Unknown option --perms` ⇒ **沙箱起不来 = 所有实例全挂**（106 是 0.11.0，能过）。
  //   · 而 `--tmpfs` **自带 0755**（本文件另一处注释也这么写：`bwrap 的 --tmpfs 权限是 755`），
  //     且在 0.4.0 上就可用。
  // 47 上实测：改用 `--tmpfs` 后 `/etc` 可见条目 **78 → 78（零变化）**，且 `/etc/pki` 权限
  // 由 `drwx------` 变为 `drwxr-xr-x`（可穿越）。代价 = 每个中间目录多一个空 tmpfs 挂载（极小）。
  return mountParentDirList(dest, stopAt).flatMap((d) => ['--tmpfs', d])
}

/**
 * Local backend: owns the lifecycle of per-user DSH process pairs via
 * child_process. State is in-memory. Implements {@link Spawner}.
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * 覆盖网络线 序 ㉕：「逐步拉起」= 启动时**不再一刀切清空**既有实例 scope。
 *
 * 背景（历史）：实例真实生命周期在 OS 层（systemd scope），编排器只靠
 * 内存 map 追踪 ⇒ 重启后 map 空、旧 scope 成孤儿 ⇒ 当时的修法是「启动即统一清掉」。
 * 但那条修法有两个副作用：① **所有**实例在 Manager 启动瞬间被同时杀掉（N 个一起 = 启动
 * 风暴）② 空闲期实例也不保。本序把它换成「**扫描 → 认领 → 逐个错峰探活**」。
 *
 * 🔴 一条必须先说的**客观边界**（本序实测得出，⛔ 别再试图绕过）：
 * 「认领」**不可能**做到"用户无感直接复用" —— 因为 `Instance.launchToken` 是 dsh web
 * **启动时在 stdout 打印一次**的一次性凭据（`/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/`），
 * 既**不落盘**、也无法在运行期重新取出（实测：无 token 直连实例回 **401**）。而恢复它的两条
 * 路都被红线封死：改官方 dsh 取 token（**R2**）✗；把 token 落盘成可读凭据（**R11** 安全维度净变差）✗。
 * ⇒ 故 `enter` 在"实例 alive 但无 token"时只能拿 503（`routes/dsh.ts` 的既有语义，⛔ 未改）。
 * ⇒ 本序交付的语义 = **「不批量清空、错峰保留、访问时自然替换」**：重启后既有 scope **不被杀**，
 * 按节流逐个探活登记；用户访问时由 `spawnInstance` 既有的 `cleanStaleScopes(uid)` **自然替换**
 * （换端口换 token，与旧行为等价但**错峰**、且空闲期实例不死）。⛔ 未新增任何凭据落盘。
 * ───────────────────────────────────────────────────────────────────────────── */

/** 从 scope 的 `Description`（= `systemd-run` 记录的完整 argv）恢复出的实例三要素。 */
export interface AdoptedScopeInfo {
  /** 平台侧用户 id —— 从 `--chdir <dataRoot>/users/<userId>/…` 反解。 */
  userId: string
  role: InstanceRole
  /** 仅 `role === 'main'` 有；watchdog 走 headless、无监听端口。 */
  port?: number
  /** 实例 cwd（= `spawnInstance` 传给 `spawnAsUser` 的 `folder`）。 */
  folder: string
}

/** 单个既有 scope 的处置决定（⛔ 纯数据，便于单测与先红后绿）。 */
export type ScopeAction =
  | { kind: 'adopt' }
  | { kind: 'stop'; reason: string }

/**
 * 解析 `systemctl show -p Description` 的内容。
 *
 * ⛔ **纯函数、零 IO、零副作用**；**任何**一处不自洽一律回 `undefined` ⇒ 调用方按
 * **旧行为 stop**（保守：宁可清掉，也不让一个解析错半截的实例留在系统里）。
 *
 * 自洽校验（三道，缺一即拒）：
 *   ① 必须能解出 `--profile web|headless`（决定 main / watchdog，⛔ 猜不得）
 *   ② 必须能解出 `--chdir <abs>` 且其中含 `/users/<userId>/` 段（拿 userId）
 *   ③ argv 里的 `--reuid <n>` 必须**等于** scope 名里的 uid（交叉验证；本序实测 106 实例为
 *      `dsh-100002-ef8d1d12.scope` ＋ `--reuid 100002` ⇒ 两者必然同源）
 */
export function parseScopeDescription(desc: string, uidFromName: number): AdoptedScopeInfo | undefined {
  const tokens = desc.split(/\s+/).filter((t) => t !== '')
  const valueOf = (flag: string): string | undefined => {
    const i = tokens.indexOf(flag)
    return i >= 0 ? tokens[i + 1] : undefined
  }
  // ① role
  const profile = valueOf('--profile')
  if (profile !== 'web' && profile !== 'headless') return undefined
  const role: InstanceRole = profile === 'web' ? 'main' : 'watchdog'
  // ③ uid 交叉校验
  const reuid = valueOf('--reuid')
  if (reuid === undefined || reuid !== String(uidFromName)) return undefined
  // ② folder + userId
  const folder = valueOf('--chdir')
  if (folder === undefined || !folder.startsWith('/')) return undefined
  const marker = '/users/'
  const at = folder.indexOf(marker)
  if (at < 0) return undefined
  const rest = folder.slice(at + marker.length)
  const slash = rest.indexOf('/')
  const userId = slash < 0 ? rest : rest.slice(0, slash)
  if (userId === '' || userId.includes(' ')) return undefined
  // main 必须解出端口；watchdog 不该有端口（有 ⇒ 不自洽）
  const portRaw = valueOf('--port')
  if (role === 'main') {
    if (portRaw === undefined || !/^\d+$/.test(portRaw)) return undefined
    const port = Number(portRaw)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
    return { userId, role, port, folder }
  }
  if (portRaw !== undefined) return undefined
  return { userId, role, folder }
}

/**
 * 单个 scope 该「认领」还是「按旧行为停掉」。
 *
 * @param info    解析结果；`undefined` = 解析失败 ⇒ **停**
 * @param dupUid  同一 uid 名下出现多个 scope（本平台不可能产生，= 异常/旧 bug 残留）
 *                ⇒ **全部停**（风险本体：多实例共 profile 写冲突）
 *
 * 判 `stop` 的四种情形（⛔ 一个都别放宽）：
 *   ① `dup-uid` —— 同 uid 多 scope；
 *   ② `unparsable` —— 端口 / 用户 / uid 任一解不出（半截信息认领 = 后续替换时定位错实例）；
 *   ③ `no-probe-target` —— watchdog：一次性 headless 任务、无监听端口 ⇒ **无法确认健康**
 *      且留着无收益（它正常应当很快自己退出）；
 *   ④ role=main 却无端口 —— 由 ② 一并覆盖（`parseScopeDescription` 直接拒）。
 */
export function decideScopeAction(info: AdoptedScopeInfo | undefined, dupUid: boolean): ScopeAction {
  if (dupUid) return { kind: 'stop', reason: 'dup-uid' }
  if (info === undefined) return { kind: 'stop', reason: 'unparsable' }
  if (info.role !== 'main') return { kind: 'stop', reason: 'no-probe-target' }
  return { kind: 'adopt' }
}

/** scope 名 → uid。仅接受本平台自己产生的形态（`dsh-<uid>-<8hex>.scope`）。 */
export function parseScopeUnitName(name: string): number | undefined {
  const m = /^dsh-(\d+)-[0-9a-f]+\.scope$/.exec(name)
  if (m === null || m[1] === undefined) return undefined
  const uid = Number(m[1])
  return Number.isInteger(uid) && uid > 0 ? uid : undefined
}

/** 已被「认领」的既有 scope —— ⛔ 刻意**不进** `mains`：见文件头 序 ㉕ 的边界说明。 */
interface AdoptedScope {
  unit: string
  uid: number
  info: AdoptedScopeInfo
  adoptedAt: number
  /** 探活结果：`undefined` = 未探；`true`/`false` = 结果（失败即按旧行为停）。 */
  alive?: boolean
}

/** 认领 / 回收的**计数面**（判别器必须落计数，⛔ 不许只写日志）—— 供探针与演练断言。 */
export interface RehydrateReport {
  scanned: number
  adopted: number
  stopped: number
  probeOk: number
  probeFail: number
  retained: number
  notes: string[]
}

export class LocalSpawner implements Spawner {
  private readonly mains = new Map<string, Instance>()
  private readonly watchdogs = new Map<string, Instance>()
  private readonly children = new Map<string, ChildProcess>()
  private readonly restartTimers = new Map<string, NodeJS.Timeout>()
  /** 熔断窗口内的自动重启时间戳。 */
  private readonly crashHistory = new Map<string, number[]>()
  /** 自上次稳定运行以来的连续重启次数（驱动指数退避）。 */
  private readonly crashStreak = new Map<string, number>()
  /** 稳定判定定时器：连续运行达 `crashStableMs` 即视为已恢复。 */
  private readonly stableTimers = new Map<string, NodeJS.Timeout>()

  /**
   * 熔断冷却状态（**跨轮存活** —— `resetCrashState()` 刻意不清它）。
   * 冷却期内拒绝**隐式**启动；冷却过后只给一次干净预算。key = userId。
   */
  private readonly breaker = new Map<string, BreakerState>()
  /** Last activity per user (ms epoch) — fed by proxied traffic / enter. */
  private readonly lastActive = new Map<string, number>()
  private readonly reapTimer: NodeJS.Timeout | undefined

  private readonly portGuard: PortGuard | undefined
  /** 序 ㉕：认领到的既有实例 scope（⛔ 刻意不进 `mains`，理由见文件头）。key = unit 名。 */
  private readonly adopted = new Map<string, AdoptedScope>()
  /** 序 ㉕：认领 / 回收的计数面（判别器必须落计数）。 */
  private readonly rehydrate: RehydrateReport = {
    scanned: 0,
    adopted: 0,
    stopped: 0,
    probeOk: 0,
    probeFail: 0,
    retained: 0,
    notes: [],
  }

  /**
   * 覆盖网络线 序 ㊽：**本轮认领的探活全部落定**之后的回调。
   *
   * ## 为什么需要它（这正是一个实测缺陷的修法）
   * 认领来的存量实例**刻意不进 `mains`**（文件头 序 ㉕ 的边界：`launchToken` 不可恢复），
   * 而 `listUserInstances()` 的口径**就是 `mains`** ⇒ 上一进程遗留的实例监听端口**没有任何人**
   * 会向 relay 重新声明一遍。实测症状（2026-09-19）：106 的实例 `:21001` 进程健在、
   * `[rehydrate] probe OK` 也打了，但两台中继的端点表里都没有它（47 侧只留一条
   * `<host-b>:<worker-port-b> online=false` 的**孤儿**条目）⇒ Manager 侧 `(hostId, port)` 翻译不出来。
   *
   * ⇒ 由 **worker agent** 接这个回调，把 `adoptedInstancePorts()` 并进对账口径（⛔ 不改认领语义、
   * ⛔ 不把认领实例写进 `mains`）：端口一落定就登记，**不必等 20 s 对账节拍**。
   * ⚠️ 缺省 `undefined` ⇒ 行为与改造前**逐字一致**（其他装配点不受影响）。
   */
  onRehydrateSettled: (() => void) | undefined

  /** 序 ㊽：本轮仍在途的探活条数。探活是**异步**的（socket 事件）⇒ ⛔ 不能只看 `schedule` 的基例。 */
  private pendingProbes = 0

  /** 序 ㊽：本轮 `schedule` 已走完（不会再产生新探活）。`true` ＋ `pendingProbes === 0` ⇒ 落定。 */
  private rehydrateScheduled = false

  constructor(
    private readonly config: ServerConfig,
    /** Resolve the user's own API key (decrypted); null = user has none. */
    private readonly resolveApiKey: (userId: string) => Promise<string | null>,
    /** Resolve the user's assigned Linux uid (falls back to hash when unset). */
    private readonly resolveUid: (userId: string) => Promise<number>,
  ) {
    this.portGuard = createPortGuard(config.portGuard)
    // 覆盖网络线 序 ㉕：原为「portal 启动即清掉遗留实例 scope（重启后无法接管）」。
    // 现改为「扫描 → 认领 → 逐个错峰探活」—— 见文件头 序 ㉕ 的完整说明与那条客观边界。
    this.rehydrateAdoptedScopes()
    // Local-mode idle reap: periodically stop mains that are idle past the TTL,
    // then cap the resident count (LRU by last activity). Only armed when at
    // least one of the two rules is enabled. The timer is unref'd so it never
    // keeps the process alive by itself.
    if (
      config.idleReapIntervalSeconds > 0 &&
      (config.instanceIdleTtlSeconds > 0 || config.maxIdleInstances > 0)
    ) {
      this.reapTimer = setInterval(() => void this.reapOnce(), config.idleReapIntervalSeconds * 1000)
      this.reapTimer.unref()
    }
  }

  /** Record activity so a warm instance is not treated as idle. */
  touch(userId: string): void {
    this.lastActive.set(userId, Date.now())
  }

  /** Idle-reap pass: ① stop mains idle past the TTL; ② cap resident count by
   * least-recent activity. Only stops processes — never touches user data. */
  private async reapOnce(): Promise<void> {
    const now = Date.now()
    const ttlMs = this.config.instanceIdleTtlSeconds * 1000
    const max = this.config.maxIdleInstances
    const reaped = new Set<string>()
    const reaperLog = (userId: string, reason: string): void => {
      const idleSecs = Math.round((now - (this.lastActive.get(userId) ?? now)) / 1000)
      process.stderr.write(`[idle-reap] stop ${userId} (${reason}; idle ${idleSecs}s)\n`)
    }
    if (ttlMs > 0) {
      for (const userId of [...this.mains.keys()]) {
        const last = this.lastActive.get(userId) ?? now
        if (now - last > ttlMs) {
          reaped.add(userId)
          reaperLog(userId, `idle>${this.config.instanceIdleTtlSeconds}s`)
          await this.stop(userId)
        }
      }
    }
    if (max > 0) {
      const running = [...this.mains.keys()].filter((userId) => !reaped.has(userId))
      if (running.length > max) {
        const excess = running
          .sort((a, b) => (this.lastActive.get(a) ?? 0) - (this.lastActive.get(b) ?? 0))
          .slice(0, running.length - max)
        for (const userId of excess) {
          reaperLog(userId, `cap>${max} lru`)
          await this.stop(userId)
        }
      }
    }
  }

  /** Spawn the resident main DSH for a user (watchdog is pulled up on demand). */
  async launch(
    userId: string,
    folder: string,
    patch?: string,
    opts?: { force?: boolean },
  ): Promise<Instance> {
    if (this.mains.has(userId)) throw new AlreadyRunningError(userId)
    // 冷却期内拒绝**隐式**启动（`/api/dsh/enter` 与「用户选文件夹」都会走到这里）。
    // 原实现里 circuit-open 会 resetCrashState() 清空预算 ⇒ 只要有人（用户 F5、注入脚本自愈、
    // 脚本直铺）不断重试，崩溃循环就能无限重复。`force: true` 供**平台自身**的显式操作绕开。
    if (opts?.force === true) this.clearBreaker(userId, 'forced-launch')
    else this.assertBreakerClosed(userId)
    // 显式启动 = 新一轮：清空崩溃计数（用户重新进入后应拿到完整重试预算）。
    this.resetCrashState(userId)
    // v3 收尾：启动前补齐"受限目录选择器"（幂等；首登 profile 尚未创建时会自行跳过）。
    this.ensurePickerProfile(userId)
    this.touch(userId)
    const instance = await this.spawnInstance(userId, 'main', folder, patch)
    // 等待 dsh web 打印 launch token，保证返回的打开 URL 可直接通过浏览器认证
    await this.waitForLaunchToken(instance)
    return instance
  }

  /**
   * v3 收尾（第二层自愈）：确保该用户的 profile 具备"受限目录选择器"
   * （平台段 + 插件包）—— 执行可选的初始化脚本（由 `DSH_PICKER_ENSURE_SCRIPT` 指定，幂等）。
   * 异步 fire-and-forget：不阻塞启动；失败只记日志（第一层由 provisioning 钩子兜底）。
   * 覆盖场景：profile 被清空/重建、手工删掉平台段、插件被卸载。
   */
  private ensurePickerProfile(userId: string): void {
    const script =
      process.env.DSH_PICKER_ENSURE_SCRIPT ??
      ''
    if (!existsSync(script)) return
    try {
      const child = spawn('node', [script, '--user-id', userId], { detached: true, stdio: 'ignore' })
      child.on('error', (err) => {
        process.stderr.write(`[picker-ensure] spawn failed: ${err.message}\n`)
      })
      child.unref()
    } catch (err) {
      process.stderr.write(
        `[picker-ensure] failed for ${userId}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /** Stop the current main (clean) and respawn it with the same folder/patch. */
  async restartMain(userId: string): Promise<Instance | undefined> {
    const current = this.mains.get(userId)
    if (current === undefined) return undefined
    // 人工/接口触发的重启不是崩溃：重置计数，避免占用熔断预算。
    this.resetCrashState(userId)
    this.killInstance(userId, current)
    this.touch(userId)
    const instance = await this.spawnInstance(userId, 'main', current.folder, current.patch)
    await this.waitForLaunchToken(instance)
    return instance
  }

  /**
   * 重启实例并**探活**（功能插件启用后的可用性判定）。
   *
   * `restartMain` 内部已等 launch token（20s），但它吞掉了结论；这里叠加一个稳定窗口
   * 并给出显式判定，供调用方决定「保留该插件」还是「回滚 + 标记为不兼容」。
   * 返回 `ok:false` 时，调用方必须回滚——否则插件会把实例拖进崩溃循环（教训）。
   * 人工/接口触发的重启不计入熔断预算（`restartMain` 内已 resetCrashState）。
   */
  /**
   * 重启实例并**探活**（功能插件启用后的可用性判定）。
   *
   * 判定链：先确保有实例（无则按 /api/dsh/enter 同路径 launch 一个——否则 restartMain 返回
   * undefined，会把无辜插件误判为不兼容）→ 重启 → **轮询**到 launch token 且状态 running →
   * 再过稳定窗口确认没闪崩。任一步失败即返回 ok:false 并给出真实原因（例如 dsh 的
   * `duplicate loader entry id`），调用方据此回滚并标记该插件。
   *
   * 预算：launch/restartMain 内部各等 20s，这里再给 `budgetMs`（默认 60s）轮询——冷启动较慢的
   * 插件不该被误判（实测 2.5s 固定等待会把好插件判死）。
   */
  async restartAndProbe(userId: string, budgetMs = 60000): Promise<{ ok: boolean; reason: string }> {
    if (this.mains.get(userId) === undefined) {
      try {
        // 插件启用/隔离是平台自身的显式操作 → force 绕开熔断冷却
        // （否则「插件把实例搞崩 → 熔断 → 想自动禁用该插件」会被自己的冷却挡住）。
        await this.launch(userId, workspaceRoot(userRoot(this.config.dataRoot, userId)), undefined, {
          force: true,
        })
      } catch (err) {
        return { ok: false, reason: `实例启动异常：${err instanceof Error ? err.message : String(err)}` }
      }
    } else {
      const inst = await this.restartMain(userId)
      if (inst === undefined) return { ok: false, reason: "实例未启动" }
      await this.spawnWatchdog(userId)
    }

    const deadline = Date.now() + budgetMs
    let lastReason = ""
    while (Date.now() < deadline) {
      const m = this.mains.get(userId)
      if (m === undefined) return { ok: false, reason: "重启后实例消失" }
      if (m.status === "crashed" || m.status === "stopped") return { ok: false, reason: m.lastError ?? "实例启动后崩溃" }
      if (m.launchToken !== undefined) {
        // 稳定窗口：拿到 token 后立刻崩的插件也算失败（避免"闪一下就死"被当作成功）。
        await new Promise((resolve) => setTimeout(resolve, 2500))
        const a = this.mains.get(userId)
        if (a === undefined) return { ok: false, reason: "重启后实例消失" }
        if (a.status === "crashed" || a.status === "stopped") { lastReason = a.lastError ?? "实例启动后崩溃"; continue }
        if (a.launchToken !== undefined) return { ok: true, reason: "" }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { ok: false, reason: lastReason !== "" ? lastReason : "实例启动超时（未产出 launch token）" }
  }

  /** Restart every running main so a swapped global API key takes effect. */
  async restartAllMains(): Promise<void> {
    for (const userId of [...this.mains.keys()]) {
      try {
        await this.restartMain(userId)
      } catch (err) {
        // One user's spawn failure must not abort the broadcast restart.
        console.error(`restartAllMains: restart ${userId} failed`, err)
      }
    }
  }

  /** Spawn a one-shot watchdog for the user's current main (repair / execute). */
  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    if (!this.config.enablePatch) return undefined // watchdog needs the runtime patch
    if (this.watchdogs.has(userId)) return this.watchdogs.get(userId)
    const main = this.mains.get(userId)
    if (main === undefined) return undefined
    return await this.spawnInstance(userId, 'watchdog', main.folder, main.patch)
  }

  /** Current main + watchdog for a user. */
  async status(userId: string): Promise<UserStatus> {
    return { main: this.mains.get(userId), watchdog: this.watchdogs.get(userId) }
  }

  /**
   * 整机视角的实例清单（T08 S3：worker agent 的 `/instances` 用）。
   *
   * 口径 = **每个用户的 main 实例**（watchdog 是一次性 headless，不进对账口径）。
   * 设计上这是 `/instances` "一次拿回整机"的实现，替代逐用户查询（设计 §11.6）。
   */
  listUserInstances(): Instance[] {
    return [...this.mains.values()]
  }

  /**
   * 当前 main 实例的 launch token（T08 S3 P0-6）。
   *
   * 本地模式下 token 从子进程 stdout 解析出来；跨机后 **agent 必须把它回传 Manager**，
   * 否则「登录直达会话」（/13/15）与实例侧 401 自愈（/50/51）都会失效。
   */
  launchTokenOf(userId: string): string | undefined {
    return this.mains.get(userId)?.launchToken
  }

  /** Endpoint the proxy forwards to (local → the running main's loopback port). */
  async endpointFor(userId: string): Promise<Endpoint | undefined> {
    const port = this.mains.get(userId)?.port
    return port === undefined ? undefined : { host: '127.0.0.1', port }
  }

  /** 等待该用户 main 实例打印 launch token（本地模式启动完成信号），供 enter 复用分支
   * 在返回打开 URL 前调用；无实例/已崩溃/已停则立即返回。 */
  async waitForLaunchTokenForUser(userId: string, timeoutMs = 20000): Promise<void> {
    const main = this.mains.get(userId)
    if (main === undefined) return
    await this.waitForLaunchToken(main, timeoutMs)
  }

  /** Stop both processes for a user (cancelling any pending restart). */
  async stop(userId: string): Promise<void> {
    const timer = this.restartTimers.get(userId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.restartTimers.delete(userId)
    }
    const main = this.mains.get(userId)
    const watchdog = this.watchdogs.get(userId)
    if (main !== undefined) this.killInstance(userId, main)
    if (watchdog !== undefined) this.killInstance(userId, watchdog)
    this.mains.delete(userId)
    this.watchdogs.delete(userId)
    this.lastActive.delete(userId)
    this.resetCrashState(userId)
  }

  /**
   * 覆盖网络线 序 ㉘ → 单 A（候选 `B`）：**退出路径不再停任何实例**。
   *
   * 改前语义 = 清 `reapTimer` ＋ 逐个 `stop(userId)`（把在册实例全杀掉）⇒ 进程一重启，实例
   * scope 随主进程一起消失 ⇒ 启动认领 `rehydrateAdoptedScopes()` 永远扫不到存量
   * ⇒ 「Manager 重启后逐步拉起既有实例」**不可能成立**（序 ㉕ 已实测的真凶）。
   *
   * 改后：**只停本进程自己的定时器**，实例留给下一个进程。回收责任移交给下面三条：
   *   ① `rehydrateAdoptedScopes()` —— 启动时扫 OS 层既有 scope ⇒ 探活 ⇒ 活的认领 / **端口不通**的停掉；
   *   ② `cleanStaleScopes(uid)` —— 用户访问 / spawn 前清同 uid（**本体**，⛔ 不许删）；
   *   ③ idle-reap —— 缺省 60 s 间隔 / TTL 7 天 / 每 host 上限 4（`src/config.ts:300-302`）。
   *
   * ⛔ **不许**在退出路径里停实例、也**不许**向远端下发停止 —— 停止实例的正路是 `stop(userId)`
   * （由路由层在用户**显式**停实例时调用），⛔ 不是退出路径。机器断言见
   * the regression suite ＋ 探针 `OBS-22`。
   * ⚠️ 边界（如实）：`launchToken` 不可恢复 ⇒ 重启后 `enter` 仍可能 503，存量实例要在用户**下次访问**
   * 时被 `cleanStaleScopes` 自然替换。收益 = 「不被杀 ＋ 访问时自然替换」，⛔ **不是**「重启后直接可用」。
   * 🔙 回滚 = 把下面那行循环加回来 ⇒ 秒级（本单 §6 路 A / 路 B）。
   */
  async teardown(): Promise<void> {
    // ⛔ 退出不停实例（guard: teardown-must-not-stop-instances）
    if (this.reapTimer !== undefined) clearInterval(this.reapTimer)
  }

  /** No-op: the control plane owns the volume and touches it in-process. */
  async ensureFileService(_userId: string): Promise<void> {}

  private handoffPath(userId: string): string {
    return handoffPath(userRoot(this.config.dataRoot, userId))
  }

  /**
   * 预置默认工作区（幂等，仅在工作区列表为空时写入）：
   * 把 `<userRoot>/ws` 以短标题「我的工作区」写进 `<home>/storages/workspace.json`，
   * 使新用户/清空后无需手动选择工作区即可开始会话；已有工作区时**不覆盖**用户现状。
   * 失败不阻断启动（只记日志）。
   */
  private async seedDefaultWorkspace(userId: string): Promise<void> {
    const root = userRoot(this.config.dataRoot, userId)
    const dir = join(homeRoot(root), 'storages')
    const file = join(dir, 'workspace.json')
    try {
      mkdirSync(dir, { recursive: true })
      let existing: { global?: { workspaceIds?: unknown } } | undefined
      try {
        existing = JSON.parse(readFileSync(file, 'utf8')) as { global?: { workspaceIds?: unknown } }
      } catch {
        existing = undefined
      }
      const ids = existing?.global?.workspaceIds
      if (Array.isArray(ids) && ids.length > 0) return // 已有工作区 → 尊重用户现状
      const ws = workspaceRoot(root)
      const id = randomUUID()
      const now = new Date().toISOString()
      const seed = {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
        tables: {
          workspaces: {
            [id]: { path: ws, title: '我的工作区', sessionIds: [], createdAt: now, updatedAt: now },
          },
        },
      }
      writeFileSync(file, JSON.stringify(seed, null, 2) + '\n')
      const uid = await this.resolveUid(userId)
      chownSync(file, uid, uid) // 实例以该 uid 运行，需可读写
      chownSync(dir, uid, uid)
      process.stderr.write(`[seed-workspace] ${userId} → ${ws}\n`)
    } catch (err) {
      process.stderr.write(
        `[seed-workspace] failed for ${userId}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /** Materialize the rendered patch so the dsh CLI can `--patch <file>` it.
   * Per role, so a watchdog spawning alongside its main never races the file. */
  private writePatch(userId: string, role: InstanceRole, patch: string): string {
    const dir = join(userRoot(this.config.dataRoot, userId), 'patches')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${role}.yml`)
    writeFileSync(path, patch)
    return path
  }

  private async baseEnv(userId: string): Promise<Record<string, string>> {
    // R1-④：堆上限跟随「已启用插件集合」推导出的配额（不再写死 160）
    const memMb = instanceMaxMb()
    const root = userRoot(this.config.dataRoot, userId)
    const home = homeRoot(root)
    const workspace = workspaceRoot(root)
    const apiKey = await this.resolveApiKey(userId)
    return {
      ...scrubEnv(process.env),
      // HOME drives the child's directory picker default (homedir()); point it
      // at the user's workspace so their folders show, not DSH's internal home.
      HOME: workspace,
      // DSH's own state (profiles/sessions/credentials) stays in `home`.
      DSH_HOME: home,
      // Shared read-only skill directory (dsh-skill-filesystem bundled layer,
      // rank 600). Present only when configured.
      ...(this.config.bundledSkillDir !== '' ? { DSH_BUNDLED_SKILL_DIR: this.config.bundledSkillDir } : {}),
      // 复用官方权限逻辑，只改「默认档位」。dsh-base 的 cordis.patch.yml 读该 env：
      //   sandbox mode = DSH_PERMISSION_MODE；approval policy = (mode === 'danger-full-access' ? 'never' : 'ask')
      // 本机内核 5.10 无 Landlock、bwrap 后端在平台容器内探测失败 → 内置默认 workspace-write
      // 会 fail-closed 拒绝执行任何 shell（P0）。改 danger-full-access = 不在实例内再叠加沙箱，
      // 隔离交由平台容器（bwrap + uid + cgroup）负责，且不再逐条弹审批确认。
      // 用户仍可在实例「设置 → 权限」里用官方 UI 自行切回。运维可用同名 env 覆盖。
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? 'danger-full-access',
      // **冻结基础运行时版本**，禁止用户升级 Python / pip / node 造成版本漂移。
      // 已经天然成立的护栏：`/usr` 是 ro-bind → 实例内**改不了** `/usr/local/dsh-runtime/**`
      // （pip 默认 install 直接被 Read-only 挡）、`npm/pnpm -g` 也失败、`$HOME/.local/bin`
      // 不在实例 PATH 里（PATH 固定为 /usr/local/bin:/usr/bin:/bin）。
      // 唯一剩下的缝是 **Python 的 user-site**：一旦 pip 创建 `$HOME/.local/lib/python3.12/
      // site-packages`，它就会进入 sys.path 且**排在平台 site-packages 之前** → 用户装的同名包
      // 会盖住平台包（2026-09-11 实测：`import packaging` 拿到用户版 26.3）。故：
      //   · PYTHONNOUSERSITE=1 → user-site 不进 sys.path（平台包永不被盖）
      //   · PYTHONUSERBASE=/usr/local/dsh-runtime/.no-user-install → `pip install --user`
      //     尝试写在只读位 → **明确报权限错**（而不是"装上了却不生效"）
      // 引导：需要额外依赖 → `pip install --target <ws>/.pylibs` + PYTHONPATH，或自建 venv（不改平台）。
      PYTHONNOUSERSITE: '1',
      PYTHONUSERBASE: '/usr/local/dsh-runtime/.no-user-install',
      // （2026-09-12）：给实例内所有 node 进程设「内存上限 + 编译缓存」。
      //
      // 为什么必须设 --max-old-space-size：实测一个刚起的实例私有内存 106~117 MiB、
      // 峰值 VmHWM 206~209 MiB，而 **V8 的默认堆上限是按宿主物理内存推算的**
      // （本机 1870 MiB → heap_size_limit **960 MiB**），它**感知不到 cgroup 的 MemoryMax**。
      // 后果是内存真涨起来时先撞**内核 SIGKILL**（无优雅退出、无 stderr、日志查不到死因），
      // 而不是 V8 自己触发 GC 并抛 JS 异常。设 256 MiB 的依据：dsh 实测老生代仅 27~30 MiB，
      // 三倍余量足够；作用是把「失控上限」从 960 压到 256，让 V8 先 GC、不够就抛可诊断的 JS 错。
      // 该 env 会被实例内子进程继承（用户自己跑 node 也受限），用户可 `NODE_OPTIONS= node …` 覆盖。
      // 运维可用 DSH_INSTANCE_NODE_OPTIONS 整体覆盖（与 DSH_PERMISSION_MODE 同风格）。
      //
      // 为什么设 NODE_COMPILE_CACHE（Node 22+ 官方特性；本机 v22.23.2 实测
      // `module.enableCompileCache` 为函数、可用）：dsh 是 **223 个包 / 717 个 JS 文件 /
      // 21.2 MB 源码**的大单体，实测私有内存里 **88 MiB 是 [anon] 段** —— 主要就是 V8
      // 为这些文件即时生成的机器码（code range）。给出缓存目录后编译产物落盘复用，
      // 冷启动不必每次重编译，直接削启动开销与峰值。
      // 目录选 <userRoot>/home/.node-compile-cache：不放 ws（会被 ws-cleanup 按平台产物清理）、
      // 不放 /tmp（实例的 /tmp 是私有的，每次重建会丢）。
      // R1-④：堆上限跟随配额（160 是的旧下调值，已不再写死）
      NODE_OPTIONS: withHeap(process.env.DSH_INSTANCE_NODE_OPTIONS, memMb),
      NODE_COMPILE_CACHE: join(home, '.node-compile-cache'),
      // dsh-univer-office 的 bundled Gateway 默认监听 TCP loopback，但本平台实例的 uid
      // 被 nft 拒绝连 127.0.0.0/8（**连它自己 spawn 的 gateway 也连不上**）→ 该插件改用 unix
      // socket。由平台 env 控制：**不设 = 插件保持原 TCP 行为**（回滚只需删掉这个 env）。
      ...(process.env.DSH_INSTANCE_UNIVER_SOCKET === undefined
        ? {}
        : { UNIVER_DSH_GATEWAY_SOCKET: process.env.DSH_INSTANCE_UNIVER_SOCKET }),
      // Each user's own key; omit entirely when unset so the harness reports
      // "no key" instead of a header-hostile value.
      ...(apiKey !== null ? { DEEPSEEK_API_KEY: apiKey } : {}),
    }
  }

  private async spawnInstance(userId: string, role: InstanceRole, folder: string, patch?: string): Promise<Instance> {
    const isMain = role === 'main'
    // 覆盖网络 S3：端口来自**本机专属区间**（未配 env ⇒ 退回旧的 `listen(0)`）。
    // 为什么不能用 `listen(0)`：跨机实例的隧道落点全挤在 Manager 的 `127.0.0.1`，
    // 两台 worker 各自随机取端口就会撞号，而 `-R` 失败是**静默**的 ⇒ 会拨到别人的实例。
    const port = isMain ? await findInstancePort(this.config.instancePortBase, this.config.instancePortSpan) : undefined
    const instance: Instance = {
      id: randomUUID(),
      userId,
      role,
      folder,
      port,
      status: 'starting',
      patch,
    }
    const map = role === 'main' ? this.mains : this.watchdogs
    map.set(userId, instance)

    // 注：曾在此预置默认工作区（seedDefaultWorkspace），但实测 dsh 启动时会按其注册表
    // 不变量（order 与 table 一致性）把外部写入的条目清理掉 → 该做法无效，已移除调用
    // （方法保留但不再使用，见 2026-09-11 记录）。工作区改由用户经官方 picker 自建。

    const [command = 'dsh', ...args] = this.config.dshCommand
    const launchArgs = ['--profile', role === 'main' ? 'web' : 'headless']
    // --patch is a launcher flag and must precede any app/inner args (--host/--port
    // for web, the task string for headless): dsh forwards the first unrecognized
    // token onward, so a trailing --patch reaches the app as an unknown option.
    // Off by default so the child boots even on older dsh versions.
    if (this.config.enablePatch && patch !== undefined) {
      launchArgs.push('--patch', this.writePatch(userId, role, patch))
    }
    if (role === 'main') {
      launchArgs.push('--host', '127.0.0.1', '--port', String(port))
    } else {
      launchArgs.push(WATCHDOG_TASK)
    }

    // R1-④：本实例的内存配额由「已启用插件集合」推导（算一次，传给 spawnAsUser 用）

    const memMb = instanceMaxMb()

    const env: Record<string, string> = {
      ...(await this.baseEnv(userId)),
      DSH_AI1NET_ROLE: role,
      DSH_AI1NET_HANDOFF_PATH: this.handoffPath(userId), // both roles: main writes, watchdog reads
    }
    if (isMain) {
      env.DSH_AI1NET_PORT = String(port)
    }

    // 单实例保证升到 OS 层 —— spawn 前清掉该 uid 名下未纳管的残留 scope，
    // 防止 portal 重启后旧 scope 变孤儿、与新实例并存（共享 profile → 会话/settings 冲突）。
    if (this.config.isolationMode === 'account') {
      this.cleanStaleScopes(await this.resolveUid(userId))
    }
    const { child, unit } = await this.spawnAsUser(userId, command, [...args, ...launchArgs], { cwd: folder, env }, role)
    if (unit !== undefined) instance.unit = unit
    this.trackChild(userId, instance, child)
    return instance
  }

  /** Spawn the child inside a bwrap sandbox (mount/pid isolation) with setpriv
   * uid isolation, under a systemd-run scope that enforces cgroup resource
   * limits. 只读挂载 /usr /lib64 /etc，只暴露用户根目录 + 每用户独立 /tmp，
   * 实例读不到宿主其他路径（含其他用户、DB、凭据）。返回 child + scope 名。 */
  private async spawnAsUser(
    userId: string,
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
    role: InstanceRole = 'main',
  ): Promise<{ child: ChildProcess; unit?: string }> {
    const stdio: StdioOptions = ['ignore', 'pipe', 'pipe']
    if (this.config.isolationMode !== 'account') {
      return { child: spawn(command, args, { ...options, stdio }) }
    }
    const uid = await this.resolveUid(userId)
    const root = userRoot(this.config.dataRoot, userId)
    // 每用户独立 tmp（1777）：bwrap 的 --tmpfs 权限是 755，dsh spill-local 需 mkdtemp /tmp
    const tmpDir = join(root, 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    chmodSync(tmpDir, 0o1777) // mkdirSync 的 mode 受 umask 掩码，显式 chmod 保证 1777

    const bwrapArgs = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib64', '/lib64',
      // 2026-09-11 修复（实例内 AI 能力核查）：合成根缺 /bin /sbin /lib 会导致
      // dsh 的沙箱后端探针 execvp 失败（dsh-sandbox-local 在 Linux 优先用 bwrap，
      // Landlock 需内核>=5.13，al8 为 4.19 故不可用）→ SANDBOX_UNAVAILABLE →
      // 实例内 bash 工具被整体拒绝（"refusing to run the command unconfined"）。
      // 用符号链接补齐标准布局（不扩大可见面：仅 /bin /sbin /lib 三个链接）。
      '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/sbin', '/sbin',
      '--symlink', 'usr/lib', '/lib',
      // 2026-09-11（用户要求「实例只能读到自己那份」）：
      // /etc 由「整体只读挂载」收窄为「空 tmpfs + 文件白名单」。
      //
      // 动机：整体挂载会让每个实例读走 /etc 下 576 个 others-readable 文件，其中包含
      // **平台情报**——/etc/systemd/system/dsh-*.{service,path}（4）、
      // /etc/nftables-dsh-egress.nft（出网护栏规则全文）、/etc/cron.d/dsh-*（2）、
      // /etc/letsencrypt/renewal/*.conf。等于把平台架构与护栏策略交给每个租户。
      // （凭据类 dsh_ai1net.env / shadow / gshadow / sudoers 本就 600/0000，读不到，
      //   本次不涉及；/usr 经审计无任何凭据。）
      //
      // 白名单 = 运行时实测必需的最小集（§验证记录）：
      //   node / dsh --version / os.userInfo / DNS / node-TLS / curl 200 全通，
      //   `dsh --profile web --dump-config` 收窄前后 **544 行 / 170 个 @deepseek-ai 插件逐字一致**。
      // 效果：/etc 可见项 222 → 12，可读文件 576 → 26，平台情报 4/1/2/8 → 0/0/0/0。
      // 注意：symlink 必须绑其 **realpath 目标到 symlink 原路径**，否则实例内是断链
      //（/etc/nsswitch.conf → /etc/authselect/nsswitch.conf、/etc/localtime → /usr/share/zoneinfo/…）。
      '--tmpfs', '/etc',
      ...(() => {
        const allow = [
          '/etc/ld.so.cache', // 动态链接器缓存（node 启动必需）
          '/etc/ld.so.conf',
          '/etc/passwd', // os.userInfo() / uid→name
          '/etc/group',
          '/etc/nsswitch.conf', // DNS 解析（symlink）
          '/etc/hosts',
          '/etc/resolv.conf',
          '/etc/host.conf',
          '/etc/services',
          '/etc/localtime', // 时区（symlink）
          '/etc/os-release',
          '/etc/machine-id',
          '/etc/pki/tls/certs', // CA bundle（curl / 系统 TLS）
          '/etc/pki/ca-trust',
          // 2026-09-11 修正（补丁）：**符号链接枢纽目录，必须整体挂**。
          // 漏掉它的后果（实测）：`/usr/bin/python3 -> /etc/alternatives/python3 -> /usr/bin/python3.6`，
          // 中间一跳在 /etc → 沙箱内断链 → **21 个命令静默失效**：python3 / python / pip3 / pip-3 /
          // pydoc3 / python3-config / pyvenv-3 / easy_install-3 / unversioned-python / ld(→ld.bfd) /
          // pax / print-* (lp,lpr,lpq,lprm,lpstat,cancel) / ifup / ifdown / lpc。
          // 其中 `python3`、`pip3`（装技能依赖）、`ld`（node-gyp 编译原生模块）都是我方场景的关键命令。
          // 该目录 33 项**全部指向 /usr 下的程序/man**（已只读挂载）→ **不含任何凭据或平台情报**，
          // 挂它不扩大实质可见面，只是让 /usr 里已有程序的软链重新生效。
          // ⚠️ 通用教训：`/etc` 白名单化时，必须用探测器找出**所有穿过 /etc 的符号链接**，逐个覆盖：
          //   find /usr/bin /usr/sbin /usr/libexec /usr/local/bin -maxdepth 1 | while read f; do
          //     [ -L "$f" ] || continue; c=$f; n=0
          //     while [ -L "$c" ] && [ $n -lt 10 ]; do t=$(readlink "$c")
          //       case $t in /*) c=$t;; *) c=$(dirname "$c")/$t;; esac
          //       case $c in /etc/*) echo "$f -> $c";; esac; n=$((n+1)); done
          //   done | sort -u
          '/etc/alternatives',
          // 2026-09-11 修正（同 alternatives 一类，**第二次踩**）：**`/etc/ssl` 必须挂**。
          // 漏掉它的后果（guest 会话实证）：宿主上 `/etc/ssl/certs/ca-bundle.crt` 存在，
          // 但实例内 `/etc/ssl` 不存在 → **Python（走 FHS 默认 CA 路径）found 不到 CA** →
          // `URLError(SSLCertVerificationError: self-signed certificate in certificate chain)`。
          // curl 之所以一直没事，是因为它读 `/etc/pki/tls/certs/ca-bundle.crt`（也在白名单里）。
          // `/etc/ssl` 只含 CA 证书（公开信息），**不含凭据/平台情报**，挂它不扩大实质可见面。
          // ⚠️ 判定准则再强调：**除"叶子文件"外，还要覆盖"整个目录类枢纽"**
          //   （`/etc/alternatives` 是软链枢纽、`/etc/ssl` 是 CA 根目录），否则会静默打断一整类工具。
          '/etc/ssl',
        ]
        const out: string[] = []
        // 2026-09-15（T08 S1.6）**中间挂载点必须可穿越（0755）**。
        //
        // 现象（OpenCloudOS 9.6 实测）：实例起不来，子进程报
        //   `/usr/bin/node: OpenSSL configuration error: … Permission denied:
        //    … fopen(/etc/ssl/openssl.cnf, rb)` ⇒ **exitCode 13**。
        // 根因：bwrap 会为 `--ro-bind-try /etc/pki/tls/certs …` 这类路径**自动补齐父目录**，
        //   而这些自动创建的目录权限是 **0700（drwx------ root:root）** ⇒ 非 root 的实例
        //   **无法穿越**；宿主上 `/etc/ssl/openssl.cnf` 恰好是**指向 `/etc/pki/tls/openssl.cnf`
        //   的符号链接** ⇒ 解析要穿过 `/etc/pki` → 被拒 → 报 **EACCES（不是 ENOENT）**
        //   → node 读 OpenSSL 配置**硬失败**。
        // 为什么 47 没事：Alibaba Cloud Linux 3 上**没有** `/etc/ssl/openssl.cnf`
        //   ⇒ node 静默跳过 ⇒ **同一份代码一台能跑、一台崩**（机器基线差异，设计 §14.3）。
        // 修法：在绑定**之前**把白名单路径在 `/etc` 下的所有中间目录显式建成 0755。
        // 权限**不扩大**：`/etc` 在本沙箱里是 tmpfs，这些目录里只有下面白名单绑定的内容，
        //   不新增任何宿主可见面。（"整绑 `/etc/pki`"的替代方案已否决 —— 会顺带带入
        //   `/etc/pki/tls/private/postfix.key`，违反 **R5 权限只准收窄**。）
        // 注意顺序：由外到内（内层挂载点要求外层已存在）。
        const intermediates = new Set<string>()
        for (const p of allow) {
          for (const d of mountParentDirList(p, '/etc')) intermediates.add(d)
        }
        for (const d of [...intermediates].sort((a, b) => a.split('/').length - b.split('/').length)) {
          out.push('--tmpfs', d) // 见 mountParentDirArgs 的注释：`--tmpfs` 自带 0755 且兼容 bwrap 0.4.0
        }
        for (const p of allow) {
          let src = p
          try {
            src = realpathSync(p) // symlink → 解析到真实文件
          } catch {
            continue // 该机器上不存在则跳过（--ro-bind-try 语义）
          }
          out.push('--ro-bind-try', src, p)
        }
        return out
      })(),
      // ── 所有挂载点的**中间目录**统一在这里建好（T08 S1.6 修正版）────────────────
      // 为什么必须"统一前置 + 去重 + 由外到内"（2026-09-15 实测踩到的真 bug）：
      //   用户根（`--bind root root`）与共享技能层（`--ro-bind-try skill skill`）**可能嵌套在
      //   同一前缀下**。若按"就近创建"把技能层的中间目录插在 `--bind root root` **之后**，
      //   那么后挂的 `--tmpfs <共同祖先>` 会把**已经绑好的用户根整个遮掉** ⇒ bwrap 报
      //   `Can't chdir to <userRoot>/ws/xxx: No such file or directory` ⇒ 实例崩溃循环。
      //   前置 + 去重后，中间目录只建一次，后续所有 bind 都落在它里面，谁也不遮谁。
      // 权限不扩大：这些目录里只有随后绑定的白名单内容。
      ...(() => {
        const dirs = new Set<string>()
        for (const dest of [root, this.config.bundledSkillDir].filter((d) => d !== '')) {
          for (const d of mountParentDirList(dest, '/')) dirs.add(d)
        }
        return [...dirs]
          .sort((a, b) => a.split('/').length - b.split('/').length)
          .flatMap((d) => ['--tmpfs', d])
      })(),
      '--dev', '/dev', '--proc', '/proc',
      '--bind', tmpDir, '/tmp',
      '--bind', root, root,
      // 2026-09-11（P0 修复，收尾）：**共享技能层必须真的挂进命名空间**。
      // `@deepseek-ai/dsh-skill-filesystem` 是在**实例内** `resolve(config.bundledSkillDir ??
      // process.env.DSH_BUNDLED_SKILL_DIR)` 之后**直接读盘**（lib/index.js:84,181），不是编排器
      // 推数据 → 光注入 env 没用，目录必须可见。此前只注入了 env 未挂载 → /11 的共享
      // 技能层「投了也发现不了」（实例内 ls = No such file or directory）。
      //
      // 权限**不扩大**（2026-09-11 以平台原样参数 + 本行实测）：
      //   · mountinfo = `…/bundled-skills → 同名  ro,nosuid,nodev` → **精确叶子路径 + 只读**
      //   · `ls …/users/` **只列用户自己那一个**；读 DB = No such file；`touch` 挂载点 = Read-only
      //   · 对照组（不加本行）里父目录同样存在（bwrap 为用户 root 合成的），**不是本行新暴露的**
      // ⛔ 绝不可写成挂父目录（`--ro-bind <dataRoot> <dataRoot>`）= 一次性把全部用户 home +
      //    DB + 凭据放进每个实例。改完必须逐字复核 args 并重跑可见面实测。
      // 必须放在 '--bind root root' **之后**（bwrap 后写覆盖前写）。
      ...(this.config.bundledSkillDir !== ''
        ? (['--ro-bind-try', this.config.bundledSkillDir, this.config.bundledSkillDir] as string[])
        : []),
      // 2026-09-11（v3 收尾 / ）：平台策略文件在实例内**只读**。
      // 威胁模型：用户可把 <userRoot>/home/profiles/web 加为工作区，随后用 bash 直接改写
      // cordis.patch.yml（去掉平台段 → 恢复全盘 picker）或 package.json（挂任意 bundle）→
      // 属"绕过平台策略"（跨租户仍不成立，uid/bwrap 隔离不变）。
      // 只读三个文件；**不动 cordis.yml**——实测 dsh 启动时会写它（01:16:22），ro 会导致启动异常。
      // 注意：必须放在 '--bind root root' **之后**（bwrap 后写覆盖前写）。
      ...(() => {
        const profileDir = join(homeRoot(root), 'profiles', role === 'main' ? 'web' : 'headless')
        const protectedFiles = ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']
        const out: string[] = []
        for (const name of protectedFiles) {
          const file = join(profileDir, name)
          out.push('--ro-bind-try', file, file)
        }
        return out
      })(),
      '--unshare-pid',
      '--chdir', options.cwd,
      '--', 'setpriv', '--reuid', String(uid), '--regid', String(uid), '--clear-groups', command, ...args,
    ]

    const unit = `dsh-${uid}-${randomUUID().slice(0, 8)}`
    // R1-④：cgroup 上限由「已启用插件集合」推导（原先写死 384M；见文件头注释的事故）
    const memMb = instanceMaxMb()
    // （2026-09-12）：MemoryMax 512M → 384M。
    // 依据（全部来自实测，见 scripts/probe-instance-mem.cjs）：
    //   · dsh 自身私有内存稳态 106~117 MiB、峰值约 145 MiB（= VmHWM 206 减去共享的 62 MiB
    //     node 运行时页）；两个不同用户冷启动同量 → 这是**基座成本**而非用户行为。
    //   · 384 - 145 = **239 MiB 留给用户任务**（python / ffmpeg / pip 编译原生模块），
    //     覆盖绝大多数场景；而同样的重任务在 512 下也大概率超限，故不是本次新引入的风险。
    // 作用范围要看清：MemoryMax 是**上限而非预留**（systemd 不预扣），所以它**不决定并发数**
    //   （并发由宿主 2 核 / 1870 MiB 与实时 available 决定）；降它的真实收益是
    //   **收窄单实例失控（内存泄漏/重任务）时的破坏半径**，给同宿主其他实例留活路。
    // 若实例被 cgroup OOM kill：该实例的 scope 会非 0 退出 → 编排器按崩溃退避重启，
    //   并写结构化日志；只影响该租户，不波及其他实例（uid + cgroup 隔离）。
    // 回滚：把 384M 改回 512M，npm run build，drain + 重启 dsh_ai1net。
    // 配套：baseEnv 里的 NODE_OPTIONS=--max-old-space-size=256 才是**主动**让 V8 提前 GC
    //   的那一层；本行是兜底硬限。两者一起看才有意义。
    const sdArgs = [
      '--scope', '--unit', unit,
      '-p', 'MemoryHigh=' + instanceBaseMb() + 'M',   // **基础**（软限，超过即回收/限速）
      '-p', 'MemoryMax=' + memMb + 'M',               // **上界**（硬限，越界 OOM）
      '-p', 'CPUQuota=150%',
      '-p', 'TasksMax=128',
      '--', 'bwrap', ...bwrapArgs,
    ]
    return { child: spawn('systemd-run', sdArgs, { ...options, stdio }), unit: `${unit}.scope` }
  }

  /** 等待 dsh web 在 stdout 打印 launch token（最多 timeoutMs），用于拼装可直达的打开 URL。 */
  private async waitForLaunchToken(instance: Instance, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (instance.launchToken === undefined && Date.now() < deadline) {
      if (instance.status === 'crashed' || instance.status === 'stopped') return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  private trackChild(userId: string, instance: Instance, child: ChildProcess): void {
    this.children.set(instance.id, child)
    child.on('spawn', () => {
      instance.status = 'running'
      instance.pid = child.pid ?? undefined
      // 稳定判定：连续运行达 crashStableMs 视为已恢复 → 重置退避步数。
      if (instance.role === 'main') this.armStableReset(userId, instance)
      if (instance.role === 'main' && instance.port !== undefined && this.portGuard !== undefined) {
        try {
          this.portGuard.install(instance.port)
        } catch (error) {
          // Fail closed: without the port guard a co-tenant could reach this
          // DSH's loopback RPC directly. Kill the just-spawned child and mark
          // the instance crashed rather than serve unguarded.
          instance.status = 'crashed'
          instance.lastError = error instanceof Error ? error.message : String(error)
          child.kill('SIGKILL')
        }
      }
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      process.stdout.write(text)
      if (instance.role === 'main' && instance.launchToken === undefined) {
        const m = /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(text)
        if (m !== null && m[1] !== undefined) instance.launchToken = m[1]
      }
    })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048)
      // Also surface the child's stderr on the orchestrator's own stderr so a
      // boot crash is visible in journald instead of only in lastError.
      process.stderr.write(`[dsh-child ${instance.role}] ${chunk.toString()}`)
    })
    child.on('error', (err) => {
      instance.status = 'crashed'
      instance.lastError = err.message
      this.children.delete(instance.id)
    })
    child.on('exit', (code) => {
      instance.exitCode = code ?? undefined
      this.children.delete(instance.id)
      // Release the loopback port guard as soon as the main's process is gone
      // (explicit stop, restart, and crash all funnel through this handler).
      if (instance.role === 'main' && instance.port !== undefined) {
        this.portGuard?.remove(instance.port)
      }
      const map = instance.role === 'main' ? this.mains : this.watchdogs
      // Only act if this instance is still the current one (avoid a stale
      // exit handler touching a freshly restarted instance).
      if (map.get(userId)?.id !== instance.id) return
      if (instance.status === 'stopped') {
        map.delete(userId)
        return
      }
      // A one-shot watchdog that finished cleanly is not restarted.
      if (instance.role === 'watchdog' && code === 0) {
        instance.status = 'stopped'
        map.delete(userId)
        return
      }
      instance.status = 'crashed'
      instance.lastError = stderrTail.slice(-500) || undefined
      if (instance.role === 'main') {
        void this.spawnWatchdog(userId)
        this.scheduleCrashRestart(userId, instance)
      } else {
        map.delete(userId)
      }
    })
  }

  /** 崩溃策略参数（均来自 ServerConfig，可用 env 覆盖）。 */
  private crashPolicy(): CrashPolicyConfig {
    return {
      baseDelayMs: this.config.restartBackoffMs,
      maxDelayMs: this.config.restartBackoffMaxMs,
      windowMs: this.config.crashWindowMs,
      maxRestartsInWindow: this.config.crashMaxRestarts,
      stableResetMs: this.config.crashStableMs,
    }
  }

  /** 熔断冷却参数（均来自 ServerConfig，可用 env 覆盖）。 */
  private breakerPolicy(): BreakerPolicy {
    return {
      baseCooldownMs: this.config.crashBreakerCooldownMs,
      maxCooldownMs: this.config.crashBreakerMaxCooldownMs,
    }
  }

  /** 结构化自愈日志（stderr → journald，可 grep `event=instance-restart`）。 */
  private crashLog(payload: Record<string, unknown>): void {
    process.stderr.write(`[crash-restart] ${JSON.stringify(payload)}\n`)
  }

  /**
   * 熔断**告警**（原来只写一行 stderr，等于没有告警）。
   *
   * 双通道：① stderr → journald（`journalctl -u dsh_ai1net | grep crash-breaker`）；
   * ② 追加 `/var/log/dsh-crash-breaker.log`（与其它巡检日志同习惯，便于定时巡检 / `tail`）。
   * **只告警、不处置** —— 要不要人工介入由人判断；平台只保证「有痕迹、可 grep、冷却有界」。
   * 写文件失败不影响主流程（best-effort）。
   */
  private alertBreaker(payload: Record<string, unknown>): void {
    process.stderr.write(`[crash-breaker] ${JSON.stringify(payload)}\n`)
    const logPath = process.env.DSH_CRASH_BREAKER_LOG ?? '/var/log/dsh-crash-breaker.log'
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(payload)}\n`)
    } catch {
      /* 无权限 / 路径不存在不致命：stderr 那条仍在 */
    }
  }

  /**
   * 冷却期内拒绝隐式启动；冷却已过则清掉熔断态、放行一次干净尝试。
   *
   * **刻意不放进 `resetCrashState()`** —— 那个函数被显式启动调用，而熔断态必须
   * **跨轮存活**，否则又回到「熔断即清预算 ⇒ 无限重来」。
   */
  private assertBreakerClosed(userId: string): void {
    const b = this.breaker.get(userId)
    if (b === undefined) return
    const cfg = this.breakerPolicy()
    const now = Date.now()
    if (breakerActive(b, now, cfg)) {
      const until = breakerUntil(b, cfg)
      this.crashLog({
        event: 'crash-breaker-reject',
        userId,
        opens: b.opens,
        cooldownUntil: until,
        retryAfterMs: until - now,
      })
      throw new CrashBreakerOpenError(userId, until, b.opens)
    }
    this.breaker.delete(userId)
    this.crashLog({ event: 'crash-breaker-cooldown-expired', userId, opens: b.opens })
  }

  /** 清掉熔断态（平台自身显式操作：插件启用/隔离、admin 重启）。 */
  private clearBreaker(userId: string, reason: string): void {
    if (this.breaker.delete(userId)) {
      this.crashLog({ event: 'crash-breaker-cleared', userId, reason })
    }
  }

  /** 观测面：当前用户的熔断状态（无则 null）。 */
  breakerInfo(userId: string): { opens: number; openedAt: number; cooldownUntil: number } | null {
    const b = this.breaker.get(userId)
    if (b === undefined) return null
    return { opens: b.opens, openedAt: b.openedAt, cooldownUntil: breakerUntil(b, this.breakerPolicy()) }
  }

  /**
   * 观测面：把「本实例实际拿到的内存配额」透出来 —— 与 spawn 时用的是**同一个**
   * `instanceMemMb()` / `heapMbFor()`，因此不可能与实际 `MemoryMax` 对不上。
   *
   * 为什么需要它：实例内的客户端插件（`business-plugins` 的「功能管理」）看不到 cgroup，
   * 过去只能自建一套估算表 —— 而第二份副本**必然漂**（2026-09-13 实测：插件显示 388 MiB
   * 并报「⚠ 将超出上限」，而平台真实配额是 672 / 384，且 384 早已只是**下限**）。
   * 与其让第二份副本再漂一次，不如把已有值暴露出去、让前端读真值。
   */
  quotaInfo(userId: string): { baseMb: number; memMb: number; heapMb: number } | null {
    try {
      const memMb = instanceMaxMb()
      return { baseMb: instanceBaseMb(), memMb, heapMb: heapMbFor(memMb) }
    } catch {
      return null
    }
  }

  /** 清空某用户的崩溃计数（显式启动 / 人工重启 / 停机时调用）。 */
  private resetCrashState(userId: string): void {
    this.crashHistory.delete(userId)
    this.crashStreak.delete(userId)
    const stable = this.stableTimers.get(userId)
    if (stable !== undefined) {
      clearTimeout(stable)
      this.stableTimers.delete(userId)
    }
  }

  /** main 连续运行达 crashStableMs 即视为恢复：重置退避步数（窗口历史保留）。 */
  private armStableReset(userId: string, instance: Instance): void {
    const previous = this.stableTimers.get(userId)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.stableTimers.delete(userId)
      if (this.mains.get(userId)?.id !== instance.id) return // 已被新实例取代
      if (instance.status !== 'running') return
      if (this.crashStreak.delete(userId)) {
        this.crashLog({ event: 'instance-stable', userId, stableMs: this.config.crashStableMs })
      }
    }, this.config.crashStableMs)
    timer.unref()
    this.stableTimers.set(userId, timer)
  }

  /**
   * 插件加载失败自愈（2026-09-12 新增 · 插件不兼容事故修复）。
   *
   * 背景：门户「功能管理」启用插件走 `restartAndProbe` —— 探活失败会 `restoreProfile` +
   * 逐个隔离 + 自动禁用不兼容插件。但**不经过门户的路径**（`ensure-*.cjs`
   * 脚本直铺、手工改 profile）没有这一层；某个插件若与当前 dsh 版本不兼容（典型报错
   * `failed to import loader entry <entry> (<pkg>)`），实例会每次启动即崩，而
   * crash-restart 只止损不禁用 → 用户陷入「进不去」的死循环。
   *
   * 本方法补上这一层：从 `lastError` 解析出肇事的插件包名，把它从 profile 的
   * `package.json` bundles 摘掉，并清掉 `cordis.patch.yml` 里引用该包的条目
   * （否则 patch 中指向它的字段会报 `CONFIGURED_MISSING` 之类）。**只动 profile 的
   * 文本文件，不碰 node_modules**（重装很快，回滚 node_modules 反而易碎）。
   *
   * @returns 摘掉的包名；未命中或修复失败返回 `undefined`
   */
  private tryHealPluginFailure(userId: string, lastError: string | undefined): string | undefined {
    if (lastError === undefined || lastError === '') return undefined
    const m = /failed to import loader entry \S+ \(([^)]+)\)/.exec(lastError)
    if (m === null) return undefined
    const pkg = m[1]
    // 防御：只接受合法包名形状，避免把异常文本当路径用。
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg)) return undefined

    const dir = join(userRoot(this.config.dataRoot, userId), 'home', 'profiles', 'web')
    try {
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) return undefined
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dsh?: { profile?: { bundles?: string[] } }
      }
      const bundles = parsed.dsh?.profile?.bundles
      if (!Array.isArray(bundles) || !bundles.includes(pkg)) return undefined

      parsed.dsh!.profile!.bundles = bundles.filter((b) => b !== pkg)
      writeFileSync(pkgPath, JSON.stringify(parsed, null, 2) + '\n')

      // patch 里引用该包的条目一并清掉：删 `name: "<pkg>"` 行 + 紧邻在它上面的 `- id: …` 行。
      const patchPath = join(dir, 'cordis.patch.yml')
      if (existsSync(patchPath)) {
        const lines = readFileSync(patchPath, 'utf8').split('\n')
        const out: string[] = []
        for (const line of lines) {
          const t = line.trim()
          const quotes = `name: "${pkg}"`
          const single = `name: '${pkg}'`
          if (t === quotes || t === single || t === `name: ${pkg}`) {
            const prev = out[out.length - 1]
            if (prev !== undefined && /^\s*-\s*id:/.test(prev)) out.pop()
            continue
          }
          out.push(line)
        }
        writeFileSync(patchPath, out.join('\n'))
      }
      return pkg
    } catch (err) {
      process.stderr.write(
        `[plugin-heal] ${userId} ${pkg} 自愈失败：${err instanceof Error ? err.message : String(err)}\n`,
      )
      return undefined
    }
  }

  /**
   * 崩溃后的自动重启决策（方案 A）：
   * 指数退避（base → max）+ 窗口熔断（窗口内超过上限则停止自动重启并标记 failed）。
   */
  private scheduleCrashRestart(userId: string, instance: Instance): void {
    const cfg = this.crashPolicy()
    const now = Date.now()

    // ── 插件加载失败自愈（2026-09-12 新增 · 插件不兼容事故修复）─────────────
    // 走门户启用时，探活失败会回滚 profile 并自动禁用不兼容插件。但
    // **不经过门户的路径**（`ensure-*.cjs` 直铺、手工改 profile）没有这层保护：某个插件
    // 若与当前 dsh 版本不兼容，实例会每次启动即崩，而 crash-restart 只止损不禁用
    // → 用户陷入「进不去」的死循环（2026-09-12 admin 实例实测）。
    // 这里在重启决策**之前**先尝试摘掉肇事插件；摘掉成功就清空崩溃计数，给一次干净重启。
    const healedPlugin = this.tryHealPluginFailure(userId, instance.lastError)
    if (healedPlugin !== undefined) {
      this.crashLog({ event: 'plugin-auto-disabled', userId, plugin: healedPlugin, reason: 'plugin load failure' })
      this.resetCrashState(userId)
    }

    const history = this.crashHistory.get(userId) ?? []
    const streak = this.crashStreak.get(userId) ?? 0
    const decision = decideCrashAction(history, streak, now, cfg)

    instance.restarts = (instance.restarts ?? 0) + 1
    instance.lastCrashedAt = now

    if (decision.action === 'circuit-open') {
      // 熔断：停止自动重启，标记 failed；同时移除条目让用户重新 enter 时可重新 launch。
      // 修正：**不再「白送」满额预算** —— 记一次**跨轮存活**的熔断态，冷却期内
      // 拒绝隐式启动（`assertBreakerClosed`）。原实现在这里 resetCrashState() 把窗口历史
      // 一并清空 ⇒ 下一次 enter 又是满额预算 ⇒ 崩溃循环可以无限重来。
      instance.status = 'failed'
      this.mains.delete(userId)
      this.resetCrashState(userId)
      const bstate = openBreaker(this.breaker.get(userId), now)
      this.breaker.set(userId, bstate)
      const bcfg = this.breakerPolicy()
      const payload = {
        event: 'crash-loop-circuit-open',
        userId,
        opens: bstate.opens,
        cooldownMs: breakerCooldownMs(bstate.opens, bcfg),
        cooldownUntil: breakerUntil(bstate, bcfg),
        windowMs: cfg.windowMs,
        restartsInWindow: decision.windowRestarts,
        maxRestartsInWindow: cfg.maxRestartsInWindow,
        restarts: instance.restarts,
        lastError: instance.lastError?.slice(0, 200),
      }
      this.crashLog(payload)
      this.alertBreaker(payload)
      return
    }

    const nextHistory = pruneHistory(history, now, cfg.windowMs)
    nextHistory.push(now)
    this.crashHistory.set(userId, nextHistory)
    this.crashStreak.set(userId, streak + 1)
    this.crashLog({
      event: 'instance-restart',
      userId,
      attempt: decision.attempt,
      delayMs: decision.delayMs,
      restartsInWindow: decision.windowRestarts,
      restarts: instance.restarts,
      exitCode: instance.exitCode,
      lastError: instance.lastError?.slice(0, 200),
    })

    const timer = setTimeout(() => {
      this.restartTimers.delete(userId)
      void this.spawnInstance(userId, instance.role, instance.folder, instance.patch)
    }, decision.delayMs)
    timer.unref()
    this.restartTimers.set(userId, timer)
  }

  /* ── 序 ㉕：既有实例 scope 的「扫描 → 认领 → 错峰探活」 ──────────────────────
   *
   * ⛔ 三条自我约束（违反即等于放大的风险）：
   *   ① 只在 `isolationMode === 'account'` 下认领 —— 其它形态根本不产生 scope，
   *      此时**保持旧行为**（走 `cleanAllStaleScopes()`，实际是空操作）。
   *   ② 解析不出 / 同 uid 重复 / watchdog / 探活不通 ⇒ **一律按旧行为停掉**。
   *   ③ 认领**只登记 ＋ 探活**：⛔ 不 stop、⛔ 不 spawn、⛔ 不接管道、⛔ 不落任何凭据。
   *
   * 🔑 「孤儿」的判据 = **端口不通**，不是「启动了却不认识」：
   *   端口在听 ⇒ 它是**有效实例**（留着 = 与重启前稳态一致，用户/后台任务零中断）；
   *   端口不通 ⇒ 才是说的孤儿 ⇒ 按旧行为停掉。
   *   而"双实例共 profile"那一半由 `cleanStaleScopes(uid)`（spawn 前清同 uid）继续兜住 —— **本序未动**。
   */

  /** 节流间隔：逐条认领之间的最小时间差（⛔ 不落生产 env，只读进程环境取默认）。 */
  private rehydrateStaggerMs(): number {
    const n = Number(process.env.DSH_AI1NET_REHYDRATE_STAGGER_MS ?? '500')
    return Number.isFinite(n) && n >= 0 ? n : 500
  }

  /** 单条探活超时。 */
  private rehydrateProbeMs(): number {
    const n = Number(process.env.DSH_AI1NET_REHYDRATE_PROBE_MS ?? '2000')
    return Number.isFinite(n) && n > 0 ? n : 2000
  }

  /** 认领计数快照（供演练 / 探针断言，⛔ 只读）。 */
  rehydrateReport(): RehydrateReport {
    return { ...this.rehydrate, notes: [...this.rehydrate.notes] }
  }

  /**
   * 覆盖网络线 序 ㊽：**已认领且探活通过**的实例监听端口（worker agent 的对账口径之一）。
   *
   * 与 {@link listUserInstances} 的关系 = **互补，不合并**：那个的口径是"本进程 launch 过的"
   * （`mains`），这个是"本进程**接管**的"（`adopted`）。认领来的实例没有 `launchToken`、
   * 也进不了 `status(userId)`（文件头 序 ㉕ 的客观边界，⛔ 未改），但"**这个端口在听、且归本
   * worker 管**"与实例身份无关 ⇒ 该登记给 relay 就得登记（否则跨机代理查不到落点）。
   *
   * ⚠️ 只报 `alive === true` 的：探活没过的那条已被 `probeAdopted` 按旧行为停掉了，
   * 报出去只会让上游去登记一个死口。⛔ 未出生的探活（`alive === undefined`）同样不报。
   */
  adoptedInstancePorts(): number[] {
    const out: number[] = []
    for (const rec of this.adopted.values()) {
      if (rec.alive === true && rec.info.port !== undefined) out.push(rec.info.port)
    }
    return out.sort((a, b) => a - b)
  }

  /**
   * 序 ㊽：本轮 `schedule` 收尾 —— ⚠️ **探活可能还没落定**（异步）⇒ 只置标志，
   * 由 {@link probeAdopted} 的最后一条补射（见 {@link maybeRehydrateSettled}）。
   */
  private settleRehydrate(): void {
    this.rehydrateScheduled = true
    this.maybeRehydrateSettled()
  }

  /** 序 ㊽：`schedule` 走完 ＋ 在途探活归零 ⇒ **恰好通知一次**（幂等；回调抛错⛔不许拖垮编排器）。 */
  private maybeRehydrateSettled(): void {
    if (!this.rehydrateScheduled || this.pendingProbes > 0) return
    this.rehydrateScheduled = false
    try {
      this.onRehydrateSettled?.()
    } catch (err) {
      process.stderr.write(
        `[rehydrate] ⚠️ 落定回调抛错（已吞，不阻断）：${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  private rehydrateAdoptedScopes(): void {
    // 序 ㊽：新一轮认领起算 —— 上一轮的落定标志必须清掉（否则残留的 `true` 会让本轮提前通知）。
    this.pendingProbes = 0
    this.rehydrateScheduled = false
    // ① 非 account 形态不产生 scope ⇒ 保持旧语义（此处是空操作）。
    if (this.config.isolationMode !== 'account') {
      this.cleanAllStaleScopes()
      this.settleRehydrate()
      return
    }
    const found = this.scanExistingScopes()
    this.rehydrate.scanned = found.length
    if (found.length === 0) {
      process.stderr.write('[rehydrate] 无既有实例 scope ⇒ 不动作（与旧行为等价）\n')
      this.settleRehydrate()
      return
    }
    const perUid = new Map<number, number>()
    for (const s of found) perUid.set(s.uid, (perUid.get(s.uid) ?? 0) + 1)
    const stagger = this.rehydrateStaggerMs()
    const schedule = (i: number): void => {
      if (i >= found.length) {
        process.stderr.write(`[rehydrate] summary ${JSON.stringify(this.rehydrateReport())}\n`)
        this.settleRehydrate()
        return
      }
      const t = setTimeout(() => {
        const s = found[i]
        if (s !== undefined) this.adoptOne(s, (perUid.get(s.uid) ?? 0) > 1)
        schedule(i + 1)
      }, stagger)
      t.unref()
    }
    schedule(0)
  }

  private scanExistingScopes(): { unit: string; uid: number; desc: string }[] {
    const out: { unit: string; uid: number; desc: string }[] = []
    let listing: string
    try {
      listing = execFileSync('systemctl', ['list-units', '--type=scope', '--no-legend', '--plain'], {
        encoding: 'utf8',
        timeout: 10000,
      })
    } catch {
      // ⚠️ 列不出来 ⇒ **不杀任何东西**（与旧行为一致：旧代码的 catch 同样吞掉、不清不杀）
      process.stderr.write('[rehydrate] ⚠️ systemctl list-units 失败 ⇒ 本次不认领、不清理\n')
      return out
    }
    for (const line of listing.split('\n')) {
      const name = line.trim().split(/\s+/)[0]
      if (name === undefined || name === '') continue
      const uid = parseScopeUnitName(name)
      if (uid === undefined) continue
      out.push({ unit: name, uid, desc: this.scopeDescription(name) })
    }
    return out
  }

  /** 取 scope 的 `Description`（= `systemd-run` 记录的 argv）；取不到 ⇒ 空串 ⇒ 解析必失败 ⇒ 停。 */
  private scopeDescription(unit: string): string {
    try {
      return execFileSync('systemctl', ['show', unit, '-p', 'Description', '--value'], {
        encoding: 'utf8',
        timeout: 10000,
      }).trim()
    } catch {
      return ''
    }
  }

  private adoptOne(s: { unit: string; uid: number; desc: string }, dupUid: boolean): void {
    const info = parseScopeDescription(s.desc, s.uid)
    const action = decideScopeAction(info, dupUid)
    if (action.kind === 'stop') {
      this.rehydrate.stopped += 1
      const note = `stop ${s.unit} (${action.reason})`
      this.rehydrate.notes.push(note)
      process.stderr.write(`[rehydrate] ⛔ ${note}\n`)
      this.stopUnit(s.unit)
      return
    }
    const adopted: AdoptedScopeInfo = info as AdoptedScopeInfo
    const rec: AdoptedScope = { unit: s.unit, uid: s.uid, info: adopted, adoptedAt: Date.now() }
    this.adopted.set(s.unit, rec)
    this.rehydrate.adopted += 1
    process.stderr.write(
      `[rehydrate] adopted ${s.unit} uid=${s.uid} role=${adopted.role} port=${adopted.port ?? '-'} user=${adopted.userId}\n`,
    )
    this.probeAdopted(rec)
  }

  /** TCP 探活：端口在听 ⇒ 保留（有效实例）；连不上 ⇒ 按旧行为停掉（孤儿）。 */
  private probeAdopted(rec: AdoptedScope): void {
    const port = rec.info.port
    if (port === undefined) {
      // 不应发生（main 必带端口）；保守停掉。
      this.rehydrate.stopped += 1
      this.adopted.delete(rec.unit)
      this.stopUnit(rec.unit)
      // 序 ㊽：这一条**不产生**探活 ⇒ 若此刻已是本轮最后一条，落定通知不能等它。
      this.maybeRehydrateSettled()
      return
    }
    let settled = false
    // 序 ㊽：在途计数 —— 探活由 socket 事件驱动，`schedule` 的基例可能先于它跑完。
    this.pendingProbes += 1
    const sock = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      rec.alive = ok
      if (ok) {
        this.rehydrate.probeOk += 1
        process.stderr.write(`[rehydrate] probe OK ${rec.unit} :${port}\n`)
      } else {
        this.rehydrate.probeFail += 1
        const note = `probe-fail ${rec.unit} :${port}`
        this.rehydrate.notes.push(note)
        process.stderr.write(`[rehydrate] ⛔ ${note} ⇒ 判孤儿，按旧行为停掉\n`)
        this.rehydrate.stopped += 1
        this.adopted.delete(rec.unit)
        this.stopUnit(rec.unit)
      }
      this.pendingProbes -= 1
      this.maybeRehydrateSettled()
    }
    sock.setTimeout(this.rehydrateProbeMs(), () => done(false))
    sock.once('error', () => done(false))
    sock.once('connect', () => done(true))
  }

  /** 停一个 unit（与既有清理同款：失败**静默跳过**，⛔ 不抛）。 */
  private stopUnit(unit: string): void {
    try {
      execFileSync('systemctl', ['stop', unit], { timeout: 10000 })
    } catch {
      /* ignore */
    }
  }

  /** 清掉指定 uid 名下的残留 systemd scope（孤儿）。严格前缀匹配，不误伤门户自身。 */
  private cleanStaleScopes(uid: number): void {
    this.stopScopesByPrefix(`dsh-${uid}-`)
  }

  /** portal 启动时清一次 —— 编排器重启后无法接管已有 scope，统一清掉防孤儿。 */
  private cleanAllStaleScopes(): void {
    this.stopScopesByPrefix('dsh-', /^dsh-\d+-[0-9a-f]+\.scope$/)
  }

  /** 停止匹配前缀（可选正则）的 systemd scope；list/stop 失败一律静默跳过。 */
  private stopScopesByPrefix(prefix: string, re?: RegExp): void {
    try {
      const out = execFileSync('systemctl', ['list-units', '--type=scope', '--no-legend', '--plain'], { encoding: 'utf8', timeout: 10000 })
      for (const line of out.split('\n')) {
        const name = line.trim().split(/\s+/)[0]
        if (name === undefined || name === '') continue
        if (!name.startsWith(prefix) || !name.endsWith('.scope')) continue
        if (re !== undefined && !re.test(name)) continue
        this.stopUnit(name)
        // 序 ㉕：被清掉的 unit 若在认领表里，同步摘掉（避免留下陈旧记录）
        this.adopted.delete(name)
      }
    } catch { /* list-units 失败：跳过 */ }
  }

  private killInstance(userId: string, instance: Instance): void {
    instance.status = 'stopped'
    // bwrap 沙箱模式下，scope 由 systemd 管理：systemctl stop 才能正确终止整个
    // scope（含 bwrap + dsh），child.kill 只杀 systemd-run 进程、不杀 scope 内进程。
    if (instance.unit !== undefined) {
      try {
        execFileSync('systemctl', ['stop', instance.unit], { timeout: 10000 })
      } catch {
        // systemctl stop 失败时走 child.kill 兜底
      }
    }
    const child = this.children.get(instance.id)
    if (child === undefined) return
    child.kill('SIGTERM')
    const killer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5000)
    killer.unref()
  }
}
