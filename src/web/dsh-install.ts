/**
 * 「平台内置 dsh」安装位置解析 —— **全平台唯一入口**（补做 · 2026-09-14）。
 *
 * 为什么必须有这一层：**`npm i -g` 的落点随发行版 / npm prefix 而变** —— 实测
 *   · Debian 系常见 `/usr/local/lib/node_modules`（npm 默认 `prefix=/usr/local`）
 *   · 以发行版包管理器装的 Node（OpenCloudOS / CentOS / 宝塔 等）常见 `/usr/lib/node_modules`
 *     （例如这种：`/usr/bin/dsh` → `/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`）
 * 而定位失败**不会报错**：调用方只会静默降级（厂家目录读成空、平台包计数为 0），
 * 表现成「这个功能没做」，排查成本极高（实测：`/api/me/model-providers` 返回 `{"providers":[]}`）。
 * ⇒ 不能写死单一路径，必须**按序探测**。
 *
 * 解析顺序（命中即停）：
 *   1. env `DSH_PACKAGE_DIR` / `DSH_COMPAT_ROOT`（+ 本仓前缀别名 `DSH_AI1NET_PACKAGE_DIR` /
 *      `DSH_AI1NET_COMPAT_ROOT`）—— 显式覆盖，也是测试注入点，**无条件生效**；
 *   2. 平台配置的 dsh 可执行文件（`DSH_AI1NET_DSH_BIN`）
 *      → `realpath` 后向上找含 `name=@deepseek-ai/dsh`
 *      的 package.json。**最可靠的一路**：它就是实例真正在跑的那个包；
 *   3. 常见全局根逐一探测（`/usr/local/lib/node_modules`、`/usr/lib/node_modules`）；
 *   4. `npm root -g`（慢，只在前面全落空时跑一次，5s 超时）；
 *   5. 全落空 ⇒ 返回历史默认值（**保持旧行为**，由上层继续按「目录不可读」降级）。
 *
 * 判定用 `package.json` 的 `name` 而非「目录存在」，避免撞上同名空目录。结果缓存。
 *
 * ⚠️ 实例进程内还有一份**同思路的独立实现**
 * （跑在实例侧、拿不到本模块 —— 实例不加载平台代码），改这里的探测规则时别忘了同步那一处。
 *
 * ⚠️ 本模块**只依赖 node 内建**（无内部 import）⇒ 可单独编译、单独在目标机上验证。
 *
 * @module dsh_ai1net/web/dsh-install
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

/** 平台内建包的包名（`package.json.name`）。 */
const PKG_NAME = '@deepseek-ai/dsh'

/** 历史默认值（也是最后兜底）；仅在探测全落空时使用。 */
const LEGACY_DEFAULT_ROOT = '/usr/local/lib/node_modules/' + PKG_NAME

/** 常见的全局 `node_modules` 落点（候选，非假设）。 */
const COMMON_ROOTS = ['/usr/local/lib/node_modules', '/usr/lib/node_modules']

/** 第一个非空的 env 值。 */
function firstEnv(names: readonly string[]): string | null {
  for (const n of names) {
    const v = process.env[n]
    if (v !== undefined && v !== '') return v
  }
  return null
}

let cachedRoot: string | null = null

/** 该目录是不是 dsh 包根（看 `package.json.name`，避免撞上同名空目录）。 */
function isDshPackageDir(dir: string): boolean {
  try {
    if (!statSync(join(dir, 'package.json')).isFile()) return false
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return pkg.name === PKG_NAME
  } catch {
    return false
  }
}

