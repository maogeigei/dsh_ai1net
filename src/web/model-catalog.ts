/**
 * 官方**模型厂家目录**读取层（补做）。
 *
 * 背景：第一版「模型设置」只支持「内置 DeepSeek + 手填一个 OpenAI 兼容网关」两类，
 * 用户反馈**「厂家选择怎么这么少、国内一家都没有」** —— 而实际情况是官方 `pi-ai` 包里
 * 自带 **39 个厂家**（含 `deepseek` / `kimi-coding` / `moonshotai-cn` / `minimax-cn` /
 * `qwen-token-plan-cn` / `zai` / `xiaomi` / `ant-ling` …），只是平台没接。
 *
 * 数据来源（**只读**，与实例用的同一个包 ⇒ 不会漂）：
 *   `<dsh 安装目录>/node_modules/@earendil-works/pi-ai/dist/providers/data/<id>.json`
 * 形状：`{ "<api>": { "<模型id>": { id, name, api, baseUrl, provider, contextWindow, maxTokens, cost… } } }`
 *
 * 关键结论（读官方 `dsh-llm-pi-ai` 的 `config.d.ts` 实证）：
 *   **route 只要命中目录里的厂家 id，就被视为「目录厂家」** —— 该厂家的 endpoint、协议、
 *   显示名、模型清单**全部由目录提供**，profile 只需给 `apiKeyEnv`（外加可选覆盖）。
 *   所以对 39 个目录厂家，用户**只需要填一把 API Key**，不必手写 endpoint / 协议 / 模型。
 *
 * 显示名策略：**目录数据里只有模型信息、没有厂家名**（厂家名在 `dist/providers/<id>.js` 里，
 * 用正则去抠 JS 太脆）。所以这里用一张**显示用**的静态表（仅影响文案）：
 *   · 表里有 → 用「中文名｜官方名」；表里没有（dsh 以后新增厂家）→ 回落成 id 的 Title Case。
 *   ⇒ **选取范围永远以数据目录为准**，静态表只是标签；不会因为表落后而漏掉新厂家。
 *
 * @module dsh_ai1net/web/model-catalog
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { piAiDataDir } from './dsh-install.js'

/**
 * 厂家目录数据目录。
 *
 * ⚠️ 2026-09-14 修：原先写死 `/usr/local/lib/node_modules/...`，在 `npm root -g` 落到
 * `/usr/lib/node_modules` 的机器上会**静默返回空目录**（测试服实测
 * `GET /api/me/model-providers` → `{"providers":[]}`，而真实位置有 39 个厂家文件）。
 * 改由 `dsh-install.ts` 按序探测（env → dsh 可执行文件解软链 → 常见全局根 → `npm root -g`）。
 */
export function catalogDir(): string {
  return piAiDataDir()
}

/** 目录里一个厂家。 */
export interface CatalogProvider {
  /** = settings.yaml 里 `llm-pi-ai.providers` 的 dict 键。 */
  id: string
  /** 展示名（中文名｜官方名；认不出就 Title Case 化 id）。 */
  label: string
  api: string
  baseURL: string | null
  models: Array<{ id: string; name: string | null; contextWindow: number | null; inputCost: number | null }>
}

/**
 * 显示用标签表（`id → 中文名｜官方名`）。**只影响文案**，不影响可选范围。
 * 国内厂家集中在前半段，方便用户在列表里先看到。
 */
const LABEL: Record<string, string> = {
  deepseek: '深度求索 DeepSeek',
  'kimi-coding': '月之暗面 Kimi（编程）',
  moonshotai: '月之暗面 Moonshot',
  'moonshotai-cn': '月之暗面 Moonshot（中国）',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax（中国）',
  'qwen-token-plan': '通义千问 Qwen（Token Plan）',
  'qwen-token-plan-cn': '通义千问 Qwen（中国）',
  'qwen-token-plan-individual': '通义千问 Qwen（个人版）',
  zai: '智谱 Z.AI',
  'zai-coding-cn': '智谱 Z.AI Coding（中国）',
  xiaomi: '小米 Xiaomi',
  'xiaomi-token-plan-cn': '小米 Xiaomi（中国）',
  'xiaomi-token-plan-ams': '小米 Xiaomi（AMS）',
  'xiaomi-token-plan-sgp': '小米 Xiaomi（SGP）',
  'ant-ling': '蚂蚁 Ant Ling',
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  'azure-openai-responses': 'Azure OpenAI',
  google: 'Google Gemini',
  'google-vertex': 'Google Vertex',
  xai: 'xAI Grok',
  mistral: 'Mistral',
  groq: 'Groq',
  cerebras: 'Cerebras',
  baseten: 'Baseten',
  fireworks: 'Fireworks',
  together: 'Together AI',
  nvidia: 'NVIDIA NIM',
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'github-copilot': 'GitHub Copilot',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  'amazon-bedrock': 'Amazon Bedrock',
  radius: 'Radius',
}

/** 认不出时的回落：`my-provider` → `My Provider`。 */
function prettify(id: string): string {
  return id
    .split(/[-_]/)
    .map((s) => (s === '' ? s : s[0].toUpperCase() + s.slice(1)))
    .join(' ')
}

