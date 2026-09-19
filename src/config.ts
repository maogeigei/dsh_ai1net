/**
 * Deployment-varying configuration. Every tunable is a validated field here
 * (or read from env), never a hardcoded constant inside the app.
 * @module dsh_ai1net/config
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

import { installDir as installDirDefault, platformDir as platformDirDefault } from './platform-paths.js'

/** Isolation tier. `soft` = per-user home/workspace + sandbox (same OS user);
 * `account` = per-user OS account via a setuid wrapper (Linux, needs root). */
export type IsolationMode = 'soft' | 'account'

/** Deployment mode: a single host running per-user child processes (setuid/iptables). */
export type DeployMode = 'local' | 'cluster'

/** 外发邮件驱动（注册验证码）。见 `web/mail.ts`。 */
export type MailDriver = 'brevo' | 'http' | 'log'

/** Resolved, immutable runtime configuration. */
export interface ServerConfig {
  /** Bind host for the orchestrator HTTP server. */
  host: string
  /** Bind port; `0` requests an ephemeral port. */
  port: number
  /** SQLite database path. */
  dbPath: string
  /** Postgres connection string; when set, the DB backend is Postgres (shared HA). */
  dbUrl?: string
  /** Root under which per-user homes (`users/<id>/home`) and workspaces live. */
  dataRoot: string
  /** Parent of the platform-private dirs below. Deployment-varying ⇒ from config
   * (`DSH_PLATFORM_DIR`), never a hardcoded absolute path. */
  platformDir: string
  /** Platform state dir (managed lists, capabilities, runtime baseline). */
  stateDir: string
  /** Platform backup dir (backups taken before the platform rewrites a user home file). */
  backupDir: string
  /** Platform artifact dir (plugin / product tarballs served to instances). */
  artifactDir: string
  /** Code install root (`lib/`、`scripts/` 所在)；由本模块位置推导，无需配置。 */
  installDir: string
  /** Shared read-only skill directory for all users (injected as
   * `DSH_BUNDLED_SKILL_DIR` into every spawned DSH); empty = feature off. */
  bundledSkillDir: string
  /** Argv used to launch a child DSH; first element is the executable. */
  dshCommand: string[]
  /** Pino log level. */
  logLevel: string
  /** Set the `Secure` flag on session cookies (enable behind HTTPS). */
  secureCookies: boolean
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number
  /** Max upload request body in bytes (base64 JSON; ~0.75× the file size). */
  maxUploadBytes: number
  /** Delay before auto-restarting a crashed child DSH, in milliseconds. */
  restartBackoffMs: number
  /** Upper bound for the exponential crash-restart backoff . */
  restartBackoffMaxMs: number
  /** Auto-restarts allowed inside `crashWindowMs` before the circuit opens. */
  crashMaxRestarts: number
  /** Rolling window used to count auto-restarts . */
  crashWindowMs: number
  /** Uptime after which a main counts as recovered and the backoff resets. */
  crashStableMs: number
  /** 熔断首次冷却时长（冷却期内拒绝隐式启动）。 */
  crashBreakerCooldownMs: number
  /** 熔断冷却上限（多次熔断后指数加长到此为止）。 */
  crashBreakerMaxCooldownMs: number
  /** Isolation tier (see {@link IsolationMode}); local mode only. */
  isolationMode: IsolationMode
  /** Argv prefix that drops privileges; `{UID}`/`{GID}` are substituted. Local mode only. */
  spawnAsUserCommand: string[]
  /** Base uid for the deterministic per-user uid. */
  baseUid: number
  /** Parent domain for per-user subdomains (`<username>.<baseDomain>`); empty = disabled. */
  baseDomain: string
  /** Cookie `Domain` value (e.g. `.example.com`) so the session reaches subdomains; empty = host-only. */
  cookieDomain: string
  /** Whether to pass `--patch` to child DSHs (needs a dsh CLI that supports it). */
  enablePatch: boolean
  /** Enable the loopback OUTPUT owner-match port guard (Linux + root). Local mode only. */
  portGuard: boolean
  /** Cap on resident main instances per host (0 = no cap). Local mode idle reap. */
  maxIdleInstances: number
  /** A main instance with no proxied/entered activity for this long is stopped
   * (0 = disabled). Local mode idle reap. */
  instanceIdleTtlSeconds: number
  /** Period between idle-reap scans (seconds). Local mode idle reap. */
  idleReapIntervalSeconds: number
  /** Secret used to encrypt per-user secrets at rest (from env or dataRoot/secret.key). */
  encryptionSecret: string
  /** Deployment mode (see {@link DeployMode}). */
  deployMode: DeployMode
  // ── cluster 模式（T08 S3/S4；设计 §1.1）────────────────────────────────
  /** 本机在 `dsh_hosts.id` 里的标识（`deployMode=cluster` 时必填语义）。 */
  clusterHostId: string
  /** 本机 worker agent 的**基址**（Manager 侧用它投递实例操作），如 `http://127.0.0.1:9000`。 */
  clusterAgentUrl: string
  /** 与 agent 约定的共享密钥（仅内网 + nft 白名单）。 */
  clusterAgentToken: string
  /** agent 返回给 Manager 做代理的实例地址（同机 1a = `127.0.0.1`）。 */
  clusterInstanceHost: string
  /**
   * **worker 上**的 dataRoot（T08 S5）。
   * 空 = 与本地 `dataRoot` 相同（1a 形态）。多机部署必须显式配置 —— 而且是**基线约定**：
   * 所有 worker 的 dataRoot 必须是同一个绝对路径（同镜像即可满足，设计 §14.3）。
   */
  clusterWorkerDataRoot: string
  /**
   * **worker 侧**会合地址（覆盖网络 S1）：worker 主动拨入的 SSH 反向隧道落点。
   * 形如 `ssh://root@<server-public-ip>:<ssh-port>`（也接受不带 scheme 的 `root@host:port`）。空 = 隧道关闭。
   * ⚠️ 与旧变量 `DSH_AI1NET_TUNNEL_TARGET` **双路径并存**（新变量优先、旧变量兜底）⇒
   * 删掉新 env 即回到旧路径，**零代码回滚**。
   */
  clusterRendezvousUrl: string
  /**
   * **Manager 侧**用的自研中继入口（覆盖网络 R3），如 `wss://<base-domain>/dsh_ai1net-relay`。
   * 仅作管理面展示 / 诊断（`RelayRendezvous.dialTarget()`）；空 = 该实现不注册。
   */
  relayUrl: string
  /**
   * 中继的**状态查询地址**（覆盖网络 R3），如 `http://127.0.0.1:<relay-port>/status`。
   *
   * 为什么必须查它：relay 为每个注册端口在**它自己的回环**上开一条监听，端口号是
   * `listen(0)` 动态分配的（实测 42067）⇒ **Manager 无法从 `dsh_hosts.endpoint` 推出来**，
   * 只能问 relay「hostId + 端口 → 回环口 + 在线态」。**空 = 不注册 `relay` 实现**
   * （于是 `via='relay'` 会回退到 `manager-ssh`，行为与今天一致）。
   */
  relayStatusUrl: string
  /**
   * **拨号通道**（覆盖网络 R5）：Manager 用哪个 hostId 向 relay 注册为「拨号方」。
   * 默认 `manager`；空 ⇒ **不启用拨号通道**（一切照旧）。
   *
   * 为什么需要它：R1–R4 的落点在 **relay 主机的回环**上 ⇒ Manager 必须与 relay 同机，
   * 「中继可换机 / 多实例」就做不到。拨号通道把落点搬到 **Manager 自己本机**
   * （`src/net/relay/dialer.ts` 的口池）⇒ relay 放哪台机器都行。
   * ⚠️ 该 hostId 必须同时出现在 relay 的密钥文件里，且列在 relay 的 `DSH_AI1NET_RELAY_DIALERS` 白名单里。
   */
  relayDialHost: string
  /** 拨号方的 64 位 hex 密钥（**与 relay 密钥文件里 `relayDialHost` 那一项逐字节相同**）。空 ⇒ 不启用。 */
  relayDialSecret: string
  /** 拨号落点口池起点。**必须避开 OS 临时端口段（32768–60999）与实例端口段**。默认 25000。 */
  relayDialPortBase: number
  /** 拨号落点口池扫描宽度。默认 1000。 */
  relayDialPortSpan: number
  /** 拨号落点口池大小（= 最多同时挂多少个 `(hostId, port)` 落点）。默认 64。 */
  relayDialPool: number
  /**
   * **实例端口区间起点**（覆盖网络 S3）。`0` = 保持旧行为（`listen(0)` 随机取端口）。
   *
   * 为什么必须能配：跨机实例的**隧道落点全部挤在 Manager 的 `127.0.0.1`**，而
   * `findFreePort()` 是**每台 worker 各自**用 `listen(0)` 随机取的 ⇒ **两台 worker 取到同号
   * 就会撞号**：`-R` 失败被静默忽略（`tunnel.forward()` 的返回值无人看），Manager 仍按该
   * 端口拨 ⇒ **打到别人的实例**（2026-09-16 实测）。给每台 worker 一段**互不重叠**的区间
   * 即可根治，且**不需要改 sshd、不需要端口映射表**。
   *
   * ⚠️ 选区间时应**避开 OS 临时端口段**（本项目两台机器均为 `32768-60999`）。
   */
  instancePortBase: number
  /** 实例端口区间长度（条数）。仅当 `instancePortBase > 0` 时生效。 */
  instancePortSpan: number
  // ── 覆盖网络 P0-2 引导三级链（`net/relay/directory.ts`）─────────────────
  /**
   * **本机所属的网**（P0-1 的 `network_id`）。运维网 = `ops`（本机与未来的中继）；
   * 用户设备用 `u:<userId>`。它进目录文档的 `network` 字段（**被签名覆盖**）。
   */
  overlayNetworkId: string
  /**
   * **内置种子**（引导链第 ①级之后的兜底入口）。常量位 —— 已持证书、**不新增域名**。
   *
   * ⚠️ 约定："**引导地址 = 中继入口同源**"：目录端点 = 种子 origin + 固定路径
   * （`net/relay/directory.ts` 的 `DIRECTORY_PATH`）。本文件是**基础层**、
   * 不许 import 能力层 ⇒ 路径字面量两处各写一次，**改动必须两处同改**。
   */
  overlayBootstrapSeeds: string[]
  /**
   * **受信目录签名公钥**（PEM 或裸 32 字节 hex/base64，逗号分隔）。
   * 空 ⇒ 目录一律不接受（**不可验 = 不接受**）⇒ 只剩 env 与种子兜底两级。
   */
  overlayDirTrustedKeys: string[]
  /** 目录**签名私钥**（Ed25519 PEM）路径。空 ⇒ 目录端点 `503`（**绝不发未签名目录**）。 */
  overlayDirKeyFile: string
  /** 目录缓存文件（客户端侧）。空 ⇒ 不缓存（每次取目录，多一次往返）。 */
  overlayDirectoryCacheFile: string
  // ── 覆盖网络 一机一钥 + 信任根（`net/relay/identity.ts`）────────────
  /**
   * **本机节点私钥**文件路径（Ed25519 PEM，**0600**、属主必须是跑 dsh 的那个用户）。
   * 空 ⇒ 本机不发起身份（只做 HMAC，过渡期形态）。
   */
  overlayNodeKeyFile: string
  /** **本机入网凭据**文件路径（`{"doc":{…},"sig":"<base64>"}`，由离线信任根授权的签名者签发）。 */
  overlayNodeGrantFile: string
  // ── 注册页人机验证 + 邮箱验证码（`web/turnstile.ts` / `web/mail.ts`）──────
  /**
   * Cloudflare Turnstile 站点公钥（**会下发到注册页**，不是秘密）。
   * ⚠️ 与 `turnstileSecret` **必须成对**：只填一把 = 视为未配置（人机验证整体不启用）。
   */
  turnstileSiteKey: string
  /** Turnstile 服务端密钥。空 ⇒ 人机验证停用（注册页不渲染 widget、后端不校验）。 */
  turnstileSecret: string
  /**
   * 期望的 `action`（渲染 widget 时声明、siteverify 时回显）。默认 `signup`。
   * 不校它 ⇒ 同 sitekey 的各个入口共享 token，人机验证退化成"过一处即可用到处"。
   */
  turnstileAction: string
  /**
   * 🔴 期望的**前端主机名**白名单（`result.hostname` 必须在此列）。
   *
   * sitekey 是公开的（就在页面 HTML 里）⇒ 攻击者可在**自己站点**嵌入我们的 sitekey、
   * 为真人访客拿到合法 token，再拿去打我们的注册接口；只校 `success` 的话这条路完全通畅。
   * `hostname` 由 **Cloudflare 服务端**判定并回显，访客篡改不了 ⇒ 只有校它才能把 token
   * 真正绑到"从我们站点发出的挑战"上。
   * 默认从 `baseDomain` 派生（`<domain>` + `www.<domain>`）；**空数组 = 不安全 ⇒ 视为未配置完成**。
   */
  turnstileHostnames: string[]
  /** 邮件驱动：`brevo` / `http` / `log`。`log` 只在开发排障时用（验证码会进 journald）。 */
  mailDriver: MailDriver
  mailApiUrl: string
  mailApiKey: string
  mailAuthHeader: string
  mailFrom: string
  mailFromName: string
  mailBodyTemplate: string
  mailTimeoutMs: number
  /**
   * 注册是否**强制**邮箱验证码。默认 `true`，但**仅当邮件通道已配置**时才真正生效
   * （见 `mailEnabled`）—— 这样"没配邮件"的环境不会因为缺配置而注册不了。
   */
  registerRequireEmailCode: boolean
  /** 注册是否强制人机验证。同理：只在 `turnstileSecret` 有值时才生效。 */
  registerRequireCaptcha: boolean
  /** 验证码有效期（毫秒）。 */
  emailCodeTtlMs: number
  /** 单个验证码允许的最大试错次数（达上限即作废）。 */
  emailCodeMaxAttempts: number
  /** 反爆破策略：限额与冷却阶梯（见 `web/register-guard.ts`）。 */
  emailCodeGuard: {
    emailPerHour: number
    emailSentPerDay: number
    ipPerHour: number
    globalPerHour: number
    cooldownLadderMs: number[]
  }
}

