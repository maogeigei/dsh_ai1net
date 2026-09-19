/**
 * 插件兼容性预检 —— 判据实现在此
 *
 * 背景：某第三方插件与平台内置 dsh 版本不兼容，装进实例后
 * `plugin tree failed to load`（缺 `assertNever`）→ 实例崩溃循环。
 * 现有链路只查「来源/内容安全」，不查「与平台版本兼不兼容」→ 本模块补上。
 *
 * 两条判据（均已在生产实测复现该 bug）：
 *
 *  A. 依赖范围（semver，**默认语义，不传 includePrerelease**）
 *     插件声明的 `@deepseek-ai/*` 依赖范围必须**接受**平台内置的同名包版本。
 *     ⚠️ 为什么必须用默认语义：npm/pnpm 的实际安装判定就是默认语义 ——
 *     例如它写 `>=0.1.1-rc.1 <0.1.2`，默认语义下 **不满足** 0.1.2-rc.1，
 *     于是 pnpm 给它装了自带的 `dsh-tool-web@0.1.1-rc.2` → 与平台 dsh-llm 冲突。
 *     若传 includePrerelease 会把它误判为「满足」而漏掉这个 bug（实测已确认）。
 *
 *  B. 导出符号（运行时真值）
 *     插件 bundle 里 `import { X } from '@deepseek-ai/Y'`，`X` 必须在平台包 Y 的
 *     **运行时真实导出**里存在。取法 = `await import()` 后取 `Object.keys()`，
 *     比解析 `.d.ts` 可靠（实测平台 223 个包中 220 个可取到导出清单）。
 *
 * 覆盖边界（重要）：判据 B 只看**被扫描目录内**的 import。若插件把平台 API 的调用
 * 藏在**传递依赖**里（越界的是它自己的依赖，不在 tgz 内），
 * 本模块扫不出来 —— 那种情况由「启用前扫 profile node_modules」那一层负责（T05 §五.4）。
 *
 * 设计原则：**任何异常都不得让上传流程失败** —— 判不出来就返回 `unknown`（放行 + 标记待复核），
 * 绝不误伤正常插件。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
// 平台内置包的落点**不能写死**：`npm root -g` 随发行版变（`/usr/local/lib` vs `/usr/lib`），
// 写死只会在另一种布局上静默退化成「平台包目录不可读」而不报错（测试服实测 = 0）。
// 统一走 `dsh-install.ts` 的按序探测。
import { dshScopeDir, platformPackageVersion } from './dsh-install.js'

const DS_SCOPE = '@deepseek-ai/'

export interface CompatFinding {
  /** dep-range = 依赖范围不接受平台版本；missing-export = 平台包缺该导出 */
  kind: 'dep-range' | 'missing-export'
  pkg: string
  detail: string
  file?: string
}

export interface CompatResult {
  /** incompatible = 已判定不兼容（调用方默认拒绝，admin 可显式信任）；unknown = 静态判不了（放行 + 标记） */
  level: 'ok' | 'incompatible' | 'unknown'
  findings: CompatFinding[]
  /** 平台内置包数量（快照，供回显） */
  platformPkgs: number
  /** 是否真的看到了 @deepseek-ai 的依赖声明或 import（区分 ok / unknown 用） */
  sawPlatformRef: boolean
  /**
   * 有几条声明「按 semver 默认语义不满足、按 prerelease 容忍满足」——**平台是 prerelease**
   * 的语义产物，**不计入 `findings`、不阻断**，只留个可观测计数（2026-09-14）。
   */
  prereleaseOnly?: number
  /** 判定过程出错时的说明（此时 level=unknown） */
  note?: string
}

/* ------------------------------------------------------------------ *
 * 平台侧：版本表（读 package.json）与导出符号（按需 import，带缓存）
 * ------------------------------------------------------------------ */

const exportCache = new Map<string, Set<string> | null>()

function shortName(pkg: string): string {
  return pkg.startsWith(DS_SCOPE) ? pkg.slice(DS_SCOPE.length) : pkg
}

function platformPkgDir(pkg: string): string {
  return join(dshScopeDir(), shortName(pkg))
}

/** 是否已经就「平台包目录不可读」告过一次警（避免刷日志）。 */
let warnedScopeUnreadable = false

