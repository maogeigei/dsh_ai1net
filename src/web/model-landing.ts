/**
 * 模型条目的**落地层**：把平台凭据库里「已启用」的条目写进实例的两个配置文件。
 *
 * 为什么必须有这一层：官方「设置 → 模型」页在平台环境**必然报错** —— 该页要求 Host settings
 * 镜像，而 `dsh-client-ui-settings` 的持久化判定是
 * `isLoopback = transport.ownsHost || pageLocation === undefined || isLoopbackHostname(page)`，
 * 平台是「浏览器经域名访问远程服务器」⇒ 三条皆不成立 ⇒ persistence 降级为 `memory`
 * ⇒ `ensure()` 直接返回不读 ⇒ 页面必报「加载提供方目录失败」。详见
 * `ensure-role-profile-patch.cjs` 的 `DISABLE_MODELS_BLOCK` / `ADMIN_MODELS_BLOCK` 注释。
 * ⇒ 用户自配模型只能由**平台自己写文件**。
 *
 * 落点两处（字段名均为 2026-09-13 读官方包 `dsh-llm-pi-ai@0.1.2-rc.1` 实测，勿凭记忆改）：
 *
 *   1. `$DSH_HOME/.credentials.yaml` → `refs.<REF>: '<key>'`
 *      （REF 须匹配 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`）
 *   2. `$DSH_HOME/settings.yaml` → 顶层 `llm-pi-ai:` → `providers.<route>` →
 *      `apiKeyEnv` / `baseURL` / `api` / `models`
 *      ⚠️ 是 **`api`**（不是 `protocol`）、是 **`apiKeyEnv`**（不是 `apiKey`）；
 *         该 profile **不接受** `provider` / `maxRetries` / `maxRetryDelayMs`（会直接抛错）；
 *         `api` 的合法值只有 `openai-completions` / `openai-responses` / `anthropic-messages`。
 *
 * 本模块**只做纯文本变换**（无 IO、无 db、无 crypto）⇒ 可以被
 * `scripts/verify-model-landing.mjs` 用固定样例逐条断言。这类"改写别人家配置文件"的逻辑
 * 最怕没有回归网：它错了不会报错，只会让实例静默少一个厂家。
 *
 * 安全约束（与既有 `ensureRefInCredentials` 同族，每条都是踩出来的）：
 *   · 只认 `version: 1` 的凭据文档；认不出的布局**宁可不动**；
 *   · 平台**只管自己写过的**（`managed` 清单）：用户自己放的 ref / 厂家段**绝不覆盖、绝不删**；
 *   · 要"删掉"时只删平台自己的：凭据=我们自己写的那一行，settings=我们自己那对标记之间；
 *   · 内联样式（`baseURL: ...`）而不是 JSON 块，避免把用户的其它字段卷进重排。
 *
 * @module dsh_ai1net/web/model-landing
 */

/** 官方凭据 ref 名的语法（`dsh-credentials` 的 `REF_PATTERN`）。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 内置 DeepSeek 条目的 ref（官方与平台既有实现共同约定的名字）。 */
export const BUILTIN_REF = 'DEEPSEEK_API_KEY'

/** `settings.yaml` 里那个用户设置分区的名字（官方 `const NS = "llm-pi-ai"`）。 */
export const PI_AI_NS = 'llm-pi-ai'

/** 官方支持的线协议（`dsh-llm-pi-ai` 的 `PROTOCOLS` 键，顺序即默认优先级）。 */
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type Protocol = (typeof PROTOCOLS)[number]

/** 一条「已启用」条目落地所需的全部信息（`value` 已是解密后的明文 key）。 */
export interface LandingEntry {
  /** 展示名（只用于注释与日志）。 */
  name: string
  /** settings.yaml 的 `providers` dict 键；内置条目可为空。 */
  route: string | null
  /** 自定义厂家 endpoint；空 = 内置 DeepSeek。 */
  baseUrl: string | null
  /** 线协议；空 = `openai-completions`。 */
  api: string | null
  /** 模型 id 清单。 */
  models: string[]
  /** 解密后的 key 明文。 */
  value: string
}

/** `reconcile*` 的返回：新文本 + 这一轮之后仍归平台管的键。 */
export interface ReconcileResult {
  text: string
  managed: string[]
}

/**
 * 自定义厂家的 ref 名：`<ROUTE 大写、非字母数字折成 _>_API_KEY`。
 * 结果**一定**匹配 `REF_PATTERN`（首字符强制成字母）—— 否则 dsh 解析凭据时会直接不认，
 * 而且是静默的"这条 ref 不存在"，排查成本极高。
 */