/** Untyped overrides collected from argv / env. */
export interface ConfigOverrides {
  host?: string
  port?: string | number
  dbPath?: string
  dbUrl?: string
  dataRoot?: string
  platformDir?: string
  installDir?: string
  bundledSkillDir?: string
  dshCommand?: string[]
  logLevel?: string
  secureCookies?: boolean
  sessionTtlSeconds?: number | string
  maxUploadBytes?: number | string
  restartBackoffMs?: number | string
  restartBackoffMaxMs?: number | string
  crashMaxRestarts?: number | string
  crashWindowMs?: number | string
  crashStableMs?: number | string
  crashBreakerCooldownMs?: number | string
  crashBreakerMaxCooldownMs?: number | string
  isolationMode?: IsolationMode | string
  spawnAsUserCommand?: string[]
  baseUid?: number | string
  baseDomain?: string
  cookieDomain?: string
  enablePatch?: boolean
  portGuard?: boolean
  maxIdleInstances?: number | string
  instanceIdleTtlSeconds?: number | string
  idleReapIntervalSeconds?: number | string
  encryptionSecret?: string
  deployMode?: DeployMode | string
  clusterHostId?: string
  clusterAgentUrl?: string
  clusterAgentToken?: string
  clusterInstanceHost?: string
  clusterWorkerDataRoot?: string
  clusterRendezvousUrl?: string
  relayUrl?: string
  relayStatusUrl?: string
  relayDialHost?: string
  relayDialSecret?: string
  relayDialPortBase?: number | string
  relayDialPortSpan?: number | string
  relayDialPool?: number | string
  instancePortBase?: number | string
  instancePortSpan?: number | string
  overlayNetworkId?: string
  overlayNodeKeyFile?: string
  overlayNodeGrantFile?: string
  overlayBootstrapSeeds?: string[]
  overlayDirTrustedKeys?: string[]
  overlayDirKeyFile?: string
  overlayDirectoryCacheFile?: string
  turnstileSiteKey?: string
  turnstileSecret?: string
  turnstileAction?: string
  turnstileHostnames?: string[]
  mailDriver?: MailDriver | string
  mailApiUrl?: string
  mailApiKey?: string
  mailAuthHeader?: string
  mailFrom?: string
  mailFromName?: string
  mailBodyTemplate?: string
  mailTimeoutMs?: number | string
  registerRequireEmailCode?: boolean
  registerRequireCaptcha?: boolean
  emailCodeTtlMs?: number | string
  emailCodeMaxAttempts?: number | string
}

