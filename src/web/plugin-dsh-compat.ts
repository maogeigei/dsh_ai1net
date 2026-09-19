/**
 * plugin-dsh-compat.ts —— 判「**尚未安装**的 npm 插件按其声明，是否兼容**当前** dsh 版本」。
 *
 * 为什么单独一个文件（不复用 `plugin-compat.ts` 的**判定逻辑**）：
 *   · 那个模块判的是「**已解包到磁盘**的插件目录」，要扫 bundle 里的 import、要 import 平台包
 *     取真实导出 —— 对「官方推荐列表里还没下载的一条」根本用不上；
 *   · 两处的**语义口径必须不同**（见下），混在一起会把两边都带偏。
 *   ⚠️ **版本表是共用的**：伞包 `@deepseek-ai/dsh` **不在自己的 `node_modules` 里**，
 *     只按「scope 目录 + 短名」查会对它恒判 `null` —— 而实测那 3 条「要求更高版本」的声明
 *     **全部只写在伞包上**（不补这一步就一条都认不出来）。该解析已收口到
 *     `dsh-install.platformPackageVersion()`，`plugin-compat` 与本模块**共用同一份**。
 *
 * ⚠️ **语义口径（踩过才知道）**：判 `satisfies` 必须带 **`includePrerelease: true`**。
 *   平台版本是 prerelease（`0.1.5-rc.1` / 子包 `0.1.5-rc.2`），而 semver **默认语义**下
 *   prerelease **不满足** `^0.1.2`、甚至不满足 `*`（除非范围里带同元组 prerelease）。
 *   实测 2026-09-14：TOP300 用默认语义得 `match 97 / older 139`（`dsh-univer-office`、
 *   `dshmarket` 这些**在平台上跑得好好的**都被判成 "只兼容更旧版本"）；换成 prerelease
 *   容忍后是 `match 214 / older 22`。⇒ **此处的"匹配"= prerelease 容忍语义**。
 *   （`plugin-compat.ts` 用默认语义是**有意的**：那里要跟 pnpm 的实际安装判定一致 —— 两处
 *   语义不同是**正确的**，别"统一"掉。）
 *
 * @module dsh_ai1net/web/plugin-dsh-compat
 */

import { platformPackageVersion } from './dsh-install.js'

const DS_SCOPE = '@deepseek-ai/'
/** 伞包包名：它带版本声明时最值得看（子包版本通常与它同位）。 */
const UMBRELLA = '@deepseek-ai/dsh'

/** 兼容性分类。 */
export type DshCompat = 'match' | 'none' | 'newer' | 'older' | 'unknown'

export interface DshCompatVerdict {
  /** `match` 声明满足 / `none` 未声明任何平台依赖 / `newer` 要求更高的 dsh / `older` 只允许更旧的 / `unknown` 判不了。 */
  kind: DshCompat
  /** `kind === 'newer'` 时给出**它要求的最低 dsh 版本**（能算出来才有）。 */
  requires?: string
  /** 判据摘要（排障用，落日志/缓存，不下发给浏览器）。 */
  why?: string
}

/* ------------------------------------------------------------------ *
 * 平台版本表（含伞包）—— 唯一实现在 `dsh-install.ts`
 * ------------------------------------------------------------------ */

/**
 * 平台某 `@deepseek-ai/*` 包的真实版本；平台没有 → `null`。
 * 与本文件的伞包解析需求同源：`dsh-install.platformPackageVersion()` **含伞包**
 * （伞包不在自己的 `node_modules` 里，那条坑在 `dsh-install.ts` 里有完整记录）。
 */
export function platformVersionOf(pkg: string): string | null {
  return platformPackageVersion(pkg)
}

/** 当前平台的 dsh 伞包版本（`0.1.5-rc.1` 这种）；读不到 → `null`。 */
export function platformDshVersion(): string | null {
  return platformPackageVersion(UMBRELLA)
}

