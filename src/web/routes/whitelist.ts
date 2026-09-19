/**
 * 官方白名单来源（方案 C · 方案 B 口径）：把 awesome-dsh-plugin 官方目录接入
 * 门户「插件管理」，admin 挑选后导入功能插件候选池。
 *
 * 数据源：`https://awesome-dsh-plugin.com/plugins.json`（官方规范地址；npm 镜像
 * `dsh-plugin-catalog`）。约 3400 条，每条含 `npm` 包名 / `install` 规格 /
 * `stars` / `downloads` / 分类 / 中英描述。相比 git clone 再解析 3431 个 yml，
 * 一次 HTTP 拿全，且字段更全。
 *
 * 导入口径 = **仅预构建**（不在平台侧执行任何第三方构建脚本）：
 *   1. 有 `npm` 包名        → 取 registry.npmjs.org 官方 tarball（预构建，秒装）
 *   2. 无 npm、有 `tarball` → 取 GitHub release 资产直链
 *   3. 两者皆无（官方 `install` 形态为 `github:owner/repo`，需源码构建）→ 不支持
 *      一键导入，接口返回明确原因，前端标记「需源码构建」。
 * 覆盖约 54%（1854/3408），官方下载量 TOP10 热门插件全部包含。
 *
 * 导入复用 business-plugins 的 `stageTgzArchive`（成员路径校验 + package.json
 * 校验 + 危险内容安全扫描）+ 同名替换策略，与管理员手工上传是同一条链路。
 *
 * 注：官方清单的「收录」不等于安全审计（上游 README 明确声明）。安全兜底完全
 * 依赖 `stageTgzArchive` 的安全扫描；P0 命中时阻断并把原因原样回显给 admin。
 * @module dsh_ai1net/web/routes/whitelist
 */

import type { FastifyPluginAsync } from 'fastify'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAdmin } from '../middleware/authn.js'
import { httpError } from '../security-scan.js'
import { type DshCompat, type DshCompatVerdict, judgeDshCompat, platformDshVersion } from '../plugin-dsh-compat.js'
import { stageTgzArchive } from './business-plugins.js'

/** 官方目录规范地址（同一份内容亦镜像为 npm 包 `dsh-plugin-catalog`）。 */
const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const REGISTRY = 'https://registry.npmjs.org'
/** 索引缓存 TTL：6 小时。 */
const CACHE_TTL = 6 * 60 * 60 * 1000
/**
 * 缓存结构版本。改字段/换数据源时必须 +1 —— 否则 TTL 内的旧格式缓存会被直接
 * 复用，条目缺字段，后续按字段过滤就会在请求里抛异常（v1 = git clone + yml 版）。
 */
const CACHE_VERSION = 3
const FETCH_TIMEOUT_MS = 60_000
/** 单次导入上限（避免一次拉太多把请求拖死）。 */
const MAX_IMPORT = 20
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024

/** 官方 `plugins.json` 的单条原始形态（字段可能缺失，全部按需兜底）。 */
interface RawEntry {
  name?: string
  owner?: string
  url?: string
  page?: string
  category?: string
  description?: { zh?: string; en?: string }
  npm?: string | null
  version?: string | null
  stars?: number
  downloads?: number | null
  install?: string
  tarball?: string | null
  screenshots?: unknown
}

/** 导入方式：`npm` = registry 官方 tarball；`tarball` = release 资产；`source` = 需源码构建（不支持）。 */
type ImportKind = 'npm' | 'tarball' | 'source'

interface WhitelistEntry {
  /** `owner/name`，清单内唯一，前端勾选与导入回查都用它。 */
  id: string
  name: string
  owner: string
  url: string
  page: string
  category: string
  /** 分类中文名（来自目录顶层 `categories` 映射，如 `ui` → UI 增强）；缺映射时回退为 id。 */
  categoryLabel: string
  description: string
  npm: string | null
  version: string | null
  stars: number
  downloads: number
  install: string
  importKind: ImportKind
  tarball: string | null
  /** 官方目录是否给该插件配了截图（约 17% 条目有；有则可去 `page` 看效果图）。 */
  hasShots: boolean
}