const DEFAULT_HOST = '127.0.0.1'

// 覆盖网络 S3：实例端口区间（`0` = 保持旧行为 `listen(0)` 随机）。
const DEFAULT_INSTANCE_PORT_BASE = 0
const DEFAULT_INSTANCE_PORT_SPAN = 1000
const DEFAULT_PORT = 3080
const DEFAULT_DSH_COMMAND = ['dsh']
const DEFAULT_LOG_LEVEL = 'info'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_RESTART_BACKOFF_MS = 1000
/** 崩溃自愈退避上限。 */
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30000
/** 熔断窗口内允许的自动重启次数。 */
const DEFAULT_CRASH_MAX_RESTARTS = 5
/** 熔断窗口长度。 */
const DEFAULT_CRASH_WINDOW_MS = 600000
/** 连续运行多久视为已恢复、重置退避步数。 */
const DEFAULT_CRASH_STABLE_MS = 60000
// 熔断冷却 —— 首次 10 分钟，指数加长，封顶 6 小时
const DEFAULT_CRASH_BREAKER_COOLDOWN_MS = 600000
const DEFAULT_CRASH_BREAKER_MAX_COOLDOWN_MS = 21600000
const DEFAULT_ISOLATION_MODE: IsolationMode = 'soft'
const DEFAULT_SPAWN_AS_USER_COMMAND = [
  'setpriv',
  '--reuid',
  '{UID}',
  '--regid',
  '{GID}',
  '--inh-caps=-all',
  '--clear-groups',
  '--',
]
const DEFAULT_BASE_UID = 100000
const DEFAULT_BASE_DOMAIN = ''
const DEFAULT_COOKIE_DOMAIN = ''
const DEFAULT_ENABLE_PATCH = false
const DEFAULT_MAX_IDLE_INSTANCES = 4
const DEFAULT_INSTANCE_IDLE_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_IDLE_REAP_INTERVAL_SECONDS = 60
const DEFAULT_DEPLOY_MODE: DeployMode = 'local'
// 注册页人机验证 + 邮箱验证码
const DEFAULT_REGISTER_REQUIRE_EMAIL_CODE = true
const DEFAULT_REGISTER_REQUIRE_CAPTCHA = true
const DEFAULT_MAIL_TIMEOUT_MS = 10_000
const DEFAULT_TURNSTILE_TIMEOUT_MS = 8_000
/** Turnstile `action` 默认值：与注册页渲染时声明的一致（见 `web/register.html`）。 */
const DEFAULT_TURNSTILE_ACTION = 'signup'
const DEFAULT_EMAIL_CODE_TTL_MS = 10 * 60 * 1000
const DEFAULT_EMAIL_CODE_MAX_ATTEMPTS = 5
const DEFAULT_EMAIL_GUARD = {
  // 6 = 冷却阶梯每一级都可达（索引 0…5）；见 `web/register-guard.ts` 的说明。
  emailPerHour: 6,
  emailSentPerDay: 8,
  ipPerHour: 20,
  globalPerHour: 200,
  // 索引 = 该邮箱最近一小时内已发起的次数（超出取最后一项）⇒ 冷却随重试次数递增。
  cooldownLadderMs: [60_000, 60_000, 180_000, 300_000, 900_000, 1_800_000],
}
/**
 * 覆盖网络 P0-2：**内置种子**（引导链的常量位）。
 *
 * ⛔ 这里**刻意留空** —— 种子是具体部署的入口地址，属部署相关值，
 * 一律由 `DSH_AI1NET_OVERLAY_BOOTSTRAP_SEEDS` 提供（见 `config/platform.env`）。
 * 代码内不留任何真实域名 / IP ⇒ 仓库副本换一个部署者也不会带出别人的地址。
 * 未配置 ⇒ 引导链为空，覆盖网络不自动取址（可显式 `--url` 指定）。
 * ⚠️ 目录端点路径由 `net/relay/directory.ts` 的 `DIRECTORY_PATH` 决定（同源约定）。
 */