export function routeRef(route: string): string {
  let up = (route ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/^_+|_+$/g, '')
  if (up === '' || !/^[A-Z]/.test(up)) up = 'X' + up
  return `${up}_API_KEY`
}

/** 该条目用哪个 ref：内置 ⇒ `DEEPSEEK_API_KEY`；目录厂家 / 自定义 ⇒ `routeRef(route)`。 */
export function refForEntry(entry: Pick<LandingEntry, 'route' | 'baseUrl'>): string {
  // 内置 DeepSeek ⇔ **没有 route**（它走 `dsh-llm-deepseek` + `DEEPSEEK_API_KEY`，不写 settings.yaml）。
  // ⚠️ 不能再用「baseUrl 为空」当判据：**目录厂家**（读官方 pi-ai 目录的那些 route）也是
  // baseUrl 为空 —— 它们的 endpoint/协议/模型全由目录提供 —— 但它们有自己的 route 与
  // 自己的 `<ROUTE>_API_KEY`。两者混一起会把目录厂家的 key 写进 DEEPSEEK_API_KEY。
  const route = entry.route ?? ''
  return route === '' ? BUILTIN_REF : routeRef(route)
}

/** 协议取值规范化：认不出的一律回落官方默认（第一个），不抛错、不写坏配置。 */
export function normalizeProtocol(api: string | null | undefined): Protocol {
  return (PROTOCOLS as readonly string[]).includes(api ?? '') ? (api as Protocol) : PROTOCOLS[0]
}

/** YAML 单引号标量转义（`'` → `''`）—— 避免 key 里的引号把文档弄坏。 */
function yamlSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把「已启用条目」对账进 `.credentials.yaml`。
 *
 * @param text - 现有文件内容（空串 = 文件不存在）。
 * @param desired - 期望存在的 `{ ref, value }`。
 * @param managed - **平台自己写过**的 ref 清单（上一次的返回值）。只有这里的 ref 允许被改写/删除。
 * @returns 新文本 + 新的 managed 清单。认不出的布局会原样返回（宁可不动）。
 */
export function reconcileCredentials(
  text: string,
  desired: readonly { ref: string; value: string }[],
  managed: readonly string[] = [],
): ReconcileResult {
  const owned = new Set(managed)
  const wanted = new Map(desired.map((d) => [d.ref, d.value]))

  // 文件不存在 / 空 ⇒ 从零建一个最小合法文档（与既有 ensureRefInCredentials 同款）。
  if (text.trim() === '') {
    if (desired.length === 0) return { text, managed: [] }
    const body = desired.map((d) => `  ${d.ref}: ${yamlSingle(d.value)}`).join('\n')
    return { text: `version: 1\nrefs:\n${body}\n`, managed: desired.map((d) => d.ref) }
  }

  const lines = text.split('\n')
  const insideRefs: boolean[] = []
  let refsAt = -1
  let versionAt = -1
  let inside = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const indented = /^[ \t]/.test(raw)
    inside = indented ? inside : raw.trim() === 'refs:'
    if (!indented && raw.trim() === 'refs:' && refsAt < 0) refsAt = i
    if (!indented && versionAt < 0 && /^version:[ \t]*1[ \t]*$/.test(raw.trim())) versionAt = i
    insideRefs.push(inside && indented)
  }

  const refAt = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    if (!insideRefs[i]) continue
    const m = /^[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/.exec(lines[i])
    if (m !== null) refAt.set(m[1], i)
  }

  const drop = new Set<number>()
  const kept: string[] = []
  const setLine: Array<{ at: number; ref: string; value: string }> = []
  const add: Array<{ ref: string; value: string }> = []

  for (const ref of owned) {
    if (wanted.has(ref)) {
      kept.push(ref)
      continue
    }
    const at = refAt.get(ref)
    if (at !== undefined) drop.add(at) // 用户关掉了 ⇒ 把平台自己写的那行撤掉
  }
  for (const [ref, value] of wanted) {
    const at = refAt.get(ref)
    if (at === undefined) {
      add.push({ ref, value })
      kept.push(ref)
      continue
    }
    if (!owned.has(ref)) continue // 文件里有、但不是平台写的 ⇒ 用户自己的，绝不碰
    setLine.push({ at, ref, value })
    kept.push(ref)
  }

  const inserted = new Map<number, string[]>()
  if (add.length > 0) {
    const anchor = refsAt >= 0 ? refsAt : versionAt
    if (anchor < 0) return { text, managed: [...owned] } // 认不出布局 ⇒ 宁可不动
    const body = add.map((d) => `  ${d.ref}: ${yamlSingle(d.value)}`)
    inserted.set(anchor, refsAt >= 0 ? body : ['refs:', ...body])
  }

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!drop.has(i)) {
      const s = setLine.find((d) => d.at === i)
      out.push(s === undefined ? lines[i] : `  ${s.ref}: ${yamlSingle(s.value)}`)
    }
    const extra = inserted.get(i)
    if (extra !== undefined) out.push(...extra)
  }
  return { text: out.join('\n'), managed: [...new Set(kept)] }
}