/** 从某个路径向上找包根（最多 6 层，够到 `<root>/lib/bin.js` 这种深度）。 */
function findPackageRootUpwards(from: string): string | null {
  let cur = resolve(from)
  for (let i = 0; i < 6; i += 1) {
    if (isDshPackageDir(cur)) return cur
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return null
}

/** 由平台配置的 dsh 可执行文件反推包根（解软链）。 */
function rootFromConfiguredBin(): string | null {
  const bin = firstEnv(['DSH_AI1NET_DSH_BIN'])
  if (bin === null) return null
  try {
    return findPackageRootUpwards(realpathSync(bin))
  } catch {
    return null
  }
}

/** 由 `npm root -g` 反推包根（兜底；失败 / 超时一律当作没有）。 */
function rootFromNpm(): string | null {
  try {
    const root = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (root === '') return null
    const candidate = join(root, PKG_NAME)
    return isDshPackageDir(candidate) ? candidate : null
  } catch {
    return null
  }
}

/**
 * 平台内置 dsh 的包根目录。
 * @returns 绝对路径；**不保证存在**（全落空时返回历史默认值，由调用方按「目录不可读」降级）。
 */
export function dshPackageRoot(): string {
  if (cachedRoot !== null) return cachedRoot

  const envRoot = firstEnv(['DSH_PACKAGE_DIR', 'DSH_AI1NET_PACKAGE_DIR', 'DSH_COMPAT_ROOT', 'DSH_AI1NET_COMPAT_ROOT'])
  if (envRoot !== null) {
    cachedRoot = envRoot
    return envRoot
  }

  const probes: Array<string | null> = [
    rootFromConfiguredBin(),
    ...COMMON_ROOTS.map((r) => join(r, PKG_NAME)),
    rootFromNpm(),
  ]
  for (const p of probes) {
    if (p !== null && isDshPackageDir(p)) {
      cachedRoot = p
      return p
    }
  }

  cachedRoot = LEGACY_DEFAULT_ROOT
  return LEGACY_DEFAULT_ROOT
}

/** 平台内建包所在 scope 目录（`<root>/node_modules/@deepseek-ai`）。 */
export function dshScopeDir(): string {
  return join(dshPackageRoot(), 'node_modules', '@deepseek-ai')
}

/* ------------------------------------------------------------------ *
 * 平台包版本查询（**含伞包**）
 * ------------------------------------------------------------------ */

const SCOPE = '@deepseek-ai/'
/** 包名 → 平台版本；平台没有该包 → `null`。进程内缓存。 */
const versionCache = new Map<string, string | null>()

/**
 * 平台某 `@deepseek-ai/*` 包的真实版本；平台没有该包 → `null`。
 *
 * ⚠️ **伞包 `@deepseek-ai/dsh` 必须单独解析**：`dshScopeDir()` = `<dsh 包根>/node_modules/@deepseek-ai`，
 *   而**伞包不在自己的 `node_modules` 里** ⇒ 只走「scope 目录 + 短名」，对伞包恒为 `null`。
 *   2026-09-14 实测代价：声明 `@deepseek-ai/dsh: ^0.1.5-rc.2` 的插件
 *   （`dsh-zotero` / `dsh-any-background` / `dsh-md-notes`）在兼容性判定里**一条都认不出来**
 *   —— 会被当成「平台没这个包，不算不兼容」而放行。
 *
 * @param pkg 包名；`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` / 不带 scope 的短名都认
 */
export function platformPackageVersion(pkg: string): string | null {
  const full = pkg.startsWith('@') ? pkg : SCOPE + pkg
  const hit = versionCache.get(full)
  if (hit !== undefined) return hit
  let v: string | null = null
  try {
    // 伞包读 `<dsh 包根>/package.json`；子包读 scope 目录下的同名目录
    const dir = full === PKG_NAME ? dshPackageRoot() : join(dshScopeDir(), full.slice(SCOPE.length))
    const pj = join(dir, 'package.json')
    if (existsSync(pj)) {
      const meta = JSON.parse(readFileSync(pj, 'utf8')) as { version?: unknown }
      v = typeof meta.version === 'string' ? meta.version : null
    }
  } catch {
    v = null
  }
  versionCache.set(full, v)
  return v
}

/**
 * `@earendil-works/pi-ai` 的**厂家目录**数据位置。
 * @returns 绝对路径；**不保证存在**（不存在时返回首选候选，由调用方降级为空目录）。
 */
export function piAiDataDir(): string {
  const envDir = firstEnv(['PI_AI_DATA_DIR', 'DSH_AI1NET_PI_AI_DATA_DIR'])
  if (envDir !== null) return envDir

  const root = dshPackageRoot()
  const first = join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
  // 另一种合法布局：pi-ai 被提升到 `dsh-llm-pi-ai` 自己的 node_modules 下。
  const nested = join(
    root,
    'node_modules',
    '@deepseek-ai',
    'dsh-llm-pi-ai',
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
    'data',
  )
  if (existsSync(first)) return first
  if (existsSync(nested)) return nested
  return first
}

/** 清解析缓存（改了 env 之后重新解析；测试用）。 */
export function resetInstallPathsCache(): void {
  cachedRoot = null
  versionCache.clear()
}