const DEFAULT_OVERLAY_BOOTSTRAP_SEEDS: string[] = []

/** Load the encryption secret from env, or persist a generated one at
 * `<dataRoot>/secret.key` (0600) so it survives restarts without setup. */
function resolveEncryptionSecret(dataRoot: string): string {
  const fromEnv = process.env.DSH_AI1NET_SECRET
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const path = join(dataRoot, 'secret.key')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing !== '') return existing
  } catch {
    // fall through to generate
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path, secret, { mode: 0o600 })
  return secret
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

/**
 * 解析端口号（覆盖网络 S3）。空 / 非法 / 越界 ⇒ 回落到 `fallback`（`0` = 旧行为 `listen(0)`）。
 * 不接受 NaN：`listen(NaN)` 会以"启动正常但实例起不来"的形式烂在运行时。
 */
function toPortNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback
}


/**
 * 邮件驱动解析。**不认识的值回落 `brevo` 而不是报错** ——
 * 写错一个字母就打不开注册页，代价远大于"驱动没换成"。
 */
function toMailDriver(value: string | undefined): MailDriver {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'http' || v === 'log' || v === 'brevo' ? v : 'brevo'
}

/**
 * Turnstile `action` 归一：CF 规定 1–32 字符、仅 `[A-Za-z0-9_-]`。
 * 非法值 ⇒ 回落默认（而不是抛错）：`action` 只是"这枚 token 属于哪个业务"的标签，
 * 打错字不该让注册页起不来。
 */