/** 平台内置 @deepseek-ai 包的数量（目录级，低成本）。 */
export function platformPkgCount(): number {
  try {
    return readdirSync(dshScopeDir()).filter((n) => !n.startsWith('.')).length
  } catch {
    // ⚠️ 这里**不能只返回 0**：调用方会把它当成"没有平台包"⇒ 预检直接退化成
    // 「平台包目录不可读」——**安全网静默失效**（上传不兼容插件不再被拦）。
    // 2026-09-14：加一次告警，让"读不到"这件事可观测。
    if (!warnedScopeUnreadable) {
      warnedScopeUnreadable = true
      console.warn(
        `[plugin-compat] 平台包目录不可读：${dshScopeDir()} —— 插件兼容性预检将退化为「不检查」。` +
          ' 检查 DSH_AI1NET_DSH_BIN / DSH_COMPAT_ROOT 是否正确（见 src/web/dsh-install.ts）。',
      )
    }
    return 0
  }
}

/** 平台内置某包的版本；平台没有该包 → `null`。
 *
 * 2026-09-14：改为走 `dsh-install.platformPackageVersion()` —— 原实现只查
 * `<scope>/<短名>/package.json`，而**伞包 `@deepseek-ai/dsh` 不在自己的 `node_modules` 里**
 * ⇒ 对它恒判 `null`，被当作「平台没这个包，不算不兼容」而放行（实测那 3 条"要求更高版本"的
 * 插件全部只写在伞包上）。收口后该判据**含伞包**，与 `plugin-dsh-compat` 共用同一份版本表。
 */
function platformVersion(pkg: string): string | null {
  return platformPackageVersion(pkg)
}

function resolveEntryFile(pkg: string): string | null {
  const base = platformPkgDir(pkg)
  const cands: string[] = []
  try {
    const meta = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')) as {
      main?: unknown
      module?: unknown
      exports?: unknown
    }
    if (typeof meta.module === 'string') cands.push(meta.module)
    if (typeof meta.main === 'string') cands.push(meta.main)
  } catch {
    /* 忽略：退回默认候选 */
  }
  cands.push('lib/index.js', 'dist/index.js', 'esm/index.js', 'index.js', 'lib/index.mjs')
  for (const c of cands) {
    const f = join(base, c)
    try {
      if (existsSync(f) && statSync(f).isFile()) return f
    } catch {
      /* 忽略 */
    }
  }
  return null
}

/**
 * 平台某包的运行时导出符号集合。返回 null = 无法判定（**不能**据此断言不兼容）。
 * 只对「插件真的 import 了的包」调用，避免启动成本。
 */
async function platformExports(pkg: string): Promise<Set<string> | null> {
  const hit = exportCache.get(pkg)
  if (hit !== undefined) return hit
  let keys: Set<string> | null = null
  try {
    const entry = resolveEntryFile(pkg)
    if (entry !== null) {
      const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
      keys = new Set(Object.keys(mod))
    }
  } catch {
    keys = null // import 失败可能是环境原因，不能当作「插件不兼容」的证据
  }
  exportCache.set(pkg, keys)
  return keys
}

type SemverLike = { satisfies(v: string, r: string, o?: { includePrerelease?: boolean }): boolean }
let semverPromise: Promise<SemverLike | null> | null = null

function loadSemver(): Promise<SemverLike | null> {
  semverPromise ??= (async () => {
    try {
      const m = (await import('semver')) as unknown as { default?: SemverLike } & SemverLike
      return (m.default ?? m) as SemverLike
    } catch {
      return null
    }
  })()
  return semverPromise
}

/* ------------------------------------------------------------------ *
 * 插件侧：依赖声明 + bundle 内的 @deepseek-ai import
 * ------------------------------------------------------------------ */

const MAX_SCAN_FILES = 4000
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs'])
const IMPORT_RE =
  /(?:import|export)\s*(?:\*\s*as\s*[\w$]+|\{([^}]*)\})\s*from\s*["'](@deepseek-ai\/[^"']+)["']/g

interface ImportHit {
  pkg: string
  named: string[]
  file: string
}

function findPackageJson(root: string): string | null {
  const direct = join(root, 'package.json')
  if (existsSync(direct)) return direct
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const nested = findPackageJson(join(root, e.name))
        if (nested !== null) return nested
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

function collectJsFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_SCAN_FILES || depth > 8) return out
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (out.length >= MAX_SCAN_FILES) break
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      collectJsFiles(join(dir, e.name), out, depth + 1)
    } else if (SCAN_EXT.has(extname(e.name))) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

function scanImports(root: string): { hits: ImportHit[]; fileCount: number } {
  const files = collectJsFiles(root)
  const hits: ImportHit[] = []
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    if (!text.includes(DS_SCOPE)) continue
    IMPORT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const spec = m[1] ?? ''
      const named = spec
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter((s) => s !== '' && !s.startsWith('type '))
      hits.push({ pkg: m[2], named, file: f.slice(root.length + 1) })
    }
  }
  return { hits, fileCount: files.length }
}