/**
 * 一条要写进 `settings.yaml` 的厂家声明。
 * ⚠️ `baseURL` / `api` / `models` **都可选**：**目录厂家**（route 命中官方 pi-ai 目录）只需要
 * `apiKeyEnv` —— 它的 endpoint、协议、模型目录全部由官方目录提供（官方 `config.d.ts`：
 * "When it does, that provider's endpoint, protocol, display name, and model catalog are the
 * profile's defaults and the profile overrides them field by field"）。写得越少越不容易漂。
 */
export interface SettingsEntry {
  route: string
  apiKeyEnv: string
  baseURL?: string
  api?: Protocol
  models?: string[]
}

const markBegin = (route: string): string => `    # dsh_ai1net:model-route ${route} begin`
const markEnd = (route: string): string => `    # dsh_ai1net:model-route ${route} end`

/**
 * 把厂家声明对账进 `settings.yaml`。
 *
 * 用**成对标记**夹住平台自己写的那个 route 段：① 不解析别人的 YAML（不重排、不丢注释）；
 * ② "关掉某个厂家"就是删掉自己那对标记之间的内容 ⇒ 精确可控。
 * 代价：若 dsh 或用户某次把文件整体重写、标记丢了，就再也删不掉那个 route
 * （但"已存在"检查仍会拦住重复写入，所以最坏是留一条模型清单里的僵尸厂家，不会写坏配置）。
 *
 * @param text - 现有文件内容（空串 = 文件不存在）。
 * @param desired - 期望存在的厂家声明。
 * @param managed - 平台自己写过的 route 清单。
 */