function normalizeAction(value: string | undefined): string {
  const v = (value ?? '').trim()
  return /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : DEFAULT_TURNSTILE_ACTION
}

/**
 * 主机名归一：去掉协议 / 路径 / 端口 / 首尾点，转小写并去重。
 * 为什么要容错：运维很容易把 env 写成 `https://<base-domain>/`（照抄 URL 的习惯），
 * 而 CF 回显的是**裸主机名** ⇒ 不归一就是"配了却永远不匹配"的静默失效。
 */
export function normalizeHostnames(values: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of values) {
    const host = raw
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      .split(':')[0]
      .replace(/^\.+|\.+$/g, '')
    if (host !== '' && !out.includes(host)) out.push(host)
  }
  return out
}

/**
 * 期望主机名：**显式配了就用配的**（空 ⇒ 视为未配置完成，交由 `turnstileEnabled` 判停用），
 * 否则从 `baseDomain` 派生 `<domain>` + `www.<domain>`。
 * ⚠️ **绝不自动加 `localhost` / `127.0.0.1`** —— 生产后端的白名单里放它们 = 放开本地伪造。
 */
export function resolveTurnstileHostnames(configured: readonly string[] | undefined, baseDomain: string): string[] {
  if (configured !== undefined && configured.length > 0) return normalizeHostnames(configured)
  if (configured !== undefined) return [] // 显式空 = 关闭（不派生）
  const domain = baseDomain.trim().toLowerCase()
  return domain === '' ? [] : normalizeHostnames([domain, `www.${domain}`])
}

/** 正整数解析（0 / 负数 / 非数字 / 空 ⇒ `fallback`）。用于各种毫秒数与次数上限。 */
function toPositiveInt(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * 冷却阶梯解析：env 给的是**秒**的逗号分隔列表（`60,60,180,300,900,1800`），
 * 内部一律用毫秒。空 / 全非法 ⇒ 回落默认阶梯。
 */
function parseSecondsLadder(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined || value === '') return [...fallback]
  const seconds = value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return seconds.length === 0 ? [...fallback] : seconds.map((s) => Math.floor(s) * 1000)
}

/**
 * 逗号分隔列表解析。与 {@link parseCidrs} 的区别：**没配**（`undefined`）⇒ 返回
 * `undefined`，让调用方把"没配"与"配成空列表"区分开（前者走默认值、后者是显式关闭）。
 */
function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return [...new Set(value.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
}

/** Parse an isolation-mode value, rejecting anything outside `soft`/`account`
 * so a typo in the env var fails loudly at startup instead of silently
 * falling back to `soft` isolation. */
function toIsolationMode(value: string | undefined): IsolationMode | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'soft' || normalized === 'account') return normalized
  throw new Error(`invalid isolation mode "${value}" (expected "soft" or "account")`)
}

/** Parse a deploy-mode value, rejecting anything outside `local`. */
function toDeployMode(value: string | undefined): DeployMode | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'local' || normalized === 'cluster') return normalized
  throw new Error(`invalid deploy mode "${value}" (expected "local" or "cluster")`)
}

/**
 * Fold argv/env overrides over defaults. `dataRoot` defaults to
 * `~/.dsh_ai1net` (always writable for dev); production sets
 * `DSH_AI1NET_DATA_ROOT=<data-root>`.
 */
