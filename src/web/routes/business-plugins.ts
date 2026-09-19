/**
 * Business-plugin (系统外插件) candidate-pool routes. Admin-only.
 *
 * Upload contract: a `.tgz` bundle containing a dsh cordis bundle — a
 * `package.json` with `name` (npm package-name shape, scope allowed). The
 * archive is extracted into staging, its `package.json` is validated, and its
 * text files are scanned for obviously-malicious patterns (安全检测) before it
 * is admitted to the pool.
 *
 * Same-name upload REPLACES the pool entry: the previous `.tgz` file is removed
 * in full first (替换策略, not overwrite — stale files cannot survive).
 *
 * The pool is a set of `.tgz` files under `<dataRoot>/business-plugins/` plus a
 * `business_plugins` row of metadata. Users enable a plugin per-instance in a
 * later phase (阶段 2), which copies the bundle into their profile.
 * @module dsh_ai1net/web/routes/business-plugins
 */

import type { FastifyPluginAsync } from 'fastify'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { requireAdmin, requireAuth } from '../middleware/authn.js'
import { httpError, scanDirDetailed, type ScanBlock, type ScanFinding } from '../security-scan.js'
import { checkPluginCompat, type CompatResult } from '../plugin-compat.js'
import { userRoot } from '../../fs/workspace.js'

/** Route-level body limit for uploads (base64 ~4/3 of archive size). */
const UPLOAD_BODY_LIMIT = 180 * 1024 * 1024

const STAGE_PREFIX = '.biz-plugin-'
const STAGE_ID_RE = /^\.biz-plugin-[0-9a-f]{12}$/
const STAGE_TTL_MS = 10 * 60 * 1000

/** npm package-name shape, scope (`@scope/name`) allowed. */
const PKG_NAME_RE = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/

/** Sanitize a package name into a flat, path-safe filename. */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

interface ProfileManifest {
  bundles: string[]
  deps: Record<string, string>
}

function readProfileManifest(dir: string): ProfileManifest {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
      dependencies?: Record<string, string>
    }
    return { bundles: pkg.dsh?.profile?.bundles ?? [], deps: pkg.dependencies ?? {} }
  } catch {
    return { bundles: [], deps: {} }
  }
}

function writeProfileManifest(dir: string, bundles: string[], deps: Record<string, string>): void {
  const path = join(dir, 'package.json')
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    pkg = { name: 'dsh-profile-web', private: true }
  }
  const dsh = (pkg.dsh ?? {}) as Record<string, unknown>
  const profile = (dsh.profile ?? {}) as Record<string, unknown>
  profile.bundles = bundles
  dsh.profile = profile
  pkg.dsh = dsh
  pkg.dependencies = deps
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
}

/** Find the first `package.json` under `root` (depth ≤ 3), tolerant of the npm
 * `package/` wrapper directory produced by `npm pack`. */