interface CachedIndex {
  version: number
  fetchedAt: number
  source: string
  /** 分类 id → 中文名（目录顶层 `categories` 的映射，随缓存一起留存）。 */
  categoryLabels: Record<string, string>
  entries: WhitelistEntry[]
}

export const whitelistRoutes: FastifyPluginAsync = async (app) => {
  const cacheDir = join(app.config.dataRoot, 'whitelist-cache')
  const indexFile = join(cacheDir, 'index.json')

  const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

  /** 把官方目录 JSON 归一化成内部条目表 + 分类中文名映射，条目按热度排序。 */
  const buildIndex = (raw: unknown): { entries: WhitelistEntry[]; categoryLabels: Record<string, string> } => {
    const obj = raw as { plugins?: RawEntry[]; categories?: Record<string, { en?: string; zh?: string }> }
    const list = obj.plugins
    if (!Array.isArray(list)) throw httpError(502, '官方目录格式异常：缺少 plugins 数组')
    // 顶层 categories = { id: { en, zh } } —— 官方只在这里给分类的中文名。
    const categoryLabels: Record<string, string> = {}
    for (const [id, v] of Object.entries(obj.categories ?? {})) {
      const label = asString(v?.zh) !== '' ? asString(v.zh) : asString(v?.en)
      if (label !== '') categoryLabels[id] = label
    }
    const entries: WhitelistEntry[] = []
    for (const e of list) {
      const name = asString(e.name)
      if (name === '') continue
      const owner = asString(e.owner)
      const category = asString(e.category)
      const npm = asString(e.npm)
      const tarball = asString(e.tarball)
      const importKind: ImportKind = npm !== '' ? 'npm' : tarball !== '' ? 'tarball' : 'source'
      entries.push({
        id: owner === '' ? name : `${owner}/${name}`,
        name,
        owner,
        url: asString(e.url),
        page: asString(e.page),
        category,
        categoryLabel: categoryLabels[category] ?? category,
        description: asString(e.description?.zh) !== '' ? asString(e.description?.zh) : asString(e.description?.en),
        npm: npm === '' ? null : npm,
        version: asString(e.version) === '' ? null : asString(e.version),
        stars: Number(e.stars ?? 0) || 0,
        downloads: Number(e.downloads ?? 0) || 0,
        install: asString(e.install),
        importKind,
        tarball: tarball === '' ? null : tarball,
        hasShots: Array.isArray(e.screenshots) && e.screenshots.length > 0,
      })
    }
    // 下载量降序（未发 npm 的条目 downloads 为 0，自然沉底）→ 热门 = 可预构建安装。
    entries.sort((a, b) => b.downloads - a.downloads || b.stars - a.stars)
    return { entries, categoryLabels }
  }

  /** 拉官方目录并落缓存。 */
  const fetchCatalog = async (): Promise<{ entries: WhitelistEntry[]; categoryLabels: Record<string, string> }> => {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
    if (!res.ok) throw httpError(502, `官方目录拉取失败 HTTP ${res.status}`)
    const { entries, categoryLabels } = buildIndex(await res.json())
    if (entries.length === 0) throw httpError(502, '官方目录为空')
    mkdirSync(cacheDir, { recursive: true, mode: 0o755 })
    const payload: CachedIndex = { version: CACHE_VERSION, fetchedAt: Date.now(), source: CATALOG_URL, categoryLabels, entries }
    writeFileSync(indexFile, JSON.stringify(payload))
    return { entries, categoryLabels }
  }

  /** 读缓存：版本或结构不符一律当未命中（旧格式不能被复用）。 */
  const readCache = (): CachedIndex | null => {
    if (!existsSync(indexFile)) return null
    try {
      const cached = JSON.parse(readFileSync(indexFile, 'utf8')) as CachedIndex
      if (cached.version !== CACHE_VERSION) return null
      if (!Array.isArray(cached.entries) || cached.entries.length === 0) return null
      if (typeof cached.entries[0]?.importKind !== 'string') return null
      return cached
    } catch {
      return null
    }
  }

  /** 取索引：命中 TTL 用缓存；否则拉取；拉取失败但有旧缓存 → 降级用旧缓存并标 `stale`。 */
  const getIndex = async (force = false): Promise<{ fetchedAt: number; entries: WhitelistEntry[]; categoryLabels: Record<string, string>; stale: boolean }> => {
    const cached = readCache()
    if (!force && cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL) return { fetchedAt: cached.fetchedAt, entries: cached.entries, categoryLabels: cached.categoryLabels ?? {}, stale: false }
    try {
      const { entries, categoryLabels } = await fetchCatalog()
      return { fetchedAt: Date.now(), entries, categoryLabels, stale: false }
    } catch (err) {
      if (cached !== null) app.log.warn({ err }, 'whitelist: 官方目录拉取失败，降级使用本地缓存')
      if (cached !== null) return { fetchedAt: cached.fetchedAt, entries: cached.entries, categoryLabels: cached.categoryLabels ?? {}, stale: true }
      throw err
    }
  }

  /** 解析出可下载的预构建 tarball 直链（方案 B：绝不触发源码构建）。 */
  const resolveTarball = async (entry: WhitelistEntry): Promise<{ url: string; version: string | null }> => {
    if (entry.importKind === 'npm' && entry.npm !== null) {
      const name = entry.npm
      // scoped 包（@scope/name）的 packument 地址：`@` 保留、`/` 编码。
      const res = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw httpError(502, `npm registry 查询失败 HTTP ${res.status}（${name}）`)
      const meta = (await res.json()) as {
        'dist-tags'?: { latest?: string }
        versions?: Record<string, { dist?: { tarball?: string } }>
      }
      const latest = meta['dist-tags']?.latest
      const url = latest === undefined ? undefined : meta.versions?.[latest]?.dist?.tarball
      if (typeof url !== 'string' || url === '') throw httpError(502, `npm 包无可下载的已发布版本：${name}`)
      return { url, version: latest ?? null }
    }
    if (entry.tarball !== null) return { url: entry.tarball, version: entry.version }
    throw httpError(400, `该插件需从源码构建安装${entry.install === '' ? '' : `（${entry.install}）`}，暂不支持一键导入`)
  }

  /* ------------------------------------------------------------------ *
   * dsh 版本兼容判定
   *
   * 由来（用户 2026-09-14）：「官方推荐插件列表**只能显示匹配当前 dsh 版本 和 超过当前版本**的
   * 插件（超过的要明确标注）」。官方目录**不带 dsh 版本字段**（只有插件自身 `version`）⇒ 只能
   * 逐包去 npm 取 `peerDependencies / engines`，与**平台真实版本**比（判定细节见
   * `src/web/plugin-dsh-compat.ts` 头部注释，含「必须 includePrerelease」的实测缘由）。
   *
   * 成本与缓存：一条 = 1 次 `registry.npmjs.org` 的**精简 packument**（十几 KB，不下载 tarball）。
   * 结果按 `<npm>@<version>` 落盘缓存，TTL 7 天（peer 范围极少变）。首次冷启动靠 `warmCompat`
   * 在后台预热；请求内只给有限预算，超预算的条目判 `unknown`（**显示并标注"未验证"**，
   * 绝不因为一次网络抖动就把插件**静默藏掉**）。
   * ------------------------------------------------------------------ */
  const compatFile = join(cacheDir, 'npm-dsh-compat.json')
  /** 缓存结构版本（判定口径变了就 +1，免得旧口径结论被复用）。 */
  const COMPAT_VERSION = 1
  const COMPAT_TTL = 7 * 24 * 60 * 60 * 1000
  /** 请求内判定的预算：超时即判 `unknown`（页面仍可用，后台预热会补上）。 */
  const COMPAT_BUDGET_MS = 6_000
  /** 请求内并发（别再高：registry 有软限流）。 */
  const COMPAT_CONCURRENCY = 12
  /** 预热并发（更保守：这是后台任务，不赶时间）。 */
  const WARM_CONCURRENCY = 6
  /** 每次请求最多判定多少条（列表页上限 300，多留一点余量给"过滤后补位"）。 */
  const COMPAT_WINDOW = 360

  interface CompatRecord {
    kind: DshCompat
    requires?: string
    why?: string
    at: number
  }

  let compatMem: Map<string, CompatRecord> | null = null
  let warmStarted = false

  const compatKey = (entry: WhitelistEntry): string | null =>
    entry.npm === null || entry.importKind === 'source' ? null : `${entry.npm}@${entry.version ?? ''}`

  const loadCompat = (): Map<string, CompatRecord> => {
    if (compatMem !== null) return compatMem
    compatMem = new Map()
    try {
      if (existsSync(compatFile)) {
        const raw = JSON.parse(readFileSync(compatFile, 'utf8')) as { version?: number; items?: Record<string, CompatRecord> }
        if (raw.version === COMPAT_VERSION && typeof raw.items === 'object' && raw.items !== null) {
          for (const [k, v] of Object.entries(raw.items)) if (typeof v?.kind === 'string') compatMem.set(k, v)
        }
      }
    } catch {
      /* 缓存坏了就当空表（不影响功能，只是要重判） */
    }
    return compatMem
  }

  let compatDirty = false
  const saveCompat = (): void => {
    if (!compatDirty || compatMem === null) return
    try {
      mkdirSync(cacheDir, { recursive: true, mode: 0o755 })
      const items: Record<string, CompatRecord> = {}
      for (const [k, v] of compatMem) items[k] = v
      writeFileSync(compatFile, JSON.stringify({ version: COMPAT_VERSION, items }))
      compatDirty = false
    } catch (err) {
      app.log.warn({ err }, 'whitelist: dsh 兼容缓存写入失败（下次请求重判）')
    }
  }

  /** 取单条判定；命中缓存（且未过期）直接返回，否则查 npm registry。 */
  const compatOf = async (entry: WhitelistEntry): Promise<DshCompatVerdict> => {
    const key = compatKey(entry)
    if (key === null) return { kind: 'none', why: '未发 npm 包' }
    const cache = loadCompat()
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < COMPAT_TTL) return { kind: hit.kind, requires: hit.requires, why: hit.why }

    let verdict: DshCompatVerdict
    try {
      const name = entry.npm as string
      // 精简 packument：带 `peerDependencies`，体积远小于完整 packument
      const res = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const meta = (await res.json()) as { 'dist-tags'?: { latest?: string }; versions?: Record<string, unknown> }
      const latest = meta['dist-tags']?.latest
      // 优先用「目录声明的版本」；缺了才用 latest（目录版本 = 用户会装到的那个）
      const manifest = (entry.version !== null ? meta.versions?.[entry.version] : undefined) ?? (latest === undefined ? undefined : meta.versions?.[latest])
      if (manifest === undefined) throw new Error('包内找不到该版本')
      verdict = await judgeDshCompat(manifest)
    } catch (err) {
      // 网络/元数据问题 ≠ 不兼容：判 `unknown` 并**照常显示**（fixture: 见本文件头部注释）
      verdict = { kind: 'unknown', why: err instanceof Error ? err.message : String(err) }
    }
    cache.set(key, { ...verdict, at: Date.now() })
    compatDirty = true
    return verdict
  }

  /** 批量判定（限并发 + 限总预算）；返回 id → 判定。 */
  const compatBatch = async (list: WhitelistEntry[], budgetMs: number): Promise<Map<string, DshCompatVerdict>> => {
    const out = new Map<string, DshCompatVerdict>()
    const deadline = Date.now() + budgetMs
    const queue = [...list]
    await Promise.all(
      Array.from({ length: Math.min(COMPAT_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          if (Date.now() > deadline) return
          const e = queue.shift() as WhitelistEntry
          out.set(e.id, await compatOf(e))
        }
      }),
    )
    saveCompat()
    return out
  }

  /**
   * 后台预热：把**全部可导入条目**的判定补进缓存（进程内只跑一次）。
   * 不 await —— 首次冷启动的列表请求不该等这 1800 次查询；预热完成后列表即为缓存命中。
   */
  const warmCompat = (entries: WhitelistEntry[]): void => {
    if (warmStarted) return
    warmStarted = true
    const queue = entries.filter((e) => compatKey(e) !== null)
    void (async () => {
      let done = 0
      const t0 = Date.now()
      await Promise.all(
        Array.from({ length: WARM_CONCURRENCY }, async () => {
          while (queue.length > 0) {
            const e = queue.shift() as WhitelistEntry
            try {
              await compatOf(e)
            } catch {
              /* compatOf 自身不会抛；这里只是双保险 */
            }
            done++
          }
        }),
      )
      saveCompat()
      app.log.info(`whitelist: dsh 兼容预热完成 ${done} 条，用时 ${Math.round((Date.now() - t0) / 1000)}s`)
    })()
  }

  app.get('/api/plugins/whitelist', { preHandler: requireAdmin }, async (request) => {
    const { q, category, onlyImportable, dshCompat } = request.query as {
      q?: string
      category?: string
      onlyImportable?: string
      dshCompat?: string
    }
    const { fetchedAt, entries, categoryLabels, stale } = await getIndex()
    // 首次进列表页就把全量判定在后台热起来（不阻塞本次响应）
    warmCompat(entries)
    let list = entries
    if (category !== undefined && category !== '') list = list.filter((e) => e.category === category)
    if (onlyImportable === '1') list = list.filter((e) => e.importKind !== 'source')
    if (q !== undefined && q !== '') {
      const kw = q.toLowerCase()
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(kw) ||
          (e.description ?? '').toLowerCase().includes(kw) ||
          (e.npm ?? '').toLowerCase().includes(kw) ||
          (e.owner ?? '').toLowerCase().includes(kw),
      )
    }
    // 分类清单带中文名 + 计数（按条目数降序），供前端下拉直接用中文展示。
    const counts = new Map<string, number>()
    for (const e of entries) if (e.category !== '') counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
    const categories = [...counts.entries()]
      .map(([id, count]) => ({ id, label: categoryLabels[id] ?? id, count }))
      .sort((a, b) => b.count - a.count)

    /** 兼容判定结果（`dshCompat=all` 时只标注、不过滤，便于排障）。 */
    const onlyCompat = dshCompat !== 'all'
    // 判定窗口取「比页面上限略大」：过滤掉"只兼容更旧版本"的后仍能把页面填满
    const window = list.slice(0, COMPAT_WINDOW)
    const verdicts = await compatBatch(
      onlyCompat ? window : window.filter((e) => compatKey(e) !== null),
      COMPAT_BUDGET_MS,
    )
    const annotate = (e: WhitelistEntry): WhitelistEntry & { dshCompat: DshCompat; dshRequires?: string } => {
      const v = verdicts.get(e.id)
      return v === undefined ? { ...e, dshCompat: 'unknown' as DshCompat } : { ...e, dshCompat: v.kind, ...(v.requires === undefined ? {} : { dshRequires: v.requires }) }
    }
    const shownWindow = onlyCompat ? window.filter((e) => verdicts.get(e.id)?.kind !== 'older') : window
    const hiddenByDsh = onlyCompat ? window.length - shownWindow.length : 0
    const plugins = shownWindow.slice(0, 300).map(annotate)

    return {
      fetchedAt,
      stale,
      total: entries.length,
      count: plugins.length,
      /** 过滤前的可展示条数（本次筛选条件命中数），供前端说明「被隐藏了多少」。 */
      countAll: window.length,
      hiddenByDsh,
      /** 当前平台 dsh 版本 —— 前端据此显示「已按 dsh X 过滤」与「需 ≥ Y」的对比。 */
      dshVersion: platformDshVersion(),
      compatFiltered: onlyCompat,
      importable: entries.filter((e) => e.importKind !== 'source').length,
      categories,
      plugins,
    }
  })

  app.post('/api/plugins/whitelist/refresh', { preHandler: requireAdmin }, async () => {
    const { entries, fetchedAt } = await getIndex(true)
    warmCompat(entries)
    return { ok: true, total: entries.length, importable: entries.filter((e) => e.importKind !== 'source').length, fetchedAt }
  })

  app.post('/api/plugins/whitelist/import', { preHandler: requireAdmin }, async (request, reply) => {
    const { names } = request.body as { names?: string[] }
    if (!Array.isArray(names) || names.length === 0) return reply.code(400).send({ error: 'no_plugins_selected' })
    const { entries } = await getIndex()
    const byId = new Map(entries.map((e) => [e.id, e]))
    const results: Array<{ id: string; name: string; ok: boolean; kind?: ImportKind; version?: string | null; error?: string }> = []
    for (const id of names.slice(0, MAX_IMPORT)) {
      try {
        const entry = byId.get(id)
        if (entry === undefined) throw httpError(404, `不在官方清单：${id}`)
        const { url, version } = await resolveTarball(entry)
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
        if (!res.ok) throw httpError(502, `下载失败 HTTP ${res.status}`)
        const archive = Buffer.from(await res.arrayBuffer())
        if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) throw httpError(400, '包大小异常')
        const staged = await stageTgzArchive(app.config.dataRoot, archive)

        // 投放裁决（与门户上传同一套口径）：P0 命中 / 版本不兼容 → 跳过该包并回显依据。
        // ⚠️ 本路径原先只依赖 `stageTgzArchive` 内部 throw；把它改成「收集式返回」
        //    （P0 不再抛出、由调用方裁决）之后**这里漏了裁决** → P0 会被静默放过。
        //    本次一并补上，并叠加的兼容性判定（导入 = 用户要求的第二个入口）。
        // 拒绝以 error 文本回显：批量导入是逐个 try/catch 收集结果，没有单条交互式「显式信任」入口。
        if (staged.blocked.length > 0) {
          throw httpError(
            409,
            `安全检测命中 P0，已跳过该包：${staged.blocked
              .slice(0, 3)
              .map((b) => `${b.why}（${b.file}）`)
              .join('；')}`,
          )
        }
        if (staged.compat.level === 'incompatible') {
          throw httpError(
            409,
            `与当前平台 dsh 版本不兼容，已跳过该包：${staged.compat.findings
              .slice(0, 3)
              .map((f) => `${f.pkg} — ${f.detail}`)
              .join('；')}`,
          )
        }
        const dir = join(app.config.dataRoot, 'business-plugins')
        await mkdir(dir, { recursive: true, mode: 0o755 })
        const existing = await app.db.findBusinessPlugin(staged.name)
        if (existing !== undefined && existsSync(existing.tgzPath)) await rm(existing.tgzPath, { force: true })
        const destPath = join(dir, staged.tgzName)
        await rename(join(staged.stage, 'payload.tgz'), destPath)
        const plugin = await app.db.upsertBusinessPlugin({
          id: staged.name,
          name: staged.name,
          // 说明优先用**目录条目的中文**：`WhitelistEntry.description` 在 `getIndex()`
          // 建索引时已按 `zh ?? en` 归一（见该处映射），比 tgz 里 `package.json` 的
          // description（第三方作者写的，通常英文）更贴合中文用户。
          // 之前这里直接写 `staged.description`，等于把目录里现成的中文丢掉 ——
          // 门户「已投放插件」表与实例内「功能管理」因此只显示英文
          //（2026-09-12 实测：该插件 / 某第三方插件 / dsh-univer-office 三者全部如此）。
          description: entry.description !== '' ? entry.description : staged.description,
          version: staged.version ?? version,
          tgzPath: destPath,
          fileSize: archive.length,
          uploadedBy: request.user?.id ?? null,
        })
        await app.db.audit(request.user?.id ?? null, 'import_whitelist_plugin', JSON.stringify({ id, name: plugin.name, kind: entry.importKind }))
        await rm(staged.stage, { recursive: true, force: true }).catch(() => undefined)
        results.push({ id, name: staged.name, ok: true, kind: entry.importKind, version: plugin.version })
      } catch (err) {
        results.push({ id, name: id, ok: false, error: (err as Error).message })
      }
    }
    return { ok: true, results }
  })
}