export function resolveConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const dataRoot =
    overrides.dataRoot ?? process.env.DSH_AI1NET_DATA_ROOT ?? join(homedir(), '.dsh_ai1net')
  // 部署相关的路径一律由 `platform-paths.ts` 统一解析（单一来源 ⇒ 见其模块头注）。
  // 代码内**不含任何真实路径**；缺省值是中性值（`<数据根>/platform`）。
  const platformDir = overrides.platformDir ?? platformDirDefault()
  const installDir = overrides.installDir ?? installDirDefault()
  const port = overrides.port ?? process.env.DSH_AI1NET_PORT ?? DEFAULT_PORT
  const dshBin = process.env.DSH_AI1NET_DSH_BIN
  const isolationMode =
    toIsolationMode(overrides.isolationMode) ??
    toIsolationMode(process.env.DSH_AI1NET_ISOLATION_MODE) ??
    DEFAULT_ISOLATION_MODE
  const deployMode =
    toDeployMode(overrides.deployMode) ??
    toDeployMode(process.env.DSH_AI1NET_DEPLOY_MODE) ??
    DEFAULT_DEPLOY_MODE
  // `baseDomain` 提前算出：Turnstile 的**期望主机名白名单**要从它派生（见下）。
  const baseDomainResolved = overrides.baseDomain ?? process.env.DSH_AI1NET_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN
  return {
    host: overrides.host ?? DEFAULT_HOST,
    port: typeof port === 'number' ? port : Number(port),
    dbPath: overrides.dbPath ?? join(dataRoot, 'dsh_ai1net.db'),
    dbUrl: overrides.dbUrl ?? process.env.DSH_AI1NET_DB_URL,
    dataRoot,
    platformDir,
    stateDir: join(platformDir, 'state'),
    backupDir: join(platformDir, 'backups'),
    artifactDir: join(platformDir, 'artifacts'),
    installDir,
    bundledSkillDir:
      overrides.bundledSkillDir ??
      process.env.DSH_AI1NET_BUNDLED_SKILL_DIR ??
      join(dataRoot, 'bundled-skills'),
    dshCommand: overrides.dshCommand ?? (dshBin !== undefined ? [dshBin] : DEFAULT_DSH_COMMAND),
    logLevel: overrides.logLevel ?? DEFAULT_LOG_LEVEL,
    secureCookies:
      overrides.secureCookies ?? toBool(process.env.DSH_AI1NET_SECURE_COOKIES, false),
    sessionTtlSeconds: Number(
      overrides.sessionTtlSeconds ?? process.env.DSH_AI1NET_SESSION_TTL ?? DEFAULT_SESSION_TTL_SECONDS,
    ),
    maxUploadBytes: Number(
      overrides.maxUploadBytes ?? process.env.DSH_AI1NET_MAX_UPLOAD ?? DEFAULT_MAX_UPLOAD_BYTES,
    ),
    restartBackoffMs: Number(
      overrides.restartBackoffMs ?? process.env.DSH_AI1NET_RESTART_BACKOFF ?? DEFAULT_RESTART_BACKOFF_MS,
    ),
    restartBackoffMaxMs: Number(
      overrides.restartBackoffMaxMs ??
        process.env.DSH_AI1NET_RESTART_BACKOFF_MAX ??
        DEFAULT_RESTART_BACKOFF_MAX_MS,
    ),
    crashMaxRestarts: Number(
      overrides.crashMaxRestarts ??
        process.env.DSH_AI1NET_CRASH_MAX_RESTARTS ??
        DEFAULT_CRASH_MAX_RESTARTS,
    ),
    crashWindowMs: Number(
      overrides.crashWindowMs ?? process.env.DSH_AI1NET_CRASH_WINDOW ?? DEFAULT_CRASH_WINDOW_MS,
    ),
    crashStableMs: Number(
      overrides.crashStableMs ?? process.env.DSH_AI1NET_CRASH_STABLE ?? DEFAULT_CRASH_STABLE_MS,
    ),
    crashBreakerCooldownMs: Number(
      overrides.crashBreakerCooldownMs ??
        process.env.DSH_AI1NET_CRASH_BREAKER_COOLDOWN ??
        DEFAULT_CRASH_BREAKER_COOLDOWN_MS,
    ),
    crashBreakerMaxCooldownMs: Number(
      overrides.crashBreakerMaxCooldownMs ??
        process.env.DSH_AI1NET_CRASH_BREAKER_MAX_COOLDOWN ??
        DEFAULT_CRASH_BREAKER_MAX_COOLDOWN_MS,
    ),
    isolationMode,
    spawnAsUserCommand: overrides.spawnAsUserCommand ?? DEFAULT_SPAWN_AS_USER_COMMAND,
    baseUid: Number(overrides.baseUid ?? process.env.DSH_AI1NET_BASE_UID ?? DEFAULT_BASE_UID),
    baseDomain: baseDomainResolved,
    cookieDomain: overrides.cookieDomain ?? process.env.DSH_AI1NET_COOKIE_DOMAIN ?? DEFAULT_COOKIE_DOMAIN,
    enablePatch: overrides.enablePatch ?? toBool(process.env.DSH_AI1NET_ENABLE_PATCH, DEFAULT_ENABLE_PATCH),
    portGuard: overrides.portGuard ?? toBool(process.env.DSH_AI1NET_PORT_GUARD, false),
    maxIdleInstances: Number(
      overrides.maxIdleInstances ?? process.env.DSH_AI1NET_MAX_IDLE_INSTANCES ?? DEFAULT_MAX_IDLE_INSTANCES,
    ),
    instanceIdleTtlSeconds: Number(
      overrides.instanceIdleTtlSeconds ??
        process.env.DSH_AI1NET_INSTANCE_IDLE_TTL ??
        DEFAULT_INSTANCE_IDLE_TTL_SECONDS,
    ),
    idleReapIntervalSeconds: Number(
      overrides.idleReapIntervalSeconds ??
        process.env.DSH_AI1NET_IDLE_REAP_INTERVAL ??
        DEFAULT_IDLE_REAP_INTERVAL_SECONDS,
    ),
    encryptionSecret:
      overrides.encryptionSecret ?? resolveEncryptionSecret(dataRoot),
    deployMode,
    clusterHostId: overrides.clusterHostId ?? process.env.DSH_AI1NET_CLUSTER_HOST_ID ?? hostname(),
    clusterAgentUrl: overrides.clusterAgentUrl ?? process.env.DSH_AI1NET_CLUSTER_AGENT_URL ?? '',
    clusterAgentToken: overrides.clusterAgentToken ?? process.env.DSH_AI1NET_CLUSTER_AGENT_TOKEN ?? '',
    clusterInstanceHost: overrides.clusterInstanceHost ?? process.env.DSH_AI1NET_CLUSTER_INSTANCE_HOST ?? '127.0.0.1',
    clusterWorkerDataRoot: overrides.clusterWorkerDataRoot ?? process.env.DSH_AI1NET_CLUSTER_WORKER_DATA_ROOT ?? '',
    // 覆盖网络 S1：会合地址出 env。新变量 `DSH_AI1NET_RENDEZVOUS_URL` 优先，旧变量 `DSH_AI1NET_TUNNEL_TARGET`
    // 兜底（两台机器可分先后改；删掉新 env 即回滚到旧路径，**不需要回滚代码**）。
    clusterRendezvousUrl:
      overrides.clusterRendezvousUrl ??
      process.env.DSH_AI1NET_RENDEZVOUS_URL ??
      process.env.DSH_AI1NET_TUNNEL_TARGET ??
      '',
    // 覆盖网络 R3：Manager 侧的 relay 接入（**空 = 完全不启用**，与 R2 之前行为一致）。
    relayUrl: overrides.relayUrl ?? process.env.DSH_AI1NET_RELAY_URL ?? '',
    relayStatusUrl: overrides.relayStatusUrl ?? process.env.DSH_AI1NET_RELAY_STATUS_URL ?? '',
    // 覆盖网络 R5：Manager 侧拨号通道（**空密钥 = 完全不启用**，落回 `/status` 快照那条老路）。
    relayDialHost: (overrides.relayDialHost ?? process.env.DSH_AI1NET_RELAY_DIAL_HOST ?? 'manager').trim(),
    relayDialSecret: (overrides.relayDialSecret ?? process.env.DSH_AI1NET_RELAY_DIAL_SECRET ?? '').trim(),
    relayDialPortBase: toPortNumber(overrides.relayDialPortBase ?? process.env.DSH_AI1NET_RELAY_DIAL_PORT_BASE, 25000),
    relayDialPortSpan: toPortNumber(overrides.relayDialPortSpan ?? process.env.DSH_AI1NET_RELAY_DIAL_PORT_SPAN, 1000),
    relayDialPool: Number(overrides.relayDialPool ?? process.env.DSH_AI1NET_RELAY_DIAL_POOL ?? 64) || 64,
    // 覆盖网络 S3：实例端口区间隔离（`0` = 旧行为）。非法值**回落**而不是变 NaN ——
    // `listen(NaN)` 是那种"启动看起来正常、实例起不来"的坑。
    instancePortBase: toPortNumber(
      overrides.instancePortBase ?? process.env.DSH_AI1NET_INSTANCE_PORT_BASE,
      DEFAULT_INSTANCE_PORT_BASE,
    ),
    instancePortSpan: toPortNumber(
      overrides.instancePortSpan ?? process.env.DSH_AI1NET_INSTANCE_PORT_SPAN,
      DEFAULT_INSTANCE_PORT_SPAN,
    ),
    // 覆盖网络 P0-2：引导三级链（env 显式 > 缓存目录 > 内置种子）。
    // 内置种子**为空**（部署相关值不入代码）⇒ 不配 env 时引导链为空、不自动取址。
    overlayNetworkId: (overrides.overlayNetworkId ?? process.env.DSH_AI1NET_OVERLAY_NETWORK_ID ?? 'ops').trim() || 'ops',
    overlayBootstrapSeeds:
      overrides.overlayBootstrapSeeds ??
      splitList(process.env.DSH_AI1NET_OVERLAY_BOOTSTRAP_SEEDS) ??
      DEFAULT_OVERLAY_BOOTSTRAP_SEEDS,
    overlayDirTrustedKeys:
      overrides.overlayDirTrustedKeys ?? splitList(process.env.DSH_AI1NET_OVERLAY_DIR_PUBKEYS) ?? [],
    overlayDirKeyFile: (overrides.overlayDirKeyFile ?? process.env.DSH_AI1NET_OVERLAY_DIR_KEY ?? '').trim(),
    overlayDirectoryCacheFile: (
      overrides.overlayDirectoryCacheFile ??
      process.env.DSH_AI1NET_OVERLAY_DIR_CACHE ??
      join(dataRoot, 'overlay', 'directory.json')
    ).trim(),
    // 覆盖网络 本机节点身份（一机一钥 + 入网凭据）。
    // **两个都配了**才发起身份 ⇒ 不配 = 与今天行为一致（只做 HMAC）；配了却读不出来 ⇒ 起动即抛
    //（见 `net/relay/identity.ts#loadClientIdentity` —— 静默退化成"没身份"会让"凭据坏了"
    //  表现成"一切正常"，等 relay 一开强制就整台失联）。
    overlayNodeKeyFile: (overrides.overlayNodeKeyFile ?? process.env.DSH_AI1NET_OVERLAY_NODE_KEY_FILE ?? '').trim(),
    overlayNodeGrantFile: (overrides.overlayNodeGrantFile ?? process.env.DSH_AI1NET_OVERLAY_NODE_GRANT_FILE ?? '').trim(),
    // ── 注册页人机验证 + 邮箱验证码────────────────────────────────
    // 主键一律**默认空** ⇒ 「不配任何 env = 与今天行为完全一致」；配齐了才启用。
    // 这一条是刻意的：注册是平台唯一的入口，不能因为漏配一个 env 就把注册锁死。
    turnstileSiteKey: (overrides.turnstileSiteKey ?? process.env.DSH_AI1NET_TURNSTILE_SITE_KEY ?? '').trim(),
    turnstileSecret: (overrides.turnstileSecret ?? process.env.DSH_AI1NET_TURNSTILE_SECRET ?? '').trim(),
    turnstileAction: normalizeAction(overrides.turnstileAction ?? process.env.DSH_AI1NET_TURNSTILE_ACTION),
    turnstileHostnames: resolveTurnstileHostnames(
      overrides.turnstileHostnames ?? splitList(process.env.DSH_AI1NET_TURNSTILE_HOSTNAMES),
      baseDomainResolved,
    ),
    mailDriver: toMailDriver(overrides.mailDriver ?? process.env.DSH_AI1NET_MAIL_DRIVER),
    mailApiUrl: (overrides.mailApiUrl ?? process.env.DSH_AI1NET_MAIL_API_URL ?? '').trim(),
    mailApiKey: (overrides.mailApiKey ?? process.env.DSH_AI1NET_MAIL_API_KEY ?? '').trim(),
    mailAuthHeader: (overrides.mailAuthHeader ?? process.env.DSH_AI1NET_MAIL_AUTH_HEADER ?? '').trim(),
    mailFrom: (overrides.mailFrom ?? process.env.DSH_AI1NET_MAIL_FROM ?? '').trim(),
    mailFromName: (overrides.mailFromName ?? process.env.DSH_AI1NET_MAIL_FROM_NAME ?? '').trim(),
    mailBodyTemplate: (overrides.mailBodyTemplate ?? process.env.DSH_AI1NET_MAIL_BODY_TEMPLATE ?? '').trim(),
    mailTimeoutMs: toPositiveInt(
      overrides.mailTimeoutMs ?? process.env.DSH_AI1NET_MAIL_TIMEOUT_MS,
      DEFAULT_MAIL_TIMEOUT_MS,
    ),
    registerRequireEmailCode:
      overrides.registerRequireEmailCode ??
      toBool(process.env.DSH_AI1NET_REGISTER_REQUIRE_EMAIL_CODE, DEFAULT_REGISTER_REQUIRE_EMAIL_CODE),
    registerRequireCaptcha:
      overrides.registerRequireCaptcha ??
      toBool(process.env.DSH_AI1NET_REGISTER_REQUIRE_CAPTCHA, DEFAULT_REGISTER_REQUIRE_CAPTCHA),
    emailCodeTtlMs: toPositiveInt(
      overrides.emailCodeTtlMs ?? process.env.DSH_AI1NET_EMAIL_CODE_TTL_MS,
      DEFAULT_EMAIL_CODE_TTL_MS,
    ),
    emailCodeMaxAttempts: toPositiveInt(
      overrides.emailCodeMaxAttempts ?? process.env.DSH_AI1NET_EMAIL_CODE_MAX_ATTEMPTS,
      DEFAULT_EMAIL_CODE_MAX_ATTEMPTS,
    ),
    emailCodeGuard: {
      emailPerHour: toPositiveInt(process.env.DSH_AI1NET_EMAIL_QUOTA_EMAIL_HOUR, DEFAULT_EMAIL_GUARD.emailPerHour),
      emailSentPerDay: toPositiveInt(process.env.DSH_AI1NET_EMAIL_QUOTA_EMAIL_DAY, DEFAULT_EMAIL_GUARD.emailSentPerDay),
      ipPerHour: toPositiveInt(process.env.DSH_AI1NET_EMAIL_QUOTA_IP_HOUR, DEFAULT_EMAIL_GUARD.ipPerHour),
      globalPerHour: toPositiveInt(process.env.DSH_AI1NET_EMAIL_QUOTA_GLOBAL_HOUR, DEFAULT_EMAIL_GUARD.globalPerHour),
      cooldownLadderMs: parseSecondsLadder(
        process.env.DSH_AI1NET_EMAIL_COOLDOWN_LADDER_SEC,
        DEFAULT_EMAIL_GUARD.cooldownLadderMs,
      ),
    },
  }
}