export function reconcileSettings(
  text: string,
  desired: readonly SettingsEntry[],
  managed: readonly string[] = [],
): ReconcileResult {
  const owned = new Set(managed)
  const wanted = new Map(desired.map((d) => [d.route, d]))

  // ① 先删：不再需要的、且是我们自己写的块。
  const lines = text === '' ? [] : text.split('\n')
  const kept: string[] = []
  const present = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const b = /^[ \t]*# dsh_ai1net:model-route ([^\s]+) begin[ \t]*$/.exec(lines[i])
    if (b === null) {
      // 非标记行里如果已经有 `    <route>:`（可能是用户/官方自己写的）⇒ 记为"已存在"，不重复写。
      const k = /^[ \t]{4}([^\s:#][^\s:]*)[ \t]*:[ \t]*$/.exec(lines[i])
      if (k !== null) present.add(k[1])
      kept.push(lines[i])
      continue
    }
    const route = b[1]
    const endRe = new RegExp(`^[ \\t]*# dsh_ai1net:model-route ${escapeRe(route)} end[ \\t]*$`)
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (endRe.test(lines[j])) {
        end = j
        break
      }
    }
    if (wanted.has(route) || !owned.has(route)) {
      // 还要留着（或不是我们的，不该动）⇒ 原样搬过去。
      present.add(route)
      if (end < 0) kept.push(lines[i])
      else {
        kept.push(...lines.slice(i, end + 1))
        i = end
      }
      continue
    }
    // 用户已关掉这个厂家 ⇒ 整块丢掉（这就是"删"）。
    i = end < 0 ? i : end
  }

  const add = desired.filter((d) => !present.has(d.route))
  const newOwned = [...new Set([...owned].filter((r) => wanted.has(r) || present.has(r)))]
  if (add.length === 0) return { text: kept.join('\n'), managed: newOwned }

  // ② 找 `llm-pi-ai:` → `providers:` 链，缺什么补什么，然后在 `providers:` 之后插入。
  //    ⚠️ 这里**不能**用"只看顶层行"的循环：`providers:` 本身就是缩进 2 的（它是
  //    `llm-pi-ai:` 的子键）。第一版就是这么写的 ⇒ 找不到既有 providers ⇒ 又补一行
  //    `  providers:` ⇒ 文档里出现**两个**同键（回归 [8]/[9] 当场抓到）。
  let nsAt = -1
  for (let i = 0; i < kept.length; i++) {
    if (/^[ \t]/.test(kept[i])) continue
    if (kept[i].trim() === `${PI_AI_NS}:`) {
      nsAt = i
      break
    }
  }
  let provAt = -1
  if (nsAt >= 0) {
    for (let i = nsAt + 1; i < kept.length; i++) {
      const raw = kept[i]
      if (!/^[ \t]/.test(raw)) {
        if (raw.trim() !== '') break // 撞到下一个顶层键 ⇒ 该分区到此为止
        continue // 分区里的空行不算结束
      }
      if (raw.trim() === 'providers:') {
        provAt = i
        break
      }
    }
  }

  const blocks = add.flatMap((d) => {
    const lines = [markBegin(d.route), `    ${d.route}:`, `      apiKeyEnv: ${d.apiKeyEnv}`]
    // 只写**给了的**字段：目录厂家只给 apiKeyEnv（其余由官方目录兜底），
    // 自定义厂家才需要 baseURL / api / models。
    if (d.baseURL !== undefined && d.baseURL !== '') lines.push(`      baseURL: ${d.baseURL}`)
    if (d.api !== undefined) lines.push(`      api: ${d.api}`)
    if (d.models !== undefined && d.models.length > 0) {
      lines.push('      models:')
      for (const m of d.models) lines.push(`        - id: ${m}`)
    }
    lines.push(markEnd(d.route))
    return lines
  })

  const out = [...kept]
  if (provAt >= 0) {
    out.splice(provAt + 1, 0, ...blocks)
  } else if (nsAt >= 0) {
    out.splice(nsAt + 1, 0, '  providers:', ...blocks)
  } else {
    // 整个 `llm-pi-ai:` 分区都不在 ⇒ 追加到文件末尾（顶层键，顺序无关）。
    if (out.length > 0 && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${PI_AI_NS}:`, '  providers:', ...blocks, '')
    else out.push(`${PI_AI_NS}:`, '  providers:', ...blocks)
  }
  return { text: out.join('\n'), managed: [...new Set([...newOwned, ...add.map((d) => d.route)])] }
}

/**
 * 读出 `.credentials.yaml` 里某个 ref 的**当前值**（没有该 ref 时 `null`）。
 *
 * 用途只有一个：**一次性交接**。老实现把平台共享 key 直接写进
 * `refs.DEEPSEEK_API_KEY`，但那时没有托管清单 ⇒ 新逻辑会把它当成"用户自己写的"而永不清理
 * ⇒ 用户关掉共享开关后那个 key 仍然留在文件里（"关掉即生效"就不成立）。
 * 所以首次运行时要**认领**该 ref，但只在那行确实等于平台共享 key 的明文时才认领
 * —— 否则就是用户自己配的，绝不碰。
 * @param text - `.credentials.yaml` 内容。
 * @param ref - 要读的 ref 名。
 * @returns 去掉引号后的值，或 `null`。
 */
export function readRefValue(text: string, ref: string): string | null {
  if (text === '') return null
  const lines = text.split('\n')
  let inside = false
  for (const raw of lines) {
    const indented = /^[ \t]/.test(raw)
    inside = indented ? inside : raw.trim() === 'refs:'
    if (!inside || !indented) continue
    const m = new RegExp(`^[ \\t]+${ref}[ \\t]*:[ \\t]*(.*)$`).exec(raw)
    if (m === null) continue
    const v = m[1].trim()
    if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
      return v.slice(1, -1).replace(/''/g, "'")
    }
    return v
  }
  return null
}

/**
 * 把 `models` 列（JSON 数组字符串）解析成 id 清单。
 * 宽容：非数组、非字符串项、超量一律丢弃 —— 这条路上宁可少写一个模型，
 * 也不能让一个坏值把整个 `settings.yaml` 变成 dsh 拒绝加载的文档。
 */
export function parseModels(json: string | null | undefined, limit = 50): string[] {
  if (json === null || json === undefined) return []
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    const out: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const v = item.trim()
      if (v === '' || v.length > 128) continue
      if (!out.includes(v)) out.push(v)
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}