function findPackageJson(root: string, depth = 0): string | null {
  if (depth > 3) return null
  const candidate = join(root, 'package.json')
  if (existsSync(candidate)) return candidate
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry)
    if (lstatSync(abs).isDirectory() && !entry.startsWith('.')) {
      const found = findPackageJson(abs, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

interface StagedPlugin {
  stage: string
  tgzName: string
  name: string
  description: string | null
  version: string | null
  fileCount: number
  /** P0 命中（**不阻断**，交调用方裁决：默认拒绝，或 admin 显式信任后放行）。 */
  blocked: ScanBlock[]
  /** P1 告警（不阻断，记录 + 可回显）。 */
  warnings: ScanFinding[]
  /**
   * 兼容性预检结果：`incompatible` 表示与当前平台 dsh 版本不兼容
   * （判据：`@deepseek-ai/*` 依赖范围 / 导出符号），**默认拒绝投放**，admin 可显式信任。
   * `unknown` = 静态判不了（放行 + 标记待装后复核）。
   */
  compat: CompatResult
}

/** Extract + validate + scan a `.tgz` bundle under `<dataRoot>/<staging>`. */
export async function stageTgzArchive(dataRoot: string, archive: Buffer): Promise<StagedPlugin> {
  const stage = join(dataRoot, STAGE_PREFIX + randomBytes(6).toString('hex'))
  const payload = join(stage, 'payload.tgz')
  const unzipDir = join(stage, 'unzip')
  mkdirSync(unzipDir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(payload, archive)

    // 1. List members, reject absolute / traversal paths.
    const members = execFileSync('tar', ['-tzf', payload], { encoding: 'utf8', timeout: 30000 }).split('\n')
    let fileCount = 0
    for (let raw of members) {
      raw = raw.trim()
      if (raw === '' || raw.startsWith('./')) raw = raw.replace(/^\.\/+/, '')
      if (raw === '') continue
      if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw httpError(400, `tgz member uses an absolute path: ${raw}`)
      if (raw.split('/').includes('..')) throw httpError(400, `tgz member escapes the root: ${raw}`)
      if (!raw.endsWith('/')) fileCount += 1
    }
    if (fileCount === 0) throw httpError(400, 'tgz 为空（无文件）')

    // 2. Extract.
    execFileSync('tar', ['-xzf', payload, '-C', unzipDir], { timeout: 120000 })

    // 3. Validate package.json.
    const pkgJsonPath = findPackageJson(unzipDir)
    if (pkgJsonPath === null) throw httpError(400, 'tgz 缺少 package.json —— 不是 dsh 插件包')
    let pkg: { name?: unknown; version?: unknown; description?: unknown }
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as typeof pkg
    } catch {
      throw httpError(400, 'package.json 解析失败')
    }
    const name = typeof pkg.name === 'string' ? pkg.name.trim() : ''
    if (name === '' || !PKG_NAME_RE.test(name)) {
      throw httpError(400, `package.json name 无效（须为 npm 包名，可含 @scope）："${name}"`)
    }
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : null
    const description = typeof pkg.description === 'string' ? pkg.description.trim() : null

    // 4. Security scan (危险内容扫描).
    // **收集式**：P0 命中不在此处抛出，而是随结构返回交调用方裁决。理由：命中常来自文档里的
    // 说明性字样（典型：第三方插件的 README 教用户把 key 写进 `.credentials.yaml`，被
    // `/\.credentials\.yaml/` 规则判成「读取实例会话密钥」）—— 直接 400 会让 admin 看不到
    // 命中详情、也无从对**已人工确认**的包放行。调用方（上传接口）默认拒绝并把逐条命中回显，
    // 只有 admin **显式声明信任**（并写 audit）后才放行。
    const scanned = scanDirDetailed(unzipDir)
    if (scanned.blocked.length > 0 || scanned.warnings.length > 0) {
      process.stderr.write(
        `[upload-scan] ${JSON.stringify({
          name,
          blocked: scanned.blocked.length,
          warnings: scanned.warnings.length,
          detail: scanned.blocked.slice(0, 10),
        })}\n`,
      )
    }

    // 5. 兼容性预检。
    //    与安全扫描同一套裁决方式：**不在此处抛出**，把结果随结构返回交调用方裁决
    //    （`incompatible` 默认拒绝并把逐条依据回显，admin 显式信任后才放行并留痕）。
    //    为什么必须在投放时判：不兼容的插件装上去会让实例 `plugin tree failed to load`
    //    → 崩溃循环（插件兼容性事故就是这么发生的）。
    const compat = await checkPluginCompat(unzipDir)
    if (compat.level !== 'ok') {
      process.stderr.write(
        `[upload-compat] ${JSON.stringify({
          name,
          level: compat.level,
          findings: compat.findings.slice(0, 10),
          note: compat.note ?? null,
        })}\n`,
      )
    }

    return {
      stage,
      tgzName: sanitizeFileName(name) + '.tgz',
      name,
      description,
      version,
      fileCount,
      blocked: scanned.blocked,
      warnings: scanned.warnings,
      compat,
    }
  } catch (err) {
    rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

function collectStaleStages(dataRoot: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dataRoot).filter((n) => n.startsWith(STAGE_PREFIX))
  } catch {
    return []
  }
  const stale: string[] = []
  for (const name of names) {
    try {
      if (Date.now() - lstatSync(join(dataRoot, name)).mtimeMs > STAGE_TTL_MS) stale.push(name)
    } catch {
      stale.push(name)
    }
  }
  return stale
}

// ── web provider 联动（2026-09-12）──────────────────────────────
// 为什么需要：dsh 的 web provider 选择是**单选** —— 显式配置即硬绑定（provider 一旦不在就报
// CONFIGURED_MISSING 且**不回落**），未配置时只有「恰好一个可用」才自动选，多个可用直接
// AMBIGUOUS 报错。于是「两个 provider 共存 + 用户可任意启停」必然出现坏状态。
// 解法：平台在插件启停后**按当前 bundles 重算**这一段 ——
//   插件在 → 写死它声明的 searchProvider；插件不在 → 整段删除（回到「只有一个可用」时自动选）。
// 平台策略：`fetchProvider` 恒为本地 `http`（保留 SSRF 防护），**忽略**插件对 fetch 的声明。
//
// 放在模块级并导出（不依赖 `app`），以便被独立验证。
export const WEB_PROVIDER_OPEN = '# >>> platform: web-provider (managed by business-plugins)'
export const WEB_PROVIDER_CLOSE = '# <<< platform: web-provider'
/** 历史托管段（早期版本直铺时写下的标记），同步时一并清掉。 */
export const WEB_PROVIDER_LEGACY: ReadonlyArray<readonly [string, string]> = [
  ['# >>> platform: search-provider', '# <<< platform: search-provider'],
]

/** 扫描已启用 bundle 自带的 cordis.patch.yml，收集它们对 `dsh-web` 的 provider 声明。 */
export function collectWebProviderClaims(dir: string, bundles: readonly string[]): { search: string | null } {
  let search: string | null = null
  for (const b of bundles) {
    if (b.startsWith('@deepseek-ai/')) continue
    let text: string
    try {
      text = readFileSync(join(dir, 'node_modules', b, 'cordis.patch.yml'), 'utf8')
    } catch {
      continue
    }
    let inWeb = false
    let inConfig = false
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+$/, '')
      const idm = /^-\s+id:\s*(\S+)/.exec(line)
      if (idm !== null) {
        inWeb = idm[1] === 'web'
        inConfig = false
        continue
      }
      if (!inWeb) continue
      if (/^\s+config:\s*$/.test(line)) {
        inConfig = true
        continue
      }
      if (!inConfig) continue
      const sm = /^\s+searchProvider:\s*(\S+)/.exec(line)
      if (sm !== null && search === null) search = sm[1]
    }
  }
  return { search }
}