/**
 * 中国大陆可直连的厂家 id（仅用于界面**分组**，让用户一眼看到国内选项 —— 用户原话：
 * 「模型厂商选择怎么这么少 国内的一家都没有」）。判据是厂家主体在中国大陆。
 */
const CN_IDS = new Set([
  'deepseek',
  'kimi-coding',
  'moonshotai-cn',
  'minimax-cn',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'zai',
  'zai-coding-cn',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'ant-ling',
])

/** @returns 该厂家是否属于「中国大陆可直连」分组。 */
export function isCnProvider(id: string): boolean {
  return CN_IDS.has(id)
}

/** @returns 该厂家的展示名。 */
export function providerLabel(id: string): string {
  return LABEL[id] ?? prettify(id)
}

/** 解析一个厂家的数据文件。 */
function parseProvider(id: string, raw: string): CatalogProvider | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object') return null
  const byApi = data as Record<string, Record<string, Record<string, unknown>>>
  let api = ''
  let baseURL: string | null = null
  const models: CatalogProvider['models'] = []
  const seen = new Set<string>()
  for (const [apiKey, group] of Object.entries(byApi)) {
    if (group === null || typeof group !== 'object') continue
    if (api === '') api = apiKey
    for (const [modelId, m] of Object.entries(group)) {
      if (m === null || typeof m !== 'object') continue
      if (seen.has(modelId)) continue
      seen.add(modelId)
      const row = m as Record<string, unknown>
      if (baseURL === null && typeof row.baseUrl === 'string' && row.baseUrl !== '') baseURL = row.baseUrl
      const cost = (row.cost ?? null) as Record<string, unknown> | null
      models.push({
        id: typeof row.id === 'string' ? row.id : modelId,
        name: typeof row.name === 'string' ? row.name : null,
        contextWindow: typeof row.contextWindow === 'number' ? row.contextWindow : null,
        inputCost: cost !== null && typeof cost.input === 'number' ? cost.input : null,
      })
    }
  }
  if (models.length === 0) return null
  models.sort((a, b) => a.id.localeCompare(b.id))
  return { id, label: providerLabel(id), api, baseURL, models }
}

/** 进程内缓存（目录是安装期冻结的，TTL 给长一点省 IO）。 */
let cache: { at: number; list: CatalogProvider[] } | null = null
const TTL_MS = 10 * 60 * 1000

/** 读取结果的可读性诊断。 */
export interface CatalogDiagnostics {
  /** 实际使用的目录（`dsh-install.ts` 探测出来的）。 */
  dir: string
  /** 能否读到（`false` = 探测/读取失败 ⇒ 界面只剩内置 DeepSeek + 自定义网关）。 */
  readable: boolean
  /** 读到了几个厂家。 */
  count: number
}

/**
 * 目录可读性诊断（2026-09-14 加）。
 *
 * 为什么必须加：定位/读取失败原本**完全静默**（catch 后返回 `[]`），于是
 * 「功能没做」与「功能做了但读不到目录」在界面上**一模一样** —— 一个 P1 缺陷就这样在
 * 另一种安装布局（`npm root -g` = `/usr/lib/node_modules`）上潜伏了很久，最后靠人工
 * 比对才看出来。⇒ ① 读不到时 `console.warn`（每进程一次，不刷日志）；
 * ② 把结果透出到 `/api/me/model-providers`，让「到底读没读到」可观测。
 */
let diag: CatalogDiagnostics | null = null
let warnedUnreadable = false

/** 最近一次读取的可读性诊断（尚未读过时返回 `null`）。 */
export function catalogDiagnostics(): CatalogDiagnostics | null {
  return diag
}

/**
 * 读出目录里的全部厂家（按中文名/官方名排序）。
 * 目录不存在（例如本地开发机）⇒ 返回空数组，**不抛错**：调用方据此降级为"只有内置 + 自定义"。
 * ⚠️ 降级**不是无声的** —— 见 `catalogDiagnostics()` 与上方的 `console.warn`。
 */
export async function listCatalogProviders(force = false): Promise<CatalogProvider[]> {
  if (!force && cache !== null && Date.now() - cache.at < TTL_MS) return cache.list
  const dir = catalogDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    diag = { dir, readable: false, count: 0 }
    if (!warnedUnreadable) {
      warnedUnreadable = true
      console.warn(
        `[model-catalog] 厂家目录不可读：${dir} —— 「设置 → 模型设置 → 新增厂家」只会显示内置 DeepSeek 与自定义网关。` +
          ' 检查 DSH_AI1NET_DSH_BIN / DSH_PACKAGE_DIR 是否正确（见 src/web/dsh-install.ts）。',
      )
    }
    cache = { at: Date.now(), list: [] }
    return []
  }
  const ids = files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.slice(0, -'.json'.length))
  const out: CatalogProvider[] = []
  for (const id of ids) {
    try {
      const p = parseProvider(id, await readFile(join(dir, id + '.json'), 'utf8'))
      if (p !== null) out.push(p)
    } catch {
      /* 单个文件读坏不影响其余 */
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  diag = { dir, readable: true, count: out.length }
  cache = { at: Date.now(), list: out }
  return out
}

/** 目录里有没有这个厂家 id（`POST /api/me/keys` 的校验用）。 */
export async function isCatalogProvider(id: string): Promise<boolean> {
  return (await listCatalogProviders()).some((p) => p.id === id)
}