function declaredDeepseekDeps(pkgPath: string): Array<[string, string]> {
  let meta: {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  try {
    meta = JSON.parse(readFileSync(pkgPath, 'utf8')) as typeof meta
  } catch {
    return []
  }
  const merged = { ...meta.peerDependencies, ...meta.optionalDependencies, ...meta.dependencies }
  return Object.entries(merged).filter(([k]) => k.startsWith(DS_SCOPE))
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 对一个**已解包**的插件目录做兼容性预检（只读）。
 * @param root 解包后的插件根目录（含 package.json 的那一层或其上层）
 */
export async function checkPluginCompat(root: string): Promise<CompatResult> {
  const out: CompatResult = {
    level: 'unknown',
    findings: [],
    platformPkgs: platformPkgCount(),
    sawPlatformRef: false,
  }
  try {
    if (out.platformPkgs === 0) {
      out.note = `平台包目录不可读：${dshScopeDir()}`
      return out
    }
    const pkgPath = findPackageJson(root)
    if (pkgPath === null) {
      out.note = '未找到 package.json'
      return out
    }

    // ---- 判据 A：依赖范围 ----
    const deps = declaredDeepseekDeps(pkgPath)
    if (deps.length > 0) out.sawPlatformRef = true
    const semver = deps.length > 0 ? await loadSemver() : null
    for (const [pkg, range] of deps) {
      const v = platformVersion(pkg)
      if (v === null) continue // 平台没这个包：不算不兼容（插件自带）
      if (semver === null) {
        out.note = 'semver 不可用，依赖范围未判定'
        continue
      }
      let ok: boolean
      let prereleaseOnly = false
      try {
        // ① 先按**默认语义**判（与 pnpm 的实际安装判定一致）
        ok = semver.satisfies(v, range)
        if (!ok) {
          // ② 不满足时再看是不是**prerelease 语义产物**。
          //    平台版本是 prerelease（`0.1.5-rc.1`、子包 `0.1.5-rc.2`），而 semver 默认语义下
          //    prerelease **不满足** `*`、`^0.1.2` 这类不含 prerelease 的范围 —— 于是
          //    「声明 `*`（= 任意版本）」会被判成不兼容。
          //    实测 2026-09-14（抽样 300）：
          //      real-newer 3 ｜ narrow-pin 22 ｜ **prerelease-artifact 117** ｜ match 98
          //    ⇒ 若把这 117 也当"不兼容"，闸门会有 ~39% 假阳性（`dshmarket`、`dsh-context`
          //    这些**在平台上跑得好好的**都会被拦）。所以：**只有 prerelease 容忍下也不满足，
          //    才算真不兼容**；容忍下能满足的只记一条 note（可观测，不阻断）。
          if (semver.satisfies(v, range, { includePrerelease: true })) {
            ok = true
            prereleaseOnly = true
          }
        }
      } catch {
        continue // 范围写法无法解析：不据此断言
      }
      if (!ok) {
        out.findings.push({
          kind: 'dep-range',
          pkg,
          detail: `平台为 ${v}，插件要求 ${range}（不满足）`,
        })
      } else if (prereleaseOnly) {
        // 保持可观测：这一条是"按 pnpm 语义不满足、按 prerelease 容忍满足"的平台效应
        out.prereleaseOnly = (out.prereleaseOnly ?? 0) + 1
      }
    }

    // ---- 判据 B：导出符号 ----
    const { hits, fileCount } = scanImports(root)
    if (hits.length > 0) out.sawPlatformRef = true
    for (const h of hits) {
      if (h.named.length === 0) continue
      if (platformVersion(h.pkg) === null) continue // 非平台内置包：跳过
      const exports = await platformExports(h.pkg)
      if (exports === null) continue // 拿不到导出清单 → 不判定
      const missing = h.named.filter((n) => !exports.has(n))
      if (missing.length > 0) {
        out.findings.push({
          kind: 'missing-export',
          pkg: h.pkg,
          detail: `平台包未导出：${missing.join(', ')}`,
          file: h.file,
        })
      }
    }

    out.level = out.findings.length > 0 ? 'incompatible' : out.sawPlatformRef ? 'ok' : 'unknown'
    if (out.level === 'unknown' && out.note === undefined) {
      out.note = `插件未声明也未直接 import 任何 @deepseek-ai 包（扫描 ${fileCount} 个 js 文件）→ 需装后扫 node_modules 复核`
    }
    return out
  } catch (err) {
    // 任何意外都不影响上传流程：降级为 unknown（放行 + 标记）
    out.level = 'unknown'
    out.note = `预检异常（已降级为待复核）：${err instanceof Error ? err.message : String(err)}`
    return out
  }
}