/** 按当前 bundles 重算 profile 的 web provider 托管段（幂等：先摘旧段，再按需追加）。 */
export function syncWebProviderPatch(dir: string): void {
  const path = join(dir, 'cordis.patch.yml')
  let text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const blocks: ReadonlyArray<readonly [string, string]> = [[WEB_PROVIDER_OPEN, WEB_PROVIDER_CLOSE], ...WEB_PROVIDER_LEGACY]
  for (const [open, close] of blocks) {
    const s = text.indexOf(open)
    const e = text.indexOf(close)
    if (s < 0 || e <= s) continue
    const lineStart = text.lastIndexOf('\n', s)
    text = text.slice(0, lineStart < 0 ? s : lineStart) + text.slice(e + close.length)
  }
  const { search } = collectWebProviderClaims(dir, readProfileManifest(dir).bundles)
  if (search !== null) {
    text = text.replace(/\s*$/, '\n') + [
      '',
      WEB_PROVIDER_OPEN,
      '# 由业务插件的启用/禁用自动维护，请勿手改。策略：只换 search，fetch 恒为本地 http（保留 SSRF 防护）。',
      '- id: web',
      '  config:',
      `    searchProvider: ${search}`,
      '    fetchProvider: http',
      WEB_PROVIDER_CLOSE,
      '',
    ].join('\n')
  }
  writeFileSync(path, text.replace(/^\s*\n/, ''))
}