/* ------------------------------------------------------------------ *
 * semver（与 plugin-compat 同款"软依赖"载入：拿不到就全部 unknown）
 * ------------------------------------------------------------------ */

type SemverLike = {
  satisfies(v: string, r: string, o?: { includePrerelease?: boolean }): boolean
  minVersion(r: string): { version: string } | null
  lt(a: string, b: string): boolean
}

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
 * 声明抽取 + 判定
 * ------------------------------------------------------------------ */

/**
 * 从 npm 包的 manifest 里抽出**与平台相关**的声明：`@deepseek-ai/*` 的
 * peer / optional / 运行依赖，外加 `engines.dsh`（有插件用它写版本要求）。
 * @param manifest npm registry 返回的 `versions[<ver>]` 对象（字段可能缺失）
 */
export function platformDeclsOf(manifest: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof manifest !== 'object' || manifest === null) return out
  const m = manifest as Record<string, Record<string, unknown> | undefined>
  for (const bucket of ['peerDependencies', 'optionalDependencies', 'dependencies']) {
    const bag = m[bucket]
    if (typeof bag !== 'object' || bag === null) continue
    for (const [k, v] of Object.entries(bag)) {
      if (k.startsWith(DS_SCOPE) && typeof v === 'string') out.set(k, v)
    }
  }
  const eng = m['engines']
  if (typeof eng === 'object' && eng !== null && typeof (eng as Record<string, unknown>)['dsh'] === 'string') {
    out.set(UMBRELLA, (eng as Record<string, string>)['dsh'])
  }
  return out
}

/**
 * 判定「按该插件声明的平台依赖范围，能否装在**当前** dsh 上」。
 * @param manifest npm registry 的版本 manifest（要用 `platformDeclsOf` 能认的那一层）
 */
export async function judgeDshCompat(manifest: unknown): Promise<DshCompatVerdict> {
  const decls = platformDeclsOf(manifest)
  if (decls.size === 0) return { kind: 'none', why: '未声明任何 @deepseek-ai/* 依赖' }

  const semver = await loadSemver()
  if (semver === null) return { kind: 'unknown', why: 'semver 不可用' }

  let satisfied = 0
  let unjudged = 0
  /** 不满足且「要求比平台更高」→ 记下它要求的最低版本。 */
  let newer: { pkg: string; range: string; min: string } | null = null
  const older: string[] = []

  for (const [pkg, range] of decls) {
    const v = platformVersionOf(pkg)
    // 平台没有这个包 ⇒ 不据此断言（与 plugin-compat 判据 A 同一处理：可能是插件自带）
    if (v === null) {
      unjudged++
      continue
    }
    let ok: boolean
    try {
      ok = semver.satisfies(v, range, { includePrerelease: true })
    } catch {
      unjudged++
      continue
    }
    if (ok) {
      satisfied++
      continue
    }
    let min: string | null = null
    try {
      min = semver.minVersion(range)?.version ?? null
    } catch {
      min = null
    }
    if (min !== null && semver.lt(v, min)) {
      // 平台版本低于该范围允许的最低版本 ⇒ 插件要求**更新的** dsh
      if (newer === null || semver.lt(newer.min, min)) newer = { pkg, range, min }
    } else {
      older.push(`${pkg}(${v} ∉ ${range})`)
    }
  }

  // 只要有一条"要求更高"，这条插件就属于「需要升级 dsh 才能用」—— 比"只兼容更旧"更重要。
  if (newer !== null) {
    return { kind: 'newer', requires: newer.min, why: `${newer.pkg} 要求 ${newer.range}` }
  }
  if (older.length > 0) return { kind: 'older', why: older.slice(0, 3).join('；') }
  if (satisfied > 0) return { kind: 'match', why: `满足 ${satisfied} 条声明` }
  if (unjudged > 0) return { kind: 'unknown', why: `平台无对应包或范围不可解析（${unjudged} 条）` }
  return { kind: 'none', why: '无可判定的声明' }
}