export const businessPluginRoutes: FastifyPluginAsync = async (app) => {
  const poolDir = (): string => join(app.config.dataRoot, 'business-plugins')

  const gc = (): void => {
    for (const stale of collectStaleStages(app.config.dataRoot)) {
      rm(join(app.config.dataRoot, stale), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  app.get('/api/plugins/business', { preHandler: requireAdmin }, async () => {
    return { plugins: await app.db.listBusinessPlugins() }
  })

  app.post(
    '/api/plugins/business',
    { preHandler: requireAdmin, bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      const body = request.body as {
        file?: string
        filename?: string
        /** admin 对 P0 命中的显式信任声明；缺省时命中即拒绝（fail-closed）。 */
        trust?: { confirmed?: boolean; reason?: string }
      }
      try {
        const filename = body.filename ?? ''
        if (!basename(filename).toLowerCase().endsWith('.tgz')) throw httpError(400, '仅支持 .tgz 文件')
        const archive = Buffer.from(body.file ?? '', 'base64')
        if (archive.length === 0) throw httpError(400, 'empty archive payload')
        gc()
        const staged = await stageTgzArchive(app.config.dataRoot, archive)

        // 安全检测裁决：默认 fail-closed —— P0 命中即拒绝，但把逐条命中回显给 admin
        //（旧行为只有一句脱敏文案，admin 无从判断）。admin 显式声明信任后才放行并留痕。
        const trusted = body.trust?.confirmed === true
        if (staged.blocked.length > 0 && !trusted) {
          await rm(staged.stage, { recursive: true, force: true }).catch(() => undefined)
          return reply.code(409).send({
            error: 'scan_blocked',
            message: '安全检测命中 P0 规则，已拒绝投放。请逐条查看命中内容；确认该包可信后，再提交并在请求中声明信任（会记入审计日志）。',
            blocked: staged.blocked,
            warnings: staged.warnings,
          })
        }

        // 兼容性裁决：同一套 fail-closed + 显式信任。
        // 判据 A = `@deepseek-ai/*` 依赖范围是否接受平台版本；判据 B = import 的符号是否在平台包导出里。
        if (staged.compat.level === 'incompatible' && !trusted) {
          await rm(staged.stage, { recursive: true, force: true }).catch(() => undefined)
          return reply.code(409).send({
            error: 'compat_incompatible',
            message: '该插件与当前平台 dsh 版本不兼容，已拒绝投放（判据：依赖版本范围 / 导出符号）。请逐条查看依据；若已人工确认可用，再提交并在请求中声明信任（会记入审计日志）。',
            compat: staged.compat,
            warnings: staged.warnings,
          })
        }

        // 替换策略：同名先删旧 tgz（旧文件无残留），再落新包。
        const dir = poolDir()
        await mkdir(dir, { recursive: true, mode: 0o755 })
        const existing = await app.db.findBusinessPlugin(staged.name)
        if (existing !== undefined) {
          if (existsSync(existing.tgzPath)) await rm(existing.tgzPath, { force: true })
        }
        const destPath = join(dir, staged.tgzName)
        await rename(join(staged.stage, 'payload.tgz'), destPath)

        const plugin = await app.db.upsertBusinessPlugin({
          id: staged.name,
          name: staged.name,
          description: staged.description,
          version: staged.version,
          tgzPath: destPath,
          fileSize: archive.length,
          uploadedBy: request.user?.id ?? null,
        })
        const compatOverrode = trusted && staged.compat.level === 'incompatible'
        const overrode = trusted && (staged.blocked.length > 0 || compatOverrode)
        await app.db.audit(
          request.user?.id ?? null,
          'upload_business_plugin',
          JSON.stringify({
            name: plugin.name,
            version: plugin.version,
            trustedOverride: overrode,
            compatLevel: staged.compat.level,
          }),
        )
        if (overrode) {
          await app.db.audit(
            request.user?.id ?? null,
            'trust_business_plugin',
            JSON.stringify({
              name: staged.name,
              version: staged.version,
              blocked: staged.blocked,
              compat: compatOverrode ? staged.compat : undefined,
              reason: body.trust?.reason ?? '',
            }),
          )
        }
        await rm(staged.stage, { recursive: true, force: true }).catch(() => undefined)
        return {
          ok: true,
          plugin,
          replaced: existing !== undefined,
          trustedOverride: overrode,
          compat: staged.compat,
          warnings: staged.warnings,
        }
      } catch (err) {
        const e = err as Error & { statusCode?: number }
        return reply.code(e.statusCode ?? 400).send({ error: e.message })
      }
    },
  )

  app.delete('/api/plugins/business/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!PKG_NAME_RE.test(id)) return reply.code(400).send({ error: 'invalid_plugin_id' })
    const existing = await app.db.findBusinessPlugin(id)
    if (existing === undefined) return reply.code(404).send({ error: 'not_found' })
    if (existsSync(existing.tgzPath)) await rm(existing.tgzPath, { force: true })
    await app.db.deleteBusinessPlugin(id)
    await app.db.audit(request.user?.id ?? null, 'delete_business_plugin', JSON.stringify({ name: id }))
    return { ok: true }
  })

  // ── mine: per-user enable/disable of business plugins（异步 + pnpm） ──────
  // 启用 = `pnpm add file:<tgz>`（装插件 + 依赖，pnpm 全局 store 硬链复用依赖）+ reconcile
  // bundles；禁用 = `pnpm remove`（依赖从 dependencies 移除，重新启用靠 store 硬链秒恢复）。
  // 改完重启实例。安装异步执行：POST 返回 taskId，前端轮询 GET task/:id 看「阶段 + 状态」
  //（B 方案：不滚日志，失败给友好文案）。
  const profileDir = (userId: string): string => join(userRoot(app.config.dataRoot, userId), 'home', 'profiles', 'web')
  /** 该用户的 `<root>/ws` —— pnpm 的 HOME（store / cache 落在这里）。 */
  const wsDir = (userId: string): string => join(userRoot(app.config.dataRoot, userId), 'ws')

  /**
   * 该用户的 Linux uid/gid —— 取 `<root>/home` 的属主（编排器创建时就 chown 给了该用户）。
   * 不查 DB：uid 列与本目录属主由同一次创建写入，读目录少一处耦合。
   */
  const uidOf = (userId: string): number => lstatSync(join(userRoot(app.config.dataRoot, userId), 'home')).uid

  /**
   * **以该用户身份**跑 pnpm（setpriv 降权）。
   *
   * 为什么必须有：这条路（门户候选池启停）早期直接**以平台进程身份**跑 pnpm，装出来的文件属主是
   * root —— 此后该用户自己跑任何 `pnpm add/remove` 都会撞 `EACCES`，插件彻底装不上
   * （2026-09-12 实测：guest profile 下积了 561 个 root 属主项，升级直接失败）。
   * 平台侧脚本（平台侧脚本）一直用的是 setpriv 正姿，两条路线不同所以没暴露。
   */
  const runPnpmAs = (userId: string, args: readonly string[], cwd: string): void => {
    const uid = uidOf(userId)
    execFileSync('setpriv', [
      '--reuid', String(uid), '--regid', String(uid), '--clear-groups',
      'env', `HOME=${wsDir(userId)}`,
      'pnpm', ...args,
    ], { cwd, timeout: 180000, stdio: 'pipe' })
  }

  /**
   * 属主自愈：把 profile 下 **root 属主**的残留项还给该用户（历史根因留下的存量）。
   *
   * 每次改插件前跑一次 —— 这是「修根因 + 防复发」里的防复发那一半：即便将来**别的**写入路径
   * 又污染了属主，用户下次启停插件时也会被自动清理，不必再人工排查。
   * 用 `find -exec chown +` 而不是一次传全部路径，避免路径过多撞命令行长度上限。
   *
   * @param userId - 目标用户。
   * @returns 修复的条目数（0 = 本来就干净）。
   */
  const healOwnership = (userId: string): number => {
    const dir = profileDir(userId)
    let count = 0
    try {
      const out = execFileSync('find', [dir, '-user', 'root'], { encoding: 'utf8', timeout: 60000 })
      count = out.split('\n').filter((line) => line.trim() !== '').length
      if (count === 0) return 0
    } catch {
      return 0
    }
    const uid = uidOf(userId)
    try {
      // `-h`：`.bin/*` 是指向别处的符号链接，要改链接本身而不是它的目标。
      execFileSync('find', [dir, '-user', 'root', '-exec', 'chown', '-h', `${uid}:${uid}`, '{}', '+'], { timeout: 180000 })
    } catch {
      return 0
    }
    return count
  }
  // pnpm 的 store 位置由 HOME 决定；dsh 跑 pnpm 时 HOME 指向用户 ws，store 落在
  // `<root>/ws/.local/share/pnpm/store/v3`（.modules.yaml 记录）。平台跑 pnpm 必须设同样的
  // HOME，否则会报 ERR_PNPM_UNEXPECTED_STORE —— 见上面 `runPnpmAs` 里的 `HOME=<ws>`。

  interface PluginTask {
    status: 'pending' | 'running' | 'success' | 'failed' | 'timeout'
    stage: string
    error?: string
    enabled?: string[]
    /** 本轮因「启用后实例起不来」被自动摘掉的插件。 */
    rejected?: Array<{ id: string; reason: string }>
    restarted: boolean
    startedAt: number
    updatedAt: number
  }
  const tasks = new Map<string, PluginTask>()

  /** 一个依赖是否带 dsh.bundle.patch（= 是 bundle，对齐 dsh 的 isBundle 判定）。 */
  function isBundle(dir: string, dep: string): boolean {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', dep, 'package.json'), 'utf8')) as {
        dsh?: { bundle?: { patch?: unknown } }
      }
      return pkg.dsh?.bundle?.patch !== undefined
    } catch {
      return false
    }
  }

  /** 对齐 dsh plugin add 的 reconcile：dependencies 里带 dsh.bundle.patch 的进 bundles，
   * 非 @deepseek-ai 模板且已不在 dependencies 的从 bundles 移除。返回最终 bundles。 */
  function reconcileBundles(dir: string): string[] {
    const path = join(dir, 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    const bundles = pkg.dsh?.profile?.bundles ?? []
    const kept = bundles.filter((b) => b.startsWith('@deepseek-ai/') || deps.includes(b))
    for (const dep of deps) {
      if (!kept.includes(dep) && isBundle(dir, dep)) kept.push(dep)
    }
    pkg.dsh = pkg.dsh ?? {}
    pkg.dsh.profile = pkg.dsh.profile ?? {}
    pkg.dsh.profile.bundles = kept
    writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
    return kept
  }

  /** 把 pnpm 的原始报错翻译成用户能懂的友好文案。 */
  function friendlyError(err: unknown): string {
    const message = String((err as Error)?.message ?? err)
    const stderr = String((err as { stderr?: Buffer })?.stderr ?? '')
    const text = stderr || message
    if (text.includes('ETIMEDOUT') || text.includes('timed out')) return '安装超时，请重试'
    if (text.includes('No matching version')) return '插件版本不匹配'
    if (text.includes('ENOTFOUND') || text.includes('getaddrinfo')) return '网络连接失败，请重试'
    if (text.includes('Not Found') || text.includes('E404')) return '依赖包不存在，请重试'
    return '安装失败，请重试或联系管理员'
  }

  // ── profile 快照与还原（插件启用失败时回滚用）────────────────
  // 只快照我们会改动的文件；node_modules 不回滚（无害，重装很快，回滚反而慢且易碎）。
  const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'] as const

  function snapshotProfile(dir: string): Record<string, string | null> {
    const snap: Record<string, string | null> = {}
    for (const f of SNAPSHOT_FILES) {
      const p = join(dir, f)
      snap[f] = existsSync(p) ? readFileSync(p, 'utf8') : null
    }
    return snap
  }

  function restoreProfile(dir: string, snap: Record<string, string | null>): void {
    for (const [f, content] of Object.entries(snap)) {
      const p = join(dir, f)
      if (content === null) {
        if (existsSync(p)) rmSync(p, { force: true })
      } else {
        writeFileSync(p, content)
      }
    }
  }

  app.get('/api/plugins/mine', { preHandler: requireAuth }, async (request) => {
    const user = request.user!
    const { bundles } = readProfileManifest(profileDir(user.id))
    const enabled = new Set(bundles)
    const plugins = await app.db.listBusinessPlugins()
    return {
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        fileSize: p.fileSize,
        enabled: enabled.has(p.id),
      })),
    }
  })

  app.post('/api/plugins/mine/apply', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!
    const body = request.body as { plugins?: Array<{ id: string; enabled: boolean }> }
    const selections = body.plugins ?? []
    for (const sel of selections) {
      if (!PKG_NAME_RE.test(sel.id)) return reply.code(400).send({ error: `invalid plugin id: ${sel.id}` })
    }
    const dir = profileDir(user.id)
    await mkdir(dir, { recursive: true })
    const { bundles } = readProfileManifest(dir)
    const enabledSet = new Set(bundles)
    const toEnable = selections.filter((s) => s.enabled && !enabledSet.has(s.id))
    const toDisable = selections.filter((s) => !s.enabled && enabledSet.has(s.id))
    if (toEnable.length === 0 && toDisable.length === 0) return { ok: true, restarted: false, noop: true }

    const taskId = randomBytes(8).toString('hex')
    tasks.set(taskId, { status: 'pending', stage: '排队中', restarted: false, startedAt: Date.now(), updatedAt: Date.now() })

    void (async () => {
      const task = tasks.get(taskId)!
      task.status = 'running'
      const setStage = (stage: string): void => {
        task.stage = stage
        task.updatedAt = Date.now()
      }
      setStage('准备中…')

      // 应用前快照，供探活失败时回滚。
      const snap = snapshotProfile(dir)
      const applied: string[] = []
      const rejected: Array<{ id: string; reason: string }> = []

      const install = async (id: string): Promise<void> => {
        const plugin = await app.db.findBusinessPlugin(id)
        if (plugin === undefined) throw httpError(404, `插件不在候选池：${id}`)
        // 先自愈存量属主污染 —— 否则以用户身份跑 pnpm 连旧文件都覆盖不了（EACCES 直接失败）。
        const healed = healOwnership(user.id)
        if (healed > 0) {
          await app.db.audit(user.id, 'heal_plugin_ownership', JSON.stringify({ stage: `install:${id}`, healed }))
        }
        runPnpmAs(user.id, ['add', 'file:' + plugin.tgzPath, '--ignore-workspace-root-check', '--reporter', 'silent'], dir)
        reconcileBundles(dir)
        syncWebProviderPatch(dir)
      }
      const uninstall = async (id: string): Promise<void> => {
        const healed = healOwnership(user.id)
        if (healed > 0) {
          await app.db.audit(user.id, 'heal_plugin_ownership', JSON.stringify({ stage: `uninstall:${id}`, healed }))
        }
        runPnpmAs(user.id, ['remove', id, '-w', '--reporter', 'silent'], dir)
        reconcileBundles(dir)
        syncWebProviderPatch(dir)
      }
      const restartProbe = async (): Promise<{ ok: boolean; reason: string }> => {
        await app.userFs.writeHandoff(user.id, JSON.stringify({ command: '', createdAt: Date.now() }))
        return await app.supervisor.restartAndProbe(user.id)
      }

      try {
        // ① 禁用项：pnpm remove 不引入新代码，永远安全 → 不需要探活。
        for (const sel of toDisable) {
          setStage(`正在停用 ${sel.id}…`)
          await uninstall(sel.id)
        }

        if (toEnable.length > 0) {
          // ② 先整批试一次：正常路径（绝大多数）只花 1 次重启，与旧行为一致。
          setStage(`正在安装 ${toEnable.length} 个插件…`)
          for (const sel of toEnable) await install(sel.id)
          setStage('正在重启实例并探活…')
          const probe = await restartProbe()
          if (probe.ok) {
            applied.push(...toEnable.map((s) => s.id))
          } else {
            // ③ 探活失败 → 回滚到快照，再逐插件隔离定位：坏插件单独摘掉，好插件保留。
            setStage('实例未能启动，正在定位问题插件…')
            restoreProfile(dir, snap)
            for (let i = 0; i < toEnable.length; i++) {
              const sel = toEnable[i]
              setStage(`正在定位问题插件（${i + 1}/${toEnable.length}）：${sel.id}`)
              await install(sel.id)
              const p = await restartProbe()
              if (p.ok) {
                applied.push(sel.id)
                continue
              }
              setStage(`插件 ${sel.id} 与实例不兼容，已自动禁用`)
              // （2026-09-13）：**必须 await** —— uninstall 是 async，缺 await 时它的 rejection
              // 会逃出这个同步 try/catch，变成 unhandled rejection ⇒ **整个 orchestrator 进程退出**
              // （07:43:58 实证：pnpm remove 报 Unknown option → 平台被带崩、全体用户瞬断）。
              try { await uninstall(sel.id) } catch { /* 尽力而为 */ }
              rejected.push({ id: sel.id, reason: p.reason })
              await app.db.audit(user.id, 'plugin_incident', JSON.stringify({ pluginId: sel.id, reason: p.reason }))
            }
            // 定位循环结束时实例可能停在「刚摘掉坏插件」的状态 → 再确认一次。
            setStage('正在恢复实例…')
            await restartProbe()
          }
        }

        const finalBundles = readProfileManifest(dir).bundles
        task.enabled = finalBundles
        task.rejected = rejected
        task.restarted = true
        task.status = 'success'
        task.stage = rejected.length === 0
          ? '完成'
          : `完成：${applied.length} 个已启用，${rejected.length} 个已自动禁用`
        if (rejected.length > 0) {
          task.error = `以下插件与实例不兼容，已自动禁用：${rejected.map((r) => r.id).join('、')}`
        }
        task.updatedAt = Date.now()
        await app.db.audit(user.id, 'apply_business_plugins', JSON.stringify({ plugins: selections.map((s) => s.id), applied, rejected }))
      } catch (err) {
        // 兜底：任何异常都把 profile 还原，绝不让用户实例停在半应用状态。
        try { restoreProfile(dir, snap) } catch { /* ignore */ }
        try { await restartProbe() } catch { /* ignore */ }
        const friendly = friendlyError(err)
        task.status = friendly === '安装超时，请重试' ? 'timeout' : 'failed'
        task.stage = '失败'
        task.error = friendly
        task.updatedAt = Date.now()
      }
    })().catch((err: unknown) => {
      // 加固（2026-09-13）：**双保险** —— 任何逃出内层 try/catch 的异常都不许终止进程。
      // 没有这一层时，一次 uninstall 失败就把整个 dsh_ai1net 带崩（全体用户瞬断 + 所有实例被停）。
      // 注意：`task` 是 IIFE 内的局部量，这里只能按 taskId 从 tasks 表取回。
      try {
        const t = tasks.get(taskId)
        if (t !== undefined) {
          t.status = 'failed'
          t.stage = '失败'
          t.error = String((err as Error)?.message ?? err)
          t.updatedAt = Date.now()
        }
      } catch { /* ignore */ }
      try { console.error('[business-plugins] apply task crashed:', err) } catch { /* ignore */ }
    })
    return { ok: true, taskId }
  })

  app.get('/api/plugins/mine/task/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const task = tasks.get(id)
    if (task === undefined) return reply.code(404).send({ error: 'not_found' })
    return { ...task }
  })
}
